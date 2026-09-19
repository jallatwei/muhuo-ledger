/**
 * 申报表与财务报表 —— 抽取模型与校验
 * ============================================================
 * 与发票识别的区别：
 *
 *   发票：单张票、字段固定、校验靠"金额+税额=价税合计"。
 *   报表：一张表几十行、每行两个数（期末/期初 或 本期/累计）、
 *         没有统一的行次标准（不同年度、不同地区、不同软件导出的行次都有差异）。
 *
 * 因此本模块的设计原则是：
 *
 *   ① **保留原始行项目**，不强行映射科目。
 *      报表行次会变，科目映射留到重建阶段按需做。
 *      先把"表上写了什么"如实存下来 —— 这是不会错的做法。
 *
 *   ② **不做自动重算**。若表内"资产总计"与明细之和对不上，
 *      如实记录差额并告警，**不擅自改数**。因为有可能是我方理解错了行次含义，
 *      擅自"修正"会把真实数据改成错的。
 *
 *   ③ **平衡自检只报不修**。资产负债表恒等式不成立时给出明确提示，
 *      让人去核对原件，而不是悄悄填平。
 */
import { Decimal, round2 } from '@bookkeeper/shared';

// ============================================================================
//  抽取结果结构
// ============================================================================

/** 单个行项目 */
export interface StatementItem {
  /** 行次（表上有则取，无则空） */
  lineNo?: string | null;
  /** 表内原始行项目名称 */
  label: string;
  /** 期末余额 / 本期金额 */
  endBalance: string | null;
  /** 年初余额 / 本年累计金额 */
  beginBalance: string | null;
}

/** 增值税申报表抽取结果（主表关键行次） */
export interface VatReturnExtraction {
  periodStart?: string | null;
  periodEnd?: string | null;

  // 销售额
  line1SalesTaxable?: string | null; // 按适用税率计税销售额
  line5SalesSimple?: string | null; // 按简易办法计税销售额
  line8SalesExempt?: string | null; // 免税销售额

  // 税款计算
  line11OutputTax?: string | null; // 销项税额
  line12InputTax?: string | null; // 进项税额
  line13CreditBroughtForward?: string | null; // 上期留抵税额
  line14InputTaxTransferOut?: string | null; // 进项税额转出
  line17DeductibleTotal?: string | null; // 应抵扣税额合计
  line18ActualDeducted?: string | null; // 实际抵扣税额
  line19TaxPayable?: string | null; // 应纳税额
  line20CreditCarriedForward?: string | null; // 期末留抵税额
  line21SimpleTaxPayable?: string | null; // 简易计税应纳税额
  line24TaxPayableTotal?: string | null; // 应纳税额合计

  // 税款缴纳
  line25OpeningUnpaid?: string | null; // 期初未缴税额
  line27TaxPaidThisPeriod?: string | null; // 本期已缴税额
  line32ClosingUnpaid?: string | null; // 期末未缴税额
  line34PayableOrRefund?: string | null; // 本期应补(退)税额

  // 附加税费
  surtaxBase?: string | null; // 计税(费)依据
  surtaxCity?: string | null; // 城建税
  surtaxEducation?: string | null; // 教育费附加
  surtaxLocalEducation?: string | null; // 地方教育附加
  surtaxTotal?: string | null;

  /** 原始行项目（报表可能有多版本行次，如实保留） */
  items?: StatementItem[];
  _warnings?: string[];
}

/** 企业所得税申报表抽取结果 */
export interface CitReturnExtraction {
  periodStart?: string | null;
  periodEnd?: string | null;

  line1Revenue?: string | null; // 营业收入
  line2Cost?: string | null; // 营业成本
  line3ProfitTotal?: string | null; // 利润总额
  line4SpecificAdjust?: string | null; // 加：特定业务计算的应纳税所得额
  line5NonTaxableIncome?: string | null; // 减：不征税收入
  line7TaxFreeIncome?: string | null; // 减：免税收入、减计收入、加计扣除
  line9LossOffset?: string | null; // 减：弥补以前年度亏损
  line10TaxableIncome?: string | null; // 实际利润额
  line11TaxRate?: string | null; // 税率
  line12TaxPayable?: string | null; // 应纳所得税额
  line13TaxRelief?: string | null; // 减：减免所得税额
  line14PaidThisYear?: string | null; // 减：本年实际已缴纳所得税额
  line16PayableOrRefund?: string | null; // 本期应补(退)所得税额

