/**
 * 价外税勾稽：不含税金额与税额的推导
 * ============================================================
 * ★ 这一模块要解决的问题：**不能让模型做算术，更不能让模型替我们判税**。
 *
 *   增值税是价外税，「不含税金额 = 含税金额 ÷ (1 + 税率)」是一条恒等式，
 *   不是估计。但实测模型会把它当成应用题自己算，产出两类错误：
 *
 *   ① 三元组自相矛盾（铁路票实测）：
 *        不含税=41.00  税率=9%  税额=3.38  含税=41.00
 *        41.00 + 3.38 = 44.38 ≠ 41.00
 *
 *   ② 三元组"自洽"但税判错了（同一张票的另一次识别）：
 *        不含税=41.00  税率=0   税额=0     含税=41.00
 *        41.00 + 0 = 41.00 —— 勾稽成立，于是就这么过了。
 *      可铁路运输是 9% 应税，票价的 41.00 里含着 3.39 可抵扣进项税。
 *      按"免税"处理等于让企业白白多缴这笔税，而且不会有任何报错。
 *
 *   ★ ②比①危险得多：①会 FAIL 把人叫来，②一路 PASS 悄悄少抵税。
 *     所以"自洽就不倒算"是错的判据 —— 旅客运输凭证的票面**本来就只印
 *     一个含税票价**，不含税与税额根本没印，模型报的 0% 是它的推断，
 *     不是票面事实。凡是法定税率明确的凭证，一律以法定口径倒算。
 *
 * ★ 法定税率由**凭证类型**决定，不能听模型的。
 *   财政部 税务总局公告2026年第13号 第一条第（二）项：
 *     1. 电子发票（铁路电子客票）、电子发票（航空运输电子客票行程单）
 *        —— 为「发票上列明**或包含**的增值税税额」；
 *        未列明时即包含在票面金额里，按 9% 倒算（交通运输服务）。
 *     2. 列明旅客身份信息的公路、水路等其他客票
 *        —— 票面金额 ÷ (1 + 3%) × 3%
 *   两者税率不同，认错凭证类型就会算错税额。
 */
import { Decimal, dec, round2 } from '@bookkeeper/shared';

/** 旅客运输凭证类型 —— 决定法定税率 */
export type PassengerTransportKind = 'RAIL' | 'AIR' | 'ROAD_WATER';

/**
 * 各凭证类型的法定税率（小数）。
 *
 * ★ 出租车/网约车的**卷式机打发票刻意不在此列**：
 *   它未列明旅客身份信息，按 13号公告（二）2 与上海税务口径**不属于**
 *   可抵扣凭证，压根不该给它倒算进项税 —— 那会凭空多抵 3%，
 *   是实打实的少缴税风险。
 *   而网约车开的**增值税电子普通发票**走另一条路（票面列明税额、凭票直抵），
 *   也不需要倒算。两种情况都不该走到这里。
 */
export const PASSENGER_TRANSPORT_RATE: Record<PassengerTransportKind, string> = {
  RAIL: '0.09',
  AIR: '0.09',
  ROAD_WATER: '0.03',
};

export type TaxSplitVerdict =
  /** 票面三元组自洽，且与法定口径一致 —— 原样保留 */
  | 'CONSISTENT'
  /** 已按价外税公式倒算，采用倒算值 */
  | 'DERIVED'
  /** 数互不相容且无法倒算 —— 倾向识别错误，交人工 */
  | 'CONFLICT'
  /** 信息不足，无法处理 */
  | 'INSUFFICIENT';

export interface TaxSplitInput {
  amountExclTax?: string | number | null;
  taxRate?: string | number | null;
  taxAmount?: string | number | null;
  amountInclTax?: string | number | null;
}

export interface TaxSplitResult {
  verdict: TaxSplitVerdict;
  amountExclTax: string | null;
  taxRate: string | null;
  taxAmount: string | null;
  amountInclTax: string | null;
  /** 给人看的说明，会作为一条校验发现展示（倒算必须让用户看见） */
  note: string;
}

