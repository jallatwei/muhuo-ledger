/**
 * 企业所得税申报底稿（季度预缴 + 年度汇算清缴）
 * ============================================================
 * 小企业会计准则 + 小型微利企业优惠场景。
 *
 * ★ 与增值税底稿最大的区别：企业所得税的口径**大量依赖判断**，
 *   而不是简单的科目归集。所以这份底稿的写法是：
 *
 *     · 能按税法规定直接算的（如利润总额、按税率算应纳所得税额）→ 算出来
 *     · 需要判断的（纳税调整、优惠适用、弥补亏损）→ **留空并列出依据要求**
 *     · 每一格标明"账上取数"还是"需要人工判断"
 *
 *   为什么不做成"自动算完"：
 *     纳税调整项（业务招待费扣除限额、广告费结转、罚款不得扣除…）
 *     每一项都需要看具体凭证与业务实质。系统自动算出来的调整额
 *     如果错了，用户会直接照着申报 —— 那比不给结果更糟。
 *
 * 时效性声明：
 *   税率与优惠门槛会变。本文件里的税率是**默认值**，可由配置覆盖；
 *   政策变动由「税务政策检索」模块负责发现并提示，不由代码写死。
 */
import { Decimal, round2 } from '@bookkeeper/shared';

export interface CitCell {
  line: string;
  label: string;
  amount: Decimal | null;
  source: 'LEDGER' | 'CALCULATED' | 'MANUAL' | 'JUDGEMENT' | 'UNKNOWN';
  sourceNote: string;
  /** 需要人工判断的说明 */
  judgement?: string;
}

export interface CitWorksheet {
  title: string;
  periodLabel: string;
  /** QUARTERLY 季度预缴 | ANNUAL 汇算清缴 */
  kind: 'QUARTERLY' | 'ANNUAL';
  cells: CitCell[];
  /** 纳税调整项清单（年度汇算用） */
  adjustments: Array<{
    item: string;
    amount: Decimal | null;
    basis: string;
    needJudgement: boolean;
  }>;
  /** 优惠适用判断 */
  preferences: Array<{
    name: string;
    applicable: 'YES' | 'NO' | 'UNKNOWN';
    condition: string;
    note: string;
  }>;
  checks: Array<{ name: string; ok: boolean; expected?: string; actual?: string; detail: string }>;
  warnings: string[];
  /** 必须由人确认的事项 */
  requiresHumanDecision: string[];
}

/** 企业所得税税率（默认值，可由配置覆盖） */
export interface CitRates {
  /** 法定税率 */
  standard: string;
  /** 小型微利企业实际税负（应纳税所得额 ≤ 300 万部分） */
  smallMicro: string;
  /** 小型微利企业应纳税所得额上限 */
  smallMicroCap: string;
  /** 高新技术企业 */
  highTech: string;
}

export const DEFAULT_CIT_RATES: CitRates = {
  standard: '0.25',
  smallMicro: '0.05',
  smallMicroCap: '3000000',
  highTech: '0.15',
};

export interface CitWorksheetInput {
  periodLabel: string;
  kind: 'QUARTERLY' | 'ANNUAL';
  /** 利润表口径的累计数（取自报表） */
  incomeStatement: {
    revenue: Decimal;
    cost: Decimal;
    taxSurcharge: Decimal;
    sellingExpense: Decimal;
    adminExpense: Decimal;
    financeExpense: Decimal;
    investIncome: Decimal;
    nonOpIncome: Decimal;
    nonOpExpense: Decimal;
    profitBeforeTax: Decimal;
  };
  /** 从账上能直接取到的、已知需要调整的项 */
  knownAdjustments: {
    /** 业务招待费发生额（有扣除限额，必然需要调整） */
    entertainment: Decimal;
    /** 广告费和业务宣传费发生额（有扣除限额） */
    advertising: Decimal;
    /** 税收滞纳金、罚款、罚金（不得扣除） */
    finesAndPenalties: Decimal;
    /** 公益性捐赠支出（限额扣除） */
    publicDonation: Decimal;
    /** 无票成本（未取得合规凭证，不得扣除） */
    costWithoutInvoice: Decimal;
  };
  /** 已预缴税额（本年度累计） */
  prepaidThisYear: Decimal | null;
  /** 以前年度亏损可弥补额 */
  lossCarryForward: Decimal | null;
  rates?: CitRates;
}

