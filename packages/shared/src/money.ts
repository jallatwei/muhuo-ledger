/**
 * 金额精确运算工具
 * ============================================================
 * 设计红线（见 design/00-总览与范围.md 第 3 节）：
 *   1. 金额一律用十进制精确运算，**严禁 number 参与金额计算**
 *   2. 最小单位为「分」，所有入账金额必须恰好 2 位小数
 *   3. 舍入统一使用 ROUND_HALF_UP（四舍五入），与中文会计惯例一致
 *
 * 用法约定：
 *   - 从数据库读出的 Prisma.Decimal 直接传进来即可
 *   - 从表单读出的 string 直接传进来即可
 *   - 只有需要展示或写库时才调用 .toFixed(2) / .toString()
 */
import Decimal from 'decimal.js';

// ---------------------------------------------------------------- 全局配置
Decimal.set({
  precision: 28, // 足够覆盖任何企业金额
  rounding: Decimal.ROUND_HALF_UP, // 四舍五入（默认是 ROUND_HALF_UP，此处显式声明）
  toExpNeg: -30, // 禁止出现 1e-7 这类科学计数法
  toExpPos: 30,
});

/** 金额精度：2 位小数（分） */
export const MONEY_SCALE = 2;

/** 数量/单价精度：4 位小数（发票明细用） */
export const QUANTITY_SCALE = 4;

/** 税率精度：4 位小数（如 0.1300） */
export const TAX_RATE_SCALE = 4;

/** 借贷平衡允许的容差（元）。正常应为 0，仅用于容忍历史脏数据 */
export const BALANCE_TOLERANCE = new Decimal('0.005');

export type DecimalInput = Decimal | string | number | bigint;

// ---------------------------------------------------------------- 基础转换
/**
 * 转成 Decimal。
 * ⚠️ 传入 number 会有浮点误差风险，仅允许在**测试与常量**中使用；
 *    业务代码请传 string 或 Decimal。
 */
export function dec(value: DecimalInput): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MoneyError(`金额必须是有限数值，收到: ${value}`);
    }
    return new Decimal(value);
  }
  if (typeof value === 'bigint') return new Decimal(value.toString());
  const trimmed = String(value).trim().replace(/,/g, '').replace(/[¥￥\s]/g, '');
  if (trimmed === '') return new Decimal(0);
  try {
    return new Decimal(trimmed);
  } catch {
    throw new MoneyError(`无法解析为金额: "${value}"`);
  }
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

// ---------------------------------------------------------------- 舍入
/** 舍入到 2 位小数（分）。所有入账金额的最后一步都必须经过它 */
export function round2(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

/** 舍入到指定小数位 */
export function roundTo(value: DecimalInput, scale: number): Decimal {
  return dec(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
}

/** 舍入到 4 位小数（单价/数量） */
export function round4(value: DecimalInput): Decimal {
  return roundTo(value, QUANTITY_SCALE);
}

/** 向下取整到分（用于"最多可抵扣"类计算，保守处理） */
export function floor2(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_DOWN);
}

// ---------------------------------------------------------------- 核心断言
/**
 * ★ 断言金额恰好为 2 位小数。
 * 这是防止"3 位小数的金额悄悄入库"的闸门。
 * 不做静默四舍五入——静默舍入会让差额凭空消失，导致借贷不平且难以定位。
 */
export function assertMoneyPrecision(value: DecimalInput, fieldName = '金额'): Decimal {
  const d = dec(value);
  if (!d.isFinite()) {
    throw new MoneyError(`${fieldName} 必须是有限数值，收到: ${d.toString()}`);
  }
  if (d.decimalPlaces() > MONEY_SCALE) {
    throw new MoneyError(
      `${fieldName} 精度超过 ${MONEY_SCALE} 位小数: ${d.toString()}。` +
        `请先显式调用 round2()，不要依赖静默舍入。`,
    );
  }
  return d;
}

/** 断言金额为正数（分录行金额恒为正，方向由 direction 表达） */
export function assertPositive(value: DecimalInput, fieldName = '金额'): Decimal {
  const d = assertMoneyPrecision(value, fieldName);
  if (d.lte(0)) {
    throw new MoneyError(
      `${fieldName} 必须大于 0，收到: ${d.toString()}。` +
        `借贷方向请用 direction 字段表达，不要用负数金额。`,
    );
  }
  return d;
}

/** 断言金额非负 */
export function assertNonNegative(value: DecimalInput, fieldName = '金额'): Decimal {
  const d = assertMoneyPrecision(value, fieldName);
  if (d.lt(0)) {
    throw new MoneyError(`${fieldName} 不能为负数，收到: ${d.toString()}`);
  }
  return d;
}

// ---------------------------------------------------------------- 运算
export function add(...values: DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

export function sub(a: DecimalInput, b: DecimalInput): Decimal {
  return dec(a).minus(dec(b));
}

export function mul(a: DecimalInput, b: DecimalInput): Decimal {
  return dec(a).times(dec(b));
}

export function div(a: DecimalInput, b: DecimalInput): Decimal {
  const divisor = dec(b);
  if (divisor.isZero()) {
    throw new MoneyError('除数不能为 0');
  }
  return dec(a).dividedBy(divisor);
}

/** 求和并舍入到分（用于借贷合计） */
export function sumRound2(values: DecimalInput[]): Decimal {
  return round2(values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0)));
}

