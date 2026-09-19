/**
 * PDF 文本层 → 保留版面的文本
 * ============================================================
 * ★ 为什么不能直接把文本层拼成一个字符串
 *
 *   实测踩过一次会**静默记错账**的坑。一张北京住宿电子发票的文本层字符
 *   完全正确（143 个汉字，一个都没错），但按阅读顺序拼出来是这样的：
 *
 *     销售方信息          ← 竖排标签，右列
 *     购买方信息          ← 竖排标签，左列
 *     煤炭工业规划设计研究院有限公司   ← 左列「名称」（实为购买方）
 *     91110000710934035X               ← 左列「税号」（实为购买方）
 *     东宇酒店（北京）有限责任公司     ← 右列「名称」（实为销售方）
 *     91110113MA04CM3C37               ← 右列「税号」（实为销售方）
 *
 *   标签的先后是「先销售方、后购买方」，取值的先后却是「先左列、后右列」——
 *   **两者正好相反**。模型很自然地把「销售方」标签之后出现的第一个名称
 *   配给了销售方，于是买卖双方整个读反。
 *
 *   后果不是报错而是记错账：若本主体恰好是购买方，系统会判定为
 *   `direction=销项`，把一张住宿票记成销售收入（进项税记成销项税），
 *   而方向校验 V4 因为「销售方 = 本主体」一致反而 PASS —— 三道防线全过。
 *
 *   根因是平铺文本丢掉了**水平位置**：购买方与销售方这两个标签完全相同的
 *   并列块，只能靠位置区分。所以这里按坐标重建版面，让标签与取值在
 *   字符网格上重新对齐。
 *
 *   实测对比（同一模型、同一份内容，只改呈现方式）：
 *     平铺       → buyer=东宇酒店              seller=煤炭工业规划设计研究院  ✗ 读反
 *     保留版面   → buyer=煤炭工业规划设计研究院  seller=东宇酒店              ✓ 正确
 */

/** pdfjs 的文本项里我们用得到的部分 */
export interface PdfTextItem {
  str: string;
  /** 文本项原点在页面坐标系中的 x（pt） */
  x: number;
  /** 文本项基线 y（pt）。PDF 原点在左下角，因此 y 越大越靠上 */
  y: number;
  /** 字号近似值（pt），用来估算一个字符占多宽 */
  height?: number;
}

export interface RebuildOptions {
  /** 行聚合容差（pt）：y 相差不超过它就算同一行 */
  rowTolerance?: number;
  /** 单行最多填充的空格数，防止异常坐标把一行撑到几万字符 */
  maxPad?: number;
}

/** 同一行的 y 容差。取得比字号略小，避免把相邻两行粘成一行。 */
const DEFAULT_ROW_TOLERANCE = 6;
const DEFAULT_MAX_PAD = 240;

/**
 * 字符宽度估算的上下限（pt）。
 *
 * ★ 估算值偏小会让相邻单元格互相压上，只能退化成"一个空格"，
 *   对齐随之丢失 —— 而**对齐正是这个模块存在的全部理由**。
 *   所以下限不能太激进。
 */
const MIN_CHAR_WIDTH = 4;
const MAX_CHAR_WIDTH = 24;
const FALLBACK_CHAR_WIDTH = 8;

/** 文本层可用的最低门槛：字符数与汉字数 */
export const MIN_TEXT_LAYER_CHARS = 40;
export const MIN_TEXT_LAYER_CJK = 10;

/**
 * 按坐标把文本项重建成"看起来像原页面"的文本。
 *
 * 同一行的单元格按 x 从左到右排列，并用空格补齐到各自的列位置，
 * 于是「购买方信息」与「销售方信息」这两列会重新落在各自的纵向位置上。
 */