function cell(
  line: string,
  label: string,
  amount: Decimal | null,
  source: CitCell['source'],
  sourceNote: string,
  judgement?: string,
): CitCell {
  return { line, label, amount: amount === null ? null : round2(amount), source, sourceNote, judgement };
}

/**
 * 生成企业所得税申报底稿。
 *
 * 季度预缴用的是**实际利润额**口径（按会计利润预缴，年度汇算时再调整），
 * 所以季度底稿比年度简单得多 —— 这个差异在底稿里要写清楚，
 * 避免用户拿季度表当年度表用。
 */
export function buildCitWorksheet(input: CitWorksheetInput): CitWorksheet {
  const rates = input.rates ?? DEFAULT_CIT_RATES;
  const is = input.incomeStatement;
  const warnings: string[] = [];
  const requiresHumanDecision: string[] = [];

  const cells: CitCell[] = [];

  // ---------------------------------------------------------------- 利润总额
  cells.push(
    cell('1', '营业收入', is.revenue, 'LEDGER', '取自利润表第 1 行（本年累计）'),
  );
  cells.push(
    cell('2', '营业成本', is.cost, 'LEDGER', '取自利润表第 2 行（本年累计）'),
  );
  cells.push(
    cell('3', '税金及附加', is.taxSurcharge, 'LEDGER', '取自利润表第 3 行'),
  );
  cells.push(
    cell('4', '销售费用', is.sellingExpense, 'LEDGER', '取自利润表第 4 行'),
  );
  cells.push(
    cell('5', '管理费用', is.adminExpense, 'LEDGER', '取自利润表第 5 行'),
  );
  cells.push(
    cell('6', '财务费用', is.financeExpense, 'LEDGER', '取自利润表第 6 行'),
  );
  cells.push(
    cell('7', '投资收益', is.investIncome, 'LEDGER', '取自利润表第 7 行'),
  );
  cells.push(
    cell('8', '营业外收入', is.nonOpIncome, 'LEDGER', '取自利润表第 9 行'),
  );
  cells.push(
    cell('9', '营业外支出', is.nonOpExpense, 'LEDGER', '取自利润表第 10 行'),
  );

  // 利润总额：优先用报表算出来的，同时用利润表第11行交叉核对
  const computedProfit = round2(
    is.revenue
      .minus(is.cost)
      .minus(is.taxSurcharge)
      .minus(is.sellingExpense)
      .minus(is.adminExpense)
      .minus(is.financeExpense)
      .plus(is.investIncome)
      .plus(is.nonOpIncome)
      .minus(is.nonOpExpense),
  );
  cells.push(
    cell(
      '10',
      '利润总额',
      is.profitBeforeTax,
      'LEDGER',
      `取自利润表第 11 行。按分项重算为 ${computedProfit.toFixed(2)}，两者应相等`,
    ),
  );

  // ---------------------------------------------------------------- 季度预缴口径
  let taxableIncome: Decimal | null = null;
  let taxRateUsed = rates.standard;
  let taxPayable: Decimal | null = null;

  if (input.kind === 'QUARTERLY') {
    cells.push(
      cell(
        '11',
        '特定业务计算的应纳税所得额',
        new Decimal(0),
        'JUDGEMENT',
        '房地产开发等特定业务专用；一般企业填 0',
        '如果你的企业涉及房地产开发等特定业务，这一行需要按专门规定计算，系统不代为计算。',
      ),
    );

    // 季度预缴按会计利润预缴，不做纳税调整（除特定业务与不征税收入）
    taxableIncome = is.profitBeforeTax;

    // 弥补以前年度亏损
    const lossOffset =
      input.lossCarryForward && input.lossCarryForward.gt(0)
        ? Decimal.min(input.lossCarryForward, Decimal.max(is.profitBeforeTax, new Decimal(0)))
        : new Decimal(0);
    cells.push(
      cell(
        '12',
        '减：弥补以前年度亏损',
        input.lossCarryForward === null ? null : round2(lossOffset),
        input.lossCarryForward === null ? 'UNKNOWN' : 'MANUAL',
        input.lossCarryForward === null
          ? '未提供可弥补亏损额'
          : `以前年度可弥补亏损 ${round2(input.lossCarryForward).toFixed(2)}`,
        input.lossCarryForward === null
          ? '请提供以前年度汇算清缴确认的可弥补亏损余额；若没有则填 0'
          : '★ 季度预缴可弥补以前年度亏损，但需以已完成汇算清缴确认的亏损额为限。',
      ),
    );
    taxableIncome = round2(Decimal.max(is.profitBeforeTax.minus(lossOffset), new Decimal(0)));
    cells.push(
      cell('13', '实际利润额', taxableIncome, 'CALCULATED', '= 利润总额 − 弥补以前年度亏损'),
    );

    // 税率：按小型微利企业判断
    const pref = judgeSmallMicro(taxableIncome, rates);
    taxRateUsed = pref.rate;
    cells.push(
      cell(
        '14',
        '税率',
        new Decimal(taxRateUsed),
        pref.applicable === 'YES' ? 'CALCULATED' : 'JUDGEMENT',
        pref.note,
        pref.applicable === 'UNKNOWN' ? pref.condition : undefined,
      ),
    );

    taxPayable = round2(taxableIncome.times(taxRateUsed));
    cells.push(
      cell('15', '应纳所得税额', taxPayable, 'CALCULATED', `= 实际利润额 × ${formatRate(taxRateUsed)}`),
    );
  } else {
    // ---------------------------------------------------------------- 年度汇算口径
    cells.push(
      cell(
        '11',
        '纳税调整增加额',
        null,
        'JUDGEMENT',
        '需要逐项分析后填列',
        '★ 这一项必须人工判断。系统已在下方列出有调整线索的项目，但扣除限额的计算、' +
          '以及是否属于「与取得收入有关的合理支出」，需要结合业务实质判断。',
      ),
    );
    cells.push(
      cell(
        '12',
        '纳税调整减少额',
        null,
        'JUDGEMENT',
        '需要逐项分析后填列',
        '免税收入、减计收入、加计扣除等在此填列。',
      ),
    );
    cells.push(
      cell(
        '13',
        '纳税调整后所得',
        null,
        'UNKNOWN',
        '= 利润总额 + 调整增加额 − 调整减少额',
        '需要先完成第 11、12 行的判断才能计算。',
      ),
    );

    const lossOffset =
      input.lossCarryForward && input.lossCarryForward.gt(0) ? input.lossCarryForward : new Decimal(0);
    cells.push(
      cell(
        '14',
        '减：弥补以前年度亏损',
        input.lossCarryForward === null ? null : round2(lossOffset),
        input.lossCarryForward === null ? 'UNKNOWN' : 'MANUAL',
        input.lossCarryForward === null ? '未提供可弥补亏损额' : '取自以前年度汇算清缴确认数',
      ),
    );

    cells.push(
      cell('15', '应纳税所得额', null, 'UNKNOWN', '= 纳税调整后所得 − 弥补以前年度亏损',
        '需要先完成纳税调整。'),
    );

    const pref = judgeSmallMicro(null, rates);
    // ★ 年度汇算的税率**不能预填**。
    //   税率取决于应纳税所得额规模与小微/高新资格，而应纳税所得额要先完成纳税调整才知道。
    //   先填一个 25% 出来，用户很可能就照着申报了 —— 那正是本底稿最该避免的事。
    cells.push(
      cell(
        '16',
        '税率',
        null,
        'JUDGEMENT',
        `法定税率 ${formatRate(rates.standard)}；若符合小型微利企业条件，` +
          `应纳税所得额不超过 ${Number(rates.smallMicroCap).toLocaleString('zh-CN')} 元的部分按 ${formatRate(rates.smallMicro)} 计算。`,
        '★ 税率取决于应纳税所得额规模与优惠资格。请先完成纳税调整、算出应纳税所得额，再确认适用税率 —— ' +
          '系统不预填，避免被当成结论照抄。',
      ),
    );

    cells.push(
      cell('17', '应纳所得税额', null, 'UNKNOWN', '= 应纳税所得额 × 税率',
        '需要先完成纳税调整与税率确认。'),
    );
  }

  // ---------------------------------------------------------------- 已预缴与应补退
  if (input.kind === 'ANNUAL') {
    cells.push(
      cell('18', '减：本年实际已预缴所得税额', input.prepaidThisYear, input.prepaidThisYear === null ? 'UNKNOWN' : 'MANUAL',
        input.prepaidThisYear === null
          ? '未取到本年预缴记录'
          : '取自本年各季度预缴申报的实际缴纳额合计',
        input.prepaidThisYear === null ? '请手工填入本年已预缴的所得税合计' : undefined),
    );
    cells.push(
      cell('19', '本年应补(退)所得税额', null, 'UNKNOWN',
        '= 应纳所得税额 − 本年已预缴 + 以前年度多缴/少缴',
        '需要先完成应纳所得税额的计算。'),
    );
  } else {
    cells.push(
      cell('16', '减：以前季度已预缴', input.prepaidThisYear, input.prepaidThisYear === null ? 'UNKNOWN' : 'MANUAL',
        input.prepaidThisYear === null ? '未取到已预缴记录' : '取自已完成申报的以前季度预缴额合计',
        input.prepaidThisYear === null ? '请手工填入以前季度已预缴的所得税合计；若为首个季度则填 0' : undefined),
    );
    if (taxPayable !== null) {
      const due = round2(taxPayable.minus(input.prepaidThisYear ?? new Decimal(0)));
      cells.push(
        cell('17', '本期应补(退)所得税额', due, 'CALCULATED',
          `= 应纳所得税额 ${taxPayable.toFixed(2)} − 已预缴 ${round2(input.prepaidThisYear ?? 0).toFixed(2)}`),
      );
    }
  }

  // ---------------------------------------------------------------- 纳税调整线索（年度）
  const adjustments: CitWorksheet['adjustments'] = [];
  if (input.kind === 'ANNUAL') {
    const ka = input.knownAdjustments;

    adjustments.push({
      item: '业务招待费',
      amount: ka.entertainment,
      basis:
        '按发生额的 60% 扣除，且最高不得超过当年营业收入的 5‰，两者孰低。' +
        `本期发生额 ${round2(ka.entertainment).toFixed(2)}，` +
        `按 60% 为 ${round2(ka.entertainment.times('0.6')).toFixed(2)}，` +
        `按营业收入 5‰ 为 ${round2(is.revenue.times('0.005')).toFixed(2)}，` +
        `可扣除额为两者孰低，超出部分调增。`,
      needJudgement: true,
    });

    adjustments.push({
      item: '广告费和业务宣传费',
      amount: ka.advertising,
      basis:
        '一般企业不超过当年营业收入 15% 的部分准予扣除，超过部分准予在以后纳税年度结转扣除。' +
        `本期发生额 ${round2(ka.advertising).toFixed(2)}，扣除限额 ${round2(is.revenue.times('0.15')).toFixed(2)}。`,
      needJudgement: true,
    });

    adjustments.push({
      item: '税收滞纳金、罚金、罚款和被没收财物的损失',
      amount: ka.finesAndPenalties,
      basis:
        '★ 不得扣除，应全额调增。注意区分：行政性罚款（不得扣除）与经营性违约金（可以扣除）。' +
        `本期账面发生额 ${round2(ka.finesAndPenalties).toFixed(2)}。`,
      needJudgement: true,
    });

    adjustments.push({
      item: '公益性捐赠支出',
      amount: ka.publicDonation,
      basis:
        '不超过年度利润总额 12% 的部分准予扣除，超过部分准予结转以后三年内扣除。' +
        '★ 需确认是否属于**公益性**捐赠（通过公益性社会组织或县级以上政府），' +
        '直接捐赠不得扣除。',
      needJudgement: true,
    });

    if (ka.costWithoutInvoice.gt(0)) {
      adjustments.push({
        item: '无合规凭证的成本费用',
        amount: ka.costWithoutInvoice,
        basis:
          `★ 未取得合规扣除凭证的成本 ${round2(ka.costWithoutInvoice).toFixed(2)} 元，` +
          '原则上不得税前扣除，应调增。若在汇算清缴期结束前取得合规凭证，可以扣除。' +
          '（该数据来自历史数据重建中识别出的无票成本）',
        needJudgement: true,
      });
    }

    requiresHumanDecision.push(
      '纳税调整项必须逐项人工判断：扣除限额的计算、业务实质的认定、' +
        '以及凭证是否合规，都需要看具体凭证。系统列出线索与依据，但不代填。',
    );
  }

  // ---------------------------------------------------------------- 优惠判断
  const smallMicro = judgeSmallMicro(input.kind === 'QUARTERLY' ? taxableIncome : null, rates);
  const preferences: CitWorksheet['preferences'] = [
    {
      name: '小型微利企业优惠',
      applicable: smallMicro.applicable,
      condition:
        `同时满足：年度应纳税所得额不超过 ${Number(rates.smallMicroCap).toLocaleString('zh-CN')} 元、` +
        '从业人数不超过 300 人、资产总额不超过 5000 万元，且从事国家非限制和禁止行业。',
      note:
        `${smallMicro.note} ★ 从业人数与资产总额系统无法从账上判断（涉及用工与资产口径），` +
        '请自行确认；三项条件必须**同时**满足才能适用。',
    },
  ];

  if (smallMicro.applicable === 'UNKNOWN') {
    requiresHumanDecision.push(
      '小型微利企业资格需要确认三个条件（应纳税所得额、从业人数、资产总额），' +
        '系统只能算出第一个，其余两项请核对后确认。',
    );
  }

  // ---------------------------------------------------------------- 自检
  const checks: Array<{ name: string; ok: boolean; expected?: string; actual?: string; detail: string }> = [
    {
      name: '利润总额与利润表一致',
      ok: is.profitBeforeTax.eq(computedProfit),
      expected: computedProfit.toFixed(2),
      actual: round2(is.profitBeforeTax).toFixed(2),
      detail:
        '企业所得税以会计利润为起点，所以利润表必须先对。' +
        '两者不等说明利润表本身有问题，应先在账上查清，而不是在企业所得税表上调整。',
    },
  ];

  if (input.kind === 'QUARTERLY' && taxableIncome !== null) {
    if (taxableIncome.lt(0)) {
      warnings.push(
        `本期实际利润额为负（${taxableIncome.toFixed(2)}），本期无需预缴。` +
          '亏损可在以后年度弥补，但要注意季度预缴表上亏损如何填列（通常填 0 或负数，按当地税局要求）。',
      );
    }
  }

  if (input.kind === 'QUARTERLY') {
    policyNoteForQuarterly(requiresHumanDecision, warnings);
  }

  return {
    title:
      input.kind === 'QUARTERLY'
        ? '企业所得税季度预缴申报底稿'
        : '企业所得税年度汇算清缴底稿',
    periodLabel: input.periodLabel,
    kind: input.kind,
    cells,
    adjustments,
    preferences,
    checks,
    warnings,
    requiresHumanDecision,
  };
}