/** 金额比较容差：与 validation 的 V1 保持一致 */
const TOLERANCE = '0.02';

/**
 * 从凭证类别文本识别旅客运输类型。
 *
 * 只在**明确**是铁路/航空/公路水路旅客运输时才返回，认不出就返回 null
 * —— 宁可不倒算，也不要套错税率。
 */
export function detectPassengerTransportKind(
  text: string | null | undefined,
): PassengerTransportKind | null {
  const s = (text ?? '').trim();
  if (!s) return null;

  /*
   * ★ 顺序不能反，而且关键词不能图省事写宽。
   *
   *   「电子发票（航空运输电子客票行程单）」里也含"电子客票"三个字 ——
   *   如果先判铁路、又把"电子客票"当成铁路的特征词，
   *   航空行程单会被认成铁路。虽然两者法定税率都是 9%、这次算不差钱，
   *   但类型判错会让所有按类型分支的逻辑一起错，所以先判航空，
   *   铁路也不靠"电子客票"这个词。
   */
  // 航空：电子发票（航空运输电子客票行程单）、机票
  if (/航空|机票|行程单/.test(s)) return 'AIR';
  // 铁路：电子发票（铁路电子客票）、火车票、高铁、12306 …
  if (/铁路|火车|高铁|动车|城际|12306/.test(s)) return 'RAIL';
  // 公路 / 水路：注意"出租车"刻意不算 —— 卷式发票不可抵扣
  if (/公路|水路|客运|长途汽车|汽车票|船票|轮渡/.test(s)) return 'ROAD_WATER';

  return null;
}

/**
 * 对票面金额做价外税勾稽；与法定口径不符时按公式倒算。
 *
 * @param input         模型抄回来的四个数（都可能是 null）
 * @param preferredRate 凭证类型对应的**法定**税率。给了就以它为准并强制倒算
 *                      （不看模型报的税率）；不给则退化为
 *                      "自洽即通过、不自洽才尝试倒算"。
 */
