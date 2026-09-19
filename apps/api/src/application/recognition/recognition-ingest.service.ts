/**
 * 识别录入：把上传的文件变成「识图/抽取」的输入
 * ============================================================
 * 三类文件的处理路径完全不同，这里把它们统一成 AiService.extract 的入参：
 *
 *   图片 (png/jpg/webp/...)  → base64 → 多模态模型的视觉输入
 *   PDF                      → 优先取**文本层**（更便宜也更准），取不到再转图片路径
 *   Excel / CSV（报表常见）  → 直接解析成表格文本，走纯文本抽取
 *
 * 为什么 Excel 报表要走"文本"而不是"图片"：
 *   代账公司给的资产负债表基本都是 Excel。Excel 里数字是精确的，
 *   把它渲染成图片再让模型"看"，等于把精确数据主动降级成有损识别。
 *   直接读单元格 → 零识别误差，只花文本 token，成本还更低。
 *
 * ★ 无论走哪条路径，金额最终都由系统按票面字段计算，模型只负责"抄"。
 */
import { Injectable, Logger } from '@nestjs/common';
import { readReportGrid, gridToText } from '../../domain/history/report-reader';

/** 可识别的文件类型 */
export type IngestKind = 'IMAGE' | 'PDF' | 'SHEET';

export interface IngestResult {
  kind: IngestKind;
  /** 给模型看的文本：PDF 文本层 / 表格文本；图片为空 */
  text: string | null;
  /** 图片输入（base64）。PDF 无文本层时也会带上原文件 */
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

@Injectable()
export class RecognitionIngestService {
  private readonly logger = new Logger(RecognitionIngestService.name);

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
      const text = await this.pdfTextLayer(params.buffer);
      if (text && text.trim().length >= 40) {
        notes.push('已读取 PDF 文本层（比图片识别更准、更省 token），图片仅用于核对。');
        return {
          kind,
          text: text.slice(0, MAX_TEXT_CHARS),
          images: [],
          fileName: params.fileName,
          sizeBytes: params.buffer.length,
          notes,
        };
      }

      // 扫描件 / 图片型 PDF：没有文本层，只能交给视觉模型
      notes.push(
        '该 PDF 没有可用文本层（可能是扫描件或图片型 PDF），已转为视觉识别，金额请重点核对。',
      );
      return {
        kind: 'PDF',
        text: null,
        images: [{ base64: params.buffer.toString('base64'), mimeType: 'application/pdf' }],
        fileName: params.fileName,
        sizeBytes: params.buffer.length,
        notes,
      };
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

  /**
   * 提取 PDF 文本层。
   *
   * 用 require 动态加载：pdf-parse 在模块顶层会去读一个测试用的样例 PDF 文件，
   * 直接 import 会在某些打包/工作目录下抛 ENOENT。
   */
  private async pdfTextLayer(buffer: Buffer): Promise<string | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text?: string }>;
      const result = await pdfParse(buffer);
      return result.text ?? null;
    } catch (e) {
      this.logger.warn(
        `PDF 文本层提取失败，将走视觉识别：${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
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
