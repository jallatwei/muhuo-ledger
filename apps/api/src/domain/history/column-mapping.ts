/**
 * 表头映射引擎
 * ============================================================
 * 现实问题：从哪里导出的发票明细，列名都不一样：
 *   "开票日期" / "开票时间" / "发票日期" / "日期"
 *   "价税合计" / "含税金额" / "总金额" / "价税合计金额"
 *   "销方名称" / "销售方" / "销方单位" / "对方单位名称"
 *   "税额" / "税金" / "增值税额"
 *
 * 本引擎做两级匹配：
 *   ① 内置别名词典（覆盖主流开票软件与税局导出格式）—— 快、准、零成本
 *   ② 词典未命中时交给 AI —— 处理长尾与奇怪的自定义列名
 *
 * ★ 但**金额与日期字段一律不允许仅靠 AI 猜测**：
 *   AI 给出的映射会带 confidence，低于阈值的必须由人工在界面上确认。
 *   因为列映射错了会导致全部数据错位，是灾难性的。
 */
import { Decimal } from '@bookkeeper/shared';

export type InvoiceField =
  | 'invoiceCode'
  | 'invoiceNumber'
  | 'invoiceDate'
  | 'counterpartyName'
  | 'counterpartyTaxNo'
  | 'amountExclTax'
  | 'taxRate'
  | 'taxAmount'
  | 'amountInclTax'
  | 'isCertified'
  | 'isRedFlushed'
  | 'itemSummary';

export interface FieldMapping {
  /** 源表头 */
  source: string;
  /** 目标字段 */
  target: InvoiceField | 'IGNORE';
  confidence: number;
  /** 匹配依据，展示给用户看 */
  reason: string;
  /** 是否必须人工确认（金额/日期等关键字段且置信度不高时） */
  needsConfirm: boolean;
}

export interface MappingResult {
  mappings: FieldMapping[];
  /** 必填字段是否都已映射 */
  complete: boolean;
  missingRequired: InvoiceField[];
  /** 多列争夺同一字段的歧义清单（必须人工确认） */
  ambiguous: Array<{ field: InvoiceField; sources: string[] }>;
  warnings: string[];
}

// ---------------------------------------------------------------- 别名词典
//
// 说明：这里刻意"宁多勿少" —— 多写几个别名成本极低，
// 而少写一个就会导致用户要手工映射，体验落差很大。
const FIELD_ALIASES: Record<InvoiceField, string[]> = {
  invoiceCode: ['发票代码', '代码', '票种代码', 'invoicecode', '发票代码(12位)', '发票代码（12位）'],
  invoiceNumber: ['发票号码', '号码', '票号', '发票号', 'invoicenumber', '数电票号码', '全电发票号码'],
  invoiceDate: [
    '开票日期',
    '开票时间',
    '发票日期',
    '日期',
    '开票日',
    'invoicedate',
    '业务日期',
    '记账日期',
    '所属期',
  ],
  counterpartyName: [
    '销方名称',
    '销售方名称',
    '销售方',
    '销方单位',
    '购方名称',
    '购买方名称',
    '购买方',
    '购方单位',
    '对方单位名称',
    '对方名称',
    '单位名称',
    '客户名称',
    '供应商名称',
    '往来单位',
    '公司名称',
  ],
  counterpartyTaxNo: [
    '销方税号',
    '销售方税号',
    '销方纳税人识别号',
    '购方税号',
    '购买方税号',
    '纳税人识别号',
    '统一社会信用代码',
    '税号',
    '对方税号',
  ],
  amountExclTax: [
    '金额',
    '不含税金额',
    '金额(不含税)',
    '金额（不含税）',
    '不含税价',
    '销售额',
    '合计金额',
    '货款金额',
    'amount',
    '净额',
  ],
  taxRate: ['税率', '税率/征收率', '征收率', 'taxrate', '税率(%)', '税率（%）'],
  taxAmount: ['税额', '税金', '增值税额', '增值税', '税额合计', 'tax', 'taxamount'],
  amountInclTax: [
    '价税合计',
    '含税金额',
    '总金额',
    '价税合计金额',
    '价税合计(含税)',
    '价税合计（含税）',
    '合计',
    '含税价',
    '实际金额',
    '应收金额',
    '应付金额',
  ],
  isCertified: [
    '是否认证',
    '认证状态',
    '勾选状态',
    '是否勾选',
    '抵扣状态',
    '是否抵扣',
    '认证月份',
    '勾选月份',
    '用途确认状态',
  ],
  isRedFlushed: ['红冲标志', '是否红冲', '红字发票', '发票状态', '是否作废', '作废标志'],
  itemSummary: ['货物或应税劳务名称', '货物名称', '商品名称', '品名', '项目名称', '货物或服务名称', '经营项目'],
};

