/**
 * PDF → PNG（WASM 渲染）
 * ============================================================
 * ★ 为什么必须有这一步
 *
 *   视觉模型**不接受 PDF**。实测把原始 PDF 字节按
 *   `data:application/pdf;base64,...` 发给小米 MiMo，直接回：
 *     400 "invalid image format, only bmp/gif/png/jpeg/webp are supported"
 *
 *   而改造前 `RecognitionIngestService` 在"PDF 没有可用文本层"时，
 *   正是把原始 PDF 当图片发出去 —— 也就是说「没有文本层就转视觉」
 *   这条路**一直是坏的**：只要用户传扫描件，必然 400。
 *   它没被更早发现，只是因为手边的样例都是带文本层的电子发票。
 *
 * ★ 为什么用 mupdf 而不是 pdfjs + canvas
 *
 *   · pdfjs 自己渲染需要 node-canvas：原生模块，要 node-gyp 编译，
 *     意味着镜像里得装 python3 / make / g++，还得处理平台差异。
 *   · mupdf 是 WASM，纯 npm 包（无安装脚本），Windows 与 Linux
 *     行为一致，不会出现"宿主机能跑、容器里不能跑"。
 *
 *   代价：mupdf 是纯 ESM，而本项目 API 编译成 CommonJS —— 见 dynamicImport。
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';

/** 渲染出的单页 */
export interface RasterizedPage {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface RasterizeResult {
  pages: RasterizedPage[];
  totalPages: number;
  /** 页数超过上限被截断 —— 必须让上层告诉用户，不能悄悄只识别前几页 */
  truncated: boolean;
}

/** 单次最多渲染几页。发票是一页，流水才可能几十页，超出的由上层提示用户拆分。 */
export const MAX_RASTER_PAGES = 5;

/**
 * 长边目标像素。
 *
 * 1200～1600 对票据类文档足够：字够大、模型看得清，token 也不至于失控。
 * 再高只是把清晰度浪费在纸面上。
 */
export const TARGET_MAX_DIMENSION = 1600;

const MIN_SCALE = 1;
const MAX_SCALE = 3;

// ============================================================================
//  mupdf 的最小类型声明
// ============================================================================
//  ★ 不去依赖 mupdf 自带的 .d.ts：它是 ESM 包，包内类型入口在 CJS 下解析
//    容易出岔子，而且我们只用到极少几个成员。自己声明反而更清楚。

interface MupdfPixmap {
  asPNG(): Uint8Array;
  getWidth(): number;
  getHeight(): number;
  destroy?(): void;
}

interface MupdfPage {
  /** [x0, y0, x1, y1] */
  getBounds(): number[];
  toPixmap(
    matrix: unknown,
    colorspace: unknown,
    alpha: boolean,
    showExtras: boolean,
  ): MupdfPixmap;
  destroy?(): void;
}

interface MupdfDocument {
  countPages(): number;
  loadPage(index: number): MupdfPage;
  destroy?(): void;
}

interface MupdfModule {
  Document: { openDocument(buffer: Buffer, magic: string): MupdfDocument };
  Matrix: { scale(x: number, y: number): unknown };
  ColorSpace: { DeviceRGB: unknown };
}

/**
 * ★ 为什么要绕这么一圈
 *
 *   tsconfig 是 `module: commonjs`，TypeScript 会把 `await import('mupdf')`
 *   降级成 `require('mupdf')`；而 mupdf 是纯 ESM 且带 top-level await，
 *   require 会直接抛：
 *     "require() cannot be used on an ESM graph with top-level await"
 *
 *   把 import 包进 `new Function` 的字符串里，类型检查与降级都看不见它，
 *   于是动态 import 原样保留到运行时。这是 Node 侧 CommonJS 调 ESM 的标准做法。
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<MupdfModule>;

@Injectable()
export class PdfRasterizer {
  private readonly logger = new Logger(PdfRasterizer.name);

  /**
   * 把 PDF 的每一页渲染成 PNG。
   *
   * 失败时抛错而不是返回空数组：空数组会让上层以为"渲染成功但没内容"，
   * 于是给模型发一个没有任何图片的请求，最后报一个跟真实原因无关的错。
   */
  async rasterize(
    buffer: Buffer,
    options: { maxPages?: number; maxDimension?: number } = {},
  ): Promise<RasterizeResult> {
    const maxPages = options.maxPages ?? MAX_RASTER_PAGES;
    const maxDimension = options.maxDimension ?? TARGET_MAX_DIMENSION;

    const mupdf = await dynamicImport('mupdf');

    /*
     * ★ openDocument 必须包在 try 里。
     *
     *   实测：传一个不是 PDF 的文件（后缀改成 .pdf 的文本、或损坏的 PDF），
     *   mupdf 的 WASM 直接抛出内部错误 "no objects found"。
     *   改造初期它在这个 try 之外，于是原始内部信息一路漏成 500
     *   「系统内部错误」—— 用户既不知道是文件的问题，也不知道该怎么办。
     *
     *   PDF 文本层解析失败（pdfjs 报 Invalid PDF structure）时会走到这里，
     *   此时文件本身就已经不可读了，所以按**用户输入问题**报 400，
     *   并说清"这个文件不是有效的 PDF"与可行的出路。
     */
    let doc: MupdfDocument;
    try {
      doc = mupdf.Document.openDocument(buffer, 'application/pdf');
    } catch (e) {
      this.logger.warn(
        `PDF 无法打开（mupdf）：${e instanceof Error ? e.message : String(e)}`,
      );
      throw new BadRequestException(
        '这个文件无法作为 PDF 打开：它可能已损坏、被加密，或者只是把后缀改成了 .pdf。' +
          '请确认原件能正常打开后再上传；也可以先把页面截图，以图片形式上传。',
      );
    }

    try {
      const totalPages = doc.countPages();
      if (totalPages === 0) {
        throw new BadRequestException('这个 PDF 一页都没有，可能是文件损坏或不是真正的 PDF。');
      }

      const pages: RasterizedPage[] = [];
      const limit = Math.min(totalPages, maxPages);

      for (let i = 0; i < limit; i += 1) {
        pages.push(this.renderPage(mupdf, doc, i, maxDimension));
      }

      return { pages, totalPages, truncated: totalPages > limit };
    } finally {
      doc.destroy?.();
    }
  }

