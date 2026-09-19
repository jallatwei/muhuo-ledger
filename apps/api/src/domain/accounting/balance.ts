/**
 * 科目余额计算 —— 纯函数
 * ============================================================
 * 余额计算的唯一权威公式（见 design/03 第 4 节）：
 *
 *   借方科目（direction = DEBIT）:
 *     closingDebit = openingDebit + debitOccurred − creditOccurred
 *   贷方科目（direction = CREDIT）:
 *     closingCredit = openingCredit + creditOccurred − debitOccurred
 *
 *   反方向余额（如银行存款透支）以负数记入同侧，是允许的，报表会如实呈现。
 *
 * ★ 关于红冲的重要约定：
 *   被红冲的原凭证状态为 REVERSED，但它的分录**依然计入发生额** ——
 *   因为红冲凭证本身也过账了，两者相加净额为 0。
 *   若把 REVERSED 排除，就会出现「冲销了但原账还在」的灾难。
 *   这正是很多自制记账工具翻车的地方。
 */
import { Decimal, round2, add, sub } from '@bookkeeper/shared';

export type Direction = 'DEBIT' | 'CREDIT';

/** 参与余额计算的凭证状态 */
export const BALANCE_AFFECTING_STATUSES = ['POSTED', 'REVERSED'] as const;

export interface OccurrenceRow {
  accountId: string;
  direction: Direction;
  amount: Decimal;
}

export interface Occurrence {
  accountId: string;
  debitOccurred: Decimal;
  creditOccurred: Decimal;
}

export interface OpeningBalance {
  accountId: string;
  openingDebit: Decimal;
  openingCredit: Decimal;
}

export interface AccountBalanceResult {
  accountId: string;
  openingDebit: Decimal;
  openingCredit: Decimal;
  debitOccurred: Decimal;
  creditOccurred: Decimal;
  closingDebit: Decimal;
  closingCredit: Decimal;
}

/**
 * 聚合本期发生额。
 * 传入的 rows 应当已按「凭证状态 ∈ {POSTED, REVERSED}」过滤好。
 */
export function aggregateOccurrences(rows: OccurrenceRow[]): Map<string, Occurrence> {
  const map = new Map<string, Occurrence>();
  for (const row of rows) {
    const cur = map.get(row.accountId) ?? {
      accountId: row.accountId,
      debitOccurred: new Decimal(0),
      creditOccurred: new Decimal(0),
    };
    if (row.direction === 'DEBIT') {
      cur.debitOccurred = cur.debitOccurred.plus(row.amount);
    } else if (row.direction === 'CREDIT') {
      cur.creditOccurred = cur.creditOccurred.plus(row.amount);
    }
    map.set(row.accountId, cur);
  }
  return map;
}

/**
 * ★ 计算期末余额。
 *
 * @param direction  科目的余额正常方向
 * @param opening    期初余额（借/贷两栏）
 * @param occurrence 本期发生额（借/贷两栏）
 */
export function computeClosing(params: {
  direction: Direction;
  openingDebit: Decimal | string | number;
  openingCredit: Decimal | string | number;
  debitOccurred: Decimal | string | number;
  creditOccurred: Decimal | string | number;
}): { closingDebit: Decimal; closingCredit: Decimal } {
  const openingDebit = round2(params.openingDebit);
  const openingCredit = round2(params.openingCredit);
  const debitOccurred = round2(params.debitOccurred);
  const creditOccurred = round2(params.creditOccurred);

  if (params.direction === 'DEBIT') {
    return {
      closingDebit: round2(add(openingDebit, debitOccurred).minus(creditOccurred)),
      closingCredit: new Decimal(0),
    };
  }
  return {
    closingDebit: new Decimal(0),
    closingCredit: round2(add(openingCredit, creditOccurred).minus(debitOccurred)),
  };
}