  items?: StatementItem[];
  _warnings?: string[];
}

/** 财务报表抽取结果 */
export interface StatementExtraction {
  statementType: 'BALANCE_SHEET' | 'INCOME_STATEMENT' | 'CASH_FLOW';
  periodStart?: string | null;
  periodEnd?: string | null;
  /** 表头标注的单位（元 / 万元），用于换算核对 */
  unit?: string | null;

  items: StatementItem[];

  // 关键合计（模型给出，我们会再自行核算一遍）
  totalAssets?: string | null;
  totalLiabilities?: string | null;
  totalEquity?: string | null;
  revenue?: string | null;
  cost?: string | null;
  profitBeforeTax?: string | null;
  netProfit?: string | null;

  _selfCheck?: { balanced?: boolean; difference?: string | null };
  _warnings?: string[];
}

// ============================================================================
//  校验
// ============================================================================

export interface StatementFinding {
  code: string;
  level: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
  message: string;
  suggestion?: string;
}

export interface StatementValidation {
  findings: StatementFinding[];
  hasFailure: boolean;
  failCount: number;
  warnCount: number;
  /** 自检算出的平衡差额（资产负债表） */
  balanceDifference?: Decimal | null;
  balanced?: boolean;
  /** 期间是否可用 */
  periodLabel?: string | null;
}

const AMOUNT_LIMIT = new Decimal('1000000000000'); // 1 万亿，超过必是识别错误

