/**
 * 历史数据重建 —— 核心算法
 * ============================================================
 * 场景：以前没有账（或账已丢失），只有
 *   ① 销项开票明细  ② 已勾稽的进项发票  ③ 税务申报/年报记录
 *
 * ★ 核心认知（决定了整个模块的设计）：
 *
 *   从这三类数据里能**有据重建**的科目是有限的：
 *     ✓ 主营业务收入       ← 销项发票 + 增值税申报表
 *     ✓ 应收账款           ← 销项价税合计 − 已收款（无收款数据时为上限）
 *     ✓ 进项税额/待抵扣     ← 已勾稽的进项发票
 *     ✓ 应交增值税         ← 申报表「期末未缴税额」
 *     ✓ 应交企业所得税     ← 所得税申报表
 *     ✓ 税金及附加         ← 申报表附加税费
 *     ✓ 管理费用/成本（有票部分） ← 进项发票归类
 *     ✓ 累计未分配利润     ← Σ各年净利润（倒轧）
 *
 *   推不出来的（必须问人或倒轧，且**必须标注为推算**）：
 *     ✗ 现金/银行存款余额   ← 没有任何支付流水
 *     ✗ 无票成本费用        ← 只有税表利润总额能反推总额
 *     ✗ 存货、固定资产      ← 发票口径无法区分"已耗用"与"结存"
 *     ✗ 实收资本、借款      ← 完全没有信息
 *
 *   所以本模块不假装能给出完整账套，而是产出
 *   「期初建账方案」——每一行都标明来源为
 *   DECLARED（申报取数）/ INVOICE（发票聚合）/ DERIVED（倒轧推算）/ MANUAL（人工补录），
 *   并强制人工确认后才允许生成期初凭证。
 */
import { Decimal, round2, add, sub, mul, div, dec } from '@bookkeeper/shared';

// ============================================================================
//  输入
// ============================================================================

export interface InvoiceAggregate {
  direction: 'OUTPUT' | 'INPUT';
  year: number;
  count: number;
  amountExclTax: Decimal;
  taxAmount: Decimal;
  amountInclTax: Decimal;
  /** 进项中已勾选认证的税额 */
  certifiedTaxAmount: Decimal;
  /** 按 AI 归类汇总的进项金额（用于推断费用结构） */
  byCategory: Map<string, { amountExclTax: Decimal; taxAmount: Decimal; count: number }>;
}

export interface FilingAggregate {
  year: number;
  /** 增值税申报表合计 */
  vat: {
    salesExclTax: Decimal | null;
    outputTax: Decimal | null;
    inputTax: Decimal | null;
    inputTaxTransferOut: Decimal | null;
    taxPayable: Decimal | null;
    taxPaid: Decimal | null;
    /** 各月期末未缴税额之和（年末余额取最后一个月的值） */
    taxUnpaidYearEnd: Decimal | null;
    surtax: Decimal | null;
    monthCount: number;
  };
  /** 企业所得税年报 */
  cit: {
    revenue: Decimal | null;
    cost: Decimal | null;
    profitBeforeTax: Decimal | null;
    taxPayable: Decimal | null;
    taxPaid: Decimal | null;
    adjustUp: Decimal | null;
  } | null;
}

// ============================================================================
//  输出
// ============================================================================

export interface ReconciliationFinding {
  item: string;
  invoiceSide: Decimal | null;
  declaredSide: Decimal | null;
  difference: Decimal | null;
  level: 'PASS' | 'WARN' | 'FAIL';
  explanation: string;
  suggestion?: string;
}

export interface YearReconstruction {
  year: number;

  // ---- 发票侧（有据）----
  sales: InvoiceAggregate | null;
  purchases: InvoiceAggregate | null;

  // ---- 申报侧（有据）----
  filing: FilingAggregate | null;

  // ---- 核对 ----
  reconciliations: ReconciliationFinding[];
  reconciled: boolean;

  // ---- 倒轧推算 ----
  /** 营业收入（优先取自申报表，无则用发票聚合） */
  revenue: Decimal;
  revenueSource: 'DECLARED' | 'INVOICE';
  /** 有票成本（进项发票中可归入成本费用的部分） */
  invoicedCost: Decimal;
  /** 推算的营业成本与费用合计 = 营业收入 − 利润总额（按所得税年报倒轧） */
  derivedCostTotal: Decimal | null;
  /** 无票成本 = 推算成本 − 有票成本（汇算清缴需纳税调增） */
  costWithoutInvoice: Decimal | null;
  /** 利润总额（取自所得税年报） */
  profitBeforeTax: Decimal | null;
  /** 所得税费用 */
  incomeTaxExpense: Decimal | null;
  /** 净利润 */
  netProfit: Decimal | null;

  // ---- 待人工补录 ----
  requiredInputs: RequiredInput[];

  warnings: string[];
}

export interface RequiredInput {
  field: string;
  label: string;
  reason: string;
  suggestion: string;
  /** 若该项有可用的推算值，一并给出，供用户参考或直接采纳 */
  suggestedValue?: string;
}

// ============================================================================
//  核对：发票聚合 vs 申报表
// ============================================================================

/**
 * 发票口径与申报口径**本来就可能不一致**，所以不能简单地"不等就报错"。
 * 常见合理差异：
 *   · 存在未开票收入（申报表按纳税义务时间，可能早于或晚于开票）
 *   · 跨期认证（进项发票开票在 12 月，勾选在次年 1 月）
 *   · 红字发票跨期冲销
 *   · 简易计税/免税项目不走销项税额
 *   · 视同销售、进项转出等调整
 * 因此这里的判定是：差异在容差内 PASS；差异较小时 WARN 并解释原因；
 * 差异较大时 FAIL 并提示这可能意味着数据不完整。
 */