// ---------------------------------------------------------------- 比较
export function eq(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).equals(dec(b));
}

export function gt(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).greaterThan(dec(b));
}

export function gte(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).greaterThanOrEqualTo(dec(b));
}

export function lt(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).lessThan(dec(b));
}

export function lte(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).lessThanOrEqualTo(dec(b));
}

export function isZero(a: DecimalInput): boolean {
  return dec(a).isZero();
}

export function isPositive(a: DecimalInput): boolean {
  return dec(a).greaterThan(0);
}

/** 在容差范围内相等（仅用于比对历史数据，不用于入账校验） */
export function approxEq(a: DecimalInput, b: DecimalInput, tolerance: DecimalInput = BALANCE_TOLERANCE): boolean {
  return dec(a).minus(dec(b)).abs().lte(dec(tolerance));
}

// ---------------------------------------------------------------- 借贷平衡
export interface DirectionalAmount {
  direction: 'DEBIT' | 'CREDIT';
  amount: DecimalInput;
}

export interface BalanceResult {
  totalDebit: Decimal;
  totalCredit: Decimal;
  /** 借方 − 贷方 */
  difference: Decimal;
  balanced: boolean;
}

/**
 * ★★ 计算并判定借贷是否平衡。这是全系统最重要的一段代码。
 *
 * 规则：
 *   - 借方合计 == 贷方合计（精确相等，不容差）
 *   - 借方合计必须 > 0（不允许空凭证或全零凭证）
 *   - 至少 1 借 1 贷（单边凭证不是合法会计凭证）
 */
export function checkBalance(lines: DirectionalAmount[]): BalanceResult {
  if (!lines || lines.length === 0) {
    throw new MoneyError('凭证没有任何分录行');
  }

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  let debitCount = 0;
  let creditCount = 0;

  for (const [i, line] of lines.entries()) {
    const amount = assertMoneyPrecision(line.amount, `第 ${i + 1} 行金额`);
    if (amount.lte(0)) {
      throw new MoneyError(
        `第 ${i + 1} 行金额必须大于 0，收到 ${amount.toString()}。` +
          `负数金额请改用相反方向的 direction。`,
      );
    }
    if (line.direction === 'DEBIT') {
      totalDebit = totalDebit.plus(amount);
      debitCount += 1;
    } else if (line.direction === 'CREDIT') {
      totalCredit = totalCredit.plus(amount);
      creditCount += 1;
    } else {
      throw new MoneyError(`第 ${i + 1} 行 direction 非法: ${String(line.direction)}`);
    }
  }

  if (debitCount === 0 || creditCount === 0) {
    throw new MoneyError(
      `凭证必须同时有借方和贷方分录，当前 借${debitCount}条 / 贷${creditCount}条`,
    );
  }

  const difference = totalDebit.minus(totalCredit);

  return {
    totalDebit: round2(totalDebit),
    totalCredit: round2(totalCredit),
    difference,
    balanced: difference.isZero() && totalDebit.gt(0),
  };
}

/** 借贷不平衡时抛错；平衡则返回合计。过账前的最后一道闸门 */
export function assertBalanced(lines: DirectionalAmount[], voucherLabel = '凭证'): BalanceResult {
  const result = checkBalance(lines);
  if (!result.balanced) {
    throw new MoneyError(
      `${voucherLabel}借贷不平：借方合计 ${result.totalDebit.toFixed(2)}，` +
        `贷方合计 ${result.totalCredit.toFixed(2)}，` +
        `差额 ${result.difference.toFixed(2)}。凭证未保存。`,
    );
  }
  return result;
}

// ---------------------------------------------------------------- 价税分离
export interface TaxBreakdown {
  /** 不含税金额 */
  amountExclTax: Decimal;
  /** 税额 */
  taxAmount: Decimal;
  /** 价税合计 */
  amountInclTax: Decimal;
}

/**
 * 由「不含税金额 + 税率」计算税额与价税合计（用于开票、价外税计算）
 */