  private renderPage(
    mupdf: MupdfModule,
    doc: MupdfDocument,
    index: number,
    maxDimension: number,
  ): RasterizedPage {
    const page = doc.loadPage(index);

    try {
      const [x0 = 0, y0 = 0, x1 = 595, y1 = 842] = page.getBounds();
      const width = Math.max(1, x1 - x0);
      const height = Math.max(1, y1 - y0);

      // 长边缩放到目标像素；再夹在 [MIN_SCALE, MAX_SCALE] 之间，
      // 避免极小页面被放到糊、或超大页面把 token 吃光。
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, maxDimension / Math.max(width, height)),
      );

      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );

      try {
        const png = pixmap.asPNG();
        return {
          base64: Buffer.from(png).toString('base64'),
          mimeType: 'image/png',
          width: pixmap.getWidth(),
          height: pixmap.getHeight(),
        };
      } finally {
        pixmap.destroy?.();
      }
    } catch (e) {
      this.logger.warn(
        `PDF 第 ${index + 1} 页渲染失败：${e instanceof Error ? e.message : String(e)}`,
      );
      throw new BadRequestException(
        `PDF 第 ${index + 1} 页渲染失败，无法转为图片送模型识别。` +
          '请确认该 PDF 未加密、未损坏；也可以先把页面截图后以图片形式上传。',
      );
    } finally {
      page.destroy?.();
    }
  }
}