export function reconcile(
  invoices: InvoiceAggregate | null,
  filing: FilingAggregate | null,
  options: { toleranceRatio?: number } = {},
): ReconciliationFinding[] {
  const findings: ReconciliationFinding[] = [];
  const toleranceRatio = options.toleranceRatio ?? 0.01; // 1%

  const tol = (base: Decimal): Decimal => {
    const t = mul(base.abs(), toleranceRatio);
    // 至少容忍 100 元，避免小额时过于敏感
    return t.lt(100) ? new Decimal(100) : round2(t);
  };

  const sales = invoices?.direction === 'OUTPUT' ? invoices : null;
  const purchase = invoices?.direction === 'INPUT' ? invoices : null;

  // ---------- 销项：不含税销售额 ----------
  if (sales && filing?.vat.salesExclTax !== null && filing?.vat.salesExclTax !== undefined) {
    const inv = round2(sales.amountExclTax);
    const dec_ = round2(filing.vat.salesExclTax);
    const diff = inv.minus(dec_);
    const limit = tol(dec_);
    const absDiff = diff.abs();

    let level: 'PASS' | 'WARN' | 'FAIL' = 'PASS';
    let explanation = `发票聚合 ${inv.toFixed(2)} 与申报表 ${dec_.toFixed(2)} 一致`;
    let suggestion: string | undefined;

    if (absDiff.gt(limit)) {
      const ratio = dec_.isZero() ? new Decimal(1) : absDiff.div(dec_.abs());
      // ★ 差异方向必须说清楚：发票少 vs 发票多，处理方式完全不同。
      //   只说「相差 50000」会让人不知道到底哪边多。
      const directionWord = inv.lt(dec_) ? '发票少于申报' : '发票多于申报';
      if (ratio.lte(0.15)) {
        level = 'WARN';
        explanation =
          `发票聚合 ${inv.toFixed(2)} 与申报销售额 ${dec_.toFixed(2)} 相差 ${diff.toFixed(2)}` +
          `（${directionWord}，${mul(ratio, 100).toFixed(2)}%）。`;
        suggestion =
          inv.lt(dec_)
            ? '申报额大于开票额，通常存在「未开票收入」。这部分收入同样要入账，建议在期初方案中按申报额确认收入。'
            : '开票额大于申报额，可能存在跨期开票或红冲未同步。请核对是否有次年才申报的发票。';
      } else {
        level = 'FAIL';
        explanation =
          `发票聚合 ${inv.toFixed(2)} 与申报销售额 ${dec_.toFixed(2)} 相差 ${diff.toFixed(2)}` +
          `（${directionWord}，${mul(ratio, 100).toFixed(2)}%），差异过大。`;
        suggestion = '差异过大通常意味着导入数据不完整（漏了某些月份或某些票种）。请检查导入的开票明细是否覆盖全年。';
      }
    }

    findings.push({
      item: '销售额（不含税）',
      invoiceSide: inv,
      declaredSide: dec_,
      difference: diff,
      level,
      explanation,
      suggestion,
    });
  } else if (sales && !filing?.vat.salesExclTax) {
    findings.push({
      item: '销售额（不含税）',
      invoiceSide: round2(sales.amountExclTax),
      declaredSide: null,
      difference: null,
      level: 'WARN',
      explanation: '缺少该年度的增值税申报记录，无法核对销售额。',
      suggestion: '建议补充导入增值税申报记录，否则收入确认只能完全依赖发票，会漏掉未开票收入。',
    });
  }

  // ---------- 销项：销项税额 ----------
  if (sales && filing?.vat.outputTax !== null && filing?.vat.outputTax !== undefined) {
    const inv = round2(sales.taxAmount);
    const decl = round2(filing.vat.outputTax);
    const diff = inv.minus(decl);
    const limit = tol(decl);

    findings.push({
      item: '销项税额',
      invoiceSide: inv,
      declaredSide: decl,
      difference: diff,
      level: diff.abs().lte(limit) ? 'PASS' : 'WARN',
      explanation: diff.abs().lte(limit)
        ? `发票税额 ${inv.toFixed(2)} 与申报销项税额 ${decl.toFixed(2)} 一致`
        : `发票税额 ${inv.toFixed(2)} 与申报销项税额 ${decl.toFixed(2)} 相差 ${diff.toFixed(2)}`,
      suggestion: diff.abs().lte(limit)
        ? undefined
        : '可能原因：存在简易计税或免税项目（不计销项）、视同销售调整、或跨期开票。',
    });
  }

  // ---------- 进项：已勾稽发票 vs 申报进项税额 ----------
  if (purchase && filing?.vat.inputTax !== null && filing?.vat.inputTax !== undefined) {
    const certified = round2(purchase.certifiedTaxAmount);
    const decl = round2(filing.vat.inputTax);
    const diff = certified.minus(decl);
    const limit = tol(decl);

    let level: 'PASS' | 'WARN' | 'FAIL' = 'PASS';
    let explanation = `已勾稽进项税额 ${certified.toFixed(2)} 与申报进项税额 ${decl.toFixed(2)} 一致`;
    let suggestion: string | undefined;

    if (diff.abs().gt(limit)) {
      if (diff.gt(0)) {
        level = 'WARN';
        explanation =
          `已勾稽进项税额 ${certified.toFixed(2)} 大于申报抵扣的 ${decl.toFixed(2)}，` +
          `相差 ${diff.toFixed(2)}（可能存在留抵或尚未抵扣）。`;
        suggestion = '这部分税额应挂在「待抵扣进项税额」，不进入期初的进项税额。';
      } else {
        level = 'WARN';
        explanation =
          `申报抵扣的进项税额 ${decl.toFixed(2)} 大于已勾稽发票的 ${certified.toFixed(2)}，` +
          `相差 ${diff.abs().toFixed(2)}。`;
        suggestion = '可能存在其他扣税凭证（海关缴款书、农产品收购发票、旅客运输计算抵扣）未导入。';
      }
    }

    findings.push({
      item: '进项税额',
      invoiceSide: certified,
      declaredSide: decl,
      difference: diff,
      level,
      explanation,
      suggestion,
    });
  }

  // ---------- 进项税额转出 ----------
  if (filing?.vat.inputTaxTransferOut && filing.vat.inputTaxTransferOut.gt(0)) {
    findings.push({
      item: '进项税额转出',
      invoiceSide: null,
      declaredSide: round2(filing.vat.inputTaxTransferOut),
      difference: null,
      level: 'WARN',
      explanation: `该年度存在进项税额转出 ${filing.vat.inputTaxTransferOut.toFixed(2)}。`,
      suggestion: '进项税额转出通常对应用于集体福利、个人消费或非正常损失，这部分成本金额需相应调增。',
    });
  }

  // ---------- 期末未缴增值税 ----------
  if (filing?.vat.taxUnpaidYearEnd && filing.vat.taxUnpaidYearEnd.gt(0)) {
    findings.push({
      item: '年末未缴增值税',
      invoiceSide: null,
      declaredSide: round2(filing.vat.taxUnpaidYearEnd),
      difference: null,
      level: 'PASS',
      explanation: `该年度末仍有未缴增值税 ${filing.vat.taxUnpaidYearEnd.toFixed(2)}，将计入期初「应交税费—未交增值税」。`,
    });
  }

  // ---------- 所得税年报：收入口径 ----------
  if (filing?.cit?.revenue && filing.vat.salesExclTax) {
    const citRev = round2(filing.cit.revenue);
    const vatSales = round2(filing.vat.salesExclTax);
    const diff = citRev.minus(vatSales);
    const limit = tol(vatSales);
    if (diff.abs().gt(limit)) {
      findings.push({
        item: '所得税营业收入 vs 增值税销售额',
        invoiceSide: null,
        declaredSide: null,
        difference: diff,
        level: 'WARN',
        explanation:
          `所得税年报营业收入 ${citRev.toFixed(2)} 与增值税申报销售额 ${vatSales.toFixed(2)} ` +
          `相差 ${diff.toFixed(2)}。`,
        suggestion:
          '两个口径存在差异是正常的（如视同销售、政府补助计入其他收益、不动产处置等），' +
          '但差异较大时建议核对，以免收入确认金额取错。',
      });
    }
  }

  return findings;
}

