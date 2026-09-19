/**
 * 识别录入：把上传的文件变成「识图/抽取」的输入
 * ============================================================
 * 三类文件的处理路径完全不同，这里把它们统一成 AiService.extract 的入参：
 *
 *   图片 (png/jpg/webp/...)  → base64 → 多模态模型的视觉输入
 *   PDF                      → 优先取**文本层**（更便宜也更准），取不到再渲染成图
 *   Excel / CSV（报表常见）  → 直接解析成表格文本，走纯文本抽取
 *
 * 为什么 Excel 报表要走"文本"而不是"图片"：
 *   代账公司给的资产负债表基本都是 Excel。Excel 里数字是精确的，
 *   把它渲染成图片再让模型"看"，等于把精确数据主动降级成有损识别。
 *   直接读单元格 → 零识别误差，只花文本 token，成本还更低。
 *
 * ★ PDF 这条路踩过两个坑，都在这一版修掉，改动原因见各处注释：
 *   1. 文本层按**阅读顺序**平铺会丢掉水平位置，导致购买方/销售方互换
 *      → 改为按坐标重建版面（domain/recognition/pdf-layout.ts）
 *   2. "没有文本层就转视觉"曾经把原始 PDF 当图片发出去，模型必然 400
 *      → 改为先用 mupdf 渲染成 PNG（infrastructure/pdf/pdf-rasterizer.ts）
 *
 * ★ 无论走哪条路径，金额最终都由系统按票面字段计算，模型只负责"抄"。
 */
import { Injectable, Logger } from '@nestjs/common';
import { readReportGrid, gridToText } from '../../domain/history/report-reader';
import {
  assessTextLayer,
  rebuildLayoutText,
  type PdfTextItem,
} from '../../domain/recognition/pdf-layout';
import { PdfRasterizer } from '../../infrastructure/pdf/pdf-rasterizer';

/** 可识别的文件类型 */
export type IngestKind = 'IMAGE' | 'PDF' | 'SHEET';

export interface IngestResult {
  kind: IngestKind;
  /** 给模型看的文本：PDF 文本层 / 表格文本；图片为空 */
  text: string | null;
  /** 图片输入（base64）。PDF 文本层不可用时也会带上渲染后的页图 */
  images: Array<{ base64: string; mimeType: string }>;
  fileName: string;
  sizeBytes: number;
  /** 交给前端显示的提示（例如"该 PDF 没有文本层，已转为视觉识别"） */
  notes: string[];
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

const SHEET_EXT = new Set(['xlsx', 'xlsm', 'csv', 'txt']);

/** 单个文件大小上限：50MB。再大就不是"一张票一张表"了，应该走批量导入。 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** 文本层截断长度：报表几十行也够用；截断是为了控 token 成本 */
const MAX_TEXT_CHARS = 20000;

/** pdfjs 里我们用得到的最小面 */
interface PdfJsTextItem {
  str?: string;
  transform?: number[];
  height?: number;
}
interface PdfJsPage {
  getTextContent(): Promise<{ items: PdfJsTextItem[] }>;
}
interface PdfJsDocument {
  numPages: number;
  getPage(index: number): Promise<PdfJsPage>;
  destroy(): Promise<void>;
}
interface PdfJsModule {
  getDocument(params: {
    data: Uint8Array;
    isEvalSupported?: boolean;
    useSystemFonts?: boolean;
  }): { promise: Promise<PdfJsDocument> };
}

@Injectable()
export class RecognitionIngestService {
  private readonly logger = new Logger(RecognitionIngestService.name);

  constructor(private readonly rasterizer: PdfRasterizer) {}

  /** 从文件名判断类型 —— 浏览器给的 mimetype 常不可靠（.png 被标成 octet-stream） */
  detectKind(fileName: string, mimeType?: string): IngestKind {
    const ext = extOf(fileName);
    if (ext && IMAGE_MIME_BY_EXT[ext]) return 'IMAGE';
    if (ext === 'pdf') return 'PDF';
    if (ext && SHEET_EXT.has(ext)) return 'SHEET';

    // 扩展名不可用时才退回 mimetype
    const mime = (mimeType ?? '').toLowerCase();
    if (mime.startsWith('image/')) return 'IMAGE';
    if (mime === 'application/pdf') return 'PDF';
    if (mime.includes('spreadsheet') || mime.includes('csv') || mime === 'text/plain') return 'SHEET';

    throw new Error(
      `无法识别的文件类型「${fileName}」。` +
        `支持：图片（png / jpg / webp）、PDF、Excel（xlsx）、CSV。`,
    );
  }

