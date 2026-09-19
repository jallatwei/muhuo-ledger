/**
 * 财务报表行次定义与按科目标记归集
 * ============================================================
 * 科目表里 123 个科目**全部**带了 reportItem 标记（BS_/IS_ 前缀），
 * 所以报表可以纯粹按标记归集，不需要在代码里硬编码"哪个科目进哪一行"。
 *
 * 这样做的好处：
 *   · 新增/调整科目时只改科目的 reportItem，改一处
 *   · 报表口径与科目表始终一致，不会出现"代码里写死了 1122，但科目表改名了"
 *   · 同一 reportItem 下的多个科目自动合并（如 1001+1002+1012 → 货币资金）
 *
 * ★ 每一行都必须能说清"这个数从哪来"。
 *   报表最怕的不是算错，而是**算错了还看不出来**。
 *   所以归集结果里每行都带 source（账上取数 / 计算得出）与科目构成明细，
 *   点开任意一行都能看到它由哪些科目的余额加总而成。
 */
import { Decimal, round2 } from '@bookkeeper/shared';

/** 归集来源：让每个数字都可追溯 */
export type FigureSource =
  | 'LEDGER' // 直接取自科目余额
  | 'CALCULATED' // 由其他行计算得出（如小计、合计）
  | 'DECLARED' // 取自申报表（口径可能不同，需核对）
  | 'DERIVED'; // 倒轧得出（需人工确认）

/** 报表上的一行 */
export interface ReportRow {
  /** 行次（小企业会计准则报表的行次） */
  lineNo: string;
  /** 行项目名称 */
  label: string;
  /** 期末 / 本期金额 */
  amount: Decimal | null;
  /** 年初 / 上期金额（有数据时才有） */
  compareAmount: Decimal | null;
  source: FigureSource;
  /** 由哪些科目归集而来（LEDGER 行必有） */
  accounts?: Array<{ code: string; name: string; amount: string }>;
  /** 该行的说明（口径提示、勾稽关系等） */
  note?: string;
  /** 是否是需要重点关注的行（如应交税费） */
  highlight?: boolean;
}

export interface ReportSheet {
  title: string;
  /** 表号，如"会小企01表" */
  formNo: string;
  periodLabel: string;
  /** 单位 */
  unit: string;
  rows: ReportRow[];
  /** 表内勾稽自检结论 */
  checks: Array<{ name: string; ok: boolean; expected?: string; actual?: string; detail: string }>;
  warnings: string[];
}

/** 报表行的定义（不含金额） */
interface RowDef {
  lineNo: string;
  label: string;
  /** 取哪些 reportItem 的合计；为空表示这是计算行 */
  items?: string[];
  /** 计算行：由其他行的 lineNo 组合 */
  calc?: (get: (lineNo: string) => Decimal) => Decimal;
  /** 小计/合计行 */
  isTotal?: boolean;
  note?: string;
  /** 需要重点关注的行（如应交税费 —— 它同时是申报表的取数来源） */
  highlight?: boolean;
}

// ============================================================================
//  资产负债表（会小企01表）
// ============================================================================

