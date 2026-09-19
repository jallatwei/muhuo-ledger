/**
 * 增值税及附加税费申报底稿
 * ============================================================
 * 一般纳税人，月度申报（季度申报的小规模不适用本模块口径）。
 *
 * ★ 本模块的定位是**底稿**，不是申报表本身。
 *   底稿要做的事只有一件：把账上的数按申报表的口径归集好、摆整齐、
 *   每一格都标明来源，让人对着电子税局 5 分钟填完。
 *
 *   所以：
 *   · 每一个格子都能回答"这个数从哪来"（账上哪个科目 / 发票聚合 / 上期申报表）
 *   · 算不出来的格子留空并说明原因，**绝不猜**
 *   · 申报表之间的勾稽关系做成自检项，不通过就显式报出来
 *
 * 现实约束（避免做无用功）：
 *   全国统一规范电子税务局目前不提供给普通企业的通用文件导入接口，
 *   所以底稿是 Excel + 逐格对照，不是"一键申报"。
 */
import { Decimal, round2 } from '@bookkeeper/shared';

/** 底稿里的一格 */
export interface Cell {
  /** 申报表行次（如 "1"、"11"） */
  line: string;
  /** 项目名称（照抄申报表原文，便于对照） */
  label: string;
  amount: Decimal | null;
  /** 数据来源，必须说清 */
  source: 'LEDGER' | 'INVOICE' | 'PRIOR_FILING' | 'CALCULATED' | 'MANUAL' | 'UNKNOWN';
  /** 来源说明（具体到科目编码或计算式） */
  sourceNote: string;
  /** 无法取数时的原因与补救建议 */
  blocked?: string;
}

export interface VatWorksheet {
  title: string;
  periodLabel: string;
  /** 纳税人口径 */
  taxpayerKind: string;
  mainForm: Cell[];
  /** 附列资料一：按税率分档的销售额与销项税 */
  annex1: Array<{
    taxRate: string;
    salesExclTax: Decimal;
    outputTax: Decimal;
    invoiceCount: number;
    note: string;
  }>;
  /** 附列资料二：进项税额明细 */
  annex2: Array<{
    item: string;
    amount: Decimal;
    source: Cell['source'];
    sourceNote: string;
  }>;
  /** 附加税费 */
  surtax: {
    base: Decimal;
    baseNote: string;
    city: Decimal;
    education: Decimal;
    localEducation: Decimal;
    total: Decimal;
    rates: { city: string; education: string; localEducation: string };
    /** ★ 小微减免的提示（只提示，需要人工判断是否适用） */
    reductionHint: string | null;
  };
  checks: Array<{ name: string; ok: boolean; expected?: string; actual?: string; detail: string }>;
  warnings: string[];
  /** 需要人工判断的政策事项 */
  policyNote: string[];
}

/** 附加税费率（可由配置覆盖；默认取最常见的口径） */
export interface SurtaxRates {
  /** 城市维护建设税：市区 7% / 县城、镇 5% / 其他 1% */
  city: string;
  /** 教育费附加：3% */
  education: string;
  /** 地方教育附加：2% */
  localEducation: string;
}

export const DEFAULT_SURTAX_RATES: SurtaxRates = {
  city: '0.07',
  education: '0.03',
  localEducation: '0.02',
};

export interface VatWorksheetInput {
  periodLabel: string;
  /** 增值税各明细科目的**本期发生额**（不是余额） */
  ledger: {
    /** 22210105 销项税额 贷方发生额 */
    outputTax: Decimal;
    /** 22210101 进项税额 借方发生额 */
    inputTaxCertified: Decimal;
    /** 22210102 待认证进项税额 */
    inputTaxPending: Decimal;
    /** 22210103 待抵扣进项税额 */
    inputTaxDeferred: Decimal;
    /** 22210104/… 进项税额转出 贷方发生额 */
    inputTaxTransferOut: Decimal;
    /** 22210108 简易计税销项税额 */
    outputTaxSimple: Decimal;
    /** 5001/6001 等收入类科目本期贷方发生额（用于与销售额交叉核对） */
    revenueOccurred: Decimal;
  };
  /** 发票聚合（部门/税率分档） */
  invoiceByRate: Array<{
    taxRate: string;
    amountExclTax: Decimal;
    taxAmount: Decimal;
    count: number;
    direction: 'INPUT' | 'OUTPUT';
  }>;
  /** 上期申报表（用于取「上期留抵税额」「期初未缴税额」） */
  priorFiling: {
    creditCarriedForward: Decimal | null;
    closingUnpaid: Decimal | null;
  } | null;
  /** 本期实际已缴税额（通常取上期期末未缴在本期缴纳的部分） */
  taxPaidThisPeriod: Decimal | null;
  surtaxRates?: SurtaxRates;
}

