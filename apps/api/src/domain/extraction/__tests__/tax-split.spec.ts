/**
 * 价外税勾稽与倒算测试
 * ============================================================
 * ★ 核心回归：**火车票那张的真实数字**。
 *
 *   模型对电子发票（铁路电子客票）返回过：
 *     不含税=41.00  税率=9%  税额=3.38  含税=41.00
 *   三个数没有一个体系自洽（41.00 + 3.38 = 44.38 ≠ 41.00）。
 *   票面上其实只有「票价 ¥41.00」，不含税与税额本来就没印，
 *   是模型自己算出来的。
 *
 *   增值税是价外税，不含税 = 含税 ÷ (1+税率) 是恒等式。
 *   所以正确做法是系统自己算，而不是拿模型算错的数去报"识别有误"。
 */
import { describe, expect, it } from 'vitest';

import {
  PASSENGER_TRANSPORT_RATE,
  detectPassengerTransportKind,
  reconcileTaxSplit,
} from '../tax-split';

const RAIL = PASSENGER_TRANSPORT_RATE.RAIL; // 0.09

describe('detectPassengerTransportKind —— 凭证类型决定税率', () => {
  it('铁路电子客票 → RAIL（9%）', () => {
    expect(detectPassengerTransportKind('电子发票（铁路电子客票）')).toBe('RAIL');
    expect(detectPassengerTransportKind('火车票')).toBe('RAIL');
    expect(detectPassengerTransportKind('高铁')).toBe('RAIL');
  });

  it('航空运输电子客票行程单 → AIR（9%）', () => {
    expect(detectPassengerTransportKind('电子发票（航空运输电子客票行程单）')).toBe('AIR');
    expect(detectPassengerTransportKind('机票')).toBe('AIR');
  });

  it('公路 / 水路客票 → ROAD_WATER（3%）', () => {
    expect(detectPassengerTransportKind('公路客运客票')).toBe('ROAD_WATER');
    expect(detectPassengerTransportKind('长途汽车票')).toBe('ROAD_WATER');
    expect(detectPassengerTransportKind('轮渡船票')).toBe('ROAD_WATER');
  });

  it('★ 出租车卷式发票**不**归入旅客运输 —— 它未列明旅客身份信息，本就不能抵扣', () => {
    // 如果这里判成了 ROAD_WATER，系统就会给一张不可抵扣的凭证倒算出进项税，
    // 等于凭空多抵 3%，是实打实的少缴税风险。
    expect(detectPassengerTransportKind('出租车发票')).toBeNull();
    expect(detectPassengerTransportKind('河北通用机打发票（出租车卷式）')).toBeNull();
  });

  it('普通发票类别不归入旅客运输', () => {
    expect(detectPassengerTransportKind('增值税专用发票')).toBeNull();
    expect(detectPassengerTransportKind('增值税普通发票')).toBeNull();
    expect(detectPassengerTransportKind('')).toBeNull();
    expect(detectPassengerTransportKind(null)).toBeNull();
  });
});

describe('reconcileTaxSplit —— 票面自洽时原样保留', () => {
  it('专票三元组自洽 → CONSISTENT，不做任何改动', () => {
    const r = reconcileTaxSplit({
      amountExclTax: '1000.00',
      taxRate: '0.13',
      taxAmount: '130.00',
      amountInclTax: '1130.00',
    });
    expect(r.verdict).toBe('CONSISTENT');
    expect(r.amountExclTax).toBe('1000.00');
    expect(r.taxAmount).toBe('130.00');
  });

  it('住宿发票那组真实数字（471.70 / 6% / 28.30 / 500.00）→ CONSISTENT', () => {
    const r = reconcileTaxSplit({
      amountExclTax: '471.70',
      taxRate: '0.06',
      taxAmount: '28.30',
      amountInclTax: '500.00',
    });
    expect(r.verdict).toBe('CONSISTENT');
  });
});