// ============================================================================
//  年度重建
// ============================================================================

export interface ReconstructYearParams {
  year: number;
  salesInvoices: InvoiceAggregate | null;
  purchaseInvoices: InvoiceAggregate | null;
  filing: FilingAggregate | null;
  /** 小型微利企业实际税负率（默认 5%），用于无年报时的所得税倒轧 */
  smallProfitEffectiveRate?: Decimal;
}

/**
 * ★ 单年度重建
 *
 * 计算顺序（顺序很重要，错一步整条链都错）：
 *   1. 收入：优先取所得税年报营业收入 → 其次增值税申报销售额 → 最后发票聚合
 *   2. 有票成本：进项发票中归类为成本/费用的部分（不含税额）
 *   3. 推算成本总额：由所得税年报「利润总额」倒轧
 *        成本费用总额 = 营业收入 − 利润总额
 *      （因为 利润总额 = 营业收入 − 成本费用 − 税金及附加 + 其他）
 *      注：这是近似，税金及附加与营业外收支会被算进成本费用里，需在提示中说明
 *   4. 无票成本 = 推算成本总额 − 有票成本  ← ★ 汇算清缴纳税调增的重点
 *   5. 所得税费用：优先取年报；否则按利润总额 × 小微实际税负率倒轧
 *   6. 净利润 = 利润总额 − 所得税费用
 */