export function splitTaxFromExcl(amountExclTax: DecimalInput, taxRate: DecimalInput): TaxBreakdown {
  const excl = round2(amountExclTax);
  const rate = dec(taxRate);
  const tax = round2(excl.times(rate));
  return { amountExclTax: excl, taxAmount: tax, amountInclTax: round2(excl.plus(tax)) };
}

/**
 * 由「价税合计 + 税率」反算不含税金额与税额（用于从票面总额拆税）
 *
 * ⚠️ 增值税发票票面是「金额 + 税额 = 价税合计」，其中金额=round(价税合计/(1+税率))。
 *    计算顺序必须是「先算不含税金额，再倒挤税额」，否则会出现
 *    金额+税额 ≠ 价税合计 的 1 分钱差异（这是财务软件最常见的 bug 之一）。
 */
export function splitTaxFromIncl(amountInclTax: DecimalInput, taxRate: DecimalInput): TaxBreakdown {
  const incl = round2(amountInclTax);
  const rate = dec(taxRate);
  if (rate.isZero()) {
    return { amountExclTax: incl, taxAmount: new Decimal(0), amountInclTax: incl };
  }
  const excl = round2(incl.dividedBy(rate.plus(1)));
  // ★ 倒挤：税额 = 价税合计 − 不含税金额，保证三者恒等
  const tax = round2(incl.minus(excl));
  return { amountExclTax: excl, taxAmount: tax, amountInclTax: incl };
}

/**
 * 校验「金额 + 税额 == 价税合计」（容忍 ±0.02 元的票面舍入差异）
 * 这是识别阶段的交叉校验规则 V1，能拦住大量 OCR 数字错误。
 */
export function assertTaxConsistency(
  amountExclTax: DecimalInput,
  taxAmount: DecimalInput,
  amountInclTax: DecimalInput,
  tolerance = '0.02',
): { ok: boolean; difference: Decimal } {
  const expected = round2(dec(amountExclTax).plus(dec(taxAmount)));
  const actual = round2(amountInclTax);
  const difference = expected.minus(actual);
  return { ok: difference.abs().lte(dec(tolerance)), difference };
}

// ---------------------------------------------------------------- 中文大写金额
const CN_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'] as const;
const CN_UNITS = ['', '拾', '佰', '仟'] as const;
const CN_BIG_UNITS = ['', '万', '亿', '万亿'] as const;

/** 把一个 1~4 位的数字段转成中文，内部连续零合并为一个「零」，末尾零丢弃 */
function cnSection(digits: string): string {
  let out = '';
  let zeroPending = false;
  const len = digits.length;

  for (let i = 0; i < len; i += 1) {
    const d = Number(digits[i] ?? '0');
    const unit = CN_UNITS[len - 1 - i] ?? '';
    if (d === 0) {
      zeroPending = true;
    } else {
      if (zeroPending && out !== '') out += '零';
      zeroPending = false;
      out += (CN_DIGITS[d] ?? '') + unit;
    }
  }
  return out;
}

/**
 * 数字金额转中文大写（财务规范写法）。
 *
 * 示例：
 *   0                  → 零元整
 *   0.05               → 零元零伍分
 *   -1234.56           → 负壹仟贰佰叁拾肆元伍角陆分
 *   1130               → 壹仟壹佰叁拾元整
 *   1001               → 壹仟零壹元整
 *   10000              → 壹万元整
 *   100010000          → 壹亿零壹万元整
 *   100000000.01       → 壹亿元零壹分
 *   100.10             → 壹佰元壹角
 *
 * ⚠️ 重要：大写金额与小写不一致时，**以大写为准**（发票查验惯例）。
 *    识别阶段会把大小写差异作为告警返回给人工复核。
 */