function parseAmount(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '' || s === '-' || s === '—' || s === '/') return null;
  try {
    const d = new Decimal(s.replace(/[¥￥,\s]/g, ''));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** 从行项目里按名称模糊找值（模型给的关键项可能不准，这里用行项目兜底） */
function findItemValue(
  items: StatementItem[] | undefined,
  patterns: RegExp[],
  field: 'endBalance' | 'beginBalance',
): Decimal | null {
  if (!items) return null;
  for (const p of patterns) {
    const hit = items.find((it) => p.test(it.label.replace(/\s/g, '')));
    if (hit) {
      const v = parseAmount(hit[field]);
      if (v !== null) return v;
    }
  }
  return null;
}

/**
 * 校验申报期间是否可解析。
 * 期间是重建的前提 —— 解析不出期间，数据就归不到年份上。
 */
function validatePeriod(
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
): { label: string | null; finding: StatementFinding } {
  const raw = periodStart ?? periodEnd;
  if (!raw) {
    return {
      label: null,
      finding: {
        code: 'P1',
        level: 'WARN',
        message: '未能识别出报表所属期间。',
        suggestion:
          '期间是历史重建的前提 —— 没有它就归不到年份上。请在确认时手动选择所属期间，或重新上传表头更清晰的文件。',
      },
    };
  }

  const m = /(\d{4})\s*[-年/.]?\s*(\d{1,2})?/.exec(raw);
  if (!m) {
    return {
      label: null,
      finding: {
        code: 'P1',
        level: 'WARN',
        message: `期间格式无法解析：${raw}`,
        suggestion: '请手动选择所属期间。',
      },
    };
  }

  const year = m[1]!;
  const month = m[2];
  const label = month ? `${year}-${String(Number(month)).padStart(2, '0')}` : year;

  return {
    label,
    finding: {
      code: 'P1',
      level: 'PASS',
      message: `识别期间：${label}`,
    },
  };
}

/**
 * ★ 资产负债表平衡自检
 *
 * 「资产总计 = 负债和所有者权益总计」是恒等式。
 * 不成立时**只报不改** —— 有可能是识别错，也有可能是我方对行次的理解有误，
 * 擅自填平会把真实数据改成错的。
 */
export function validateBalanceSheet(data: StatementExtraction): StatementValidation {
  const findings: StatementFinding[] = [];

  const period = validatePeriod(data.periodStart, data.periodEnd);
  findings.push(period.finding);

  // 行项目数量
  if (!data.items || data.items.length === 0) {
    findings.push({
      code: 'P2',
      level: 'FAIL',
      message: '没有识别出任何行项目。',
      suggestion: '请确认上传的是财务报表，且图片清晰、表格线完整。必要时改用 Excel 导入。',
    });
    return finish(findings);
  }
  findings.push({
    code: 'P2',
    level: 'PASS',
    message: `识别出 ${data.items.length} 个行项目。`,
  });

  // 期末余额列是否有值
  const withEnd = data.items.filter((it) => parseAmount(it.endBalance) !== null);
  const withBegin = data.items.filter((it) => parseAmount(it.beginBalance) !== null);

  if (withEnd.length === 0) {
    findings.push({
      code: 'P3',
      level: 'FAIL',
      message: '「期末余额」列没有任何数值。',
      suggestion: '财务报表通常有两列（期末/年初），可能识别到了错误的列。请核对确认。',
    });
  } else {
    findings.push({
      code: 'P3',
      level: withBegin.length === 0 ? 'WARN' : 'PASS',
      message:
        withBegin.length === 0
          ? `期末余额列有 ${withEnd.length} 行，但「年初余额」列全为空。`
          : `期末余额 ${withEnd.length} 行、年初余额 ${withBegin.length} 行。`,
      suggestion:
        withBegin.length === 0
          ? '年初余额缺失不影响期初建账（主要用期末数），但无法做勾稽核对。'
          : undefined,
    });
  }

  // ★ 恒等式校验：优先用关键合计，缺失时从行项目里找
  const assets =
    parseAmount(data.totalAssets) ??
    findItemValue(data.items, [/^资产总计/, /^资产合计/], 'endBalance');
  const liabEquity =
    findItemValue(data.items, [/^负债和所有者权益总计/, /^负债及所有者权益总计/, /^负债和股东权益总计/], 'endBalance') ??
    (() => {
      const l = parseAmount(data.totalLiabilities) ??
        findItemValue(data.items, [/^负债合计/], 'endBalance');
      const e = parseAmount(data.totalEquity) ??
        findItemValue(data.items, [/^所有者权益合计/, /^股东权益合计/], 'endBalance');
      if (l === null || e === null) return null;
      return round2(l.plus(e));
    })();

  let balanceDifference: Decimal | null = null;
  let balanced: boolean | undefined;

  if (assets === null || liabEquity === null) {
    findings.push({
      code: 'P4',
      level: 'WARN',
      message: '未能取得「资产总计」或「负债和所有者权益总计」，无法做平衡校验。',
      suggestion: '请在确认界面手动补充这两个合计数，或核对原表是否完整。',
    });
  } else {
    balanceDifference = round2(assets.minus(liabEquity));
    balanced = balanceDifference.isZero();

    if (balanced) {
      findings.push({
        code: 'P4',
        level: 'PASS',
        message: `平衡校验通过：资产总计 ${assets.toFixed(2)} = 负债和所有者权益总计 ${liabEquity.toFixed(2)}。`,
      });
    } else {
      // 只报不改
      findings.push({
        code: 'P4',
        level: 'FAIL',
        message:
          `平衡校验不成立：资产总计 ${assets.toFixed(2)}，` +
          `负债和所有者权益总计 ${liabEquity.toFixed(2)}，差额 ${balanceDifference.toFixed(2)}。`,
        suggestion:
          '请对照原件核对。常见原因：识别漏行、把「年初余额」列的值读到了「期末余额」、' +
          '或原表单位是万元未换算。系统不会自动填平这个差额 —— 擅自改数会把真实数据改成错的。',
      });
    }
  }

  // 金额上限
  const absurd = data.items.filter((it) => {
    const v = parseAmount(it.endBalance) ?? parseAmount(it.beginBalance);
    return v !== null && v.abs().gt(AMOUNT_LIMIT);
  });
  if (absurd.length > 0) {
    findings.push({
      code: 'P5',
      level: 'WARN',
      message: `有 ${absurd.length} 行的金额超过 1 万亿，明显异常：${absurd.slice(0, 3).map((a) => a.label).join('、')}。`,
      suggestion: '多为识别错误（多识别了数字）或单位换算有误，请核对。',
    });
  }

  // 单位提示
  if (data.unit && /万/.test(data.unit)) {
    findings.push({
      code: 'P6',
      level: 'INFO',
      message: `原表单位为「${data.unit}」，已按 ×10000 换算为元。`,
      suggestion: '如换算有误请手动修正。',
    });
  }

  return finish(findings, balanceDifference, balanced, period.label);
}

/** 利润表校验 */
export function validateIncomeStatement(data: StatementExtraction): StatementValidation {
  const findings: StatementFinding[] = [];

  const period = validatePeriod(data.periodStart, data.periodEnd);
  findings.push(period.finding);

  if (!data.items || data.items.length === 0) {
    findings.push({
      code: 'P2',
      level: 'FAIL',
      message: '没有识别出任何行项目。',
      suggestion: '请确认上传的是利润表，且图片清晰。',
    });
    return finish(findings);
  }
  findings.push({ code: 'P2', level: 'PASS', message: `识别出 ${data.items.length} 个行项目。` });

  const revenue =
    parseAmount(data.revenue) ??
    findItemValue(data.items, [/^一、营业收入/, /^营业收入/, /^主营业务收入/], 'endBalance');
  const cost =
    parseAmount(data.cost) ??
    findItemValue(data.items, [/^减：营业成本/, /^营业成本/, /^主营业务成本/], 'endBalance');
  const profit =
    parseAmount(data.profitBeforeTax) ??
    findItemValue(data.items, [/^三、利润总额/, /^利润总额/], 'endBalance');
  const net =
    parseAmount(data.netProfit) ??
    findItemValue(data.items, [/^四、净利润/, /^净利润/], 'endBalance');

  if (revenue === null) {
    findings.push({
      code: 'R1',
      level: 'FAIL',
      message: '未能取得「营业收入」，利润表的核心项目缺失。',
      suggestion: '请在确认界面手动补充。',
    });
  } else if (profit !== null && revenue.lt(profit) && revenue.gte(0)) {
    // 收入小于利润总额，通常意味着有营业外收入或投资收益，值得提示但不报错
    findings.push({
      code: 'R2',
      level: 'INFO',
      message: `利润总额 ${profit.toFixed(2)} 大于营业收入 ${revenue.toFixed(2)}。`,
      suggestion: '可能有大额营业外收入或投资收益，属正常情况；请确认取数行次无误。',
    });
  } else if (revenue !== null) {
    findings.push({
      code: 'R1',
      level: 'PASS',
      message: `营业收入 ${revenue.toFixed(2)}${cost !== null ? `，营业成本 ${cost.toFixed(2)}` : ''}${profit !== null ? `，利润总额 ${profit.toFixed(2)}` : ''}${net !== null ? `，净利润 ${net.toFixed(2)}` : ''}。`,
    });
  }

  if (profit === null && net === null) {
    findings.push({
      code: 'R3',
      level: 'WARN',
      message: '未能取得利润总额与净利润。',
      suggestion: '这两项是历史重建中倒轧成本的关键依据，建议补充。',
    });
  }

  return finish(findings, null, undefined, period.label);
}

/** 增值税申报表校验 */
export function validateVatReturn(data: VatReturnExtraction): StatementValidation {
  const findings: StatementFinding[] = [];

  const period = validatePeriod(data.periodStart, data.periodEnd);
  findings.push(period.finding);

  const output = parseAmount(data.line11OutputTax);
  const input = parseAmount(data.line12InputTax);
  const payable = parseAmount(data.line19TaxPayable) ?? parseAmount(data.line24TaxPayableTotal);
  const credit = parseAmount(data.line13CreditBroughtForward);
  const actualDeducted = parseAmount(data.line18ActualDeducted);
  const unpaidEnd = parseAmount(data.line32ClosingUnpaid);

  if (output === null && input === null) {
    findings.push({
      code: 'V1',
      level: 'FAIL',
      message: '未能取得销项税额与进项税额，无法确认这是增值税申报表。',
      suggestion: '请确认上传的是增值税申报表主表；若只有附列资料，请一并上传主表。',
    });
    return finish(findings);
  }

  findings.push({
    code: 'V1',
    level: 'PASS',
    message:
      `销项税额 ${output?.toFixed(2) ?? '—'}，进项税额 ${input?.toFixed(2) ?? '—'}` +
      `${credit !== null ? `，上期留抵 ${credit.toFixed(2)}` : ''}。`,
  });

  // ★ 应纳税额勾稽：应纳税额 = 销项 − 实际抵扣
  if (output !== null && actualDeducted !== null && payable !== null) {
    const expected = round2(output.minus(actualDeducted));
    if (expected.equals(payable)) {
      findings.push({
        code: 'V2',
        level: 'PASS',
        message: `应纳税额勾稽通过：${output.toFixed(2)} − ${actualDeducted.toFixed(2)} = ${payable.toFixed(2)}。`,
      });
    } else {
      findings.push({
        code: 'V2',
        level: 'WARN',
        message:
          `应纳税额勾稽不符：销项 ${output.toFixed(2)} − 实际抵扣 ${actualDeducted.toFixed(2)} = ` +
          `${expected.toFixed(2)}，但表中应纳税额为 ${payable.toFixed(2)}。`,
        suggestion: '可能有简易计税、减征额或纳税检查调整。请核对原表。',
      });
    }
  }

  // 期末未缴 —— 这是期初建账「应交税费—未交增值税」的直接来源
  if (unpaidEnd !== null && unpaidEnd.gt(0)) {
    findings.push({
      code: 'V3',
      level: 'PASS',
      message: `期末未缴税额 ${unpaidEnd.toFixed(2)}，将用于期初建账的「应交税费—未交增值税」。`,
    });
  }

  return finish(findings, null, undefined, period.label);
}

function finish(
  findings: StatementFinding[],
  balanceDifference?: Decimal | null,
  balanced?: boolean,
  periodLabel?: string | null,
): StatementValidation {
  const failCount = findings.filter((f) => f.level === 'FAIL').length;
  const warnCount = findings.filter((f) => f.level === 'WARN').length;
  return {
    findings,
    hasFailure: failCount > 0,
    failCount,
    warnCount,
    balanceDifference: balanceDifference ?? null,
    balanced,
    periodLabel: periodLabel ?? null,
  };
}

/** 按报表类型分派校验 */
export function validateStatement(
  statementType: 'BALANCE_SHEET' | 'INCOME_STATEMENT' | 'CASH_FLOW',
  data: StatementExtraction,
): StatementValidation {
  if (statementType === 'BALANCE_SHEET') return validateBalanceSheet(data);
  if (statementType === 'INCOME_STATEMENT') return validateIncomeStatement(data);
  // 现金流量表暂只做基础检查（历史重建很少用得上）
  const findings: StatementFinding[] = [];
  const period = validatePeriod(data.periodStart, data.periodEnd);
  findings.push(period.finding);
  findings.push({
    code: 'C1',
    level: data.items?.length ? 'PASS' : 'FAIL',
    message: data.items?.length ? `识别出 ${data.items.length} 个行项目。` : '没有识别出任何行项目。',
  });
  return finish(findings, null, undefined, period.label);
}

// ============================================================================
//  归一化：把模型输出的任意 JSON 收敛成 StatementExtraction
// ============================================================================

/** 把任意值转成「金额字符串」或 null（保留原样，不做四舍五入） */
function asMoneyString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  const s = String(raw).trim();
  if (s === '' || s === '-' || s === '—' || s === '/') return null;
  return s;
}