/** 计算某科目某期间的完整余额行 */
export function computeAccountBalance(params: {
  accountId: string;
  direction: Direction;
  opening: OpeningBalance | undefined;
  occurrence: Occurrence | undefined;
}): AccountBalanceResult {
  const openingDebit = round2(params.opening?.openingDebit ?? 0);
  const openingCredit = round2(params.opening?.openingCredit ?? 0);
  const debitOccurred = round2(params.occurrence?.debitOccurred ?? 0);
  const creditOccurred = round2(params.occurrence?.creditOccurred ?? 0);

  const { closingDebit, closingCredit } = computeClosing({
    direction: params.direction,
    openingDebit,
    openingCredit,
    debitOccurred,
    creditOccurred,
  });

  return {
    accountId: params.accountId,
    openingDebit,
    openingCredit,
    debitOccurred,
    creditOccurred,
    closingDebit,
    closingCredit,
  };
}

/**
 * 滚动下期期初：上期期末即本期期初。
 */
export function rollForward(previous: AccountBalanceResult): OpeningBalance {
  return {
    accountId: previous.accountId,
    openingDebit: round2(previous.closingDebit),
    openingCredit: round2(previous.closingCredit),
  };
}

// ============================================================================
//  账务不变式校验（可随时自检）
// ============================================================================