export function reconstructYear(params: ReconstructYearParams): YearReconstruction {
  const { year, salesInvoices, purchaseInvoices, filing } = params;
  const warnings: string[] = [];
  const requiredInputs: RequiredInput[] = [];

  // ---------------------------------------------------------------- 1. 收入
  let revenue = new Decimal(0);
  let revenueSource: 'DECLARED' | 'INVOICE' = 'INVOICE';

  if (filing?.cit?.revenue && filing.cit.revenue.gt(0)) {
    revenue = round2(filing.cit.revenue);
    revenueSource = 'DECLARED';
  } else if (filing?.vat.salesExclTax && filing.vat.salesExclTax.gt(0)) {
    revenue = round2(filing.vat.salesExclTax);
    revenueSource = 'DECLARED';
  } else if (salesInvoices && salesInvoices.amountExclTax.gt(0)) {
    revenue = round2(salesInvoices.amountExclTax);
    revenueSource = 'INVOICE';
    warnings.push(
      `${year} 年缺少申报记录，收入取自开票明细 ${revenue.toFixed(2)}。` +
        `若存在未开票收入，该金额会偏低，建议补充申报记录。`,
    );
  } else {
    warnings.push(`${year} 年没有任何收入数据（发票与申报记录均为空）。`);
  }

  // ---------------------------------------------------------------- 2. 有票成本
  const invoicedCost = round2(purchaseInvoices?.amountExclTax ?? 0);
  if (!purchaseInvoices || purchaseInvoices.count === 0) {
    warnings.push(`${year} 年没有进项发票记录。若无票成本较大，年度汇算清缴需做纳税调增。`);
  }

  // ---------------------------------------------------------------- 3. 倒轧成本总额
  const profitBeforeTax = filing?.cit?.profitBeforeTax ? round2(filing.cit.profitBeforeTax) : null;
  let derivedCostTotal: Decimal | null = null;

  if (profitBeforeTax !== null) {
    // 利润总额 = 营业收入 − 成本费用（近似，见函数头注释）
    derivedCostTotal = round2(revenue.minus(profitBeforeTax));
    if (derivedCostTotal.lt(0)) {
      warnings.push(
        `${year} 年倒轧出的成本费用为负（${derivedCostTotal.toFixed(2)}），` +
          `说明利润总额大于营业收入。可能存在营业外收入、投资收益或政府补助。请人工核对。`,
      );
    }
  } else if (filing?.cit?.cost && filing.cit.cost.gt(0)) {
    derivedCostTotal = round2(filing.cit.cost);
    warnings.push(`${year} 年缺少利润总额数据，成本费用取自所得税年报「营业成本」${derivedCostTotal.toFixed(2)}，未含期间费用。`);
  } else {
    requiredInputs.push({
      field: 'costTotal',
      label: `${year} 年成本费用总额`,
      reason: '既无所得税年报的利润总额，也无营业成本数据，无法倒轧成本。',
      suggestion: '请提供该年度的利润总额，或直接填写成本费用总额（可从代账公司或申报表获取）。',
      suggestedValue: invoicedCost.gt(0) ? invoicedCost.toFixed(2) : undefined,
    });
  }

  // ---------------------------------------------------------------- 4. 无票成本
  let costWithoutInvoice: Decimal | null = null;
  if (derivedCostTotal !== null) {
    costWithoutInvoice = round2(derivedCostTotal.minus(invoicedCost));
    if (costWithoutInvoice.lt(0)) {
      warnings.push(
        `${year} 年有票成本 ${invoicedCost.toFixed(2)} 大于倒轧的成本费用总额 ` +
          `${derivedCostTotal.toFixed(2)}。可能原因：部分进项发票属于存货（未耗用）、` +
          `固定资产（资本化）或跨年耗用。建议人工核对进项发票的归类。`,
      );
    } else if (costWithoutInvoice.gt(0)) {
      warnings.push(
        `${year} 年存在无票成本 ${costWithoutInvoice.toFixed(2)}` +
          `（倒轧成本 ${derivedCostTotal.toFixed(2)} − 有票成本 ${invoicedCost.toFixed(2)}）。` +
          `这部分在企业所得税汇算清缴时需做纳税调增，存在补税风险。`,
      );
    }
  }

  // ---------------------------------------------------------------- 5. 所得税费用
  let incomeTaxExpense: Decimal | null = null;
  let netProfit: Decimal | null = null;

  if (profitBeforeTax !== null) {
    if (filing?.cit?.taxPayable !== null && filing?.cit?.taxPayable !== undefined) {
      incomeTaxExpense = round2(filing.cit.taxPayable);
    } else {
      // 无年报税额时按小型微利企业实际税负率倒轧
      const rate = params.smallProfitEffectiveRate ?? new Decimal('0.05');
      incomeTaxExpense = profitBeforeTax.gt(0) ? round2(mul(profitBeforeTax, rate)) : new Decimal(0);
      warnings.push(
        `${year} 年所得税费用由利润总额 × ${mul(rate, 100).toFixed(1)}% 倒轧得出 ` +
          `${incomeTaxExpense.toFixed(2)}（小型微利企业实际税负）。请与申报表核对。`,
      );
    }
    netProfit = round2(profitBeforeTax.minus(incomeTaxExpense));
  }

  // ---------------------------------------------------------------- 6. 待人工补录项
  requiredInputs.push({
    field: 'cashBalance',
    label: `${year} 年末银行 + 现金余额`,
    reason: '开票记录与申报记录中都不包含资金流水，无法推算现金余额。',
    suggestion:
      '请提供该年末的银行对账单余额与库存现金。这是期初建账的必填项 —— ' +
      '没有它，期初方案只能按会计恒等式倒轧，会让「货币资金」变成一个凑数科目。',
  });

  if (!filing?.cit) {
    requiredInputs.push({
      field: 'citAnnual',
      label: `${year} 年企业所得税年报数据`,
      reason: '缺少所得税年报，无法得到可靠的利润总额与应纳税额。',
      suggestion: '建议从电子税局「企业所得税年度申报表」导出后导入，或手工填写利润总额与应纳所得税额。',
    });
  }

  requiredInputs.push({
    field: 'paidInCapital',
    label: `${year} 年末实收资本`,
    reason: '实收资本与股东出资信息在发票和申报记录中完全没有。',
    suggestion: '查看营业执照注册资本与实缴情况，或查询「实收资本」在代账报表中的金额。若从未实缴可填 0。',
  });

  const reconciliations = reconcile(
    salesInvoices ?? purchaseInvoices,
    filing,
  );

  return {
    year,
    sales: salesInvoices,
    purchases: purchaseInvoices,
    filing,
    reconciliations,
    reconciled: reconciliations.every((r) => r.level !== 'FAIL'),
    revenue,
    revenueSource,
    invoicedCost,
    derivedCostTotal,
    costWithoutInvoice,
    profitBeforeTax,
    incomeTaxExpense,
    netProfit,
    requiredInputs,
    warnings,
  };
}

// ============================================================================
//  期初建账方案生成
// ============================================================================

/** 期初方案的一行 */
export interface OpeningLine {
  accountCode: string;
  accountName: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: Decimal;
  source: 'DECLARED' | 'INVOICE' | 'DERIVED' | 'MANUAL';
  sourceNote: string;
  needsReview: boolean;
  breakdown?: Record<string, string>;
}

export interface OpeningProposalResult {
  lines: OpeningLine[];
  totalDebit: Decimal;
  totalCredit: Decimal;
  difference: Decimal;
  balanced: boolean;
  cashBasis: 'DECLARED' | 'DERIVED';
  cashBalance: Decimal;
  requiredInputs: RequiredInput[];
  warnings: string[];
  summary: string;
}

export interface ManualInputs {
  /** 各年末实际货币资金余额（按年） */
  cashBalanceByYear?: Record<number, string>;
  /**
   * ★ 已建档财务报表给出的科目余额（科目编码 → 余额）。
   *
   * 这是整个方案里**可信度最高**的一类数据，优先级高于人工输入：
   * 人工输入是"我记得大概是这个数"，财务报表是"代账公司出的表上写的就是这个数"。
   *
   * 它决定了两件关键的事：
   *   ① 货币资金不再是倒轧出来的凑数科目（这是历史重建最大的失真来源）
   *   ② 存货/固定资产/实收资本不必再去问人
   */
  declaredBalances?: Map<
    string,
    { amount: string; label: string; direction: 'DEBIT' | 'CREDIT' }
  >;
  /** 已建档财务报表给出的期间（用于说明数据来源，如 "2024-12-31 资产负债表"） */
  declaredStatementNote?: string | null;
  /** 实收资本 */
  paidInCapital?: string;
  /** 存货 */
  inventory?: string;
  /** 固定资产原值 */
  fixedAsset?: string;
  /** 累计折旧 */
  accumulatedDepreciation?: string;
  /** 其他应付款 / 股东借款 */
  otherPayable?: string;
  /** 短期/长期借款 */
  loan?: string;
  /** 历史回款率估计（0~1）：用于把发票累计额折算为实际应收余额 */
  historicalCollectionRate?: string;
}