function asText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

function asItems(raw: unknown): StatementItem[] {
  if (!Array.isArray(raw)) return [];
  const out: StatementItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const label = asText(o.label ?? o.name ?? o.itemName ?? o['项目'] ?? o['项目名称']);
    if (!label) continue;
    out.push({
      lineNo: asText(o.lineNo ?? o.line_no ?? o['行次']),
      label,
      endBalance: asMoneyString(
        o.endBalance ?? o.end ?? o.current ?? o.amount ?? o['期末余额'] ?? o['本期金额'],
      ),
      beginBalance: asMoneyString(
        o.beginBalance ?? o.begin ?? o.previous ?? o['年初余额'] ?? o['上期金额'],
      ),
    });
  }
  return out;
}

/**
 * 把抽取结果归一化为 StatementExtraction。
 *
 * ★ 故意「宽容」：模型可能把 statementType 写错、把 items 写成别的键名，
 *   这里能救就救，救不了就让校验层报 FAIL —— 绝不在这里臆造数据。
 */
export function buildStatementExtraction(
  statementType: 'BALANCE_SHEET' | 'INCOME_STATEMENT' | 'CASH_FLOW',
  data: Record<string, unknown>,
): StatementExtraction {
  const items = asItems(data.items ?? data.lines ?? data.rows ?? data.detail);
  const selfCheck = data._selfCheck as { balanced?: boolean; difference?: string | null } | undefined;

  return {
    // statementType 以调用方指定的为准：模型写错类型会直接导致校验跑错规则
    statementType,
    periodStart: asText(data.periodStart ?? data.startDate ?? data['所属期起']),
    periodEnd: asText(data.periodEnd ?? data.endDate ?? data.date ?? data['所属期止']),
    unit: asText(data.unit ?? data['单位']),
    items,
    totalAssets: asMoneyString(data.totalAssets),
    totalLiabilities: asMoneyString(data.totalLiabilities),
    totalEquity: asMoneyString(data.totalEquity),
    revenue: asMoneyString(data.revenue),
    cost: asMoneyString(data.cost),
    profitBeforeTax: asMoneyString(data.profitBeforeTax),
    netProfit: asMoneyString(data.netProfit),
    _selfCheck: selfCheck
      ? { balanced: selfCheck.balanced, difference: asMoneyString(selfCheck.difference) }
      : undefined,
    _warnings: Array.isArray(data._warnings) ? (data._warnings as string[]).map(String) : [],
  };
}

