/**
 * 报表类表格读取（Excel / CSV）
 * ============================================================
 * 为什么不复用 history/sheet-parser：
 *
 *   那个解析器是为**发票明细**设计的 —— 它靠"发票/日期/金额/税额"等关键词
 *   去猜表头在哪一行。而资产负债表/利润表的列名是
 *   「项目 / 行次 / 期末余额 / 年初余额」，一个关键词都不命中，
 *   于是它会认不出表头，把报表读成一张空表。
 *
 * 报表读取的原则与发票明细正相反：
 *
 *   发票明细：要"规整" —— 必须找到表头、丢掉合计行、按列映射。
 *   报表：   要"原样" —— 报表本身就是一张带层级的网格，
 *            标题行（"资产负债表"）、单位行（"单位：元"）、
 *            缩进的项目名、空行分隔的小计块，全都是有意义的结构。
 *            任何"聪明"的清洗都会破坏它。
 *
 * 所以这里只做两件事：
 *   ① 把网格拍平成「单元格用 | 分隔」的文本行，保留空行作为块分隔；
 *   ② 裁掉完全空白的行尾列，避免输出一大堆空格。
 */
import ExcelJS from 'exceljs';

export interface RawSheetGrid {
  /** 工作表名（CSV 为文件名） */
  sheetName: string;
  /** 所有工作表名，便于提示"读的是哪一张" */
  sheetNames: string[];
  /** 网格：每行是单元格文本数组（已按内容裁掉行尾空列） */
  grid: string[][];
  /** 非空行数 */
  nonEmptyRows: number;
  warnings: string[];
}

/** 报表读取：不做表头探测，原样保留 */
export async function readReportGrid(
  buffer: Buffer,
  fileName: string,
): Promise<RawSheetGrid> {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(fileName.trim())?.[1] ?? '').toLowerCase();

  if (ext === 'csv' || ext === 'txt') {
    return readCsvGrid(buffer.toString('utf8'), fileName);
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (e) {
    throw new Error(
      `无法打开 Excel 文件「${fileName}」：${e instanceof Error ? e.message : String(e)}。` +
        `请确认是 .xlsx 格式（老的 .xls 请另存为 .xlsx 后重试）。`,
    );
  }

  const sheetNames = wb.worksheets.map((w) => w.name);
  const warnings: string[] = [];
  if (wb.worksheets.length === 0) {
    throw new Error(`Excel 文件「${fileName}」里没有任何工作表。`);
  }

  // 选"内容最多"的那张表：报表文件常带封面页、说明页
  let best: { name: string; grid: string[][]; nonEmpty: number } | null = null;
  for (const ws of wb.worksheets) {
    const grid = gridOf(ws);
    const nonEmpty = grid.filter((r) => r.some((c) => c.trim() !== '')).length;
    if (!best || nonEmpty > best.nonEmpty) {
      best = { name: ws.name, grid, nonEmpty };
    }
  }

  if (!best || best.nonEmpty === 0) {
    throw new Error(`Excel 文件「${fileName}」里所有工作表都是空的。`);
  }

  if (sheetNames.length > 1) {
    warnings.push(
      `文件含 ${sheetNames.length} 张工作表（${sheetNames.join('、')}），` +
        `已读取内容最多的「${best.name}」。若读错了表，请把目标表单独另存为文件后重传。`,
    );
  }

  // 去掉末尾连续空行
  const grid = trimTrailingEmptyRows(best.grid);

  return {
    sheetName: best.name,
    sheetNames,
    grid,
    nonEmptyRows: best.nonEmpty,
    warnings,
  };
}

// ============================================================================
//  内部
// ============================================================================

function gridOf(ws: ExcelJS.Worksheet): string[][] {
  const out: string[][] = [];
  const rowCount = ws.rowCount;
  const colCount = Math.max(ws.columnCount, 1);

  for (let r = 1; r <= rowCount; r += 1) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= colCount; c += 1) {
      cells.push(cellText(row.getCell(c)));
    }
    out.push(trimTrailingEmpty(cells));
  }
  return out;
}

