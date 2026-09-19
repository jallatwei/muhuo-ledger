/**
 * 报销合规自检
 * ============================================================
 * ★ 先说清边界：这不是税务意见，也不是审计结论。
 *
 *   本模块做的事情只有一件：**把可以机械核查的疑点找出来，摆给人看**。
 *   它不判断"这笔支出能不能税前扣除"，也不判断"这个安排是否具有合理商业目的" ——
 *   那些是涉税专业判断，需要看合同、看业务实质、看凭证，系统做不到。
 *
 * 所以规则分成两类，界面上要分开呈现：
 *
 *   【可机械核查】数据本身就能证明有问题 —— 这类必须拦下
 *     同一张票重复报销 / 借贷方向异常 / 金额与发票不符 / 日期在凭证期间外
 *
 *   【风险提示】数据形态可疑，但可能是正常业务 —— 这类只提示
 *     连号发票 / 整数大额 / 周末与节假日 / 同一供应商高频小额 / 超标接待
 *
 *   第二类**绝不能**说成"违规"。同一供应商一天开 5 张连号票，
 *   可能是正常的多次采购，也可能是拆分；
 *   系统只负责把它标出来，判断权在人。
 *
 * 每一条结论都带：规则编号、依据、涉及的具体凭证/发票、以及"该怎么核实"。
 * 只说"有问题"而不说怎么查，等于没说。
 */
import { Decimal, round2 } from '@bookkeeper/shared';

/** 检查的严重程度。★ 只有 VIOLATION 是"数据本身就能证明有问题" */
export type FindingSeverity =
  | 'VIOLATION' // 数据矛盾，必然有错（如重复报销）
  | 'SUSPICIOUS' // 形态可疑，需人工确认（如连号发票）
  | 'NOTICE'; // 仅作提示（如缺少附件）

export type RuleCategory =
  | 'DUPLICATE' // 重复
  | 'AMOUNT' // 金额
  | 'DATE' // 日期
  | 'COUNTERPARTY' // 往来单位
  | 'COMPLETENESS' // 完整性
  | 'POLICY_LIMIT'; // 限额

export interface ExpenseFinding {
  ruleId: string;
  severity: FindingSeverity;
  category: RuleCategory;
  title: string;
  /** 说清"哪里不对" */
  detail: string;
  /** ★ 说清"该怎么核实" —— 只说有问题不说怎么查等于没说 */
  howToVerify: string;
  /** 涉及的对象（凭证/发票编号，便于直接定位） */
  subjects: Array<{ type: 'VOUCHER' | 'INVOICE'; id: string; label: string }>;
  /** 涉及金额（有则填） */
  amount: Decimal | null;
  /** 规则依据（法规条款或内部制度） */
  basis: string;
}

export interface ExpenseAuditReport {
  entityId: string;
  periodLabel: string;
  generatedAt: string;
  /** 扫描范围 */
  scope: {
    voucherCount: number;
    invoiceCount: number;
    expenseVoucherCount: number;
    totalExpenseAmount: Decimal;
  };
  findings: ExpenseFinding[];
  summary: {
    violationCount: number;
    suspiciousCount: number;
    noticeCount: number;
  };
  /** ★ 必须始终呈现的边界声明 */
  disclaimer: string;
}

const DISCLAIMER =
  '本自检**不是税务意见，也不是审计结论**。它只做机械核查：把数据本身互相矛盾的地方' +
  '（如重复报销）与形态可疑的地方（如连号发票）找出来供你核实。' +
  '「形态可疑」不等于「违规」—— 同一供应商一天开多张票可能是正常业务；' +
  '能否税前扣除、是否具有合理商业目的，都需要结合合同与业务实质判断，请咨询税务专业人士。';

// ============================================================================
//  输入
// ============================================================================

/** 一条费用类凭证（已展开为便于核查的形状） */
export interface ExpenseVoucherForAudit {
  id: string;
  voucherWord: string;
  voucherNo: number;
  voucherDate: string;
  status: string;
  summary: string;
  totalAmount: Decimal;
  /** 费用类科目编码与名称 */
  expenseAccounts: Array<{ code: string; name: string; amount: Decimal }>;
  /** 关联的发票 */
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    invoiceCode: string | null;
    invoiceDate: string;
    sellerName: string;
    amountInclTax: Decimal;
    documentId: string | null;
  }>;
  /** 摘要/往来单位（用于同供应商高频检查） */
  counterpartyNames: string[];
  /** 附了多少个原始单据 */
  attachmentCount: number;
}