export function toChineseUppercase(value: DecimalInput): string {
  const d = round2(value);
  const negative = d.isNegative();
  const abs = d.abs();

  if (abs.isZero()) return '零元整';

  const [intPartRaw, fracPartRaw = ''] = abs.toFixed(2).split('.');
  const intPart = intPartRaw ?? '0';
  const jiao = Number(fracPartRaw[0] ?? '0');
  const fen = Number(fracPartRaw[1] ?? '0');

  // ---- 整数部分 ----
  let intCn = '';
  if (intPart !== '0') {
    // 从右往左每 4 位切一段
    const sections: string[] = [];
    let cursor: string = intPart;
    while (cursor.length > 0) {
      sections.unshift(cursor.slice(-4));
      cursor = cursor.slice(0, -4);
    }

    for (let i = 0; i < sections.length; i += 1) {
      const sectionStr = sections[i] as string;
      const bigUnitIndex = sections.length - 1 - i;
      const converted = cnSection(sectionStr);

      if (converted === '') {
        // 整段为 0：若后面还有非零段，需要补一个「零」占位
        const hasNonZeroAfter = sections
          .slice(i + 1)
          .some((s) => Number(s) > 0);
        if (hasNonZeroAfter && intCn !== '' && !intCn.endsWith('零')) {
          intCn += '零';
        }
        continue;
      }
      // ★ 段内高位有 0（如 "0001"、"0010"）且前面已有内容 → 必须补一个「零」
      //   例：10001 → 段 ["1","0001"]，第二段高位全零 → 壹万零壹
      //       100000001 → 段 ["1","0000","0001"]，中间段全零已被上面处理 →
      //                   壹亿零壹
      if (intCn !== '' && sectionStr.charAt(0) === '0' && !intCn.endsWith('零')) {
        intCn += '零';
      }
      intCn += converted + (CN_BIG_UNITS[bigUnitIndex] ?? '');
    }
  }

  const intCnFinal = intCn === '' ? '零' : intCn;

  // ---- 小数部分 ----
  let fracCn = '';
  if (jiao === 0 && fen === 0) {
    fracCn = '整';
  } else if (jiao === 0) {
    // 元与分之间必须有「零」
    fracCn = `零${CN_DIGITS[fen]}分`;
  } else if (fen === 0) {
    fracCn = `${CN_DIGITS[jiao]}角`;
  } else {
    fracCn = `${CN_DIGITS[jiao]}角${CN_DIGITS[fen]}分`;
  }

  return `${negative ? '负' : ''}${intCnFinal}元${fracCn}`;
}

// ---------------------------------------------------------------- 展示格式化
/** 千分位格式化，固定 2 位小数。仅用于展示，不用于计算 */
export function formatMoney(value: DecimalInput, options: { thousands?: boolean; symbol?: boolean } = {}): string {
  const { thousands = true, symbol = false } = options;
  const d = round2(value);
  const negative = d.isNegative();
  const [intPart, frac] = d.abs().toFixed(2).split('.');
  const grouped = thousands ? (intPart as string).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : (intPart as string);
  return `${negative ? '-' : ''}${symbol ? '¥' : ''}${grouped}.${frac}`;
}

/** 转为写库用的字符串（固定 2 位小数，无千分位） */
export function toDbString(value: DecimalInput): string {
  return round2(value).toFixed(2);
}

/**
 * 归一化「外来的税率写法」为小数。
 * ============================================================
 * ★ 为什么必须有这一步，而不是"让提示词写清楚就行"：
 *   实测小米 MiMo 在两次同类请求里，一次返回 "0.13"、一次返回 "13%"。
 *   提示词无法保证模型的写法，而 "13%" 走到 dec() 会直接抛 MoneyError
 *   （dec 会剥掉 ¥ 与千分位，但**不剥百分号**），
 *   最终以 500 的形式糊在用户脸上，连"税率格式不对"这句话都看不到。
 *
 *   归一化规则（之所以敢这么判，是因为合法税率全都 < 0.15）：
 *     "13%"  → 0.13     （显式百分号，除以 100）
 *     "13"   → 0.13     （数值 ≥ 1，只可能是百分数写法）
 *     "0.13" → 0.13     （已经是小数，原样保留）
 *     "0.13%"→ 0.0013   （照百分号处理；它不是合法税率，交给 V3 校验去报错）
 *
 *   ★ 注意这里**不抛异常**：不认识的写法原样返回，让校验规则 V3
 *     给出"不在合法枚举内"这种用户能看懂、能自己改的提示。
 *     "无法解析为金额"这种内部错误不该出现在用户的界面上。
 */
export function normalizeTaxRate(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (s === '') return undefined;

  const hadPercent = s.includes('%') || s.includes('％');
  const cleaned = s.replace(/[%％,，\s¥￥]/g, '');
  if (cleaned === '') return undefined;

  let d: Decimal;
  try {
    d = new Decimal(cleaned);
  } catch {
    return s; // 不认识的写法原样交回，由 V3 报"不在合法枚举内"
  }
  if (!d.isFinite()) return s;

  // 显式百分号，或数值大到不可能是小数税率 —— 都按百分数处理
  if (hadPercent || d.abs().greaterThanOrEqualTo(1)) {
    d = d.dividedBy(100);
  }
  return d.toString();
}

/** 税率展示：0.13 → "13%"，0 → "免税" */
export function formatTaxRate(rate: DecimalInput): string {
  const r = dec(rate);
  if (r.isZero()) return '免税';
  return `${roundTo(r.times(100), 2).toString()}%`;
}

export { Decimal };
