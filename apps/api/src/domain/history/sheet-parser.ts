/**
 * 表格解析（Excel / CSV）
 * ============================================================
 * 历史数据通常来自：税局导出、开票软件导出、代账公司发的 Excel。
 * 格式五花八门，所以解析层要够"耐操"：
 *   · 自动跳过标题行（很多导出文件前几行是"XX公司2024年销项发票明细"）
 *   · 自动定位真正的表头行（含"发票"/"日期"/"金额"等关键词最多的那一行）
 *   · 单位行、合计行要丢弃（否则会把"合计"当成一张发票）
 *   · 全空列、全空行丢弃
 */
import ExcelJS from 'exceljs';

export interface ParsedSheet {
  /** 识别出的表头行（第几行，1-based） */
  headerRowIndex: number;
  headers: string[];
  /** 数据行：以表头为 key */
  rows: Array<Record<string, unknown>>;
  /** 被丢弃的行数（空行、合计行等） */
  skippedRows: number;
  warnings: string[];
}

/** 表头候选关键词 —— 用来定位表头行 */
const HEADER_KEYWORDS = [
  '发票',
  '日期',
  '金额',
  '税额',
  '税率',
  '价税',
  '名称',
  '税号',
  '销售方',
  '购买方',
  '销方',
  '购方',
  '品名',
  '货物',
  '期间',
  '销售额',
  '销项',
  '进项',
  '认证',
];

/** 合计行特征 —— 必须丢弃，否则会被当成一张发票 */
const TOTAL_ROW_PATTERNS = [/^合计/, /^总计/, /^小计/, /^合\s*计/, /^总\s*计/, /^累计/];

/**
 * 解析一个工作表。
 */
export function parseSheet(worksheet: ExcelJS.Worksheet): ParsedSheet {
  const warnings: string[] = [];
  const rawRows: unknown[][] = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values: unknown[] = [];
    // ExcelJS 的 row.values 是 1-based 数组，第 0 项为 undefined
    const vals = row.values as unknown[];
    for (let c = 1; c < vals.length; c += 1) {
      values.push(normalizeCell(vals[c]));
    }
    rawRows.push(values);
  });

  if (rawRows.length === 0) {
    return { headerRowIndex: 0, headers: [], rows: [], skippedRows: 0, warnings: ['工作表为空'] };
  }

  // ---- 定位表头行：关键词命中最多的那一行（只看前 15 行）----
  let headerRowIndex = 0;
  let bestScore = -1;
  const scanLimit = Math.min(15, rawRows.length);

  for (let i = 0; i < scanLimit; i += 1) {
    const row = rawRows[i] ?? [];
    const nonEmpty = row.filter((c) => c !== null && c !== undefined && String(c).trim() !== '');
    if (nonEmpty.length < 3) continue; // 表头至少要有 3 列

    const joined = nonEmpty.map((c) => String(c)).join('|');
    let score = 0;
    for (const kw of HEADER_KEYWORDS) {
      if (joined.includes(kw)) score += 1;
    }
    // 表头行一般不含长数字（金额/号码通常不在表头）
    const hasLongNumber = nonEmpty.some((c) => /^\d{6,}$/.test(String(c).trim()));
    if (hasLongNumber) score -= 2;

    if (score > bestScore) {
      bestScore = score;
      headerRowIndex = i;
    }
  }

  if (bestScore <= 0) {
    warnings.push('未能可靠识别表头行，默认使用第一行。请在映射界面核对列名。');
    headerRowIndex = 0;
  } else if (headerRowIndex > 0) {
    warnings.push(`自动跳过前 ${headerRowIndex} 行说明性内容，表头为第 ${headerRowIndex + 1} 行。`);
  }

  const headerRaw = rawRows[headerRowIndex] ?? [];
  const headers = headerRaw.map((h, i) => {
    const s = h === null || h === undefined ? '' : String(h).trim();
    return s === '' ? `列${i + 1}` : s;
  });

  // ---- 提取数据行 ----
  const rows: Array<Record<string, unknown>> = [];
  let skippedRows = 0;

  for (let i = headerRowIndex + 1; i < rawRows.length; i += 1) {
    const row = rawRows[i] ?? [];
    const nonEmpty = row.filter((c) => c !== null && c !== undefined && String(c).trim() !== '');

    // 全空行
    if (nonEmpty.length === 0) {
      skippedRows += 1;
      continue;
    }

    // 合计行 / 小计行
    const firstCell = String(row[0] ?? '').trim();
    if (TOTAL_ROW_PATTERNS.some((p) => p.test(firstCell))) {
      skippedRows += 1;
      continue;
    }
    // 合计行也可能出现在其他列（如第一列是空，第二列写"合计"）
    const rowText = nonEmpty.map((c) => String(c)).join('');
    if (TOTAL_ROW_PATTERNS.some((p) => p.test(rowText))) {
      skippedRows += 1;
      continue;
    }

    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      if (h.startsWith('列') && /^列\d+$/.test(h)) return; // 无名列不导出
      obj[h] = row[idx] ?? null;
    });
    rows.push(obj);
  }

  return { headerRowIndex, headers, rows, skippedRows, warnings };
}