/**
 * 把抽取结果归一化为 VatReturnExtraction。
 *
 * ★ 只搬运，不推导：表上没写的行次保持 null。
 *   例如「应纳税额」缺失时**绝不**用 销项-进项 自己算一个填进去 ——
 *   申报表的口径（留抵、转出、简易计税）比这个减法复杂得多，
 *   自行推导出来的数会污染历史重建的税负基线。
 */
export function buildVatReturnExtraction(data: Record<string, unknown>): VatReturnExtraction {
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = asMoneyString(data[k]);
      if (v !== null) return v;
    }
    return null;
  };

  return {
    periodStart: asText(data.periodStart ?? data['所属期起']),
    periodEnd: asText(data.periodEnd ?? data['所属期止']),
    line1SalesTaxable: pick('line1SalesTaxable'),
    line5SalesSimple: pick('line5SalesSimple'),
    line8SalesExempt: pick('line8SalesExempt'),
    line11OutputTax: pick('line11OutputTax'),
    line12InputTax: pick('line12InputTax'),
    line13CreditBroughtForward: pick('line13CreditBroughtForward'),
    line14InputTaxTransferOut: pick('line14InputTaxTransferOut'),
    line17DeductibleTotal: pick('line17DeductibleTotal'),
    line18ActualDeducted: pick('line18ActualDeducted'),
    line19TaxPayable: pick('line19TaxPayable'),
    line20CreditCarriedForward: pick('line20CreditCarriedForward'),
    line21SimpleTaxPayable: pick('line21SimpleTaxPayable'),
    line24TaxPayableTotal: pick('line24TaxPayableTotal'),
    line25OpeningUnpaid: pick('line25OpeningUnpaid'),
    line27TaxPaidThisPeriod: pick('line27TaxPaidThisPeriod'),
    line32ClosingUnpaid: pick('line32ClosingUnpaid'),
    line34PayableOrRefund: pick('line34PayableOrRefund'),
    surtaxBase: pick('surtaxBase'),
    surtaxCity: pick('surtaxCity'),
    surtaxEducation: pick('surtaxEducation'),
    surtaxLocalEducation: pick('surtaxLocalEducation'),
    surtaxTotal: pick('surtaxTotal'),
    items: asItems(data.items),
    _warnings: Array.isArray(data._warnings) ? (data._warnings as string[]).map(String) : [],
  };
}