describe('reconcileTaxSplit —— ★ 火车票真实数字：按价外税公式倒算', () => {
  // 模型抄回来的四个数
  const trainTicket = {
    amountExclTax: '41.00', // 模型把含税价直接抄进了不含税栏
    taxRate: '0.09',
    taxAmount: '3.38',
    amountInclTax: '41.00',
  };

  it('含税与税率齐备、税额吻合 → 判 DERIVED 并采用倒算值', () => {
    const r = reconcileTaxSplit(trainTicket, RAIL);
    expect(r.verdict).toBe('DERIVED');
    expect(r.amountInclTax).toBe('41.00');
    expect(r.amountExclTax).toBe('37.61');
    expect(r.taxAmount).toBe('3.39');
  });

  it('倒算结果自身满足勾稽：37.61 + 3.39 = 41.00', () => {
    const r = reconcileTaxSplit(trainTicket, RAIL);
    const sum = Number(r.amountExclTax) + Number(r.taxAmount);
    expect(sum).toBeCloseTo(Number(r.amountInclTax), 10);
  });

  it('note 说清这是"算出来的"而不是抄来的，并带上公式', () => {
    const r = reconcileTaxSplit(trainTicket, RAIL);
    expect(r.note).toContain('倒算');
    expect(r.note).toContain('37.61');
    expect(r.note).toContain('3.39');
  });

  it('法定税率优先于模型报的税率（认错凭证类型会算错税额）', () => {
    // 模型报 3%，但铁路的法定税率是 9%
    const r = reconcileTaxSplit({ ...trainTicket, taxRate: '0.03' }, RAIL);
    expect(r.verdict).toBe('DERIVED');
    expect(r.taxRate).toBe('0.09');
    expect(r.taxAmount).toBe('3.39');
  });

  it('★ 三元组"自洽"但被判成 0% 税率时，仍必须按法定 9% 倒算', () => {
    // 这是同一张火车票的另一次识别结果：模型认为这是免税的，
    // 41.00 + 0 = 41.00 勾稽成立，于是整条链路一路 PASS。
    // 但铁路运输是 9% 应税，41.00 里含着 3.39 可抵扣进项税；
    // 按免税处理等于让企业白交这笔税，而且不会有任何报错 ——
    // 比三元组矛盾（会 FAIL 把人叫来）危险得多。
    const r = reconcileTaxSplit(
      { amountExclTax: '41.00', taxRate: '0', taxAmount: '0', amountInclTax: '41.00' },
      RAIL,
    );
    expect(r.verdict).toBe('DERIVED');
    expect(r.amountExclTax).toBe('37.61');
    expect(r.taxAmount).toBe('3.39');
    expect(r.taxRate).toBe('0.09');
  });

  it('倒算覆盖了模型的税率时，note 里要说明"已以法定口径为准"', () => {
    const r = reconcileTaxSplit(
      { amountExclTax: '41.00', taxRate: '0', taxAmount: '0', amountInclTax: '41.00' },
      RAIL,
    );
    expect(r.note).toContain('法定口径');
  });

  it('公路水路用 3%：票面金额 ÷ 1.03 × 3%', () => {
    // 103.00 含税 → 不含税 100.00、税额 3.00
    const r = reconcileTaxSplit(
      { amountInclTax: '103.00', amountExclTax: '103.00', taxAmount: '3.00' },
      PASSENGER_TRANSPORT_RATE.ROAD_WATER,
    );
    expect(r.verdict).toBe('DERIVED');
    expect(r.amountExclTax).toBe('100.00');
    expect(r.taxAmount).toBe('3.00');
  });
});

describe('reconcileTaxSplit —— ★ 识别错误不能被"洗白"', () => {
  it('含税价看大一位数时装不下自洽解 → CONFLICT，交人工', () => {
    // 真实应为 1130/1000/130，模型把含税看成了 11300。
    // 若无条件倒算会得到 10000 + 1300 = 11300 —— 勾稽成立，错误被掩盖。
    const r = reconcileTaxSplit({
      amountExclTax: '1000.00',
      taxRate: '0.13',
      taxAmount: '130.00',
      amountInclTax: '11300.00',
    });
    expect(r.verdict).toBe('CONFLICT');
    expect(r.note).toContain('识别有误');
  });

  it('CONFLICT 时不返回任何可用的倒算值（避免上层误用）', () => {
    const r = reconcileTaxSplit({
      amountExclTax: '1000.00',
      taxRate: '0.13',
      taxAmount: '130.00',
      amountInclTax: '11300.00',
    });
    expect(r.amountExclTax).toBe('1000.00'); // 保持票面原值，未被改写
    expect(r.taxAmount).toBe('130.00');
  });

  it('缺含税金额 → INSUFFICIENT', () => {
    const r = reconcileTaxSplit({ amountExclTax: '100.00', taxAmount: '13.00' });
    expect(r.verdict).toBe('INSUFFICIENT');
  });

  it('缺税率且三元组不自洽 → INSUFFICIENT（无从倒算）', () => {
    const r = reconcileTaxSplit({
      amountExclTax: '100.00',
      taxAmount: '13.00',
      amountInclTax: '200.00',
    });
    expect(r.verdict).toBe('INSUFFICIENT');
  });

  it('票面只给了含税金额、没有任何其他数 → 也走 INSUFFICIENT 而不是瞎猜', () => {
    const r = reconcileTaxSplit({ amountInclTax: '41.00' });
    expect(r.verdict).toBe('INSUFFICIENT');
  });
});

describe('reconcileTaxSplit —— 舍入顺序', () => {
  it('先舍入税额再减出不含税，保证两者之和恰好等于含税', () => {
    // 3% 这类除不尽的税率最容易暴露两次舍入的漂移
    for (const incl of ['103.00', '100.00', '37.55', '999.99', '1.03']) {
      const r = reconcileTaxSplit({ amountInclTax: incl }, PASSENGER_TRANSPORT_RATE.ROAD_WATER);
      expect(r.verdict).toBe('DERIVED');
      const sum = Number(r.amountExclTax) + Number(r.taxAmount);
      expect(sum).toBeCloseTo(Number(incl), 10);
    }
  });

  it('9% 同样不漂移', () => {
    for (const incl of ['41.00', '553.00', '1000.00', '0.09']) {
      const r = reconcileTaxSplit({ amountInclTax: incl }, RAIL);
      expect(r.verdict).toBe('DERIVED');
      const sum = Number(r.amountExclTax) + Number(r.taxAmount);
      expect(sum).toBeCloseTo(Number(incl), 10);
    }
  });
});
