/**
 * 会计期间 —— 领域逻辑
 * ============================================================
 * 状态机（见 design/03 第 3 节）：
 *
 *   OPEN ──开始结账──▶ CLOSING ──结账成功──▶ CLOSED
 *     ▲                   │                    │
 *     │                   │失败(回滚)           │反结账(需 OWNER + 理由)
 *     └───────────────────┴────────────────────┘
 *
 *   OPEN    : 可增删改凭证
 *   CLOSING : 结账施工中，禁止任何凭证写入（结账流程自身的结转凭证除外）
 *   CLOSED  : 完全冻结
 */
import type { PeriodInfo } from './voucher.entity';
import { PeriodLockedError } from './errors';

export { periodLabel } from './voucher.entity';

/** 期间是否允许普通业务写入 */
export function canWriteVouchers(period: Pick<PeriodInfo, 'status'>): boolean {
  return period.status === 'OPEN';
}

/** 期间是否可以开始结账 */
export function canStartClose(period: Pick<PeriodInfo, 'status'>): { ok: boolean; reason?: string } {
  if (period.status === 'CLOSED') {
    return { ok: false, reason: '该期间已结账。如需重新结账，请先执行「反结账」。' };
  }
  if (period.status === 'CLOSING') {
    return { ok: false, reason: '该期间正在结账中。如上次结账中断，可点击「继续结账」断点续跑。' };
  }
  return { ok: true };
}

/** 期间是否可以反结账 */
export function canReopen(period: Pick<PeriodInfo, 'status'>): { ok: boolean; reason?: string } {
  if (period.status === 'OPEN') {
    return { ok: false, reason: '该期间尚未结账，无需反结账。' };
  }
  return { ok: true };
}

/** 断言期间可写，否则抛带用户提示的错误 */
export function assertWritable(period: PeriodInfo): void {
  if (!canWriteVouchers(period)) {
    throw new PeriodLockedError(
      `${period.fiscalYear}-${String(period.month).padStart(2, '0')}`,
      period.status,
    );
  }
}

/**
 * 计算期间的起止日期。
 * ★ 使用 UTC 日期，避免容器时区变化导致期间边界漂移。
 */
export function periodBoundaries(year: number, month: number): { startsOn: Date; endsOn: Date } {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new Error(`会计年度非法：${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`会计月份非法：${month}`);
  }
  return {
    startsOn: new Date(Date.UTC(year, month - 1, 1)),
    // 下个月的第 0 天 = 本月最后一天
    endsOn: new Date(Date.UTC(year, month, 0)),
  };
}

/** 上一个期间的年月 */
export function previousPeriod(year: number, month: number): { fiscalYear: number; month: number } {
  return month === 1 ? { fiscalYear: year - 1, month: 12 } : { fiscalYear: year, month: month - 1 };
}

/** 下一个期间的年月 */
export function nextPeriod(year: number, month: number): { fiscalYear: number; month: number } {
  return month === 12 ? { fiscalYear: year + 1, month: 1 } : { fiscalYear: year, month: month + 1 };
}

/** 生成某年度的 12 个期间定义（新建主体时用） */
export function buildYearPeriods(
  entityId: string,
  year: number,
): Array<{
  entityId: string;
  fiscalYear: number;
  month: number;
  startsOn: Date;
  endsOn: Date;
  status: 'OPEN';
}> {
  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const { startsOn, endsOn } = periodBoundaries(year, month);
    return { entityId, fiscalYear: year, month, startsOn, endsOn, status: 'OPEN' as const };
  });
}

/**
 * 判断某日期是否落在期间内。
 * 用 UTC 日期比较，只比到「天」。
 */
export function isDateInPeriod(
  date: Date,
  period: Pick<PeriodInfo, 'startsOn' | 'endsOn'>,
): boolean {
  const d = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const s = Date.UTC(
    period.startsOn.getUTCFullYear(),
    period.startsOn.getUTCMonth(),
    period.startsOn.getUTCDate(),
  );
  const e = Date.UTC(
    period.endsOn.getUTCFullYear(),
    period.endsOn.getUTCMonth(),
    period.endsOn.getUTCDate(),
  );
  return d >= s && d <= e;
}

/** 从日期推出所属年月 */
export function periodOfDate(date: Date): { fiscalYear: number; month: number } {
  return { fiscalYear: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}