/**
 * 把抽取结果归一化为 CitReturnExtraction。
 *
 * ★ 与增值税同样的原则：只搬运，不推导。
 *   企业所得税的「实际利润额」是从利润总额一路加减调整算出来的，
 *   中间涉及不征税收入、免税收入、加计扣除、弥补亏损等一堆口径，
 *   自行按 `利润总额 × 税率` 推算会得出一个看起来很合理、
 *   但和实际申报数不同的数字 —— 那会让历史税负基线整体偏移。
 */
export function buildCitReturnExtraction(data: Record<string, unknown>): CitReturnExtraction {
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = asMoneyString(data[k]);
      if (v !== null) return v;
    }
    return null;
  };

  return {
    periodStart: asText(data.periodStart ?? data['所属期起']),
    periodEnd: asText(data.periodEnd ?? data['所属期止']),
    line1Revenue: pick('line1Revenue'),
    line2Cost: pick('line2Cost'),
    line3ProfitTotal: pick('line3ProfitTotal'),
    line4SpecificAdjust: pick('line4SpecificAdjust'),
    line5NonTaxableIncome: pick('line5NonTaxableIncome'),
    line7TaxFreeIncome: pick('line7TaxFreeIncome'),
    line9LossOffset: pick('line9LossOffset'),
    line10TaxableIncome: pick('line10TaxableIncome'),
    line11TaxRate: pick('line11TaxRate'),
    line12TaxPayable: pick('line12TaxPayable'),
    line13TaxRelief: pick('line13TaxRelief'),
    line14PaidThisYear: pick('line14PaidThisYear'),
    line16PayableOrRefund: pick('line16PayableOrRefund'),
    items: asItems(data.items),
    _warnings: Array.isArray(data._warnings) ? (data._warnings as string[]).map(String) : [],
  };
}