export function reconcileTaxSplit(
  input: TaxSplitInput,
  preferredRate?: string | null,
): TaxSplitResult {
  const incl = num(input.amountInclTax);
  const statedExcl = num(input.amountExclTax);
  const statedTax = num(input.taxAmount);
  const statutoryRate = num(preferredRate);
  const isStatutory = statutoryRate !== null;
  const rate = statutoryRate ?? num(input.taxRate);

  const keep = (verdict: TaxSplitVerdict, note: string): TaxSplitResult => ({
    verdict,
    amountExclTax: input.amountExclTax == null ? null : dec(input.amountExclTax).toFixed(2),
    taxRate: input.taxRate == null ? null : dec(input.taxRate).toString(),
    taxAmount: input.taxAmount == null ? null : dec(input.taxAmount).toFixed(2),
    amountInclTax: input.amountInclTax == null ? null : dec(input.amountInclTax).toFixed(2),
    note,
  });

  if (incl === null) {
    return keep('INSUFFICIENT', '票面没有可用的含税金额，无法做价外税勾稽。');
  }

  const tripleConsistent =
    statedExcl !== null &&
    statedTax !== null &&
    round2(statedExcl.plus(statedTax)).equals(round2(incl));

  // 没有税率可用：只能做朴素勾稽，凑不成体系就交人工
  if (rate === null || rate.isZero()) {
    if (tripleConsistent) {
      return keep(
        'CONSISTENT',
        `金额勾稽正确：${fmt(statedExcl)} + ${fmt(statedTax)} = ${fmt(incl)}`,
      );
    }
    if (statedExcl === null || statedTax === null) {
      return keep('INSUFFICIENT', '金额字段不完整，且没有税率可用，无法做勾稽校验。');
    }
    return keep(
      'INSUFFICIENT',
      `不含税与税额之和不等于价税合计，且没有税率可倒算：` +
        `${fmt(statedExcl)} + ${fmt(statedTax)} ≠ ${fmt(incl)}`,
    );
  }

  /*
   * ★ 先四舍五入税额、再用含税减出不含税 —— 顺序不能反。
   *   反过来的话 41.00 ÷ 1.09 = 37.61（已舍入），41.00 − 37.61 = 3.39，
   *   虽然这次也对得上，但当税率是 3% 这类除不尽的值时，
   *   两次舍入会让「不含税 + 税额」差一分钱，勾稽又失败。
   */
  const derivedTax = round2(incl.dividedBy(rate.plus(1)).times(rate));
  const derivedExcl = round2(incl.minus(derivedTax));

  const exclAgrees = statedExcl !== null && within(derivedExcl, statedExcl);
  const taxAgrees = statedTax !== null && within(derivedTax, statedTax);

  // 票面自洽、且税额与倒算一致 → 没什么可改的
  if (tripleConsistent && taxAgrees) {
    return keep(
      'CONSISTENT',
      `金额勾稽正确：${fmt(statedExcl)} + ${fmt(statedTax)} = ${fmt(incl)}`,
    );
  }

  /*
   * 非法定税率场景（专票/普票，税率是模型从票面读的）：
   * 两个数都与倒算对不上，说明**含税金额本身可疑**（例如 1130 被看成 11300），
   * 此时绝不能倒算 —— 那会把识别错误洗成一组自洽的假数字。
   *
   * 法定税率场景不做这道拦截：票面本来就只有含税票价，
   * 模型报的 0% 或错税率是它的推断，以法定口径倒算才是对的。
   */
  if (!isStatutory && !exclAgrees && !taxAgrees) {
    return keep(
      'CONFLICT',
      `金额互不相容且倒算结果也对不上：票面为 ${fmt(statedExcl)} + ${fmt(statedTax)} = ${fmt(incl)}，` +
        `按 ${pct(rate)} 倒算应为 ${fmt(derivedExcl)} + ${fmt(derivedTax)} = ${fmt(incl)}。` +
        '两者对不上通常意味着识别有误，请核对票面金额。',
    );
  }

  const changed =
    (statedExcl !== null && !exclAgrees) || (statedTax !== null && !taxAgrees);

  return {
    verdict: 'DERIVED',
    amountExclTax: derivedExcl.toFixed(2),
    taxRate: rate.toString(),
    taxAmount: derivedTax.toFixed(2),
    amountInclTax: round2(incl).toFixed(2),
    note:
      `票面未列明税额，已按价外税公式倒算：` +
      `${fmt(incl)} ÷ (1 + ${pct(rate)}) = ${fmt(derivedExcl)}，` +
      `税额 = ${fmt(incl)} − ${fmt(derivedExcl)} = ${fmt(derivedTax)}。` +
      (changed
        ? `票面识别到的税率为 ${input.taxRate == null ? '无' : pct(dec(input.taxRate))}、` +
          `税额为 ${fmt(statedTax)}，与法定口径不符，已以法定口径为准。`
        : '倒算结果与票面其他金额一致。'),
  };
}

// ============================================================================
//  内部
// ============================================================================

function num(v: string | number | null | undefined): Decimal | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  try {
    return dec(v);
  } catch {
    return null;
  }
}

function within(a: Decimal, b: Decimal): boolean {
  return a.minus(b).abs().lessThanOrEqualTo(TOLERANCE);
}

function fmt(v: Decimal | null): string {
  // 票面本来就可能没印这两个数（旅客运输凭证只有含税金额），
  // 报错文案要能如实说"未提供"，而不是显示成 0.00 误导人。
  return v === null ? '(票面未提供)' : round2(v).toFixed(2);
}

function pct(v: Decimal): string {
  return `${round2(v.times(100)).toString()}%`;
}