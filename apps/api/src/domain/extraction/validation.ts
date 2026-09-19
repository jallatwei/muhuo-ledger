/**
 * 会计交叉校验规则（识别阶段）
 * ============================================================
 * ★ 这一步比模型本身更重要。
 *   模型会看错，但会计恒等式不会骗人。
 *
 * 对应 design/04-单据导入与识图.md 第 5 节的 V1~V12：
 *   V1  金额 + 税额 == 价税合计          FAIL
 *   V2  税额 == 金额 × 税率              WARN
 *   V3  税率在合法枚举内                  FAIL
 *   V4  购买方/销售方与本主体匹配         FAIL  ← 拦"购销方颠倒"
 *   V5  发票号码格式                      WARN
 *   V6  开票日期合理                      WARN
 *   V7  业务唯一键未重复                  FAIL
 *   V8  金额为正且在合理上限内            FAIL
 *   V9  明细行金额合计 == 票面金额         WARN
 *   V10 红字发票可关联原票                WARN
 *   V11 税率与业务类型合理性              INFO
 *   V12 卖方是否已在往来单位档案中         INFO
 */
import { Decimal, VALID_TAX_RATES, assertTaxConsistency, dec, round2 } from '@bookkeeper/shared';

export type ValidationLevel = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

export interface ValidationFinding {
  code: string;
  level: ValidationLevel;
  message: string;
  /** 建议动作，便于人工快速处理 */
  suggestion?: string;
  fields?: string[];
}

export interface ExtractionForValidation {
  direction?: string | null;
  category?: string;
  invoiceCode?: string | null;
  invoiceNumber?: string;
  digitalInvoiceNo?: string | null;
  invoiceDate?: string | null;
  sellerName?: string;
  sellerTaxNo?: string | null;
  buyerName?: string;
  buyerTaxNo?: string | null;
  amountExclTax?: string | number | null;
  taxRate?: string | number | null;
  taxAmount?: string | number | null;
  amountInclTax?: string | number | null;
  isRedFlushed?: boolean;
  items?: Array<{
    itemName?: string;
    amountExclTax?: string | number | null;
    taxRate?: string | number | null;
    taxAmount?: string | number | null;
  }>;
}

export interface EntityContext {
  name: string;
  unifiedSocialCreditCode?: string | null;
  entityEnabledFrom?: Date | null;
  /** 是否已在档案中见过该卖方税号 */
  knownSellerTaxNos?: Set<string>;
  /** 业务唯一键是否已存在 */
  duplicateInvoiceId?: string | null;
}

export interface ValidationOutcome {
  findings: ValidationFinding[];
  /** 是否存在任何 FAIL —— 有则强制人工，且不允许一键确认绕过 */
  hasFailure: boolean;
  warnCount: number;
  failCount: number;
}

const AMOUNT_UPPER_LIMIT = new Decimal('10000000'); // 1000 万
const TAX_TOLERANCE = '0.02';

/** 归一化名称：去括号内容、去空格、全角转半角、去常见后缀 */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(有限责任公司|股份有限公司|有限公司|公司|厂|店|中心|事务所)$/g, '')
    .trim();
}

/** 名称是否指向同一主体（用于 V4） */
function sameParty(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // 一方包含另一方（如"演示科技"vs"演示科技有限公司"）
  return na.includes(nb) || nb.includes(na);
}

/**
 * ★ 主校验入口
 */