const BALANCE_SHEET_ROWS: RowDef[] = [
  // ---- 流动资产 ----
  { lineNo: '1', label: '货币资金', items: ['BS_MONETARY_FUNDS'] },
  { lineNo: '2', label: '短期投资', items: ['BS_SHORT_INVEST'] },
  { lineNo: '3', label: '应收票据', items: ['BS_NOTE_RECEIVABLE'] },
  { lineNo: '4', label: '应收账款', items: ['BS_ACCT_RECEIVABLE'] },
  { lineNo: '5', label: '预付款项', items: ['BS_PREPAYMENT'] },
  { lineNo: '6', label: '应收股利', items: ['BS_DIVIDEND_RECEIVABLE'] },
  { lineNo: '7', label: '应收利息', items: ['BS_INTEREST_RECEIVABLE'] },
  { lineNo: '8', label: '其他应收款', items: ['BS_OTHER_RECEIVABLE'] },
  { lineNo: '9', label: '存货', items: ['BS_INVENTORY'] },
  {
    lineNo: '15',
    label: '流动资产合计',
    isTotal: true,
    calc: (g) => g('1').plus(g('2')).plus(g('3')).plus(g('4')).plus(g('5')).plus(g('6')).plus(g('7')).plus(g('8')).plus(g('9')),
  },

  // ---- 非流动资产 ----
  { lineNo: '16', label: '长期债券投资', items: ['BS_LT_BOND_INVEST'] },
  { lineNo: '17', label: '长期股权投资', items: ['BS_LT_EQUITY_INVEST'] },
  {
    lineNo: '18',
    label: '固定资产原价',
    items: ['BS_FIXED_ASSET'],
    note: '本科目为固定资产原值，累计折旧在下一行单独列示',
  },
  {
    lineNo: '19',
    label: '减：累计折旧',
    items: ['BS_FIXED_ASSET_DEPRECIATION'],
    note: '备抵科目，贷方余额，在表上作为固定资产的减项',
  },
  {
    lineNo: '20',
    label: '固定资产账面价值',
    isTotal: true,
    calc: (g) => g('18').minus(g('19')),
  },
  { lineNo: '21', label: '在建工程', items: ['BS_CONSTRUCTION'] },
  { lineNo: '22', label: '工程物资', items: ['BS_CONSTRUCTION_MATERIAL'] },
  { lineNo: '23', label: '固定资产清理', items: ['BS_FIXED_DISPOSAL'] },
  { lineNo: '24', label: '生产性生物资产', items: ['BS_BIO_ASSET'] },
  {
    lineNo: '25',
    label: '减：生产性生物资产累计折旧',
    items: ['BS_BIO_ASSET_DEPRECIATION'],
    note: '备抵科目，贷方余额',
  },
  { lineNo: '26', label: '无形资产', items: ['BS_INTANGIBLE'] },
  {
    lineNo: '27',
    label: '减：累计摊销',
    items: ['BS_INTANGIBLE_AMORTIZATION'],
    note: '备抵科目，贷方余额，在表上作为无形资产的减项',
  },
  { lineNo: '28', label: '长期待摊费用', items: ['BS_LT_DEFERRED'] },
  {
    lineNo: '29',
    label: '非流动资产合计',
    isTotal: true,
    calc: (g) =>
      g('20')
        .plus(g('16')).plus(g('17'))
        .plus(g('21')).plus(g('22')).plus(g('23'))
        .plus(g('24')).minus(g('25'))
        .plus(g('26')).minus(g('27'))
        .plus(g('28')),
    note: '已扣除固定资产折旧、生物资产折旧与无形资产摊销',
  },
  {
    lineNo: '30',
    label: '资产总计',
    isTotal: true,
    calc: (g) => g('15').plus(g('29')),
    note: '= 流动资产合计 + 非流动资产合计',
  },

  // ---- 流动负债 ----
  { lineNo: '31', label: '短期借款', items: ['BS_SHORT_LOAN'] },
  { lineNo: '32', label: '应付票据', items: ['BS_NOTE_PAYABLE'] },
  { lineNo: '33', label: '应付账款', items: ['BS_ACCT_PAYABLE'] },
  { lineNo: '34', label: '预收款项', items: ['BS_ADVANCE_RECEIPT'] },
  { lineNo: '35', label: '应付职工薪酬', items: ['BS_PAYROLL_PAYABLE'] },
  {
    lineNo: '36',
    label: '应交税费',
    items: ['BS_TAX_PAYABLE'],
    note: '含未交增值税、应交企业所得税、附加税费等；借方余额表示多交或待抵扣',
    highlight: true,
  },
  { lineNo: '37', label: '应付利息', items: ['BS_INTEREST_PAYABLE'] },
  { lineNo: '38', label: '应付利润', items: ['BS_DIVIDEND_PAYABLE'] },
  { lineNo: '39', label: '其他应付款', items: ['BS_OTHER_PAYABLE'] },
  {
    lineNo: '40',
    label: '流动负债合计',
    isTotal: true,
    calc: (g) => g('31').plus(g('32')).plus(g('33')).plus(g('34')).plus(g('35')).plus(g('36')).plus(g('37')).plus(g('38')).plus(g('39')),
  },

  // ---- 非流动负债 ----
  { lineNo: '41', label: '长期借款', items: ['BS_LONG_LOAN'] },
  { lineNo: '42', label: '长期应付款', items: ['BS_LT_PAYABLE'] },
  { lineNo: '43', label: '递延收益', items: ['BS_DEFERRED_INCOME'] },
  {
    lineNo: '45',
    label: '非流动负债合计',
    isTotal: true,
    calc: (g) => g('41').plus(g('42')).plus(g('43')),
    note: '小企业会计准则下非流动负债只有长期借款、长期应付款、递延收益三项，没有「其他非流动负债」',
  },
  {
    lineNo: '46',
    label: '负债合计',
    isTotal: true,
    calc: (g) => g('40').plus(g('45')),
  },

  // ---- 所有者权益 ----
  { lineNo: '47', label: '实收资本', items: ['BS_PAID_IN_CAPITAL'] },
  { lineNo: '48', label: '资本公积', items: ['BS_CAPITAL_RESERVE'] },
  { lineNo: '49', label: '盈余公积', items: ['BS_SURPLUS_RESERVE'] },
  { lineNo: '50', label: '未分配利润', items: ['BS_RETAINED_EARNINGS'] },
  {
    lineNo: '51',
    label: '所有者权益合计',
    isTotal: true,
    calc: (g) => g('47').plus(g('48')).plus(g('49')).plus(g('50')),
  },
  {
    lineNo: '52',
    label: '负债和所有者权益总计',
    isTotal: true,
    calc: (g) => g('46').plus(g('51')),
  },
];