export function rebuildLayoutText(items: PdfTextItem[], options: RebuildOptions = {}): string {
  const tolerance = options.rowTolerance ?? DEFAULT_ROW_TOLERANCE;
  const maxPad = options.maxPad ?? DEFAULT_MAX_PAD;

  const cells = items
    .filter((it) => typeof it.str === 'string' && it.str.trim().length > 0)
    .map((it) => ({ ...it, str: it.str.trim() }));

  if (cells.length === 0) return '';

  const charWidth = estimateCharWidth(cells);

  // 按 y 从大到小（页面上到下）聚行；同一行内稍后按 x 排
  const rows: Array<{ y: number; cells: PdfTextItem[] }> = [];
  for (const cell of [...cells].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - cell.y) <= tolerance);
    if (row) {
      row.cells.push(cell);
      row.y = Math.max(row.y, cell.y);
    } else {
      rows.push({ y: cell.y, cells: [cell] });
    }
  }

  return rows.map((row) => renderRow(row.cells, charWidth, maxPad)).join('\n');
}

/** 统计汉字个数（含扩展 A 区与兼容区） */
export function countCjk(text: string): number {
  const matched = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  return matched ? matched.length : 0;
}

export interface TextLayerAssessment {
  usable: boolean;
  chars: number;
  cjk: number;
  /** 给人看的原因，会写进 notes 让用户知道为什么走了图像识别 */
  reason: string;
}

/**
 * 判断文本层是否**真的可用**。
 *
 * ★ 判据为什么是"汉字个数"而不是"字符长度"：
 *   火车票那张 PDF 的文本层有 185 个字符，长度早就过了 40 的门槛，
 *   但里面**一个汉字都没有** —— PDF 用了自定义字形编码且缺 ToUnicode
 *   映射表，中文全部丢失，只剩下
 *     `12306 95306 / :26119121152002953432 / Beijingxi / C2729 / :41.00`
 *   这种碎片。模型拿到碎片只能把字段全部留空，然后报"票面信息不完整"，
 *   用户看到的是**假阴性**：票明明是好的，系统说识别不出来。
 *
 *   中文票据的文本层只要可用，汉字一定很多（住宿发票那张是 143 个）。
 *   所以"汉字数"是一个又便宜又可靠的判据。判错时偏向图像识别，
 *   最多多花一次调用；判错成文本层则会静默丢掉全部字段。
 */
export function assessTextLayer(text: string | null | undefined): TextLayerAssessment {
  const raw = (text ?? '').trim();
  const chars = raw.length;
  const cjk = countCjk(raw);

  if (chars < MIN_TEXT_LAYER_CHARS) {
    return {
      usable: false,
      chars,
      cjk,
      reason: `文本层只有 ${chars} 个字符，内容不足以抽取字段`,
    };
  }

  if (cjk < MIN_TEXT_LAYER_CJK) {
    return {
      usable: false,
      chars,
      cjk,
      reason:
        `文本层有 ${chars} 个字符但只有 ${cjk} 个汉字 —— 中文基本丢失，` +
        '这类 PDF 缺 ToUnicode 映射表，剩下的是数字与拼音碎片',
    };
  }

  return { usable: true, chars, cjk, reason: `文本层可用（${chars} 字符，含 ${cjk} 个汉字）` };
}

// ============================================================================
//  内部
// ============================================================================

/**
 * 用字号中位数估算字符宽度。
 *
 * 关键性质：把 x 线性映射到列号**不改变相对位置**，所以估算值不需要很准，
 * 只要别小到让相邻单元格互相压上即可（见 MIN_CHAR_WIDTH 的说明）。
 */
function estimateCharWidth(cells: PdfTextItem[]): number {
  const heights = cells
    .map((c) => c.height ?? 0)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);

  if (heights.length === 0) return FALLBACK_CHAR_WIDTH;

  const median = heights[Math.floor(heights.length / 2)] ?? FALLBACK_CHAR_WIDTH;
  return Math.min(MAX_CHAR_WIDTH, Math.max(MIN_CHAR_WIDTH, median));
}

function renderRow(cells: PdfTextItem[], charWidth: number, maxPad: number): string {
  let line = '';

  for (const cell of [...cells].sort((a, b) => a.x - b.x)) {
    const column = Math.min(maxPad, Math.max(0, Math.round(cell.x / charWidth)));

    if (column >= line.length) {
      line += ' '.repeat(column - line.length);
    } else {
      // 位置已被上一个单元格占满（宽度估算偏小），至少隔开一格，
      // 避免两个字直接粘成一个词 —— 粘起来比错位更难排查。
      line += ' ';
    }

    line += cell.str;
  }

  return line.replace(/\s+$/, '');
}