export function validateExtraction(
  invoice: ExtractionForValidation,
  entity: EntityContext,
): ValidationOutcome {
  const findings: ValidationFinding[] = [];
  const push = (f: ValidationFinding) => findings.push(f);

  // ---------------------------------------------------------------- V1
  const hasAllAmounts =
    invoice.amountExclTax !== null &&
    invoice.amountExclTax !== undefined &&
    invoice.taxAmount !== null &&
    invoice.taxAmount !== undefined &&
    invoice.amountInclTax !== null &&
    invoice.amountInclTax !== undefined;

  if (hasAllAmounts) {
    // 收窄为确定的金额值，后续计算不用再反复断言
    const excl = dec(invoice.amountExclTax ?? 0);
    const tax = dec(invoice.taxAmount ?? 0);
    const incl = dec(invoice.amountInclTax ?? 0);
    const r = assertTaxConsistency(excl, tax, incl, TAX_TOLERANCE);

    if (r.ok) {
      push({
        code: 'V1',
        level: 'PASS',
        message: `金额勾稽正确：${round2(excl).toFixed(2)} + ${round2(tax).toFixed(2)} = ${round2(incl).toFixed(2)}`,
      });
    } else {
      push({
        code: 'V1',
        level: 'FAIL',
        message:
          `金额勾稽不成立：不含税 ${round2(excl).toFixed(2)} + ` +
          `税额 ${round2(tax).toFixed(2)} = ` +
          `${round2(excl.plus(tax)).toFixed(2)}，` +
          `但票面价税合计为 ${round2(incl).toFixed(2)}，` +
          `差异 ${r.difference.toFixed(2)} 元。`,
        suggestion: '多半是识别数字有误（0/8、1/7、3/5 易混）。请对照原图逐位核对三个金额。',
        fields: ['amountExclTax', 'taxAmount', 'amountInclTax'],
      });
    }
  } else {
    push({
      code: 'V1',
      level: 'WARN',
      message: '金额字段不完整，无法做勾稽校验',
      suggestion: '请补齐不含税金额、税额与价税合计',
      fields: ['amountExclTax', 'taxAmount', 'amountInclTax'],
    });
  }

  // ---------------------------------------------------------------- V2
  if (
    invoice.amountExclTax !== null &&
    invoice.amountExclTax !== undefined &&
    invoice.taxRate !== null &&
    invoice.taxRate !== undefined &&
    invoice.taxAmount !== null &&
    invoice.taxAmount !== undefined
  ) {
    const expected = round2(dec(invoice.amountExclTax).times(dec(invoice.taxRate)));
    const actual = round2(invoice.taxAmount as string);
    if (!expected.minus(actual).abs().lte(TAX_TOLERANCE)) {
      push({
        code: 'V2',
        level: 'WARN',
        message:
          `税额与税率不匹配：${round2(invoice.amountExclTax as string).toFixed(2)} × ` +
          `${dec(invoice.taxRate).toString()} = ${expected.toFixed(2)}，但票面税额为 ${actual.toFixed(2)}。`,
        suggestion: '可能是税率识别错误，或票面存在折扣/差额征税',
        fields: ['taxRate', 'taxAmount'],
      });
    }
  }

  // ---------------------------------------------------------------- V3
  if (invoice.taxRate !== null && invoice.taxRate !== undefined) {
    const rateStr = dec(invoice.taxRate).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    const normalized = dec(invoice.taxRate).toString();
    const valid = VALID_TAX_RATES.some((r) => dec(r).equals(normalized) || dec(r).toFixed(4) === rateStr);
    if (!valid) {
      push({
        code: 'V3',
        level: 'FAIL',
        message: `税率 ${normalized} 不在合法的增值税税率/征收率枚举内。`,
        suggestion: '合法值：0、0.5%、1%、1.5%、3%、5%、6%、9%、13%。请核对票面税率。',
        fields: ['taxRate'],
      });
    }
  }

  // ---------------------------------------------------------------- V4 ★ 最重要
  const direction = invoice.direction;
  if (direction === 'INPUT') {
    const buyerMatches =
      sameParty(invoice.buyerName, entity.name) ||
      (!!invoice.buyerTaxNo && !!entity.unifiedSocialCreditCode && invoice.buyerTaxNo === entity.unifiedSocialCreditCode);
    if (!buyerMatches) {
      push({
        code: 'V4',
        level: 'FAIL',
        message:
          `方向为「进项」，但购买方是「${invoice.buyerName || '(空)'}」，` +
          `与本主体「${entity.name}」不一致。`,
        suggestion:
          '这通常意味着购销方识别颠倒（本主体实际是销售方）。请核对原图的购买方/销售方，' +
          '若本主体为销售方，应改为销项发票。',
        fields: ['direction', 'buyerName', 'buyerTaxNo'],
      });
    }
  } else if (direction === 'OUTPUT') {
    const sellerMatches =
      sameParty(invoice.sellerName, entity.name) ||
      (!!invoice.sellerTaxNo && !!entity.unifiedSocialCreditCode && invoice.sellerTaxNo === entity.unifiedSocialCreditCode);
    if (!sellerMatches) {
      push({
        code: 'V4',
        level: 'FAIL',
        message:
          `方向为「销项」，但销售方是「${invoice.sellerName || '(空)'}」，` +
          `与本主体「${entity.name}」不一致。`,
        suggestion: '请核对原图；若本主体为购买方，应改为进项发票。',
        fields: ['direction', 'sellerName', 'sellerTaxNo'],
      });
    }
  } else {
    push({
      code: 'V4',
      level: 'WARN',
      message: '未能判定进销方向（购买方与销售方都不是本主体）',
      suggestion: '请人工确认这张票属于本主体，还是误传了别家的票',
      fields: ['direction'],
    });
  }

  // ---------------------------------------------------------------- V5
  if (invoice.category === 'E_INVOICE' || invoice.digitalInvoiceNo) {
    const no = invoice.digitalInvoiceNo ?? invoice.invoiceNumber ?? '';
    if (!/^\d{20}$/.test(no)) {
      push({
        code: 'V5',
        level: 'WARN',
        message: `数电票号码应为 20 位数字，当前为「${no}」（${no.length} 位）。`,
        suggestion: '请核对发票号码是否识别完整',
        fields: ['invoiceNumber', 'digitalInvoiceNo'],
      });
    }
  } else if (invoice.invoiceCode) {
    if (!/^\d{10}$|^\d{12}$/.test(invoice.invoiceCode)) {
      push({
        code: 'V5',
        level: 'WARN',
        message: `发票代码通常为 10 或 12 位数字，当前为「${invoice.invoiceCode}」。`,
        fields: ['invoiceCode'],
      });
    }
    if (invoice.invoiceNumber && !/^\d{8}$/.test(invoice.invoiceNumber)) {
      push({
        code: 'V5',
        level: 'WARN',
        message: `发票号码通常为 8 位数字，当前为「${invoice.invoiceNumber}」。`,
        fields: ['invoiceNumber'],
      });
    }
  }

  // ---------------------------------------------------------------- V6
  if (invoice.invoiceDate) {
    const d = new Date(invoice.invoiceDate);
    if (Number.isNaN(d.getTime())) {
      push({
        code: 'V6',
        level: 'WARN',
        message: `开票日期格式无法解析：${invoice.invoiceDate}`,
        fields: ['invoiceDate'],
      });
    } else {
      const today = new Date();
      if (d.getTime() > today.getTime() + 24 * 3600 * 1000) {
        push({
          code: 'V6',
          level: 'WARN',
          message: `开票日期 ${invoice.invoiceDate} 晚于今天，不合常理。`,
          suggestion: '请核对日期是否识别错误',
          fields: ['invoiceDate'],
        });
      }
      if (entity.entityEnabledFrom && d < entity.entityEnabledFrom) {
        push({
          code: 'V6',
          level: 'WARN',
          message: `开票日期 ${invoice.invoiceDate} 早于主体启用日期。`,
          suggestion: '该票可能属于启用前的期间，或日期识别有误',
          fields: ['invoiceDate'],
        });
      }
    }
  }

  // ---------------------------------------------------------------- V7
  if (entity.duplicateInvoiceId) {
    push({
      code: 'V7',
      level: 'FAIL',
      message: '该发票已存在（发票代码+号码+方向+是否红冲 完全匹配）。',
      suggestion: '不会重复入账。新文件将作为已有发票的补充附件挂接。',
      fields: ['invoiceCode', 'invoiceNumber'],
    });
  }

  // ---------------------------------------------------------------- V8
  if (invoice.amountInclTax !== null && invoice.amountInclTax !== undefined) {
    const amt = dec(invoice.amountInclTax);
    if (amt.lte(0)) {
      push({
        code: 'V8',
        level: 'FAIL',
        message: `价税合计必须大于 0，当前为 ${amt.toFixed(2)}。`,
        suggestion: '若为红字发票，金额应输出正数并勾选「红字发票」标记。',
        fields: ['amountInclTax'],
      });
    } else if (amt.gt(AMOUNT_UPPER_LIMIT)) {
      push({
        code: 'V8',
        level: 'FAIL',
        message: `价税合计 ${amt.toFixed(2)} 超过单个主体单票上限 ${AMOUNT_UPPER_LIMIT.toFixed(2)} 元。`,
        suggestion: '如此大额极为罕见，多半是识别时多识别了数字（如把 1130 识别成 113000）。',
        fields: ['amountInclTax'],
      });
    }
  }

  // ---------------------------------------------------------------- V9
  if (invoice.items && invoice.items.length > 0) {
    const itemSum = invoice.items.reduce(
      (s, it) => s.plus(dec(it.amountExclTax ?? 0)),
      new Decimal(0),
    );
    if (invoice.amountExclTax !== null && invoice.amountExclTax !== undefined && itemSum.gt(0)) {
      if (!itemSum.minus(dec(invoice.amountExclTax)).abs().lte(TAX_TOLERANCE)) {
        push({
          code: 'V9',
          level: 'WARN',
          message:
            `明细行金额合计 ${round2(itemSum).toFixed(2)} 与票面不含税金额 ` +
            `${round2(invoice.amountExclTax as string).toFixed(2)} 不一致。`,
          suggestion: '可能是明细行未识别完整',
          fields: ['items', 'amountExclTax'],
        });
      }
    }
  }

  // ---------------------------------------------------------------- V10
  if (invoice.isRedFlushed) {
    push({
      code: 'V10',
      level: 'INFO',
      message: '红字发票：将生成反向分录冲销原业务。',
      suggestion: '请确认对应的原蓝票已入账，否则会造成单边挂账',
    });
  }

  // ---------------------------------------------------------------- V11
  if (invoice.taxRate !== null && invoice.taxRate !== undefined) {
    const rate = dec(invoice.taxRate);
    const text = `${invoice.items?.map((i) => i.itemName ?? '').join(' ') ?? ''} ${invoice.sellerName ?? ''}`;
    const suspicious: Array<[RegExp, string]> = [
      [/餐饮|娱乐|招待/, '餐饮娱乐服务通常适用 6%'],
      [/咨询|服务费|技术服务/, '现代服务通常适用 6%'],
      [/房租|租赁|场地/, '不动产租赁通常适用 9% 或 5%'],
      [/运输|货运|物流/, '交通运输服务通常适用 9%'],
      [/软件|技术开发/, '软件服务通常适用 6%'],
    ];
    for (const [pattern, hint] of suspicious) {
      if (pattern.test(text) && rate.gte('0.13')) {
        push({
          code: 'V11',
          level: 'INFO',
          message: `品名/名称暗示该业务税率可能不是 ${rate.toString()}（${hint}）。`,
          suggestion: '请核对票面税率；若确为 13%，属正常（如同时销售货物）',
          fields: ['taxRate'],
        });
        break;
      }
    }
  }

  // ---------------------------------------------------------------- V12
  if (invoice.sellerTaxNo && entity.knownSellerTaxNos && !entity.knownSellerTaxNos.has(invoice.sellerTaxNo)) {
    push({
      code: 'V12',
      level: 'INFO',
      message: `销售方「${invoice.sellerName}」是首次往来的单位。`,
      suggestion: '系统会自动建立往来单位档案；如为异常供应商请留意风险提示',
    });
  }

  const failCount = findings.filter((f) => f.level === 'FAIL').length;
  const warnCount = findings.filter((f) => f.level === 'WARN').length;

  return {
    findings,
    hasFailure: failCount > 0,
    warnCount,
    failCount,
  };
}