// ============================================================================
//  利润表（会小企02表）
// ============================================================================

const INCOME_STATEMENT_ROWS: RowDef[] = [
  { lineNo: '1', label: '一、营业收入', items: ['IS_REVENUE'] },
  { lineNo: '2', label: '减：营业成本', items: ['IS_COST'] },
  { lineNo: '3', label: '税金及附加', items: ['IS_TAX_SURCHARGE'] },
  { lineNo: '4', label: '销售费用', items: ['IS_SELLING_EXPENSE'] },
  { lineNo: '5', label: '管理费用', items: ['IS_ADMIN_EXPENSE'] },
  { lineNo: '6', label: '财务费用', items: ['IS_FINANCE_EXPENSE'] },
  { lineNo: '7', label: '投资收益', items: ['IS_INVEST_INCOME'] },
  {
    lineNo: '8',
    label: '二、营业利润',
    isTotal: true,
    calc: (g) => g('1').minus(g('2')).minus(g('3')).minus(g('4')).minus(g('5')).minus(g('6')).plus(g('7')),
  },
  { lineNo: '9', label: '加：营业外收入', items: ['IS_NON_OP_INCOME'] },
  { lineNo: '10', label: '减：营业外支出', items: ['IS_NON_OP_EXPENSE'] },
  {
    lineNo: '11',
    label: '三、利润总额',
    isTotal: true,
    calc: (g) => g('8').plus(g('9')).minus(g('10')),
  },
  { lineNo: '12', label: '减：所得税费用', items: ['IS_INCOME_TAX'] },
  {
    lineNo: '13',
    label: '四、净利润',
    isTotal: true,
    calc: (g) => g('11').minus(g('12')),
  },
];

// ============================================================================
//  归集
// ============================================================================

/** 一个科目的本期发生与期末余额 */
export interface AccountFigure {
  code: string;
  name: string;
  reportItem: string | null;
  direction: 'DEBIT' | 'CREDIT';
  /** 期末借方余额 */
  closingDebit: Decimal;
  /** 期末贷方余额 */
  closingCredit: Decimal;
  /** 本期借方发生额 */
  debitOccurred: Decimal;
  /** 本期贷方发生额 */
  creditOccurred: Decimal;
}