export interface InvariantResult {
  code: string;
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * I2：全部科目借方余额合计 == 贷方余额合计
 *
 * 原理：每张凭证借贷相等 ⇒ 全部凭证的借方发生额合计 == 贷方发生额合计；
 *      又因期初余额本身来自上期期末（归纳基础为 0），故期末借贷余额合计必相等。
 *      I2 不通过，说明余额表被污染（手工改数、程序 bug、部分写入）。
 */
export function checkInvariantI2(balances: AccountBalanceResult[]): InvariantResult {
  const totalDebit = balances.reduce((s, b) => s.plus(b.closingDebit), new Decimal(0));
  const totalCredit = balances.reduce((s, b) => s.plus(b.closingCredit), new Decimal(0));
  const diff = totalDebit.minus(totalCredit);
  return {
    code: 'I2',
    name: '借方余额合计 == 贷方余额合计',
    passed: diff.isZero(),
    detail: diff.isZero()
      ? `借贷余额合计均为 ${round2(totalDebit).toFixed(2)}`
      : `借方余额合计 ${round2(totalDebit).toFixed(2)}，贷方余额合计 ${round2(totalCredit).toFixed(2)}，差额 ${diff.toFixed(2)}`,
  };
}

/**
 * I3：上期期末 == 本期期初（逐科目比对）
 */
export function checkInvariantI3(
  previous: AccountBalanceResult[],
  current: Array<{ accountId: string; openingDebit: Decimal; openingCredit: Decimal }>,
): InvariantResult {
  const prevMap = new Map(previous.map((b) => [b.accountId, b]));
  const mismatches: string[] = [];

  for (const cur of current) {
    const prev = prevMap.get(cur.accountId);
    if (!prev) continue;
    if (!prev.closingDebit.equals(cur.openingDebit) || !prev.closingCredit.equals(cur.openingCredit)) {
      mismatches.push(
        `科目 ${cur.accountId}: 上期期末 ${prev.closingDebit.toFixed(2)}/${prev.closingCredit.toFixed(2)} ` +
          `≠ 本期期初 ${cur.openingDebit.toFixed(2)}/${cur.openingCredit.toFixed(2)}`,
      );
    }
  }

  return {
    code: 'I3',
    name: '上期期末 == 本期期初',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? '全部科目期初余额与上期期末一致' : mismatches.slice(0, 5).join('；'),
  };
}

/**
 * I4：本期发生额 == 该期凭证分录聚合
 */
export function checkInvariantI4(
  balances: AccountBalanceResult[],
  occurrences: Map<string, Occurrence>,
): InvariantResult {
  const mismatches: string[] = [];
  for (const b of balances) {
    const occ = occurrences.get(b.accountId);
    const expDebit = round2(occ?.debitOccurred ?? 0);
    const expCredit = round2(occ?.creditOccurred ?? 0);
    if (!b.debitOccurred.equals(expDebit) || !b.creditOccurred.equals(expCredit)) {
      mismatches.push(
        `科目 ${b.accountId}: 余额表 ${b.debitOccurred.toFixed(2)}/${b.creditOccurred.toFixed(2)} ` +
          `≠ 分录聚合 ${expDebit.toFixed(2)}/${expCredit.toFixed(2)}`,
      );
    }
  }
  return {
    code: 'I4',
    name: '本期发生额 == 凭证分录聚合',
    passed: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? '余额表与凭证分录完全一致'
        : `${mismatches.length} 个科目不一致：${mismatches.slice(0, 3).join('；')}`,
  };
}

/**
 * I5：凭证号连续无空洞（每个凭证字独立判断）
 */
export function checkInvariantI5(
  vouchers: Array<{ voucherWord: string; voucherNo: number }>,
): InvariantResult {
  const byWord = new Map<string, number[]>();
  for (const v of vouchers) {
    const arr = byWord.get(v.voucherWord) ?? [];
    arr.push(v.voucherNo);
    byWord.set(v.voucherWord, arr);
  }

  const problems: string[] = [];
  for (const [word, nos] of byWord) {
    const sorted = [...nos].sort((a, b) => a - b);
    const unique = new Set(sorted);
    if (unique.size !== sorted.length) {
      problems.push(`${word}：存在重复凭证号`);
      continue;
    }
    // 年初凭证使用 0 号，单独成段
    if (sorted[0] === 0) {
      const rest = sorted.slice(1);
      if (rest.length > 0 && (rest[0] !== 1 || rest[rest.length - 1] !== rest.length)) {
        problems.push(`${word}：正常凭证号段不连续（${rest[0]}~${rest[rest.length - 1]}，共 ${rest.length} 张）`);
      }
    } else if (sorted[0] !== 1 || sorted[sorted.length - 1] !== sorted.length) {
      problems.push(`${word}：凭证号段不连续（${sorted[0]}~${sorted[sorted.length - 1]}，共 ${sorted.length} 张）`);
    }
  }

  return {
    code: 'I5',
    name: '凭证号连续无空洞',
    passed: problems.length === 0,
    detail: problems.length === 0 ? '各凭证字号段连续' : problems.join('；'),
  };
}

/** 汇总所有不变式 */
export function checkAllInvariants(params: {
  balances: AccountBalanceResult[];
  occurrences?: Map<string, Occurrence>;
  previousBalances?: AccountBalanceResult[];
  vouchers?: Array<{ voucherWord: string; voucherNo: number }>;
}): InvariantResult[] {
  const results: InvariantResult[] = [checkInvariantI2(params.balances)];
  if (params.previousBalances) {
    results.push(checkInvariantI3(params.previousBalances, params.balances));
  }
  if (params.occurrences) {
    results.push(checkInvariantI4(params.balances, params.occurrences));
  }
  if (params.vouchers) {
    results.push(checkInvariantI5(params.vouchers));
  }
  return results;
}

// ============================================================================
//  余额表呈现辅助
// ============================================================================

/**
 * 转成报表友好的「余额」数值：
 *   借方科目 → 取 closingDebit
 *   贷方科目 → 取 closingCredit
 * 反向余额以负数呈现。
 */
export function signedClosing(
  direction: Direction,
  closingDebit: Decimal | string,
  closingCredit: Decimal | string,
): Decimal {
  const d = round2(closingDebit);
  const c = round2(closingCredit);
  return direction === 'DEBIT' ? d : c;
}

/** 按科目层级汇总到上级（用于科目余额表的合计行） */
export function sumToParent(
  rows: Array<{ accountId: string; parentId: string | null; closingDebit: Decimal; closingCredit: Decimal }>,
): Map<string, { closingDebit: Decimal; closingCredit: Decimal }> {
  const own = new Map<string, { closingDebit: Decimal; closingCredit: Decimal }>();
  for (const r of rows) {
    const cur = own.get(r.accountId) ?? { closingDebit: new Decimal(0), closingCredit: new Decimal(0) };
    cur.closingDebit = cur.closingDebit.plus(r.closingDebit);
    cur.closingCredit = cur.closingCredit.plus(r.closingCredit);
    own.set(r.accountId, cur);
  }
  return own;
}