  async ingest(params: {
    fileName: string;
    buffer: Buffer;
    mimeType?: string;
  }): Promise<IngestResult> {
    if (params.buffer.length === 0) {
      throw new Error(`文件「${params.fileName}」是空的，没有可识别的内容。`);
    }
    if (params.buffer.length > MAX_UPLOAD_BYTES) {
      throw new Error(
        `文件「${params.fileName}」为 ${(params.buffer.length / 1024 / 1024).toFixed(1)}MB，` +
          `超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限。请拆分后分批上传。`,
      );
    }

    const kind = this.detectKind(params.fileName, params.mimeType);
    const notes: string[] = [];

    if (kind === 'IMAGE') {
      const mimeType = IMAGE_MIME_BY_EXT[extOf(params.fileName)] ?? params.mimeType ?? 'image/png';
      return {
        kind,
        text: null,
        images: [{ base64: params.buffer.toString('base64'), mimeType }],
        fileName: params.fileName,
        sizeBytes: params.buffer.length,
        notes,
      };
    }

    if (kind === 'PDF') {
      return this.ingestPdf(params, notes);
    }

    // ── Excel / CSV：精确读单元格，不做有损的图片识别 ──
    const grid = await readReportGrid(params.buffer, params.fileName);
    const text = gridToText(grid);
    notes.push(
      `已从工作表「${grid.sheetName}」直接读取 ${grid.nonEmptyRows} 个非空行（逐单元格读取，无识别误差）。`,
    );
    notes.push(...grid.warnings);

    return {
      kind: 'SHEET',
      text: text.slice(0, MAX_TEXT_CHARS),
      images: [],
      fileName: params.fileName,
      sizeBytes: params.buffer.length,
      notes,
    };
  }

  // ==========================================================================
  //  PDF
  // ==========================================================================

  private async ingestPdf(
    params: { fileName: string; buffer: Buffer },
    notes: string[],
  ): Promise<IngestResult> {
    const text = await this.pdfLayoutText(params.buffer);
    const assessment = assessTextLayer(text);

    if (text && assessment.usable) {
      notes.push(
        `已读取 PDF 文本层（${assessment.reason}）。` +
          '文本按原版面保留了左右位置，购买方与销售方不会因阅读顺序而互换。',
      );
      return {
        kind: 'PDF',
        text: text.slice(0, MAX_TEXT_CHARS),
        images: [],
        fileName: params.fileName,
        sizeBytes: params.buffer.length,
        notes,
      };
    }

    /*
     * 文本层不可用 → 把每一页渲染成 PNG 再走图像识别。
     *
     * ★ 不能直接把 PDF 字节当图片发出去：实测视觉模型回
     *     400 "invalid image format, only bmp/gif/png/jpeg/webp are supported"
     *   改造前就是这么发的，所以扫描件这条路径**一直必然是 400**。
     */
    notes.push(`该 PDF 的文本层不可用（${assessment.reason}），已转为图像识别。`);

    const raster = await this.rasterizer.rasterize(params.buffer);

    if (raster.truncated) {
      notes.push(
        `这个 PDF 共 ${raster.totalPages} 页，本次只识别了前 ${raster.pages.length} 页，` +
          '其余内容请拆分后单独上传。',
      );
    }
    notes.push('图像识别对倾斜、盖章遮挡、手写字的容忍度不如文本层，金额请重点核对。');

    return {
      kind: 'PDF',
      text: null,
      images: raster.pages.map((p) => ({ base64: p.base64, mimeType: p.mimeType })),
      fileName: params.fileName,
      sizeBytes: params.buffer.length,
      notes,
    };
  }

  /**
   * 提取 PDF 文本层，并按**坐标**重建版面。
   *
   * 用 require 动态加载：pdf-parse 时代留下的老问题在这里已不存在
   * （pdfjs-dist 是纯 ESM 的 v4，我们固定在 3.x 以便 CommonJS 直接 require），
   * 但保持动态加载可以让"某个 PDF 解析崩了"不至于影响整个进程启动。
   *
   * ★ 这里刻意不用 pdf-parse：它只给一个拼好的字符串，丢掉了坐标，
   *   而坐标正是区分"购买方 / 销售方"这种并列同名字段唯一可靠的依据。
   */
  private async pdfLayoutText(buffer: Buffer): Promise<string | null> {
    let doc: PdfJsDocument | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js') as PdfJsModule;

      doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        useSystemFonts: false,
      }).promise;

      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();

        const items: PdfTextItem[] = [];
        for (const raw of content.items) {
          const str = raw.str;
          const t = raw.transform;
          if (typeof str !== 'string' || !str.trim() || !Array.isArray(t)) continue;
          items.push({
            str,
            x: t[4] ?? 0,
            y: t[5] ?? 0,
            ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
          });
        }

        const pageText = rebuildLayoutText(items);
        pages.push(doc.numPages > 1 ? `--- 第 ${i} 页 ---\n${pageText}` : pageText);
      }

      return pages.join('\n\n');
    } catch (e) {
      this.logger.warn(
        `PDF 文本层提取失败，将改为渲染成图片识别：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    } finally {
      // destroy 失败不该掩盖上面的真实错误
      await doc?.destroy().catch(() => undefined);
    }
  }
}

// ============================================================================
//  工具
// ============================================================================

function extOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : '';
}