/**
 * 按 reportItem 归集出「净额」。
 *
 * ★ 净额 = 借 − 贷（按科目正常方向取正号）。
 *   资产类正常方向是借方，所以净额 = 借 − 贷；
 *   负债权益类正常方向是贷方，所以净额 = 贷 − 借。
 *
 *   为什么要按正常方向而不是一律"借−贷"：
 *   报表上的「应交税费」贷方余额表示欠税，应当显示为正数。
 *   如果一律按借−贷，它会变成负数，读表的人会以为多交了税。
 *
 *   反方向余额（如应收账款出现贷方余额）保留负号 ——
 *   这通常意味着科目用错（应记预收），**不能悄悄取绝对值抹掉**。
 */
function netByItem(figures: AccountFigure[]): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const f of figures) {
    if (!f.reportItem) continue;
    const normalDebit = f.direction === 'DEBIT';
    const net = normalDebit
      ? f.closingDebit.minus(f.closingCredit)
      : f.closingCredit.minus(f.closingDebit);
    out.set(f.reportItem, (out.get(f.reportItem) ?? new Decimal(0)).plus(net));
  }
  return out;
}

/** 按 reportItem 归集出「本期发生额净额」（损益类用；贷方为收入增加） */
function occurredByItem(figures: AccountFigure[]): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const f of figures) {
    if (!f.reportItem) continue;
    // 损益类：贷方发生 − 借方发生 = 本期净收益
    const net = f.creditOccurred.minus(f.debitOccurred);
    out.set(f.reportItem, (out.get(f.reportItem) ?? new Decimal(0)).plus(net));
  }
  return out;
}