// ============================================================================
//  置信度路由
// ============================================================================

export interface RoutingDecision {
  status: 'AUTO_DRAFTED' | 'NEEDS_REVIEW';
  reason: string;
  /** 需要重点复核的字段（低置信度） */
  lowConfidenceFields: string[];
}

/**
 * 由「模型置信度 + 校验结果」共同决定路由。
 *
 * 规则（design/04 第 5 节）：
 *   存在任一条 FAIL           → NEEDS_REVIEW（强制人工，不允许一键确认绕过）
 *   仅 WARN                  → 每条降 0.15 置信度
 *   全部 PASS 且 conf ≥ 阈值  → AUTO_DRAFTED
 */
export function decideRouting(params: {
  overallConfidence: number;
  fieldConfidence: Record<string, number>;
  outcome: ValidationOutcome;
  threshold: number;
  fieldThreshold?: number;
}): RoutingDecision {
  const { overallConfidence, fieldConfidence, outcome, threshold } = params;
  const fieldThreshold = params.fieldThreshold ?? 0.7;

  const lowConfidenceFields = Object.entries(fieldConfidence)
    .filter(([, v]) => v < fieldThreshold)
    .map(([k]) => k);

  if (outcome.hasFailure) {
    const failed = outcome.findings.filter((f) => f.level === 'FAIL');
    return {
      status: 'NEEDS_REVIEW',
      reason: `校验未通过（${failed.map((f) => f.code).join('、')}）：${failed[0]?.message ?? ''}`,
      lowConfidenceFields,
    };
  }

  const adjusted = Math.max(0, overallConfidence - outcome.warnCount * 0.15);

  if (adjusted < threshold) {
    return {
      status: 'NEEDS_REVIEW',
      reason:
        `识别置信度 ${(overallConfidence * 100).toFixed(0)}%` +
        (outcome.warnCount > 0 ? `（含 ${outcome.warnCount} 条告警，折减后 ${(adjusted * 100).toFixed(0)}%）` : '') +
        ` 低于阈值 ${(threshold * 100).toFixed(0)}%，需人工复核`,
      lowConfidenceFields,
    };
  }

  if (lowConfidenceFields.length > 0) {
    return {
      status: 'NEEDS_REVIEW',
      reason: `以下字段置信度偏低，需人工核对：${lowConfidenceFields.join('、')}`,
      lowConfidenceFields,
    };
  }

  return {
    status: 'AUTO_DRAFTED',
    reason: `校验全部通过，识别置信度 ${(overallConfidence * 100).toFixed(0)}%`,
    lowConfidenceFields: [],
  };
}
