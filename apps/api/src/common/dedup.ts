/**
 * 发票去重键
 * ============================================================
 * 「同一张发票绝不重复入账」是三条设计红线之一，而这条红线的执行点就在这里。
 *
 * 为什么必须抽成公共模块：
 *   这个规则原先在三个地方各写了一份（在线发票模块、历史导入模块、
 *   单据识别模块），三份的公式**并不完全一致** ——
 *   这类"同一规则多处实现"是重复入账最常见的来源：
 *   某一处改了公式，另一处没跟上，同一张票就会在两个入口下算出不同的键。
 *
 * 关于 namespace（`I|` / `H|` 前缀）：
 *   在线发票进 invoice 表，历史导入进 history_invoice_record 表。
 *   两张表的唯一约束都是「主体 + dedupHash」，前缀让同一张票在两张表里
 *   可以各自存在一条（这是有意的：历史表是"重建用的原始素材"，
 *   在线表是"已入账的台账"，两者生命周期不同）。
 *   但**同一张表内部**的公式必须唯一且稳定，这正是本模块保证的事。
 */
import type { Decimal } from '@bookkeeper/shared';

export interface DedupKeyInput {
  direction: string;
  invoiceCode: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date;
  isRedFlushed: boolean;
  /** 无发票号码时的兜底识别依据：对方税号优先，其次对方名称 */
  counterpartyTaxNo?: string | null;
  counterpartyName?: string | null;
  amountInclTax: Decimal;
}

/**
 * 生成去重键。
 *
 * 两级策略：
 *   ① 有发票号码 → 「方向 + 代码 + 号码 + 红冲标记」
 *      这是税局口径的天然唯一键，最可靠。
 *      ⚠️ 不含日期与金额：同一张票重扫一次，日期或金额识别出细微差异时，
 *        仍然应该被判为同一张票，而不是新增一条。
 *   ② 无发票号码（部分普票、票据、历史台账缺号）→ 降级为
 *      「方向 + 日期 + 对方 + 金额 + 红冲标记」
 *      这是**弱键**：同一天同一对方同金额的两笔真实业务会被误判为同一张。
 *      所以这里必须让调用方知道用的是弱键 —— 见 `isWeakDedupKey`。
 */
export function buildInvoiceDedupHash(
  namespace: string,
  p: DedupKeyInput,
): string {
  if (p.invoiceNumber) {
    return (
      `${namespace}|${p.direction}|${p.invoiceCode ?? ''}|${p.invoiceNumber}|` +
      `${p.isRedFlushed ? 1 : 0}`
    );
  }

  const party = (p.counterpartyTaxNo ?? p.counterpartyName ?? '').replace(/\s+/g, '');
  return (
    `${namespace}|${p.direction}|${p.invoiceDate.toISOString().slice(0, 10)}|` +
    `${party}|${p.amountInclTax.toFixed(2)}|${p.isRedFlushed ? 1 : 0}`
  );
}

/**
 * 是否退化为弱键（没有发票号码）。
 *
 * 界面应当据此提示"这条记录靠日期+对方+金额去重，同日同额的两笔业务会被判为同一张"，
 * 而不是让人以为系统能可靠地区分它们。
 */
export function isWeakDedupKey(invoiceNumber: string | null | undefined): boolean {
  return !invoiceNumber || String(invoiceNumber).trim() === '';
}

/** 在线发票台账的命名空间 */
export const DEDUP_NS_INVOICE = 'I';
/** 历史导入原始素材的命名空间 */
export const DEDUP_NS_HISTORY = 'H';