/**
 * 归一化表头。
 *
 * ★ 处理的顺序很关键：
 *   1. 括号内容**替换为空格**而不是直接删除 ——
 *      如果直接删掉，「含税金额(元)」会变成「含税金额元」，
 *      单位「元」就贴在了词尾，后面的去单位逻辑反而失效。
 *      替换为空格后再压缩空白，才能让「含税金额(元)」正确归一到「含税金额」。
 *   2. 全角括号也要处理（中文财务软件常用全角）。
 *   3. 全角字母数字转半角、去冒号、转小写。
 */
function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .replace(/[（(][^）)]*[）)]/g, ' ') // 括号内容 → 空格（保留词边界）
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：:]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 去掉金额单位后缀，便于匹配 */
function stripUnitSuffix(s: string): string {
  return s.replace(/(元|人民币|rmb|cny|￥|¥)$/i, '');
}

/**
 * 纯规则匹配（不调用 AI）。
 *
 * 匹配优先级：
 *   1. 完全相等
 *   2. 去掉单位后缀后相等
 *   3. 表头包含别名 或 别名包含表头（后者更弱，给较低置信度）
 */
export function matchByRules(headers: string[]): MappingResult {
  const used = new Set<InvoiceField>();
  const mappings: FieldMapping[] = [];

  // ★ 两阶段匹配，顺序很重要：
  //
  //   第一轮：**先只判定精确匹配，不立刻占用字段**。
  //     如果边匹配边占用会出大问题：例如表头同时有「价税合计」和「含税金额」，
  //     「价税合计」先占了 amountInclTax，「含税金额」就只能落到
  //     amountExclTax（不含税金额）上 —— 金额列错位会让整批数据不可信。
  //
  //   第二轮：再把「精确匹配已占用的字段」排除出去，对剩余列做模糊匹配。
  //     这样「含税金额」能拿到本该属于它的 amountInclTax。
  // 第一轮：找出所有精确匹配的候选 (表头, 字段, 命中别名长度)
  interface Candidate {
    header: string;
    field: InvoiceField;
    aliasLen: number;
    headerIndex: number;
  }
  const candidates: Candidate[] = [];

  headers.forEach((header, headerIndex) => {
    const norm = stripUnitSuffix(normalizeHeader(header));
    if (norm.length === 0) return;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[InvoiceField, string[]]>) {
      for (const alias of aliases) {
        const a = stripUnitSuffix(normalizeHeader(alias));
        if (a === norm) {
          candidates.push({ header, field, aliasLen: a.length, headerIndex });
        }
      }
    }
  });

  // ★ 记录「哪些列曾声称属于同一字段」—— 必须在贪心消解**之前**统计。
  //   消解之后每个字段只剩一列，冲突信息就丢失了，而那正是最需要人看的部分。
  const fieldClaimants = new Map<InvoiceField, string[]>();
  for (const c of candidates) {
    const arr = fieldClaimants.get(c.field) ?? [];
    if (!arr.includes(c.header)) arr.push(c.header);
    fieldClaimants.set(c.field, arr);
  }
  const ambiguous: Array<{ field: InvoiceField; sources: string[] }> = [];
  for (const [field, srcs] of fieldClaimants) {
    // 去重后再判断（同一列可能命中同一字段的多个等长别名）
    const uniq = [...new Set(srcs)];
    if (uniq.length > 1) ambiguous.push({ field, sources: uniq });
  }
  // ★ 冲突消解：按「命中别名长度」降序贪心分配。
  //
  //   为什么不能先到先得：
  //     「价税合计」和「含税金额」都是 amountInclTax 的精确别名。
  //     若按列顺序先到先得，且表头里两列同时存在，
  //     后出现的那一列就会掉到模糊匹配，被短别名「金额」抢到
  //     amountExclTax（不含税金额）上 —— **金额列错位**，整批数据不可信。
  //
  //   按别名长度分配更合理：别名越长越具体。
  //     「含税金额」(4 字) 命中 4 字的别名 → 长度 4，优先拿到 amountInclTax；
  //     「价税合计」(4 字) 同样长度，但它会去匹配自己的别名，
  //     最终两列各得其所。长度相同时按列顺序，保证结果稳定可复现。
  candidates.sort((a, b) => b.aliasLen - a.aliasLen || a.headerIndex - b.headerIndex);

  const exactHits = new Map<string, InvoiceField>();
  const headerClaimed = new Set<string>();
  for (const c of candidates) {
    if (headerClaimed.has(c.header)) continue; // 该列已被更具体的别名分配
    if (used.has(c.field)) continue; // 该字段已被占用
    exactHits.set(c.header, c.field);
    headerClaimed.add(c.header);
    used.add(c.field);
  }
  // 第二轮：对未精确命中的做包含匹配
  for (const header of headers) {
    const exact = exactHits.get(header);
    if (exact) {
      mappings.push({
        source: header,
        target: exact,
        confidence: 1.0,
        reason: `表头与标准字段「${exact}」精确匹配`,
        needsConfirm: false,
      });
      continue;
    }

    const norm = stripUnitSuffix(normalizeHeader(header));
    let best: { field: InvoiceField; score: number; via: string } | null = null;

    for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[InvoiceField, string[]]>) {
      if (used.has(field)) continue;
      for (const alias of aliases) {
        const a = stripUnitSuffix(normalizeHeader(alias));
        if (a.length < 2 || norm.length < 2) continue;

        if (norm.includes(a)) {
          // 表头包含别名（如 "销方名称（全称）" 包含 "销方名称"）
          // ★ 关键：命中长度越长越具体，必须优先。
          //   否则「含税金额」会被短别名「金额」抢先匹配到不含税金额上 ——
          //   这是最危险的一类错配：金额列错位会让整批数据不可信。
          //   得分 = 0.6 + 命中比例 * 0.3，命中越完整分越高。
          const score = 0.6 + (a.length / norm.length) * 0.3;
          if (!best || score > best.score) best = { field, score, via: alias };
        } else if (a.includes(norm)) {
          // 别名包含表头（如 "金额" 被 "不含税金额" 包含）——更弱
          const score = 0.4 + (norm.length / a.length) * 0.25;
          if (!best || score > best.score) best = { field, score, via: alias };
        }
      }
    }

    if (best) {
      used.add(best.field);
      mappings.push({
        source: header,
        target: best.field,
        confidence: best.score,
        reason: `表头「${header}」与别名「${best.via}」部分匹配 → ${best.field}`,
        needsConfirm: best.score < 0.8,
      });
    } else {
      mappings.push({
        source: header,
        target: 'IGNORE',
        confidence: 0,
        reason: '未能识别，默认忽略。如为必要字段请手动指定。',
        needsConfirm: false,
      });
    }
  }

  // 把涉歧义的列标记为需人工确认，并在理由里说明
  if (ambiguous.length > 0) {
    const contested = new Set(ambiguous.flatMap((a) => a.sources));
    for (const m of mappings) {
      if (m.target !== 'IGNORE' && contested.has(m.source)) {
        m.needsConfirm = true;
        if (!m.reason.includes('歧义')) m.reason += '（★ 该列与其他列存在字段归属歧义，请确认）';
      }
    }
  }
  return finalize(mappings, ambiguous);
}