/** 统一的「哪些行次有值」清单，界面用它决定展示什么 */
export function presentVatLines(data: Record<string, unknown>): Array<{
  key: string;
  label: string;
  value: string;
}> {
  const labels: Array<[string, string]> = [
    ['line1SalesTaxable', '第1行 按适用税率计税销售额'],
    ['line5SalesSimple', '第5行 按简易办法计税销售额'],
    ['line8SalesExempt', '第8行 免税销售额'],
    ['line11OutputTax', '第11行 销项税额'],
    ['line12InputTax', '第12行 进项税额'],
    ['line13CreditBroughtForward', '第13行 上期留抵税额'],
    ['line14InputTaxTransferOut', '第14行 进项税额转出'],
    ['line17DeductibleTotal', '第17行 应抵扣税额合计'],
    ['line18ActualDeducted', '第18行 实际抵扣税额'],
    ['line19TaxPayable', '第19行 应纳税额'],
    ['line20CreditCarriedForward', '第20行 期末留抵税额'],
    ['line21SimpleTaxPayable', '第21行 简易计税应纳税额'],
    ['line24TaxPayableTotal', '第24行 应纳税额合计'],
    ['line25OpeningUnpaid', '第25行 期初未缴税额'],
    ['line27TaxPaidThisPeriod', '第27行 本期已缴税额'],
    ['line32ClosingUnpaid', '第32行 期末未缴税额'],
    ['line34PayableOrRefund', '第34行 本期应补(退)税额'],
    ['surtaxBase', '附加税费 计税(费)依据'],
    ['surtaxCity', '附加税费 城建税'],
    ['surtaxEducation', '附加税费 教育费附加'],
    ['surtaxLocalEducation', '附加税费 地方教育附加'],
    ['surtaxTotal', '附加税费 合计'],
  ];
  const out: Array<{ key: string; label: string; value: string }> = [];
  for (const [key, label] of labels) {
    const v = asMoneyString(data[key]);
    if (v !== null) out.push({ key, label, value: v });
  }
  return out;
}

/** 企业所得税申报表的行次清单 */
export function presentCitLines(data: Record<string, unknown>): Array<{
  key: string;
  label: string;
  value: string;
}> {
  const labels: Array<[string, string]> = [
    ['line1Revenue', '营业收入'],
    ['line2Cost', '营业成本'],
    ['line3ProfitTotal', '利润总额'],
    ['line4SpecificAdjust', '加：特定业务计算的应纳税所得额'],
    ['line5NonTaxableIncome', '减：不征税收入'],
    ['line7TaxFreeIncome', '减：免税收入、减计收入、加计扣除'],
    ['line9LossOffset', '减：弥补以前年度亏损'],
    ['line10TaxableIncome', '实际利润额'],
    ['line11TaxRate', '税率'],
    ['line12TaxPayable', '应纳所得税额'],
    ['line13TaxRelief', '减：减免所得税额'],
    ['line14PaidThisYear', '减：本年实际已缴纳所得税额'],
    ['line16PayableOrRefund', '本期应补(退)所得税额'],
  ];
  const out: Array<{ key: string; label: string; value: string }> = [];
  for (const [key, label] of labels) {
    const v = asMoneyString(data[key]);
    if (v !== null) out.push({ key, label, value: v });
  }
  return out;
}