/**
 * ★ 由各年度重建结果生成期初建账方案
 *
 * 这是整个模块的产出。设计原则：
 *
 *   ① **能算的算准**：应交税费、累计未分配利润、有票成本相关科目按申报与发票数据计算
 *   ② **算不出的不编**：现金、存货、固定资产等没有数据来源的，
 *      如果有用户输入就用输入值（标 MANUAL），没有就列为待补录项
 *   ③ **差额必须归位**：会计恒等式要求借贷相等。
 *      在不完整重建时，差额只有一个合法去处 —— 未分配利润（累计损益）。
 *      因为「资产 − 负债 = 所有者权益」是恒等式，
 *      资产与负债都由历史事实决定，所有者权益就是被决定的那一项。
 *      但这会让未分配利润同时承载"真实累计利润"与"数据缺口"，
 *      所以必须显式标注并提示人工核对。
 *   ④ **现金是唯一需要策略选择的科目**：
 *      有实际余额 → 用它（DECLARED）；没有 → 只能倒轧（DERIVED，风险最高）
 */
export function buildOpeningProposal(params: {
  targetYear: number;
  targetMonth: number;
  years: YearReconstruction[];
  manual?: ManualInputs;
}): OpeningProposalResult {
  const { targetYear, targetMonth, years, manual = {} } = params;
  const lines: OpeningLine[] = [];
  const warnings: string[] = [];
  const requiredInputs: RequiredInput[] = [];

  const push = (line: OpeningLine): void => {
    if (line.amount.isZero()) return; // 零余额科目不入方案
    lines.push(line);
  };

  // ---------------------------------------------------------------- 一、货币资金
  //
  // 这是整个方案里最需要策略的一项：
  //   有年末银行对账单 → 用实际数（可信）
  //   没有             → 只能倒轧（不可信，必须显著提示）
  const lastYear = targetYear > 0 ? years.find((y) => y.year === targetYear - 1) ?? years[years.length - 1] : years[years.length - 1];
  const cashProvided = manual.cashBalanceByYear?.[lastYear?.year ?? 0];

  let cashBalance = new Decimal(0);
  let cashBasis: 'DECLARED' | 'DERIVED' = 'DERIVED';

  // ★ 数据来源优先级：已建档财务报表 > 人工输入 > 倒轧
  //   报表是别人（代账公司/税局）出的表，比"我记得大概是这个数"可靠得多。
  const declaredCash = manual.declaredBalances?.get('1002');
  const declaredPettyCash = manual.declaredBalances?.get('1001');

  if (declaredCash) {
    cashBalance = round2(declaredCash.amount);
    cashBasis = 'DECLARED';
    push({
      accountCode: '1002',
      accountName: '银行存款',
      direction: 'DEBIT',
      amount: cashBalance,
      source: 'DECLARED',
      sourceNote:
        `取自已建档财务报表「${declaredCash.label}」` +
        (manual.declaredStatementNote ? `（${manual.declaredStatementNote}）` : ''),
      needsReview: false,
    });
    if (declaredPettyCash) {
      push({
        accountCode: '1001',
        accountName: '库存现金',
        direction: 'DEBIT',
        amount: round2(declaredPettyCash.amount),
        source: 'DECLARED',
        sourceNote: `取自已建档财务报表「${declaredPettyCash.label}」`,
        needsReview: false,
      });
    }
  } else if (cashProvided !== undefined && cashProvided !== '') {
    cashBalance = round2(cashProvided);
    cashBasis = 'DECLARED';
    push({
      accountCode: '1002',
      accountName: '银行存款',
      direction: 'DEBIT',
      amount: cashBalance,
      source: 'MANUAL',
      sourceNote: `人工提供：${lastYear?.year ?? ''} 年末银行对账单余额`,
      needsReview: false,
    });
    push({
      accountCode: '1001',
      accountName: '库存现金',
      direction: 'DEBIT',
      amount: new Decimal(0),
      source: 'MANUAL',
      sourceNote: '若年末有库存现金余额，请在方案中补充',
      needsReview: true,
    });
  } else {
    requiredInputs.push({
      field: 'cashBalance',
      label: '启用前一日货币资金余额',
      reason: '开票与申报数据不含资金流水，无法推算。',
      suggestion:
        '有两条路，优先第一条：\n' +
        '  ① 【推荐】在「录入凭证 → 识别录入」上传代账公司出的资产负债表（Excel 最好），' +
        '建档后系统直接取「货币资金」行 —— 这是唯一不会失真的取数方式；\n' +
        '  ② 手工提供启用前一日的银行对账单余额。\n' +
        '若不提供任何一项，系统只能按会计恒等式倒轧，' +
        '这会让「货币资金」变成凑数科目 —— 强烈建议补齐。',
    });
  }

  // ---------------------------------------------------------------- 二、收入相关：应收账款
  //
  // 应收账款 = Σ各年销项价税合计
  //   ⚠️ 这是**上限**：因为没有收款流水，无法减去已收回的部分。
  //      所以必须标注 needsReview 并解释清楚。
  const totalSalesInclTax = years.reduce(
    (s, y) => s.plus(y.sales?.amountInclTax ?? 0),
    new Decimal(0),
  );

  // 若用户提供了历史回款率，按此折算；否则取上限值（100% 未回款），
  // 并**在方案中显著提示这会高估资产、把缺口全压进未分配利润**。
  const collectionRate =
    manual.historicalCollectionRate !== undefined && manual.historicalCollectionRate !== ''
      ? dec(manual.historicalCollectionRate)
      : null;

  const arAmount =
    collectionRate !== null
      ? round2(mul(totalSalesInclTax, new Decimal(1).minus(collectionRate)))
      : round2(totalSalesInclTax);

  if (totalSalesInclTax.gt(0) && arAmount.gt(0)) {
    push({
      accountCode: '1122',
      accountName: '应收账款',
      direction: 'DEBIT',
      amount: arAmount,
      source: collectionRate !== null ? 'MANUAL' : 'INVOICE',
      sourceNote:
        collectionRate !== null
          ? `历史销项发票价税合计 ${round2(totalSalesInclTax).toFixed(2)} × ` +
            `(1 − 回款率 ${mul(collectionRate, 100).toFixed(1)}%) = ${arAmount.toFixed(2)}。` +
            `回款率为人工估计值，请与往来对账核对。`
          : `历史销项发票价税合计累计 ${round2(totalSalesInclTax).toFixed(2)}。` +
            `⚠️ 这是**上限值**（假设货款全部未收回）。若不实，会把缺口全部压进「未分配利润」，` +
            `使方案看起来平衡但严重失真。建议提供历史回款率或在下方直接改成实际余额。`,
      needsReview: true,
      breakdown: Object.fromEntries(
        years
          .filter((y) => y.sales && y.sales.amountInclTax.gt(0))
          .map((y) => [
            `${y.year} 年`,
            `${y.sales!.count} 张，价税合计 ${round2(y.sales!.amountInclTax).toFixed(2)}`,
          ]),
      ),
    });

    requiredInputs.push({
      field: 'receivableAdjust',
      label: '历史应收账款实际余额',
      reason: '发票累计额未扣除已收款，通常远大于实际未收余额。',
      suggestion:
        '请查阅与主要客户的往来对账，或估算历史货款回收比例。' +
        '若历史上货款基本当期收回，可直接把应收账款调为 0。',
    });
  }

  // ---------------------------------------------------------------- 三、增值税相关
  //
  // ★ 这一组是最有据的部分 —— 直接来自申报表
  const lastYearFiling = years.find((y) => y.year === (lastYear?.year ?? 0))?.filing ?? null;

  // 3.1 未交增值税（年末未缴）
  const unpaidVat = lastYearFiling?.vat.taxUnpaidYearEnd ?? null;
  if (unpaidVat && unpaidVat.gt(0)) {
    push({
      accountCode: '222102',
      accountName: '应交税费—未交增值税',
      direction: 'CREDIT',
      amount: round2(unpaidVat),
      source: 'DECLARED',
      sourceNote: `取自 ${lastYear?.year} 年 12 月增值税申报表「期末未缴税额」`,
      needsReview: false,
    });
  }

  // 3.2 待抵扣进项税额（已勾稽但未抵扣的部分）
  const lastYearPurchases = lastYear?.purchases ?? null;
  const lastYearInputTaxDeclared = lastYearFiling?.vat.inputTax ?? null;
  if (lastYearPurchases && lastYearInputTaxDeclared !== null) {
    const pending = round2(lastYearPurchases.certifiedTaxAmount.minus(lastYearInputTaxDeclared));
    if (pending.gt(0)) {
      push({
        accountCode: '22210103',
        accountName: '应交税费—待抵扣进项税额',
        direction: 'DEBIT',
        amount: pending,
        source: 'DERIVED',
        sourceNote:
          `已勾稽进项税额 ${round2(lastYearPurchases.certifiedTaxAmount).toFixed(2)} − ` +
          `申报抵扣 ${round2(lastYearInputTaxDeclared).toFixed(2)} = ${pending.toFixed(2)}`,
        needsReview: true,
      });
    }
  }

  // 3.3 应交企业所得税（年末未缴）
  const citUnpaid = (() => {
    const payable = lastYear?.filing?.cit?.taxPayable;
    const paid = lastYear?.filing?.cit?.taxPaid;
    if (payable === null || payable === undefined) return null;
    const p = round2(payable.minus(paid ?? 0));
    return p.gt(0) ? p : null;
  })();
  if (citUnpaid) {
    push({
      accountCode: '222103',
      accountName: '应交税费—应交企业所得税',
      direction: 'CREDIT',
      amount: citUnpaid,
      source: 'DECLARED',
      sourceNote: `取自 ${lastYear?.year} 年企业所得税年报：应纳税额 − 已缴税额`,
      needsReview: false,
    });
  }

  // ---------------------------------------------------------------- 四、其他人工补录项
  const manualAccounts: Array<{
    code: string;
    name: string;
    value: string | undefined;
    direction: 'DEBIT' | 'CREDIT';
  }> = [
    { code: '1403', name: '原材料/存货', value: manual.inventory, direction: 'DEBIT' },
    { code: '1601', name: '固定资产', value: manual.fixedAsset, direction: 'DEBIT' },
    { code: '1602', name: '累计折旧', value: manual.accumulatedDepreciation, direction: 'CREDIT' },
    { code: '2241', name: '其他应付款（含股东借款）', value: manual.otherPayable, direction: 'CREDIT' },
    { code: '2001', name: '短期借款', value: manual.loan, direction: 'CREDIT' },
    { code: '3001', name: '实收资本', value: manual.paidInCapital, direction: 'CREDIT' },
  ];

  for (const ma of manualAccounts) {
    // ★ 已建档财务报表优先：报表上写了就不用再问人
    const declared = manual.declaredBalances?.get(ma.code);
    if (declared) {
      const amount = round2(declared.amount);
      if (amount.isZero()) continue;
      push({
        accountCode: ma.code,
        accountName: ma.name,
        direction: ma.direction,
        amount,
        source: 'DECLARED',
        sourceNote:
          `取自已建档财务报表「${declared.label}」` +
          (manual.declaredStatementNote ? `（${manual.declaredStatementNote}）` : ''),
        needsReview: false,
      });
      continue;
    }

    if (ma.value === undefined || ma.value === '') {
      if (ma.code === '3001') {
        requiredInputs.push({
          field: 'paidInCapital',
          label: '实收资本',
          reason: '发票与申报记录中完全没有股东出资信息。',
          suggestion:
            '按营业执照注册资本与实缴情况填写；若从未实缴可填 0。' +
            '若上传过代账公司的资产负债表，这一项会自动取「实收资本」行，无需手填。',
        });
      } else if (ma.code === '1403' || ma.code === '1601') {
        requiredInputs.push({
          field: ma.code,
          label: ma.name,
          reason: '进项发票无法区分「已耗用」与「仍结存」，无法推算期末存货与固定资产原值。',
          suggestion:
            (ma.code === '1403'
              ? '若期末有库存，请提供盘点金额；若无库存（如服务业）可填 0。'
              : '请提供固定资产原值与累计折旧（可从固定资产台账获取）；若无固定资产可填 0。') +
            '或上传代账公司的资产负债表，这两项会自动取数。',
        });
      }
      continue;
    }
    const amount = round2(ma.value);
    if (amount.isZero()) continue;
    push({
      accountCode: ma.code,
      accountName: ma.name,
      direction: ma.direction,
      amount,
      source: 'MANUAL',
      sourceNote: '人工提供',
      needsReview: false,
    });
  }

  // ---------------------------------------------------------------- 五、累计未分配利润
  //
  // ★ 两种口径，必须让用户选择并理解差异：
  //
  //   A. 真实累计利润 = Σ各年净利润  →  这才是「未分配利润」的真实含义
  //   B. 倒轧差额       = 资产 − 负债 − 实收资本  →  恒等式决定的必须值
  //
  //   在数据完整时 A == B。在不完整重建时两者必然不等，
  //   差额 = 数据缺口（未导入的资产负债）。
  //   我们记账用 B（保证借贷平衡），但必须把 A 与差额显式展示出来，
  //   让人知道"这个数字里有多少是真实的、多少是凑的"。
  const cumulativeNetProfit = years.reduce(
    (s, y) => s.plus(y.netProfit ?? 0),
    new Decimal(0),
  );

  // 先算出资产负债侧合计（不含未分配利润）
  const assetLike = lines
    .filter((l) => l.direction === 'DEBIT')
    .reduce((s, l) => s.plus(l.amount), new Decimal(0));
  const liabilityLike = lines
    .filter((l) => l.direction === 'CREDIT')
    .reduce((s, l) => s.plus(l.amount), new Decimal(0));

  // 未分配利润（贷方）= 资产 − 负债
  const retainedEarnings = round2(assetLike.minus(liabilityLike));

  // ★ 若已建档的资产负债表上有「未分配利润」，那个数才是权威值。
  //   把它与倒轧值、与累计净利润三者并列展示 —— 差距就是数据缺口有多大。
  const declaredRetained = manual.declaredBalances?.get('3103');
  const declaredRetainedAmount = declaredRetained ? round2(declaredRetained.amount) : null;
  const gapVsDeclared =
    declaredRetainedAmount !== null
      ? round2(retainedEarnings.minus(declaredRetainedAmount))
      : null;

  if (retainedEarnings.gt(0)) {
    push({
      accountCode: '310401',
      accountName: '利润分配—未分配利润',
      direction: 'CREDIT',
      amount: retainedEarnings,
      source: 'DERIVED',
      sourceNote:
        `倒轧得出：资产合计 ${round2(assetLike).toFixed(2)} − 负债合计 ${round2(liabilityLike).toFixed(2)}。` +
        `★ 按各年净利润累计的真实值应为 ${round2(cumulativeNetProfit).toFixed(2)}，` +
        `两者相差 ${round2(retainedEarnings.minus(cumulativeNetProfit)).toFixed(2)}。` +
        (declaredRetainedAmount !== null
          ? `已建档财务报表上的「${declaredRetained!.label}」为 ${declaredRetainedAmount.toFixed(2)}，` +
            `与倒轧值相差 ${gapVsDeclared!.toFixed(2)}。`
          : '') +
        `这个差额**不是利润**，而是「未导入的资产与负债」留下的缺口 —— ` +
        `常见来源：实收资本、存货、固定资产、股东借款、实际应收账款余额。` +
        `每补录一项缺口就相应减小；缺口归零时说明历史数据已完整。` +
        (declaredRetainedAmount !== null
          ? '★ 已有资产负债表时，请优先相信报表上的数并在方案中手工改为此值。'
          : '★ 若手上有代账公司的资产负债表，上传到「识别录入」后这一行会自动变成报表上的真实值。'),
      needsReview: true,
      breakdown: {
        ...Object.fromEntries(
          years
            .filter((y) => y.netProfit !== null)
            .map((y) => [`${y.year} 年净利润`, round2(y.netProfit!).toFixed(2)]),
        ),
        ...(declaredRetainedAmount !== null
          ? { '报表上的未分配利润': declaredRetainedAmount.toFixed(2) }
          : {}),
      },
    });
  } else if (retainedEarnings.lt(0)) {
    push({
      accountCode: '310401',
      accountName: '利润分配—未分配利润',
      direction: 'DEBIT',
      amount: retainedEarnings.abs(),
      source: 'DERIVED',
      sourceNote: `倒轧得出为借方余额（累计亏损）：资产 ${round2(assetLike).toFixed(2)} < 负债 ${round2(liabilityLike).toFixed(2)}`,
      needsReview: true,
    });
  }

  // ---------------------------------------------------------------- 六、平衡检查与现金倒轧
  let totalDebit = lines
    .filter((l) => l.direction === 'DEBIT')
    .reduce((s, l) => s.plus(l.amount), new Decimal(0));
  let totalCredit = lines
    .filter((l) => l.direction === 'CREDIT')
    .reduce((s, l) => s.plus(l.amount), new Decimal(0));

  let difference = round2(totalDebit.minus(totalCredit));

  // ★ 未分配利润已经吸收了资产负债两侧的全部差额，因此到这里 difference 通常已经是 0。
  //   只有在一行都没有（极端情况）或出现异常时才不为 0。
  //   下面两种情况要分开表述，不能混为一谈：
  //     A. 现金为「被迫倒挤」出来的 —— 说明资产负债两侧本身对不上
  //     B. 现金用户未提供、方案里也没有这一行 —— 只是「不详」，不是「倒挤」
  let cashIsForcedPlug = false;

  if (cashBasis === 'DERIVED' && !difference.isZero()) {
    cashIsForcedPlug = true;
    if (difference.gt(0)) {
      // 借方少 → 增加货币资金（资产）
      cashBalance = difference;
      lines.push({
        accountCode: '1002',
        accountName: '银行存款',
        direction: 'DEBIT',
        amount: cashBalance,
        source: 'DERIVED',
        sourceNote:
          `★ 倒轧得出：为满足「资产 = 负债 + 所有者权益」，货币资金被倒挤为 ${cashBalance.toFixed(2)}。` +
          `这个数字**不是真实的银行余额**，只是让账能平。请务必用实际对账单余额替换。`,
        needsReview: true,
      });
    } else {
      // 贷方少 → 货币资金出现负数，说明数据存在矛盾
      warnings.push(
        `倒轧发现货币资金应为负数 ${difference.toFixed(2)}，这在现实中不可能。` +
          `说明导入的数据之间存在矛盾（例如应收账款高估、或漏了实收资本/借款）。` +
          `请优先补录实收资本、借款与实际应收账款余额。`,
      );
      cashBalance = difference; // 保留负数以便用户看到问题
      lines.push({
        accountCode: '1002',
        accountName: '银行存款',
        direction: 'CREDIT',
        amount: difference.abs(),
        source: 'DERIVED',
        sourceNote: '★ 倒轧为负数（异常）。请检查是否存在漏记的实收资本、借款或其他负债。',
        needsReview: true,
      });
    }

    // 重算合计
    totalDebit = lines
      .filter((l) => l.direction === 'DEBIT')
      .reduce((s, l) => s.plus(l.amount), new Decimal(0));
    totalCredit = lines
      .filter((l) => l.direction === 'CREDIT')
      .reduce((s, l) => s.plus(l.amount), new Decimal(0));
    difference = round2(totalDebit.minus(totalCredit));
  }

  // ---------------------------------------------------------------- 6.5 缺口交叉校验
  //
  // ★ 这是最容易被忽略、后果最严重的一类问题：
  //   未分配利润是方案的配平项，数据缺口会被它吸收。
  //   当「倒轧值」与「各年净利润累计值」偏离很大时，
  //   说明期初资产（银行存款、存货、固定资产、其他应收款）严重录入不全 ——
  //   账能平，但资产负债表是错的。
  const gap = round2(retainedEarnings.minus(cumulativeNetProfit));
  const gapMateriality = new Decimal(50000); // 5 万元以下不提示，避免噪音

  if (gap.abs().gt(gapMateriality)) {
    const gapDesc = gap.gt(0)
      ? `倒轧的未分配利润比真实累计净利润多 ${gap.toFixed(2)}`
      : `倒轧的未分配利润比真实累计净利润少 ${gap.abs().toFixed(2)}`;
    warnings.push(
      `⚠️ 数据缺口 ${gap.abs().toFixed(2)}：${gapDesc}。` +
        `这不是利润，而是「未录入的资产负债」被未分配利润吸收了。` +
        `账能平，但资产负债表是错的。请优先补录：` +
        (gap.gt(0)
          ? '实收资本、股东借款、其他应付款（负债侧漏记）'
          : '银行存款、存货、固定资产、其他应收款（资产侧漏记）') +
        `。缺口越小，期初方案越接近真实。`,
    );
  }

  // 若倒轧出巨额累计亏损而用户从未提供亏损依据，单独提示
  if (retainedEarnings.gt(0) === false && cumulativeNetProfit.gte(0) && retainedEarnings.abs().gt(gapMateriality)) {
    warnings.push(
      `⚠️ 倒轧出累计亏损 ${retainedEarnings.abs().toFixed(2)}，但历年净利润累计为盈利 ` +
        `${cumulativeNetProfit.toFixed(2)}，两者矛盾。这几乎一定意味着期初资产未录入完整。`,
    );
  }

  // ---------------------------------------------------------------- 七、汇总提示
  const derivedCount = lines.filter((l) => l.source === 'DERIVED').length;
  const reviewCount = lines.filter((l) => l.needsReview).length;

  if (cashBasis === 'DECLARED') {
    warnings.push('货币资金采用您提供的实际余额，可信度高。');
  } else if (cashIsForcedPlug) {
    warnings.push(
      '⚠️ 货币资金为**被迫倒挤**得出（资产负债两侧本身对不上），不可信。' +
        '请填入实际银行余额，并优先补录实收资本、借款与其他应收应付。',
    );
  } else {
    // 关键区分：货币资金不是"倒挤"出来的，而是"根本没有这一行"
    warnings.push(
      '⚠️ 方案中**没有货币资金这一行** —— 因为既没有您提供的银行余额，也不存在需要倒挤的差额。' +
        '若启用前实际有银行存款，请在「待补录项」中填入，否则期初会漏掉这笔资产，' +
        '并连带把缺口压进「未分配利润」。',
    );
  }

  if (derivedCount > 0) {
    warnings.push(
      `方案中有 ${derivedCount} 行为倒轧推算（未分配利润、货币资金等），` +
        `这些数字只保证「账能平」，不保证「账对」。请逐行核对并调整。`,
    );
  }

  const summary =
    `基于 ${years.length} 个历史年度（${years.map((y) => y.year).join('、')}）重建，` +
    `共 ${lines.length} 个科目行，其中 ${reviewCount} 行需人工确认。` +
    `启用期间 ${targetYear}-${String(targetMonth).padStart(2, '0')}。`;

  return {
    lines: lines.sort((a, b) => a.accountCode.localeCompare(b.accountCode)),
    totalDebit: round2(totalDebit),
    totalCredit: round2(totalCredit),
    difference,
    balanced: difference.isZero() && totalDebit.gt(0),
    cashBasis,
    cashBalance: round2(cashBalance),
    requiredInputs,
    warnings,
    summary,
  };
}