/** 合并 AI 的补充映射（只填补规则未识别的列） */
export function mergeAiMappings(
  ruleResult: MappingResult,
  aiMappings: Array<{ source: string; target: string; confidence: number; reason?: string }>,
): MappingResult {
  const claimed = new Set<string>(
    ruleResult.mappings.filter((m) => m.target !== 'IGNORE').map((m) => m.target as string),
  );
  const validTargets = new Set<string>([...Object.keys(FIELD_ALIASES), 'IGNORE']);

  const merged = ruleResult.mappings.map((m) => ({ ...m }));

  for (const ai of aiMappings) {
    if (!validTargets.has(ai.target)) continue;
    const idx = merged.findIndex((m) => m.source === ai.source);
    if (idx < 0) continue;
    // 规则已识别的不覆盖 —— 词典比模型更可靠
    if (merged[idx]!.target !== 'IGNORE') continue;
    if (ai.target !== 'IGNORE' && claimed.has(ai.target)) continue;

    merged[idx] = {
      source: ai.source,
      target: ai.target as InvoiceField | 'IGNORE',
      confidence: Math.min(0.85, Math.max(0, ai.confidence)), // AI 映射置信度封顶 0.85
      reason: `AI 推断：${ai.reason ?? '根据列名语义判断'}`,
      needsConfirm: true, // ★ AI 推断的映射一律要人工确认
    };
    if (ai.target !== 'IGNORE') claimed.add(ai.target);
  }

  return finalize(merged, ruleResult.ambiguous);
}

/** 必填字段检查 */
const REQUIRED_FIELDS: InvoiceField[] = ['invoiceDate', 'counterpartyName', 'amountInclTax'];
/** 强烈建议字段（缺失会导致税额/不含税金额需要反算） */
const RECOMMENDED_FIELDS: InvoiceField[] = ['amountExclTax', 'taxAmount', 'taxRate', 'invoiceNumber'];