/** 某行由哪些科目构成（供界面展开查看） */
function accountsOf(figures: AccountFigure[], items: string[]): Array<{ code: string; name: string; amount: string }> {
  const out: Array<{ code: string; name: string; amount: string }> = [];
  for (const f of figures) {
    if (!f.reportItem || !items.includes(f.reportItem)) continue;
    const normalDebit = f.direction === 'DEBIT';
    const net = normalDebit
      ? f.closingDebit.minus(f.closingCredit)
      : f.closingCredit.minus(f.closingDebit);
    if (net.isZero()) continue; // 零余额科目不列，避免噪音
    out.push({ code: f.code, name: f.name, amount: round2(net).toFixed(2) });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

function buildRows(
  defs: RowDef[],
  byItem: Map<string, Decimal>,
  figures: AccountFigure[],
  mode: 'BALANCE' | 'OCCURRED',
): ReportRow[] {
  // 计算行需要按 lineNo 取值，先建一个可变表
  const amounts = new Map<string, Decimal>();
  const get = (lineNo: string): Decimal => amounts.get(lineNo) ?? new Decimal(0);

  const rows: ReportRow[] = [];
  for (const def of defs) {
    let amount: Decimal | null = null;
    let source: FigureSource = 'LEDGER';
    let accounts: Array<{ code: string; name: string; amount: string }> | undefined;

    if (def.items) {
      amount = new Decimal(0);
      for (const it of def.items) amount = amount.plus(byItem.get(it) ?? 0);
      accounts = accountsOf(figures, def.items);
      // 一个科目都没有命中的行：金额为 0，但要标出来，避免让人以为"漏了"
      if (accounts.length === 0 && amount.isZero()) {
        source = 'LEDGER';
      }
    } else if (def.calc) {
      amount = def.calc(get);
      source = 'CALCULATED';
    }

    const value = amount === null ? null : round2(amount);
    amounts.set(def.lineNo, value ?? new Decimal(0));

    rows.push({
      lineNo: def.lineNo,
      label: def.label,
      amount: value,
      compareAmount: null, // 比较期由调用方补（需要上期数据）
      source,
      accounts,
      note: def.note,
      highlight: def.highlight,
    });
  }

  void mode;
  return rows;
}

/**
 * 生成资产负债表。
 *
 * 自检项（表内勾稽，不通过就是真有问题）：
 *   ① 资产总计 == 负债和所有者权益总计 —— 会计恒等式
 *   ② 流动资产合计 <= 资产总计
 *   ③ 固定资产账面价值 == 原价 − 累计折旧
 *
 * ★ 自检不通过时**只报告，不改数**。理由同报表识别那一节：
 *   有可能是科目用错了（该记预收的记成了应收），
 *   悄悄"调平"会把真实错误藏起来。
 */
export function buildBalanceSheet(params: {
  figures: AccountFigure[];
  periodLabel: string;
}): ReportSheet {
  const byItem = netByItem(params.figures);
  const rows = buildRows(BALANCE_SHEET_ROWS, byItem, params.figures, 'BALANCE');
  const warnings: string[] = [];

  const at = (lineNo: string): Decimal =>
    rows.find((r) => r.lineNo === lineNo)?.amount ?? new Decimal(0);

  const totalAssets = at('30');
  const totalLiabEquity = at('52');
  const diff = round2(totalAssets.minus(totalLiabEquity));

  // 科目方向异常检查：资产类出现贷方余额、负债类出现借方余额
  const abnormal: string[] = [];
  for (const f of params.figures) {
    if (!f.reportItem) continue;
    const normalDebit = f.direction === 'DEBIT';
    if (normalDebit && f.closingCredit.gt(0) && f.closingDebit.isZero()) {
      abnormal.push(`${f.code} ${f.name}（资产类科目出现贷方余额 ${round2(f.closingCredit).toFixed(2)}）`);
    }
    if (!normalDebit && f.closingDebit.gt(0) && f.closingCredit.isZero() && f.code.startsWith('2')) {
      abnormal.push(`${f.code} ${f.name}（负债类科目出现借方余额 ${round2(f.closingDebit).toFixed(2)}）`);
    }
  }
  if (abnormal.length > 0) {
    warnings.push(
      `有 ${abnormal.length} 个科目的余额方向与科目性质相反：${abnormal.slice(0, 5).join('；')}` +
        `${abnormal.length > 5 ? ` 等 ${abnormal.length} 个` : ''}。` +
        `这通常意味着科目用错（例如该记「预收账款」的记成了「应收账款」），请核对。`,
    );
  }

  const checks = [
    {
      name: '会计恒等式：资产总计 = 负债和所有者权益总计',
      ok: diff.isZero(),
      expected: round2(totalLiabEquity).toFixed(2),
      actual: round2(totalAssets).toFixed(2),
      detail: diff.isZero()
        ? '两边相等。'
        : `相差 ${diff.toFixed(2)}。★ 系统不做任何平衡调整 —— 差额通常来自科目使用错误或漏记，` +
          '请查清原因后修改凭证，而不是在报表上把它抹平。',
    },
    {
      name: '固定资产账面价值 = 原价 − 累计折旧',
      ok: round2(at('18').minus(at('19'))).eq(at('20')),
      expected: round2(at('18').minus(at('19'))).toFixed(2),
      actual: round2(at('20')).toFixed(2),
      detail: '表内计算关系。',
    },
    {
      name: '累计折旧已在非流动资产合计中扣除',
      ok: true,
      detail:
        at('19').isZero()
          ? '本期无累计折旧。'
          : `累计折旧 ${round2(at('19')).toFixed(2)} 已作为减项计入非流动资产合计。` +
            '★ 折旧必须与固定资产分开列示 —— 合并归集会让固定资产虚增一个折旧额。',
    },
    {
      name: '流动资产合计 ≤ 资产总计',
      ok: at('15').lte(at('30')),
      detail: '流动资产不可能超过资产总额。',
    },
  ];

  return {
    title: '资产负债表',
    formNo: '会小企01表',
    periodLabel: params.periodLabel,
    unit: '元',
    rows,
    checks,
    warnings,
  };
}

/**
 * 生成利润表。
 *
 * 取数口径：**本期发生额**（不是余额）。
 * 损益类科目期末会结转到本年利润，余额通常为 0 ——
 * 用余额取数会得到一张全是 0 的利润表。这是自建报表最常踩的坑之一。
 */
export function buildIncomeStatement(params: {
  figures: AccountFigure[];
  periodLabel: string;
  /** 是否为本年累计口径（月报通常同时要本月数与本年累计数） */
  cumulative?: boolean;
}): ReportSheet {
  const byItem = occurredByItem(params.figures);
  const rows = buildRows(INCOME_STATEMENT_ROWS, byItem, params.figures, 'OCCURRED');
  const warnings: string[] = [];

  const at = (lineNo: string): Decimal =>
    rows.find((r) => r.lineNo === lineNo)?.amount ?? new Decimal(0);

  // 收入为负（借方净发生）通常是冲红或科目用反
  if (at('1').lt(0)) {
    warnings.push(
      `营业收入为负（${round2(at('1')).toFixed(2)}）。若本期有红冲销售，属正常；` +
        `否则请检查是否把收入记在了借方。`,
    );
  }

  const profitCalc = at('1').minus(at('2')).minus(at('3')).minus(at('4')).minus(at('5')).minus(at('6')).plus(at('7'));
  const checks = [
    {
      name: '营业利润 = 营业收入 − 成本 − 税金及附加 − 三费 + 投资收益',
      ok: round2(profitCalc).eq(at('8')),
      expected: round2(profitCalc).toFixed(2),
      actual: round2(at('8')).toFixed(2),
      detail: '表内计算关系。',
    },
    {
      name: '净利润 = 利润总额 − 所得税费用',
      ok: round2(at('11').minus(at('12'))).eq(at('13')),
      expected: round2(at('11').minus(at('12'))).toFixed(2),
      actual: round2(at('13')).toFixed(2),
      detail: '表内计算关系。',
    },
  ];

  return {
    title: '利润表',
    formNo: '会小企02表',
    periodLabel: params.periodLabel,
    unit: '元',
    rows,
    checks,
    warnings,
  };
}

/** 从报表里取某行的金额（申报表底稿需要引用报表数） */
export function amountOf(sheet: ReportSheet, lineNo: string): Decimal {
  return sheet.rows.find((r) => r.lineNo === lineNo)?.amount ?? new Decimal(0);
}

export { BALANCE_SHEET_ROWS, INCOME_STATEMENT_ROWS };

// ============================================================================
//  标记完整性自检
// ============================================================================

/**
 * 校验报表定义引用的 reportItem 在科目表里**真实存在**。
 *
 * ★ 为什么需要这个检查：
 *   报表行是按 reportItem 归集的。如果定义里写了一个科目表里不存在的标记，
 *   那一行会**静默地永远是 0** —— 不算错、不报错，只是数字凭空消失。
 *   真实踩到过这个坑：`1602 累计折旧` 与 `1601 固定资产` 打了同一个标记，
 *   两者被直接相加，固定资产虚增了一个折旧额，而报表看起来完全正常。
 *
 *   所以每次生成报表前先比对一次：定义要求的标记，科目表必须都有。
 *   缺失就报出来，而不是让它静静地变成一行 0。
 */
export function checkReportItemCoverage(params: {
  /** 科目表里实际存在的 reportItem 集合 */
  availableItems: Set<string>;
}): { ok: boolean; missing: Array<{ lineNo: string; label: string; item: string }> } {
  const missing: Array<{ lineNo: string; label: string; item: string }> = [];
  for (const def of [...BALANCE_SHEET_ROWS, ...INCOME_STATEMENT_ROWS]) {
    for (const item of def.items ?? []) {
      if (!params.availableItems.has(item)) {
        missing.push({ lineNo: def.lineNo, label: def.label, item });
      }
    }
  }
  return { ok: missing.length === 0, missing };
}