/** 归一化单元格值：日期转 ISO 日期串，富文本取文本，公式取结果 */
function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    // 统一为 UTC 日期，避免时区偏移导致跨日
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()))
      .toISOString()
      .slice(0, 10);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // 富文本
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
    }
    // 公式单元格
    if ('result' in obj) return normalizeCell(obj.result);
    // 超链接
    if ('text' in obj) return String(obj.text);
    return String(value);
  }

  if (typeof value === 'string') {
    // ★ 中文全角空格也要去掉，否则金额解析会失败
    return value.replace(/\u3000/g, ' ').trim();
  }

  return value;
}

/** 解析 CSV 文本为工作表形式 */
export function parseCsv(text: string): ParsedSheet {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    return { headerRowIndex: 0, headers: [], rows: [], skippedRows: 0, warnings: ['文件为空'] };
  }

  // 简易 CSV 解析：支持双引号包裹与转义的双引号
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else {
            inQuote = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ',' || ch === '\t') {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const rawRows = lines.map(parseLine);
  const fakeSheet = {
    eachRow: (opts: { includeEmpty: boolean }, cb: (row: { values: unknown[] }) => void) => {
      rawRows.forEach((r) => {
        void opts;
        cb({ values: [undefined, ...r] });
      });
    },
  } as unknown as ExcelJS.Worksheet;

  return parseSheet(fakeSheet);
}

/** 从 Buffer 解析（按扩展名判断 xlsx / csv） */
export async function parseBuffer(buffer: Buffer, fileName: string): Promise<ParsedSheet & { sheetName: string }> {
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    // 尝试 UTF-8；若出现大量替换字符说明可能是 GBK（很多税局导出是 GBK）。
    //
    // ★ GBK 解码依赖可选的 iconv-lite：它是可选依赖，未安装时不能静默返回乱码 ——
    //   乱码流进账务数据比报错严重得多。所以这里明确告知用户转换方式。
    let text = buffer.toString('utf8');
    const warnings: string[] = [];
    const replacementCount = (text.match(/\uFFFD/g) ?? []).length;
    const looksGarbled = replacementCount > text.length * 0.01;

    if (looksGarbled) {
      const decoded = await tryDecodeGbk(buffer);
      if (decoded !== null) {
        text = decoded;
        warnings.push('检测到文件为 GBK 编码，已自动转换。');
      } else {
        warnings.push(
          '⚠️ 文件疑似 GBK/ANSI 编码（中文出现乱码），但未安装 GBK 解码组件。' +
            '请用 Excel 打开后「另存为 → CSV UTF-8」再重新上传，' +
            '或在 apps/api 目录执行 pnpm add iconv-lite 以启用自动转换。' +
            '切勿直接导入乱码数据。',
        );
      }
    }

    return { ...parseCsv(text), sheetName: '(csv)', warnings };
  }

  const workbook = new ExcelJS.Workbook();
  // ExcelJS 的 load 接受 Buffer，但类型签名要 ArrayBuffer
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return { headerRowIndex: 0, headers: [], rows: [], skippedRows: 0, warnings: ['工作簿中没有工作表'], sheetName: '' };
  }

  return { ...parseSheet(sheet), sheetName: sheet.name };
}


/**
 * 尝试用 GBK 解码。
 * iconv-lite 是**可选依赖**：通过 createRequire 在运行时按需加载，
 * 这样未安装时不会导致编译失败，只是降级为"提示用户自行转码"。
 */
async function tryDecodeGbk(buffer: Buffer): Promise<string | null> {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(__filename);
    const iconv = require('iconv-lite') as { decode: (b: Buffer, enc: string) => string };
    const decoded = iconv.decode(buffer, 'gbk');
    // 解码后若仍然大量乱码，说明不是 GBK，返回 null 让调用方给提示
    const bad = (decoded.match(/\uFFFD/g) ?? []).length;
    return bad > decoded.length * 0.01 ? null : decoded;
  } catch {
    return null;
  }
}