function finalize(
  mappings: FieldMapping[],
  ambiguous: Array<{ field: InvoiceField; sources: string[] }> = [],
): MappingResult {
  const mapped = new Set(mappings.filter((m) => m.target !== 'IGNORE').map((m) => m.target as InvoiceField));
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapped.has(f));
  const missingRecommended = RECOMMENDED_FIELDS.filter((f) => !mapped.has(f));

  const warnings: string[] = [];

  if (ambiguous.length > 0) {
    const desc = ambiguous
      .map((a) => `${fieldLabel(a.field)}（候选列：${a.sources.join(' / ')}）`)
      .join('；');
    warnings.push(
      `★ 检测到字段归属歧义：${desc}。` +
        `系统按列顺序做了初步分配，但**金额列错位会导致整批数据不可信**，请在下方逐项确认后再导入。`,
    );
  }
  if (missingRequired.length > 0) {
    warnings.push(
      `缺少必填字段映射：${missingRequired.map(fieldLabel).join('、')}。必须在界面上手动指定后才能导入。`,
    );
  }
  if (missingRecommended.length > 0) {
    warnings.push(
      `缺少建议字段：${missingRecommended.map(fieldLabel).join('、')}。` +
        `缺失的金额字段可由「价税合计 + 税率」反算，但会增加推算成分。`,
    );
  }

  const lowConfidence = mappings.filter((m) => m.target !== 'IGNORE' && m.confidence < 0.8);
  if (lowConfidence.length > 0) {
    warnings.push(`有 ${lowConfidence.length} 个字段的映射置信度偏低，请逐项确认。`);
  }

  return {
    mappings,
    complete: missingRequired.length === 0,
    missingRequired,
    ambiguous,
    warnings,
  };
}

export function fieldLabel(f: string): string {
  const labels: Record<string, string> = {
    invoiceCode: '发票代码',
    invoiceNumber: '发票号码',
    invoiceDate: '开票日期',
    counterpartyName: '对方单位名称',
    counterpartyTaxNo: '对方税号',
    amountExclTax: '不含税金额',
    taxRate: '税率',
    taxAmount: '税额',
    amountInclTax: '价税合计',
    isCertified: '认证/勾选状态',
    isRedFlushed: '红冲标志',
    itemSummary: '货物或服务名称',
    IGNORE: '（忽略）',
  };
  return labels[f] ?? f;
}

// ============================================================================
//  值解析
// ============================================================================

/** 解析金额：清理千分位、货币符号、括号负数、中文大写干扰 */
export function parseAmount(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (s === '' || s === '-' || s === '—') return null;

  // 括号表示负数：(1,234.56) → -1234.56
  // ★ 必须同时支持半角 () 与全角 （） —— 中文财务软件导出的负数常用全角括号
  const negative = /^[（(][\s\S]*[）)]$/.test(s) || s.startsWith('-');
  s = s.replace(/[()（）]/g, '').replace(/[¥￥$,\s]/g, '').replace(/元$/, '');
  if (s === '') return null;

  try {
    const d = new Decimal(s).abs();
    return negative ? d.negated() : d;
  } catch {
    return null;
  }
}

/** 解析日期：支持多种常见格式 */
export function parseDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  // Excel 序列号（1900 起算）
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 60000) {
      const epoch = Date.UTC(1899, 11, 30);
      return new Date(epoch + serial * 86400000);
    }
  }

  // 20240115 / 2024-01-15 / 2024/1/15 / 2024.01.15
  const m1 = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(s);
  if (m1) {
    return new Date(Date.UTC(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3])));
  }
  const m2 = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m2) {
    return new Date(Date.UTC(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3])));
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 解析税率：支持 "13%" / "0.13" / "13" / "免税" / "不征税" */
export function parseTaxRate(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (/免税|不征税|零税率|免征/.test(s)) return new Decimal(0);

  const hasPercent = s.includes('%');
  const cleaned = s.replace(/[%\s]/g, '');
  try {
    const d = new Decimal(cleaned);
    if (d.isZero()) return new Decimal(0);
    // 13 → 0.13；1.3 → 0.013 不合理，视为已是小数
    if (!hasPercent && d.gte(1) && d.lte(100)) return d.div(100);
    if (hasPercent) return d.div(100);
    return d;
  } catch {
    return null;
  }
}

/** 解析布尔：支持 "是/否"、"已认证/未认证"、"Y/N"、1/0 */
export function parseBoolean(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return null;

  if (/^(是|有|已认证|已勾选|已抵扣|认证|勾选|抵扣|y|yes|true|1|✓|√)$/.test(s)) return true;
  if (/^(否|无|未认证|未勾选|未抵扣|不抵扣|n|no|false|0|×|x)$/.test(s)) return false;
  // "已认证" / "未认证" 的宽松判断
  if (s.includes('未') || s.includes('否') || s.includes('不')) return false;
  if (s.includes('已') || s.includes('是')) return true;
  return null;
}
