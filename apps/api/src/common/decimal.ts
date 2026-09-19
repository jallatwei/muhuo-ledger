/**
 * 金额工具（服务端）
 * ============================================================
 * 这里只做一件事：把 Prisma 的 Decimal 与 shared 的 Decimal 打通，
 * 并提供统一的数据库写入转换。
 *
 * ★ 所有金额运算一律使用 @bookkeeper/shared/money 的实现，
 *   本文件不重复实现任何计算逻辑，避免前后端两套算法产生分歧。
 */
import { Prisma } from '@prisma/client';
import { Decimal, dec, round2, toDbString, type DecimalInput } from '@bookkeeper/shared';

export { dec, round2, toDbString };
export type { DecimalInput };
export { Decimal };

/** Prisma Decimal / string / Decimal 统一转成 shared 的 Decimal */
export function fromDb(value: Prisma.Decimal | string | number | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  return dec(value.toString());
}

/**
 * 转成写库用的 Prisma.Decimal。
 * ★ 强制先舍入到 2 位小数，并把精度问题在这一处解决掉。
 */
export function toDb(value: DecimalInput): Prisma.Decimal {
  return new Prisma.Decimal(round2(value).toFixed(2));
}

/** 可空的金额字段 */
export function toDbNullable(value: DecimalInput | null | undefined): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  return toDb(value);
}

/** 税率（4 位小数） */
export function toDbRate(value: DecimalInput): Prisma.Decimal {
  return new Prisma.Decimal(dec(value).toDecimalPlaces(4).toString());
}

/**
 * 金额字段的 Prisma 查询过滤器辅助：
 * 处理「金额在某个区间」这类常见筛选，避免各处手写字符串比较。
 */
export function amountRange(min?: DecimalInput, max?: DecimalInput): Prisma.DecimalFilter | undefined {
  if (min === undefined && max === undefined) return undefined;
  const filter: Prisma.DecimalFilter = {};
  if (min !== undefined) filter.gte = toDb(min);
  if (max !== undefined) filter.lte = toDb(max);
  return filter;
}