export interface ExpenseAuditInput {
  entityId: string;
  periodLabel: string;
  periodStartsOn: string;
  periodEndsOn: string;
  vouchers: ExpenseVoucherForAudit[];
  /** 同一批次内的全部发票（跨凭证查重用） */
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    invoiceCode: string | null;
    invoiceDate: string;
    sellerName: string;
    amountInclTax: Decimal;
    voucherId: string | null;
  }>;
  /** 内部报销限额（元），未提供则不检查限额 */
  limits?: {
    /** 单笔业务招待费上限 */
    entertainmentPerMeal?: string;
    /** 无发票支出上限 */
    noInvoicePerItem?: string;
  };
}

// ============================================================================
//  规则
// ============================================================================

/**
 * 执行全部规则。
 *
 * ★ 规则的实现原则：**宁可漏报，不可误报**。
 *   一条误报会让人对整个自检失去信任，之后真问题也不会看。
 *   所以每条规则都要能说清"为什么这一定是问题"或"为什么这值得看一眼"。
 */
export function auditExpenses(input: ExpenseAuditInput): ExpenseAuditReport {
  const findings: ExpenseFinding[] = [];

  findings.push(...ruleDuplicateReimbursement(input));
  findings.push(...ruleInvoiceNotInAnyVoucher(input));
  findings.push(...ruleVoucherDateOutsidePeriod(input));
  findings.push(...ruleSequentialInvoiceNumbers(input));
  findings.push(...ruleRoundLargeAmount(input));
  findings.push(...ruleWeekendAndHoliday(input));
  findings.push(...ruleFrequentSmallFromSameSeller(input));
  findings.push(...ruleMissingAttachment(input));
  findings.push(...ruleAmountMismatchWithInvoice(input));
  findings.push(...ruleEntertainmentLimit(input));

  // 排序：严重程度优先，其次金额从大到小 —— 人先看该看的
  const order: Record<FindingSeverity, number> = { VIOLATION: 0, SUSPICIOUS: 1, NOTICE: 2 };
  findings.sort((a, b) => {
    const s = order[a.severity] - order[b.severity];
    if (s !== 0) return s;
    return (b.amount ?? new Decimal(0)).comparedTo(a.amount ?? new Decimal(0));
  });

  const totalExpenseAmount = input.vouchers.reduce(
    (s, v) => s.plus(v.totalAmount),
    new Decimal(0),
  );

  return {
    entityId: input.entityId,
    periodLabel: input.periodLabel,
    generatedAt: new Date().toISOString(),
    scope: {
      voucherCount: input.vouchers.length,
      invoiceCount: input.invoices.length,
      expenseVoucherCount: input.vouchers.filter((v) => v.expenseAccounts.length > 0).length,
      totalExpenseAmount: round2(totalExpenseAmount),
    },
    findings,
    summary: {
      violationCount: findings.filter((f) => f.severity === 'VIOLATION').length,
      suspiciousCount: findings.filter((f) => f.severity === 'SUSPICIOUS').length,
      noticeCount: findings.filter((f) => f.severity === 'NOTICE').length,
    },
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------- 重复报销

/**
 * 同一张发票被多张凭证引用。
 *
 * ★ 这是唯一一条"数据本身就能证明有问题"的规则之一：
 *   同一张票只能报销一次。被两张凭证引用，必然有一个是错的
 *   （要么重复报销，要么凭证引用了错误的发票）。
 *
 *   注意区分：一张发票对应多行分录是**正常**的（如一张票含多个费用项目），
 *   所以判定依据是"被多少张**不同的凭证**引用"，不是"被多少行引用"。
 */
function ruleDuplicateReimbursement(input: ExpenseAuditInput): ExpenseFinding[] {
  const byInvoice = new Map<string, { invoice: ExpenseAuditInput['invoices'][0]; voucherIds: Set<string> }>();

  for (const inv of input.invoices) {
    if (!inv.voucherId) continue;
    const key = `${inv.invoiceCode ?? ''}|${inv.invoiceNumber}`;
    const cur = byInvoice.get(key) ?? { invoice: inv, voucherIds: new Set<string>() };
    cur.voucherIds.add(inv.voucherId);
    byInvoice.set(key, cur);
  }

  const out: ExpenseFinding[] = [];
  for (const [, { invoice, voucherIds }] of byInvoice) {
    if (voucherIds.size < 2) continue;
    out.push({
      ruleId: 'DUP-001',
      severity: 'VIOLATION',
      category: 'DUPLICATE',
      title: '同一张发票被多张凭证引用',
      detail:
        `发票 ${invoice.invoiceNumber}（${invoice.sellerName}，` +
        `价税合计 ${round2(invoice.amountInclTax).toFixed(2)}）被 ${voucherIds.size} 张凭证引用。` +
        '同一张票只能报销一次，这里必然有一处是错的。',
      howToVerify:
        '打开这几张凭证，确认哪一张是正确的引用；' +
        '若确实重复报销了，应对多出的那张凭证做红冲，而不是删除（删除会丢失痕迹）。',
      subjects: [
        { type: 'INVOICE', id: invoice.id, label: `${invoice.invoiceNumber} ${invoice.sellerName}` },
        ...[...voucherIds].map((id) => ({ type: 'VOUCHER' as const, id, label: id.slice(0, 8) })),
      ],
      amount: round2(invoice.amountInclTax),
      basis: '同一张发票不得重复报销；会计上同一笔支出不得两次入账。',
    });
  }
  return out;
}

// ---------------------------------------------------------------- 发票未入账

/** 已认证/已入账但没有任何凭证引用的发票 —— 提示，不判定为错 */
function ruleInvoiceNotInAnyVoucher(input: ExpenseAuditInput): ExpenseFinding[] {
  const used = new Set(input.invoices.filter((i) => i.voucherId).map((i) => i.id));
  const orphan = input.invoices.filter((i) => !used.has(i.id));
  if (orphan.length === 0) return [];

  const total = orphan.reduce((s, i) => s.plus(i.amountInclTax), new Decimal(0));
  return [
    {
      ruleId: 'CMP-001',
      severity: 'NOTICE',
      category: 'COMPLETENESS',
      title: '有发票尚未关联到任何凭证',
      detail:
        `本期有 ${orphan.length} 张发票没有出现在任何凭证里，价税合计 ${round2(total).toFixed(2)}。`,
      howToVerify:
        '逐张确认：是尚未报销（正常），还是已报销但凭证没有关联这张票（会导致凭证册打印时带不出原件）。' +
        '若属于后者，请在凭证上补充关联。',
      subjects: orphan.slice(0, 20).map((i) => ({
        type: 'INVOICE' as const,
        id: i.id,
        label: `${i.invoiceNumber} ${i.sellerName}`,
      })),
      amount: round2(total),
      basis: '电子发票仓库与凭证应当勾稽，否则打印凭证册时无法带出原始单据。',
    },
  ];
}

// ---------------------------------------------------------------- 日期越界

/** 凭证日期落在所属会计期间之外 */
function ruleVoucherDateOutsidePeriod(input: ExpenseAuditInput): ExpenseFinding[] {
  const start = new Date(`${input.periodStartsOn}T00:00:00Z`).getTime();
  const end = new Date(`${input.periodEndsOn}T00:00:00Z`).getTime();

  const out: ExpenseFinding[] = [];
  for (const v of input.vouchers) {
    const t = new Date(`${v.voucherDate.slice(0, 10)}T00:00:00Z`).getTime();
    if (Number.isNaN(t) || (t >= start && t <= end)) continue;
    out.push({
      ruleId: 'DATE-001',
      severity: 'VIOLATION',
      category: 'DATE',
      title: '凭证日期不在所属会计期间内',
      detail:
        `凭证 ${v.voucherWord}-${v.voucherNo} 日期为 ${v.voucherDate.slice(0, 10)}，` +
        `但所属期间是 ${input.periodStartsOn} ~ ${input.periodEndsOn}。`,
      howToVerify:
        '这通常是把上/下月的凭证记到了本期。请核对原始单据日期，' +
        '跨期凭证应记入其所属期间，或在本期做跨期调整并说明。',
      subjects: [{ type: 'VOUCHER', id: v.id, label: `${v.voucherWord}-${v.voucherNo}` }],
      amount: round2(v.totalAmount),
      basis: '会计凭证应按经济业务发生的所属期间入账（权责发生制）。',
    });
  }
  return out;
}

// ---------------------------------------------------------------- 连号发票

/**
 * 同一供应商的连号发票。
 *
 * ★ 这类**只提示，不判定**。连号本身不是问题 ——
 *   一次采购开多张、或当天连续多笔业务都会连号。
 *   值得看一眼的原因是：它也可能是"把一笔支出拆成多张小额票"的形态。
 */
function ruleSequentialInvoiceNumbers(input: ExpenseAuditInput): ExpenseFinding[] {
  const bySeller = new Map<string, ExpenseAuditInput['invoices']>();
  for (const inv of input.invoices) {
    const list = bySeller.get(inv.sellerName) ?? [];
    list.push(inv);
    bySeller.set(inv.sellerName, list);
  }

  const out: ExpenseFinding[] = [];
  for (const [seller, list] of bySeller) {
    if (list.length < 3) continue;

    // 只看纯数字号码的连号；数电票 20 位号码的前缀差异大，不参与判断
    const numeric = list
      .map((i) => ({ inv: i, n: Number(i.invoiceNumber) }))
      .filter((x) => Number.isFinite(x.n) && String(x.n) === x.inv.invoiceNumber)
      .sort((a, b) => a.n - b.n);
    if (numeric.length < 3) continue;

    // 找出连续递增的段
    let runStart = 0;
    for (let i = 1; i <= numeric.length; i += 1) {
      const contiguous = i < numeric.length && numeric[i]!.n === numeric[i - 1]!.n + 1;
      if (contiguous) continue;

      const runLen = i - runStart;
      if (runLen >= 3) {
        const seg = numeric.slice(runStart, i);
        const total = seg.reduce((s, x) => s.plus(x.inv.amountInclTax), new Decimal(0));
        out.push({
          ruleId: 'SEQ-001',
          severity: 'SUSPICIOUS',
          category: 'COUNTERPARTY',
          title: '同一供应商出现连号发票',
          detail:
            `${seller} 有 ${runLen} 张连号发票（${seg[0]!.inv.invoiceNumber} ~ ` +
            `${seg[runLen - 1]!.inv.invoiceNumber}），价税合计 ${round2(total).toFixed(2)}。` +
            '连号本身不代表有问题 —— 一次采购开多张票、当天连续多笔业务都会连号。',
          howToVerify:
            '确认这些是不是同一批次业务的拆分。若单笔业务金额本可以开在一张票上却拆成多张，' +
            '需要能说明拆分原因（如不同货物适用不同税率、分次交付）；说不清就值得进一步核实。',
          subjects: seg.map((x) => ({
            type: 'INVOICE' as const,
            id: x.inv.id,
            label: `${x.inv.invoiceNumber} ${round2(x.inv.amountInclTax).toFixed(2)}`,
          })),
          amount: round2(total),
          basis: '发票开具应与实际业务一致；拆分开具需要有合理原因。',
        });
      }
      runStart = i;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 整数大额

/** 大额整数金额 —— 提示，因为真实交易金额很少正好是整数 */
function ruleRoundLargeAmount(input: ExpenseAuditInput): ExpenseFinding[] {
  const THRESHOLD = new Decimal(10000);
  const out: ExpenseFinding[] = [];

  for (const v of input.vouchers) {
    if (v.totalAmount.lt(THRESHOLD)) continue;
    // 是否整千
    if (!v.totalAmount.mod(1000).isZero()) continue;
    out.push({
      ruleId: 'AMT-001',
      severity: 'SUSPICIOUS',
      category: 'AMOUNT',
      title: '大额整数金额',
      detail:
        `凭证 ${v.voucherWord}-${v.voucherNo}（${v.summary}）金额为 ` +
        `${round2(v.totalAmount).toFixed(2)}，正好是整千数。`,
      howToVerify:
        '真实交易的金额通常带零头（含税价尤其如此）。整数大额可能意味着：' +
        '估算入账、暂估、或与实际发票金额不符。请核对原始发票金额是否一致。',
      subjects: [{ type: 'VOUCHER', id: v.id, label: `${v.voucherWord}-${v.voucherNo}` }],
      amount: round2(v.totalAmount),
      basis: '入账金额应与原始凭证一致。',
    });
  }
  return out;
}

// ---------------------------------------------------------------- 周末节假日

/**
 * 周末发生的业务招待 / 差旅费用 —— 提示。
 *
 * ★ 这条最容易误报，所以只在**明确是招待费**时才提示，
 *   且措辞必须中性：周末招待客户是完全正常的。
 */
function ruleWeekendAndHoliday(input: ExpenseAuditInput): ExpenseFinding[] {
  const out: ExpenseFinding[] = [];
  for (const v of input.vouchers) {
    const isEntertainment = v.expenseAccounts.some((a) => a.name.includes('业务招待'));
    if (!isEntertainment) continue;

    const d = new Date(`${v.voucherDate.slice(0, 10)}T00:00:00Z`);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) continue;

    out.push({
      ruleId: 'DATE-002',
      severity: 'NOTICE',
      category: 'DATE',
      title: '业务招待费发生在周末',
      detail:
        `凭证 ${v.voucherWord}-${v.voucherNo}（${v.summary}）日期 ` +
        `${v.voucherDate.slice(0, 10)} 是${dow === 0 ? '周日' : '周六'}，含业务招待费。`,
      howToVerify:
        '周末招待客户完全正常，此项仅作提示。若需要证明业务真实性，' +
        '可留存参与人员、招待事由、被招待方等信息（税务核查时通常会问）。',
      subjects: [{ type: 'VOUCHER', id: v.id, label: `${v.voucherWord}-${v.voucherNo}` }],
      amount: round2(v.totalAmount),
      basis: '业务招待费需能证明与生产经营相关。',
    });
  }
  return out;
}

// ---------------------------------------------------------------- 同供应商高频小额

/** 同一供应商当月多笔小额支出 —— 提示（可能是正常的高频采购） */
function ruleFrequentSmallFromSameSeller(input: ExpenseAuditInput): ExpenseFinding[] {
  const bySeller = new Map<string, ExpenseAuditInput['invoices']>();
  for (const inv of input.invoices) {
    const list = bySeller.get(inv.sellerName) ?? [];
    list.push(inv);
    bySeller.set(inv.sellerName, list);
  }

  const out: ExpenseFinding[] = [];
  for (const [seller, list] of bySeller) {
    if (list.length < 8) continue;
    const total = list.reduce((s, i) => s.plus(i.amountInclTax), new Decimal(0));
    const avg = total.div(list.length);
    // 只有"笔数多 + 单笔小"才提示；笔数多但金额大是正常的大供应商
    if (avg.gt(2000)) continue;

    out.push({
      ruleId: 'CP-001',
      severity: 'NOTICE',
      category: 'COUNTERPARTY',
      title: '同一供应商当月高频小额支出',
      detail:
        `${seller} 本月有 ${list.length} 笔支出，合计 ${round2(total).toFixed(2)}，` +
        `平均每笔 ${round2(avg).toFixed(2)}。`,
      howToVerify:
        '高频小额可能是正常业务（如日常采购、加油、快递），也可能是拆分大额支出。' +
        '请判断这个频次与金额是否符合该供应商的业务性质。',
      subjects: list.slice(0, 20).map((i) => ({
        type: 'INVOICE' as const,
        id: i.id,
        label: `${i.invoiceNumber} ${round2(i.amountInclTax).toFixed(2)}`,
      })),
      amount: round2(total),
      basis: '支出应与业务规模匹配。',
    });
  }
  return out;
}

// ---------------------------------------------------------------- 缺附件

/** 费用凭证没有任何附件 */
function ruleMissingAttachment(input: ExpenseAuditInput): ExpenseFinding[] {
  const out: ExpenseFinding[] = [];
  for (const v of input.vouchers) {
    if (v.expenseAccounts.length === 0) continue;
    if (v.attachmentCount > 0 || v.invoices.length > 0) continue;

    out.push({
      ruleId: 'CMP-002',
      severity: 'NOTICE',
      category: 'COMPLETENESS',
      title: '费用凭证没有原始单据',
      detail:
        `凭证 ${v.voucherWord}-${v.voucherNo}（${v.summary}）计入了费用科目，` +
        '但既没有关联发票，也没有附件。',
      howToVerify:
        '核对是否属于以下情形：尚未取得发票（应挂账并在取得后补记）、' +
        '属于不需要发票的支出（如工资、折旧）、或单纯的漏附。' +
        '★ 未取得合规凭证的成本费用在企业所得税汇算时不得扣除，需要纳税调增。',
      subjects: [{ type: 'VOUCHER', id: v.id, label: `${v.voucherWord}-${v.voucherNo}` }],
      amount: round2(v.totalAmount),
      basis: '税前扣除需取得合规凭证；无票支出在汇算清缴时纳税调增。',
    });
  }
  return out;
}

// ---------------------------------------------------------------- 金额不符

/** 凭证金额与所关联发票金额不一致 */
function ruleAmountMismatchWithInvoice(input: ExpenseAuditInput): ExpenseFinding[] {
  const out: ExpenseFinding[] = [];
  const tolerance = new Decimal('0.02');

  for (const v of input.vouchers) {
    if (v.invoices.length === 0) continue;
    const invoiceTotal = v.invoices.reduce((s, i) => s.plus(i.amountInclTax), new Decimal(0));
    const diff = round2(v.totalAmount.minus(invoiceTotal));
    if (diff.abs().lte(tolerance)) continue;

    out.push({
      ruleId: 'AMT-002',
      severity: 'VIOLATION',
      category: 'AMOUNT',
      title: '凭证金额与关联发票金额不一致',
      detail:
        `凭证 ${v.voucherWord}-${v.voucherNo} 金额 ${round2(v.totalAmount).toFixed(2)}，` +
        `关联发票合计 ${round2(invoiceTotal).toFixed(2)}，相差 ${diff.toFixed(2)}。`,
      howToVerify:
        '三种可能：① 一张凭证包含多张发票，但只关联了其中一部分（应补全关联）；' +
        '② 部分金额没有发票（无票支出，需在汇算时调增）；' +
        '③ 金额录错。请对照原始单据逐项核对。',
      subjects: [
        { type: 'VOUCHER', id: v.id, label: `${v.voucherWord}-${v.voucherNo}` },
        ...v.invoices.map((i) => ({
          type: 'INVOICE' as const,
          id: i.id,
          label: `${i.invoiceNumber} ${round2(i.amountInclTax).toFixed(2)}`,
        })),
      ],
      amount: diff.abs(),
      basis: '凭证金额应与所依据的原始凭证一致。',
    });
  }
  return out;
}

// ---------------------------------------------------------------- 招待费限额

/**
 * 业务招待费超内部限额。
 *
 * ★ 这条只在用户**明确配置了限额**时才跑。
 *   系统不内置限额数字 —— 因为"合理的招待标准"因企业规模、行业、地区而异，
 *   塞一个默认值进去会让大多数企业收到无意义的告警。
 */
function ruleEntertainmentLimit(input: ExpenseAuditInput): ExpenseFinding[] {
  const limitStr = input.limits?.entertainmentPerMeal;
  if (!limitStr) return [];
  const limit = new Decimal(limitStr);
  if (limit.lte(0)) return [];

  const out: ExpenseFinding[] = [];
  for (const v of input.vouchers) {
    const ent = v.expenseAccounts.filter((a) => a.name.includes('业务招待'));
    if (ent.length === 0) continue;
    const amount = ent.reduce((s, a) => s.plus(a.amount), new Decimal(0));
    if (amount.lte(limit)) continue;

    out.push({
      ruleId: 'LIM-001',
      severity: 'SUSPICIOUS',
      category: 'POLICY_LIMIT',
      title: '业务招待费超过内部限额',
      detail:
        `凭证 ${v.voucherWord}-${v.voucherNo} 业务招待费 ${round2(amount).toFixed(2)}，` +
        `超过你设定的单笔限额 ${limit.toFixed(2)}。`,
      howToVerify:
        '确认是否有特殊事由（如重要客户来访）。' +
        '★ 另外提醒：业务招待费在企业所得税前按发生额 60% 扣除，且不超过营业收入的 5‰ —— ' +
        '即使内部审批通过，汇算清缴时仍可能被调增。',
      subjects: [{ type: 'VOUCHER', id: v.id, label: `${v.voucherWord}-${v.voucherNo}` }],
      amount: round2(amount),
      basis: `内部设定的单笔业务招待费限额 ${limit.toFixed(2)} 元。`,
    });
  }
  return out;
}