/**
 * 单元格文本。
 *
 * 金额一律取"显示值"的原始数字串（不走 Excel 的格式化）：
 * 报表里的数字如果在 Excel 里显示成 "1,238,400.00"，我们要的是 1238400，
 * 千分位与货币符号由后续金额解析层统一处理，这里不擅自改动数值本身。
 */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';

  // 富文本
  if (typeof v === 'object' && 'richText' in v && Array.isArray(v.richText)) {
    return v.richText.map((t) => t.text ?? '').join('').trim();
  }
  // 公式：取缓存结果（报表里合计行常是公式）
  if (typeof v === 'object' && 'result' in v) {
    const r = (v as { result?: unknown }).result;
    return r === null || r === undefined ? '' : String(r).trim();
  }
  // 超链接
  if (typeof v === 'object' && 'text' in v && typeof (v as { text?: unknown }).text === 'string') {
    return ((v as { text: string }).text ?? '').trim();
  }
  // 日期
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(
      v.getUTCDate(),
    ).padStart(2, '0')}`;
  }
  if (typeof v === 'number') {
    // 避免 1e+21 这类科学计数法混进报表文本
    return Number.isFinite(v) ? String(v) : '';
  }
  return String(v).trim();
}

function trimTrailingEmpty(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && (cells[end - 1] ?? '').trim() === '') end -= 1;
  return cells.slice(0, end);
}

function trimTrailingEmptyRows(grid: string[][]): string[][] {
  let end = grid.length;
  while (end > 0 && (grid[end - 1] ?? []).every((c) => c.trim() === '')) end -= 1;
  return grid.slice(0, end);
}

/**
 * CSV 读取。
 *
 * 手写而不是用 exceljs：CSV 只有"引号转义"这一条规则，
 * 手写 30 行就能覆盖，还能顺便处理 BOM、CRLF 与制表符分隔。
 */
function readCsvGrid(text: string, fileName: string): RawSheetGrid {
  const warnings: string[] = [];
  const cleaned = text.replace(/^\uFEFF/, '');

  // ★ 不能只看第一行：税局导出的第一行往往是标题（"增值税纳税申报表…"），
  //   里面一个分隔符都没有，只看首行会误判成逗号，把整张表读成单列。
  const { delimiter, scores } = detectDelimiter(cleaned);
  if (delimiter !== ',') {
    warnings.push(
      `检测到分隔符为「${delimiter === '\t' ? '制表符' : delimiter}」，已按该分隔符解析。`,
    );
  }
  if (scores[delimiter] <= 0) {
    warnings.push('文件中没有找到明显的分隔符，可能只有一列数据；请确认导出格式。');
  }

  const rows = parseDelimited(cleaned, delimiter);
  const grid = trimTrailingEmptyRows(rows.map(trimTrailingEmpty));
  const nonEmpty = grid.filter((r) => r.some((c) => c.trim() !== '')).length;

  if (nonEmpty === 0) {
    throw new Error(`CSV 文件「${fileName}」里没有可读内容（是否为空文件或编码不是 UTF-8？）。`);
  }

  return {
    sheetName: fileName,
    sheetNames: [fileName],
    grid,
    nonEmptyRows: nonEmpty,
    warnings,
  };
}

/**
 * 探测分隔符。
 *
 * 判据不是"出现了几次"，而是"能否切出稳定的列数"：
 * 一个真正的分隔符会让绝大多数行切成同样的列数；
 * 而正文里偶然出现的逗号只会切出乱七八糟的列数。
 * 所以对每个候选分隔符，取"出现最多的列数"所占的比例作为得分。
 */
function detectDelimiter(text: string): { delimiter: string; scores: Record<string, number> } {
  const candidates = ['\t', ',', ';', '|'];
  // 只看前 60 行就够判断了，也避免大文件上做无谓的全量解析
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 60);

  const scores: Record<string, number> = {};
  let best = ',';
  let bestScore = -1;

  for (const d of candidates) {
    const counts = lines.map((l) => l.split(d).length);
    const withSep = counts.filter((c) => c > 1);
    if (withSep.length === 0) {
      scores[d] = 0;
      continue;
    }
    const tally = new Map<number, number>();
    for (const c of withSep) tally.set(c, (tally.get(c) ?? 0) + 1);
    const mode = Math.max(...tally.values());
    // 得分 = 主流列数的占比 × 该列数本身，列数越多越可能是真分隔符
    const modeColumns = [...tally.entries()].find(([, v]) => v === mode)?.[0] ?? 1;
    const score = (mode / lines.length) * (modeColumns - 1);
    scores[d] = Number(score.toFixed(4));
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }

  return { delimiter: best, scores };
}

/** RFC4180 风格的引号转义解析 */
/** 去掉字段两端空白与 BOM / 零宽字符（某些导出工具会把 BOM 写进单元格） */
function cleanField(v: string): string {
  return v.replace(/^[\uFEFF\u200B]+/, '').trim();
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cleanField(field));
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // 交给 \n 处理
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(cleanField(field));
    rows.push(row);
  }

  return rows;
}

/** 网格 → 给模型看的文本（保留空行作为块分隔） */
export function gridToText(grid: RawSheetGrid, maxRows = 500): string {
  const lines: string[] = [];
  lines.push(`# 工作表：${grid.sheetName}`);
  lines.push(`# 共 ${grid.nonEmptyRows} 个非空行，下列为原始网格（单元格以 | 分隔，空行已保留）`);
  lines.push('');

  const limit = Math.min(grid.grid.length, maxRows);
  for (let i = 0; i < limit; i += 1) {
    const row = grid.grid[i]!;
    if (row.length === 0) {
      lines.push('');
      continue;
    }
    lines.push(row.join(' | '));
  }
  if (grid.grid.length > limit) {
    lines.push('');
    lines.push(`（仅列出前 ${limit} 行，共 ${grid.grid.length} 行）`);
  }

  if (grid.warnings.length > 0) {
    lines.push('');
    lines.push('# 解析提示');
    for (const w of grid.warnings) lines.push(`- ${w}`);
  }

  return lines.join('\n');
}