// ============================================================================

function policyNoteForQuarterly(requiresHumanDecision: string[], warnings: string[]): void {
  requiresHumanDecision.push(
    '季度预缴按**会计利润**预缴，通常不做纳税调整（特定业务除外）；' +
      '纳税调整留到年度汇算清缴时统一处理。不要拿季度表当年度表用。',
  );
  warnings.push(
    '★ 时效性提示：小型微利企业优惠的具体标准、税率与执行期限可能随政策调整。' +
      '本底稿使用的是系统内置的默认值，请以申报当期有效的政策文件为准。',
  );
}

/** 小型微利企业资格判断（只能判断应纳税所得额这一项） */
function judgeSmallMicro(
  taxableIncome: Decimal | null,
  rates: CitRates,
): { applicable: 'YES' | 'NO' | 'UNKNOWN'; rate: string; note: string; condition: string } {
  const condition =
    `年度应纳税所得额不超过 ${Number(rates.smallMicroCap).toLocaleString('zh-CN')} 元、` +
    '从业人数不超过 300 人、资产总额不超过 5000 万元，且从事国家非限制和禁止行业。';

  if (taxableIncome === null) {
    return {
      applicable: 'UNKNOWN',
      rate: rates.standard,
      note: '应纳税所得额尚未算出，无法判断是否适用小型微利企业优惠。',
      condition,
    };
  }

  const cap = new Decimal(rates.smallMicroCap);
  if (taxableIncome.lte(cap)) {
    return {
      applicable: 'UNKNOWN',
      rate: rates.smallMicro,
      note:
        `应纳税所得额 ${round2(taxableIncome).toFixed(2)} 未超过 ${cap.toFixed(0)} 元，` +
        '这一项条件满足；但还需确认从业人数与资产总额两项条件。',
      condition,
    };
  }

  return {
    applicable: 'NO',
    rate: rates.standard,
    note:
      `应纳税所得额 ${round2(taxableIncome).toFixed(2)} 已超过小型微利企业上限 ${cap.toFixed(0)} 元，` +
      `不适用小微优惠，按法定税率 ${formatRate(rates.standard)} 计算。`,
    condition,
  };
}

function formatRate(rate: string): string {
  const d = new Decimal(rate || '0');
  return `${d.times(100).toDecimalPlaces(2).toString()}%`;
}