function cell(
  line: string,
  label: string,
  amount: Decimal | null,
  source: Cell['source'],
  sourceNote: string,
  blocked?: string,
): Cell {
  return {
    line,
    label,
    amount: amount === null ? null : round2(amount),
    source,
    sourceNote,
    blocked,
  };
}

/**
 * 生成增值税及附加税费申报底稿。
 *
 * 行次编号对照《增值税及附加税费申报表（一般纳税人适用）》主表。
 * 行次不追求与某一版税局表格逐字一致 —— 底稿的用途是对照填报，
 * 所以每格都写了项目名称原文，行次对不上时以名称为准。
 */
export function buildVatWorksheet(input: VatWorksheetInput): VatWorksheet {
  const L = input.ledger;
  const rates = input.surtaxRates ?? DEFAULT_SURTAX_RATES;
  const warnings: string[] = [];
  const policyNote: string[] = [];

  // ---------------------------------------------------------------- 销售额
  //
  // ★ 按税率分档反推销售额，而不是直接用利润表的"营业收入"。
  //   原因：营业收入含不征税收入、免税收入，且可能含未开票收入；
  //   而申报表的"销售额"是**增值税口径**。两者必须分开取数再交叉核对，
  //   直接混用会导致申报销售额与账面收入长期对不上，被税局预警。
  const outputByRate = input.invoiceByRate
    .filter((r) => r.direction === 'OUTPUT')
    .sort((a, b) => b.amountExclTax.comparedTo(a.amountExclTax));

  let salesFromInvoices = new Decimal(0);
  for (const r of outputByRate) salesFromInvoices = salesFromInvoices.plus(r.amountExclTax);

  // 账面销项税额反推的销售额（用于与发票聚合交叉核对）
  const blendedRate = computeBlendedRate(outputByRate);
  const salesFromLedger =
    blendedRate && blendedRate.gt(0) && L.outputTax.gt(0)
      ? round2(L.outputTax.div(blendedRate))
      : null;

  const salesExclTax =
    salesFromInvoices.gt(0) ? salesFromInvoices : (salesFromLedger ?? new Decimal(0));

  const salesSource: Cell['source'] = salesFromInvoices.gt(0) ? 'INVOICE' : L.outputTax.gt(0) ? 'CALCULATED' : 'UNKNOWN';
  const salesNote = salesFromInvoices.gt(0)
    ? `取自本期销项发票不含税金额合计（${outputByRate.length} 档税率，共 ${outputByRate.reduce((s, r) => s + r.count, 0)} 张）`
    : salesFromLedger
      ? `由账面销项税额 ${round2(L.outputTax).toFixed(2)} ÷ 加权税率 ${blendedRate?.toFixed(4)} 反推。★ 反推值仅供参考，请以开票数据为准`
      : '本期既没有销项发票，账面也没有销项税额，销售额按 0 填列';

  // ---------------------------------------------------------------- 主表
  const mainForm: Cell[] = [];

  mainForm.push(
    cell('1', '按适用税率计税销售额', salesExclTax, salesSource, salesNote,
      salesSource === 'UNKNOWN' ? '无法取数：本期无销项发票且账面无销项税额。若确实无销售，按 0 填报。' : undefined),
  );
  mainForm.push(
    cell('5', '按简易办法计税销售额', new Decimal(0), 'LEDGER',
      '本主体未使用简易计税（账面 22210108 无发生额）'),
  );
  mainForm.push(
    cell('8', '免税销售额', new Decimal(0), 'LEDGER',
      '账面未单独核算免税销售额；若本期有免税业务，请手工补填并确认对应的进项税额转出'),
  );

  // 销项税额
  mainForm.push(
    cell('11', '销项税额', L.outputTax, 'LEDGER',
      '科目 22210105 应交税费—应交增值税（销项税额）本期贷方发生额'),
  );

  // 进项税额
  const inputTaxTotal = L.inputTaxCertified.plus(L.inputTaxDeferred);
  mainForm.push(
    cell('12', '进项税额', L.inputTaxCertified, 'LEDGER',
      '科目 22210101 应交税费—应交增值税（进项税额）本期借方发生额（已认证抵扣部分）'),
  );
  mainForm.push(
    cell('13', '上期留抵税额', input.priorFiling?.creditCarriedForward ?? null,
      input.priorFiling ? 'PRIOR_FILING' : 'UNKNOWN',
      input.priorFiling
        ? '取自上期增值税申报表主表第 20 行「期末留抵税额」'
        : '未找到上期申报表',
      input.priorFiling ? undefined : '请手工填入上期申报表第 20 行；若上期无留抵则填 0'),
  );
  mainForm.push(
    cell('14', '进项税额转出', L.inputTaxTransferOut, 'LEDGER',
      '科目 22210104 应交税费—应交增值税（进项税额转出）本期贷方发生额'),
  );

  // 应抵扣税额合计 = 12 + 13 − 14
  const creditBrought = input.priorFiling?.creditCarriedForward ?? new Decimal(0);
  const deductibleTotal = round2(L.inputTaxCertified.plus(creditBrought).minus(L.inputTaxTransferOut));
  mainForm.push(
    cell('17', '应抵扣税额合计', deductibleTotal, 'CALCULATED',
      `= 第12行 ${round2(L.inputTaxCertified).toFixed(2)} + 第13行 ${round2(creditBrought).toFixed(2)} − 第14行 ${round2(L.inputTaxTransferOut).toFixed(2)}`),
  );

  // 实际抵扣税额 = min(17, 11)
  const actualDeducted = round2(
    deductibleTotal.gt(L.outputTax) ? L.outputTax : deductibleTotal,
  );
  mainForm.push(
    cell('18', '实际抵扣税额', actualDeducted, 'CALCULATED',
      '= min(第17行 应抵扣税额合计, 第11行 销项税额)。当期抵扣以销项税额为限，超出部分形成留抵'),
  );

  // 应纳税额 = 11 − 18
  const taxPayable = round2(L.outputTax.minus(actualDeducted));
  mainForm.push(
    cell('19', '应纳税额', taxPayable, 'CALCULATED', '= 第11行 销项税额 − 第18行 实际抵扣税额'),
  );

  // 期末留抵 = 17 − 18
  const creditCarriedForward = round2(deductibleTotal.minus(actualDeducted));
  mainForm.push(
    cell('20', '期末留抵税额', creditCarriedForward, 'CALCULATED',
      '= 第17行 应抵扣税额合计 − 第18行 实际抵扣税额。该数应结转到下期第 13 行'),
  );

  mainForm.push(
    cell('21', '简易计税应纳税额', L.outputTaxSimple, 'LEDGER',
      '科目 22210108 本期贷方发生额'),
  );

  const taxPayableTotal = round2(taxPayable.plus(L.outputTaxSimple));
  mainForm.push(
    cell('24', '应纳税额合计', taxPayableTotal, 'CALCULATED',
      '= 第19行 应纳税额 + 第21行 简易计税应纳税额'),
  );

  // 缴税
  mainForm.push(
    cell('25', '期初未缴税额', input.priorFiling?.closingUnpaid ?? null,
      input.priorFiling ? 'PRIOR_FILING' : 'UNKNOWN',
      input.priorFiling ? '取自上期申报表主表第 32 行「期末未缴税额」' : '未找到上期申报表',
      input.priorFiling ? undefined : '请手工填入上期申报表第 32 行；若上期无未缴则填 0'),
  );
  mainForm.push(
    cell('27', '本期已缴税额', input.taxPaidThisPeriod, input.taxPaidThisPeriod ? 'PRIOR_FILING' : 'UNKNOWN',
      input.taxPaidThisPeriod
        ? '取自本期实际缴纳的上期税款'
        : '未取到本期缴税记录',
      input.taxPaidThisPeriod ? undefined : '请手工填入本期实际缴纳的增值税额；若本期未缴则填 0'),
  );

  const openingUnpaid = input.priorFiling?.closingUnpaid ?? new Decimal(0);
  const paidThisPeriod = input.taxPaidThisPeriod ?? new Decimal(0);
  const closingUnpaid = round2(taxPayableTotal.plus(openingUnpaid).minus(paidThisPeriod));
  mainForm.push(
    cell('32', '期末未缴税额', closingUnpaid, 'CALCULATED',
      `= 第24行 ${round2(taxPayableTotal).toFixed(2)} + 第25行 ${round2(openingUnpaid).toFixed(2)} − 第27行 ${round2(paidThisPeriod).toFixed(2)}`),
  );
  mainForm.push(
    cell('34', '本期应补(退)税额', closingUnpaid, 'CALCULATED',
      '= 第32行 期末未缴税额（本栏即本期实际应缴纳的金额）'),
  );

  // ---------------------------------------------------------------- 附列资料一
  const annex1 = outputByRate.map((r) => ({
    taxRate: formatRate(r.taxRate),
    salesExclTax: round2(r.amountExclTax),
    outputTax: round2(r.taxAmount),
    invoiceCount: r.count,
    note: '取自本期销项发票，按税率分档',
  }));

  if (annex1.length === 0 && L.outputTax.gt(0)) {
    annex1.push({
      taxRate: blendedRate ? formatRate(blendedRate.toFixed(4)) : '（未知）',
      salesExclTax: salesExclTax,
      outputTax: round2(L.outputTax),
      invoiceCount: 0,
      note: '★ 没有销项发票数据，仅有账面销项税额。附列资料一需要按税率分档填列，请补充开票数据后再填',
    });
    warnings.push(
      '本期有账面销项税额但没有销项发票数据，附列资料一（按税率分档的销售明细）无法完整填列。' +
        '请先导入开票明细，或手工按税率拆分销项税额。',
    );
  }

  // ---------------------------------------------------------------- 附列资料二
  const annex2 = [
    {
      item: '认证相符的增值税专用发票（本期认证本期申报抵扣）',
      amount: round2(L.inputTaxCertified),
      source: 'LEDGER' as const,
      sourceNote: '科目 22210101 本期借方发生额',
    },
    {
      item: '待抵扣进项税额（本期转入）',
      amount: round2(L.inputTaxDeferred),
      source: 'LEDGER' as const,
      sourceNote: '科目 22210103 本期转入额',
    },
    {
      item: '进项税额转出额',
      amount: round2(L.inputTaxTransferOut),
      source: 'LEDGER' as const,
      sourceNote: '科目 22210104 本期贷方发生额',
    },
  ];

  if (L.inputTaxPending.gt(0)) {
    annex2.push({
      item: '待认证进项税额（本期发生，尚未认证）',
      amount: round2(L.inputTaxPending),
      source: 'LEDGER',
      sourceNote:
        '科目 22210102 本期借方发生额。★ 该部分**不进入**主表第12行，认证通过后才可抵扣',
    });
    policyNote.push(
      `本期有 ${round2(L.inputTaxPending).toFixed(2)} 元进项税额处于「待认证」状态。` +
        '这部分不能在本期申报抵扣；请在完成勾选认证后，于认证所属期填入主表第 12 行。',
    );
  }

  // ---------------------------------------------------------------- 附加税费
  //
  // ★ 计税依据是「实际缴纳的增值税」，不是应纳税额。
  //   留抵、预缴、减免都会影响实际缴纳数，直接用应纳税额算附加税费会多算。
  const surtaxBase = taxPayableTotal.gt(0) ? taxPayableTotal : new Decimal(0);

  const cityTax = round2(surtaxBase.times(rates.city));
  const educationSurcharge = round2(surtaxBase.times(rates.education));
  const localEducationSurcharge = round2(surtaxBase.times(rates.localEducation));
  const surtaxTotal = round2(cityTax.plus(educationSurcharge).plus(localEducationSurcharge));

  // 小微减免提示：只提示，是否适用由人判断
  const reductionHint =
    surtaxBase.gt(0)
      ? '增值税小规模纳税人、小型微利企业和个体工商户可享受「六税两费」减半征收。' +
        '★ 是否适用需要按你当期的小型微利企业认定结果判断，本系统不代为判定；' +
        '若适用，请在申报时按减半后的金额填列，并保留认定依据。'
      : null;

  // ★ 城建税档位提示与"本期有没有税"无关 —— 它是按报税地的口径提示，
  //   放在 if (base > 0) 里会导致本期无税时提示消失，而用户下次有税时
  //   又不会重新想起要看它。所以无条件给出。
  policyNote.push(
    '★ 附加税费的城建税税率按纳税人所在地分档：市区 7%、县城与镇 5%、其他 1%。' +
      '请确认你的报税地适用档位，并通过 surtaxRates 参数按你的档位生成底稿。' +
      '教育费附加 3%、地方教育附加 2% 为常见口径，各地可能有差异。' +
      '另外，「六税两费」减半征收是否适用于你，需要按小型微利企业认定结果判断。',
  );

  if (surtaxBase.gt(0)) {
    policyNote.push(
      `本期附加税费的计税依据是实际应缴纳的增值税 ${surtaxBase.toFixed(2)} 元，` +
        `当前使用的税率：城建税 ${formatRate(rates.city)}、教育费附加 ${formatRate(rates.education)}、` +
        `地方教育附加 ${formatRate(rates.localEducation)}。`,
    );
  }

  // ---------------------------------------------------------------- 勾稽自检
  const checks = [
    {
      name: '账面销项税额 = 附列资料一销项税额合计',
      ok: round2(annex1.reduce((s, r) => s.plus(r.outputTax), new Decimal(0))).eq(round2(L.outputTax)),
      expected: round2(annex1.reduce((s, r) => s.plus(r.outputTax), new Decimal(0))).toFixed(2),
      actual: round2(L.outputTax).toFixed(2),
      detail:
        '两边不等通常意味着有未开票收入已入账，或有开票未入账。' +
        '未开票收入在申报表上要填在「未开具发票」列，仍然要申报 —— 不是不用填。',
    },
    {
      name: '应纳税额合计 ≥ 0',
      ok: taxPayableTotal.gte(0),
      actual: round2(taxPayableTotal).toFixed(2),
      detail: '若为负说明留抵计算有误：留抵应体现在第 20 行，不应让应纳税额为负。',
    },
    {
      name: '期末未缴税额 = 应纳税额合计 + 期初未缴 − 本期已缴',
      ok: round2(taxPayableTotal.plus(openingUnpaid).minus(paidThisPeriod)).eq(closingUnpaid),
      expected: round2(taxPayableTotal.plus(openingUnpaid).minus(paidThisPeriod)).toFixed(2),
      actual: closingUnpaid.toFixed(2),
      detail: '表内计算关系。',
    },
  ];

  // 销售额与账面收入的交叉核对（差异不一定错，但必须解释）
  if (L.revenueOccurred.abs().gt(0) && salesExclTax.gt(0)) {
    const revenueAbs = L.revenueOccurred.abs();
    const diff = round2(salesExclTax.minus(revenueAbs));
    if (!diff.isZero()) {
      const pct = revenueAbs.gt(0) ? diff.abs().div(revenueAbs).times(100) : new Decimal(0);
      checks.push({
        name: '申报销售额 ≈ 账面营业收入',
        ok: pct.lte(5),
        expected: round2(revenueAbs).toFixed(2),
        actual: round2(salesExclTax).toFixed(2),
        detail:
          `相差 ${diff.toFixed(2)}（${pct.toFixed(2)}%）。` +
          '两者口径本就不同：申报销售额是不含税的增值税应税销售额，' +
          '营业收入可能含不征税收入、视同销售、未开票收入，也可能有跨期确认差异。' +
          '差异本身不是错误，但**必须能说清原因** —— 说不清就是被预警的信号。',
      });
    }
  }

  return {
    title: '增值税及附加税费申报底稿',
    periodLabel: input.periodLabel,
    taxpayerKind: '增值税一般纳税人（月报）',
    mainForm,
    annex1,
    annex2,
    surtax: {
      base: surtaxBase,
      baseNote: '计税依据 = 本期实际应缴纳的增值税（第24行）',
      city: cityTax,
      education: educationSurcharge,
      localEducation: localEducationSurcharge,
      total: surtaxTotal,
      rates,
      reductionHint,
    },
    checks,
    warnings,
    policyNote,
  };
}

/** 加权平均税率（按销售额加权） */
function computeBlendedRate(
  rows: Array<{ taxRate: string; amountExclTax: Decimal }>,
): Decimal | null {
  let sales = new Decimal(0);
  let tax = new Decimal(0);
  for (const r of rows) {
    const rate = new Decimal(r.taxRate || '0');
    if (!rate.isFinite() || rate.lte(0)) continue;
    sales = sales.plus(r.amountExclTax);
    tax = tax.plus(r.amountExclTax.times(rate));
  }
  if (sales.isZero()) return null;
  return tax.div(sales);
}

function formatRate(rate: string): string {
  const d = new Decimal(rate || '0');
  if (!d.isFinite()) return rate;
  return `${d.times(100).toDecimalPlaces(2).toString()}%`;
}
