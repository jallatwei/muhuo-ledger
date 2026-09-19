/**
 * 科目余额计算与账务不变式测试
 * ============================================================
 * 余额算错 = 报表全错。这组测试覆盖 design/03 第 4 节的唯一权威公式，
 * 以及 I2~I5 四条可随时自检的不变式。
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  aggregateOccurrences,
  computeClosing,
  computeAccountBalance,
  rollForward,
  checkInvariantI2,
  checkInvariantI3,
  checkInvariantI4,
  checkInvariantI5,
  checkAllInvariants,
  signedClosing,
  type AccountBalanceResult,
  type OccurrenceRow,
} from '../balance';

function bal(
  accountId: string,
  openingDebit: string,
  openingCredit: string,
  debitOccurred: string,
  creditOccurred: string,
  direction: 'DEBIT' | 'CREDIT' = 'DEBIT',
): AccountBalanceResult {
  const closing = computeClosing({
    direction,
    openingDebit,
    openingCredit,
    debitOccurred,
    creditOccurred,
  });
  return {
    accountId,
    openingDebit: new Decimal(openingDebit),
    openingCredit: new Decimal(openingCredit),
    debitOccurred: new Decimal(debitOccurred),
    creditOccurred: new Decimal(creditOccurred),
    ...closing,
  };
}

describe('发生额聚合', () => {
  it('按科目汇总借贷发生额', () => {
    const rows: OccurrenceRow[] = [
      { accountId: 'a', direction: 'DEBIT', amount: new Decimal('1000.00') },
      { accountId: 'a', direction: 'DEBIT', amount: new Decimal('500.00') },
      { accountId: 'a', direction: 'CREDIT', amount: new Decimal('200.00') },
      { accountId: 'b', direction: 'CREDIT', amount: new Decimal('1300.00') },
    ];
    const occ = aggregateOccurrences(rows);
    expect(occ.get('a')?.debitOccurred.toFixed(2)).toBe('1500.00');
    expect(occ.get('a')?.creditOccurred.toFixed(2)).toBe('200.00');
    expect(occ.get('b')?.creditOccurred.toFixed(2)).toBe('1300.00');
    expect(occ.get('b')?.debitOccurred.toFixed(2)).toBe('0.00');
  });

  it('空输入返回空 Map', () => {
    expect(aggregateOccurrences([]).size).toBe(0);
  });
});

describe('★ 期末余额计算（唯一权威公式）', () => {
  it('借方科目：期末 = 期初 + 借方发生 − 贷方发生', () => {
    const r = computeClosing({
      direction: 'DEBIT',
      openingDebit: '1000.00',
      openingCredit: '0',
      debitOccurred: '5000.00',
      creditOccurred: '3000.00',
    });
    expect(r.closingDebit.toFixed(2)).toBe('3000.00');
    expect(r.closingCredit.toFixed(2)).toBe('0.00');
  });

  it('贷方科目：期末 = 期初 + 贷方发生 − 借方发生', () => {
    const r = computeClosing({
      direction: 'CREDIT',
      openingDebit: '0',
      openingCredit: '2000.00',
      debitOccurred: '500.00',
      creditOccurred: '3000.00',
    });
    expect(r.closingCredit.toFixed(2)).toBe('4500.00');
    expect(r.closingDebit.toFixed(2)).toBe('0.00');
  });

  it('借方科目出现反向余额（如银行存款透支）以负数记入同侧', () => {
    const r = computeClosing({
      direction: 'DEBIT',
      openingDebit: '100.00',
      openingCredit: '0',
      debitOccurred: '0',
      creditOccurred: '500.00',
    });
    expect(r.closingDebit.toFixed(2)).toBe('-400.00');
    expect(r.closingCredit.toFixed(2)).toBe('0.00');
  });

  it('印花税等小额计算不丢分', () => {
    const r = computeClosing({
      direction: 'DEBIT',
      openingDebit: '0.00',
      openingCredit: '0.00',
      debitOccurred: '0.01',
      creditOccurred: '0.01',
    });
    expect(r.closingDebit.toFixed(2)).toBe('0.00');
  });
});

describe('computeAccountBalance 完整余额行', () => {
  it('缺省期初与发生额按 0 处理', () => {
    const r = computeAccountBalance({ accountId: 'a', direction: 'DEBIT', opening: undefined, occurrence: undefined });
    expect(r.openingDebit.toFixed(2)).toBe('0.00');
    expect(r.debitOccurred.toFixed(2)).toBe('0.00');
    expect(r.closingDebit.toFixed(2)).toBe('0.00');
  });

  it('组合期初与发生额', () => {
    const r = computeAccountBalance({
      accountId: 'a',
      direction: 'CREDIT',
      opening: { accountId: 'a', openingDebit: new Decimal(0), openingCredit: new Decimal('1130.00') },
      occurrence: {
        accountId: 'a',
        debitOccurred: new Decimal('1130.00'),
        creditOccurred: new Decimal('2260.00'),
      },
    });
    expect(r.closingCredit.toFixed(2)).toBe('2260.00');
  });
});

describe('滚动下期期初', () => {
  it('上期期末即本期期初', () => {
    const prev = bal('a', '1000.00', '0', '500.00', '200.00');
    expect(prev.closingDebit.toFixed(2)).toBe('1300.00');
    const opening = rollForward(prev);
    expect(opening.openingDebit.toFixed(2)).toBe('1300.00');
    expect(opening.openingCredit.toFixed(2)).toBe('0.00');
  });
});

describe('★ 不变式 I2：借方余额合计 == 贷方余额合计', () => {
  it('一张平衡凭证产生的余额满足 I2', () => {
    // 借 银行存款 1130 / 贷 主营业务收入 1000 + 贷 销项税额 130
    const balances = [
      bal('bank', '0', '0', '1130.00', '0', 'DEBIT'),
      bal('revenue', '0', '0', '0', '1000.00', 'CREDIT'),
      bal('outputTax', '0', '0', '0', '130.00', 'CREDIT'),
    ];
    const r = checkInvariantI2(balances);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('1130.00');
  });

  it('余额表被污染时 I2 不通过，并给出差额', () => {
    const balances = [
      bal('bank', '0', '0', '1130.00', '0', 'DEBIT'),
      bal('revenue', '0', '0', '0', '1000.00', 'CREDIT'), // 少了 130
    ];
    const r = checkInvariantI2(balances);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('130.00');
  });

  it('红冲后（原凭证 REVERSED + 红冲凭证 POSTED）余额归零且仍满足 I2', () => {
    const balances = [
      bal('bank', '0', '0', '1130.00', '1130.00', 'DEBIT'),
      bal('revenue', '0', '0', '1000.00', '1000.00', 'CREDIT'),
      bal('outputTax', '0', '0', '130.00', '130.00', 'CREDIT'),
    ];
    const r = checkInvariantI2(balances);
    expect(r.passed).toBe(true);
    expect(balances[0]?.closingDebit.toFixed(2)).toBe('0.00');
  });
});

describe('不变式 I3：上期期末 == 本期期初', () => {
  it('一致时通过', () => {
    const prev = [bal('a', '0', '0', '1000.00', '0')];
    const cur = [
      {
        accountId: 'a',
        openingDebit: new Decimal('1000.00'),
        openingCredit: new Decimal('0.00'),
      },
    ];
    expect(checkInvariantI3(prev, cur).passed).toBe(true);
  });

  it('不一致时指出具体科目与金额', () => {
    const prev = [bal('a', '0', '0', '1000.00', '0')];
    const cur = [
      {
        accountId: 'a',
        openingDebit: new Decimal('900.00'),
        openingCredit: new Decimal('0.00'),
      },
    ];
    const r = checkInvariantI3(prev, cur);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('1000.00');
    expect(r.detail).toContain('900.00');
  });
});

describe('不变式 I4：本期发生额 == 凭证分录聚合', () => {
  it('一致时通过', () => {
    const balances = [bal('a', '0', '0', '1000.00', '0')];
    const occ = aggregateOccurrences([
      { accountId: 'a', direction: 'DEBIT', amount: new Decimal('1000.00') },
    ]);
    expect(checkInvariantI4(balances, occ).passed).toBe(true);
  });

  it('不一致时报出差异科目数', () => {
    const balances = [bal('a', '0', '0', '1000.00', '0')];
    const occ = aggregateOccurrences([
      { accountId: 'a', direction: 'DEBIT', amount: new Decimal('900.00') },
    ]);
    const r = checkInvariantI4(balances, occ);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('1 个科目不一致');
  });
});

describe('不变式 I5：凭证号连续无空洞', () => {
  it('1..5 连续通过', () => {
    const vouchers = [1, 2, 3, 4, 5].map((n) => ({ voucherWord: '记', voucherNo: n }));
    expect(checkInvariantI5(vouchers).passed).toBe(true);
  });

  it('缺 3 号则不通过', () => {
    const vouchers = [1, 2, 4, 5].map((n) => ({ voucherWord: '记', voucherNo: n }));
    const r = checkInvariantI5(vouchers);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('记');
  });

  it('重复凭证号不通过', () => {
    const vouchers = [1, 2, 2, 3].map((n) => ({ voucherWord: '记', voucherNo: n }));
    const r = checkInvariantI5(vouchers);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('重复');
  });

  it('多个凭证字各自独立判断', () => {
    const vouchers = [
      { voucherWord: '记', voucherNo: 1 },
      { voucherWord: '记', voucherNo: 2 },
      { voucherWord: '收', voucherNo: 1 },
      { voucherWord: '收', voucherNo: 2 },
    ];
    expect(checkInvariantI5(vouchers).passed).toBe(true);
  });

  it('年初凭证用 0 号，正常凭证仍从 1 开始', () => {
    const vouchers = [
      { voucherWord: '年初', voucherNo: 0 },
      { voucherWord: '记', voucherNo: 1 },
      { voucherWord: '记', voucherNo: 2 },
    ];
    expect(checkInvariantI5(vouchers).passed).toBe(true);
  });

  it('空集合通过', () => {
    expect(checkInvariantI5([]).passed).toBe(true);
  });
});

describe('checkAllInvariants 汇总', () => {
  it('返回全部请求的不变式结果', () => {
    const balances = [
      bal('bank', '0', '0', '1130.00', '0', 'DEBIT'),
      bal('revenue', '0', '0', '0', '1130.00', 'CREDIT'),
    ];
    const occ = aggregateOccurrences([
      { accountId: 'bank', direction: 'DEBIT', amount: new Decimal('1130.00') },
      { accountId: 'revenue', direction: 'CREDIT', amount: new Decimal('1130.00') },
    ]);
    // 上期：期初为 0，发生额 800，故期末 bank 800 / revenue 800
    // 本期：期初承接上期期末（800），再发生 330，故期末 1130
    const previous = [
      bal('bank', '0', '0', '800.00', '0', 'DEBIT'),
      bal('revenue', '0', '0', '0', '800.00', 'CREDIT'),
    ];
    const current = [
      bal('bank', '800.00', '0', '330.00', '0', 'DEBIT'),
      bal('revenue', '0', '800.00', '0', '330.00', 'CREDIT'),
    ];
    const currentOcc = aggregateOccurrences([
      { accountId: 'bank', direction: 'DEBIT', amount: new Decimal('330.00') },
      { accountId: 'revenue', direction: 'CREDIT', amount: new Decimal('330.00') },
    ]);

    const results = checkAllInvariants({
      balances: current,
      occurrences: currentOcc,
      previousBalances: previous,
      // 「年初」凭证使用 0 号，正常凭证从 1 开始且连续
      vouchers: [
        { voucherWord: '年初', voucherNo: 0 },
        { voucherWord: '记', voucherNo: 1 },
      ],
    });

    expect(current[0]?.closingDebit.toFixed(2)).toBe('1130.00');
    expect(results.map((r) => r.code)).toEqual(['I2', 'I3', 'I4', 'I5']);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});

describe('余额呈现', () => {
  it('按科目方向取余额值', () => {
    expect(signedClosing('DEBIT', '1000.00', '0').toFixed(2)).toBe('1000.00');
    expect(signedClosing('CREDIT', '0', '1000.00').toFixed(2)).toBe('1000.00');
  });
});
