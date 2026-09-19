/**
 * 会计内核测试
 * ============================================================
 * 对应 design/08-开发路线图与验收.md 第 2 节的 T20~T28：
 *   T20 借贷不平不落库     T21 金额为 0 或负      T22 非末级科目记账
 *   T23 已结账期间写凭证   T24 凭证号连续性       T25 并发分配凭证号
 *   T26 幂等生成           T27 红冲                T28 重复导入同一发票
 *
 * 这些用例是「别记错」的底线，任何一条失败都不允许上线。
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { JournalVoucher, type LineDraft, type PeriodInfo } from '../voucher.entity';
import {
  InvalidAmountError,
  NonLeafAccountError,
  PeriodDateMismatchError,
  PeriodLockedError,
  PostedVoucherImmutableError,
  SingleSidedVoucherError,
  InvalidVoucherTransitionError,
  MissingAuxDimensionError,
  UnbalancedVoucherError,
} from '../errors';

// ---------------------------------------------------------------- 测试夹具
const ENTITY_ID = 'entity-1';
const PERIOD_ID = 'period-2025-03';

const PERIOD: PeriodInfo = {
  id: PERIOD_ID,
  fiscalYear: 2025,
  month: 3,
  status: 'OPEN',
  startsOn: new Date('2025-03-01T00:00:00Z'),
  endsOn: new Date('2025-03-31T23:59:59Z'),
};

function line(
  accountCode: string,
  direction: 'DEBIT' | 'CREDIT',
  amount: string,
  extra: Partial<LineDraft> = {},
): LineDraft {
  return {
    accountId: `acc-${accountCode}`,
    accountCode,
    accountName: `科目${accountCode}`,
    accountIsLeaf: true,
    accountIsActive: true,
    direction,
    amount: new Decimal(amount),
    ...extra,
  };
}

function makeDraft(lines: LineDraft[], overrides: Partial<Parameters<typeof JournalVoucher.create>[0]> = {}) {
  return JournalVoucher.create({
    entityId: ENTITY_ID,
    periodId: PERIOD_ID,
    periodYear: 2025,
    periodMonth: 3,
    voucherDate: new Date('2025-03-15T00:00:00Z'),
    summary: '测试凭证',
    sourceType: 'MANUAL',
    lines,
    ...overrides,
  });
}

/** 一张标准的采购办公用品凭证：1000 + 130 税 = 1130 */
function officeSupplyLines(): LineDraft[] {
  return [
    line('660202', 'DEBIT', '1000.00', { summary: '办公费' }),
    line('22210102', 'DEBIT', '130.00', { summary: '待认证进项税额', taxRate: new Decimal('0.13') }),
    line('2202', 'CREDIT', '1130.00', { summary: '应付账款', partnerId: 'partner-1' }),
  ];
}

// ============================================================================
describe('T20 · 借贷不平的凭证必须抛错且不落库', () => {
  it('借方 1000 / 贷方 900 → 抛 UnbalancedVoucherError', () => {
    expect(() =>
      makeDraft([line('660202', 'DEBIT', '1000.00'), line('2202', 'CREDIT', '900.00')]),
    ).toThrow(UnbalancedVoucherError);
  });

  it('差额信息必须包含具体数字，便于用户定位', () => {
    try {
      makeDraft([line('660202', 'DEBIT', '1000.00'), line('2202', 'CREDIT', '900.00')]);
      throw new Error('本应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(UnbalancedVoucherError);
      const err = e as UnbalancedVoucherError;
      expect(err.userMessage).toContain('1,000.00'.replace(',', '') === '1,000.00' ? '1000.00' : '1000.00');
      expect(err.userMessage).toContain('900.00');
      expect(err.userMessage).toContain('100.00');
    }
  });

  it('1 分钱差异也算不平', () => {
    expect(() =>
      makeDraft([line('660202', 'DEBIT', '1000.00'), line('2202', 'CREDIT', '999.99')]),
    ).toThrow(UnbalancedVoucherError);
  });

  it('只有借方没有贷方 → 单边凭证抛错', () => {
    // 单边不是「不平」，而是结构不合法，必须给用户一句能看懂的话
    expect(() => makeDraft([line('660202', 'DEBIT', '1000.00')])).toThrow(SingleSidedVoucherError);
  });

  it('没有任何分录行 → 抛 EmptyVoucherError', () => {
    expect(() => makeDraft([])).toThrow(/没有任何分录行/);
  });

  it('平衡的凭证正常创建', () => {
    const v = makeDraft(officeSupplyLines());
    expect(v.status).toBe('DRAFT');
    expect(v.totalDebit.toFixed(2)).toBe('1130.00');
    expect(v.totalCredit.toFixed(2)).toBe('1130.00');
    expect(v.voucherNo).toBeNull(); // ★ 草稿不分配凭证号
  });

  it('多借多贷复杂凭证也能平衡', () => {
    const v = makeDraft([
      line('1403', 'DEBIT', '5000.00'),
      line('22210102', 'DEBIT', '650.00'),
      line('660202', 'DEBIT', '300.00'),
      line('2202', 'CREDIT', '1650.00'),
      line('1002', 'CREDIT', '4300.00'),
    ]);
    expect(v.totalDebit.toFixed(2)).toBe('5950.00');
  });

  it('100 行 1 分钱的分录也能精确平衡（浮点会失败）', () => {
    const lines: LineDraft[] = [];
    for (let i = 0; i < 50; i += 1) {
      lines.push(line('1002', 'DEBIT', '0.01'));
      lines.push(line('1001', 'CREDIT', '0.01'));
    }
    const v = makeDraft(lines);
    expect(v.totalDebit.toFixed(2)).toBe('0.50');
    expect(v.totalCredit.toFixed(2)).toBe('0.50');
  });
});

// ============================================================================
describe('T21 · 金额为 0、负数或精度超限', () => {
  it('金额为 0 抛错', () => {
    expect(() =>
      makeDraft([line('1002', 'DEBIT', '0.00'), line('1001', 'CREDIT', '0.00')]),
    ).toThrow(/必须大于 0/);
  });

  it('负数金额抛错，并提示改用 direction', () => {
    expect(() =>
      makeDraft([line('1002', 'DEBIT', '-100.00'), line('1001', 'CREDIT', '-100.00')]),
    ).toThrow(/相反方向的 direction/);
  });

  it('超过 2 位小数抛错，绝不静默舍入', () => {
    expect(() =>
      makeDraft([line('1002', 'DEBIT', '100.001'), line('1001', 'CREDIT', '100.001')]),
    ).toThrow(/精度超过 2 位小数/);
  });

  it('非法借贷方向抛错', () => {
    expect(() =>
      makeDraft([
        line('1002', 'DEBIT', '100.00'),
        line('1001', 'SIDEWAYS' as unknown as 'CREDIT', '100.00'),
      ]),
    ).toThrow(InvalidAmountError);
  });
});

// ============================================================================
describe('T22 · 非末级科目不允许记账', () => {
  it('isLeaf=false 的科目抛 NonLeafAccountError', () => {
    expect(() =>
      makeDraft([
        line('2221', 'DEBIT', '1000.00', { accountIsLeaf: false, accountName: '应交税费' }),
        line('2202', 'CREDIT', '1000.00'),
      ]),
    ).toThrow(NonLeafAccountError);
  });

  it('错误信息里带上科目编码与名称', () => {
    try {
      makeDraft([
        line('2221', 'DEBIT', '1000.00', { accountIsLeaf: false, accountName: '应交税费' }),
        line('2202', 'CREDIT', '1000.00'),
      ]);
    } catch (e) {
      const err = e as NonLeafAccountError;
      expect(err.userMessage).toContain('2221');
      expect(err.userMessage).toContain('应交税费');
      expect(err.userMessage).toContain('末级');
    }
  });
});

// ============================================================================
describe('辅助核算完整性', () => {
  it('要求客户维度但未填 partnerId → 抛错', () => {
    expect(() =>
      makeDraft([
        line('1122', 'DEBIT', '1130.00', { accountAuxRequired: ['CUSTOMER'] }),
        line('6001', 'CREDIT', '1130.00'),
      ]),
    ).toThrow(MissingAuxDimensionError);
  });

  it('填了 partnerId 则通过', () => {
    const v = makeDraft([
      line('1122', 'DEBIT', '1130.00', { accountAuxRequired: ['CUSTOMER'], partnerId: 'p-1' }),
      line('6001', 'CREDIT', '1130.00'),
    ]);
    expect(v.status).toBe('DRAFT');
  });

  it('错误信息给出中文维度名', () => {
    try {
      makeDraft([
        line('1122', 'DEBIT', '1130.00', { accountAuxRequired: ['CUSTOMER'] }),
        line('6001', 'CREDIT', '1130.00'),
      ]);
    } catch (e) {
      expect((e as MissingAuxDimensionError).userMessage).toContain('客户');
    }
  });
});

// ============================================================================
describe('T23 · 已结账期间不允许写凭证（领域层）', () => {
  const closed: PeriodInfo = { ...PERIOD, status: 'CLOSED' };
  const closing: PeriodInfo = { ...PERIOD, status: 'CLOSING' };

  it('CLOSED 期间抛 PeriodLockedError', () => {
    const v = makeDraft(officeSupplyLines());
    expect(() => v.assertPeriodWritable(closed)).toThrow(PeriodLockedError);
  });

  it('CLOSING（结账施工中）期间同样拒绝写入', () => {
    const v = makeDraft(officeSupplyLines());
    expect(() => v.assertPeriodWritable(closing)).toThrow(PeriodLockedError);
  });

  it('错误信息告诉用户该怎么办（去反结账）', () => {
    const v = makeDraft(officeSupplyLines());
    try {
      v.assertPeriodWritable(closed);
    } catch (e) {
      expect((e as PeriodLockedError).userMessage).toContain('反结账');
      expect((e as PeriodLockedError).userMessage).toContain('2025-03');
    }
  });

  it('OPEN 期间正常放行', () => {
    const v = makeDraft(officeSupplyLines());
    expect(() => v.assertPeriodWritable(PERIOD)).not.toThrow();
  });

  it('凭证日期落在期间外 → 抛 PeriodDateMismatchError', () => {
    const v = makeDraft(officeSupplyLines(), { voucherDate: new Date('2025-04-15T00:00:00Z') });
    expect(() => v.assertPeriodWritable(PERIOD)).toThrow(PeriodDateMismatchError);
  });
});

// ============================================================================
describe('凭证状态机（白名单迁移）', () => {
  it('正常流转：草稿 → 待审核 → 已审核 → 已过账', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    expect(v.status).toBe('REVIEWING');
    v.approve('user-1');
    expect(v.status).toBe('APPROVED');
    v.post(1, 'user-1');
    expect(v.status).toBe('POSTED');
    expect(v.voucherNo).toBe(1);
    expect(v.voucherNo).toBe(1);
  });

  it('草稿不能直接过账（必须经审核）', () => {
    const v = makeDraft(officeSupplyLines());
    expect(() => v.post(1, 'user-1')).toThrow(InvalidVoucherTransitionError);
  });

  it('已过账不能再次过账', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.approve('u');
    v.post(1, 'u');
    expect(() => v.post(2, 'u')).toThrow(InvalidVoucherTransitionError);
  });

  it('★ 已过账的凭证不能再修改任何内容', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.approve('u');
    v.post(1, 'u');

    expect(() => v.setSummary('偷偷改摘要')).toThrow(PostedVoucherImmutableError);
    expect(() => v.setLines(officeSupplyLines())).toThrow(PostedVoucherImmutableError);
    expect(() => v.setVoucherDate(new Date())).toThrow(PostedVoucherImmutableError);
  });

  it('已过账凭证不能被作废（只能红冲）', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.approve('u');
    v.post(1, 'u');
    expect(() => v.void('不想要了')).toThrow(InvalidVoucherTransitionError);
  });

  it('未过账可以作废，但必须填理由', () => {
    const v = makeDraft(officeSupplyLines());
    expect(() => v.void('')).toThrow(/必须填写理由/);
    v.void('录错了');
    expect(v.status).toBe('VOID');
  });

  it('已审核可以反审核回草稿（理由必填）', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.approve('u');

    // ★ 反审核同样让制单人返工，所以和"审核退回"一样必须说清理由。
    //   留空的退回等于把人卡住却不说原因。
    expect(() => v.unapprove()).toThrow(/必须填写理由/);

    v.unapprove('金额录错，需按发票原件重录');
    expect(v.status).toBe('DRAFT');
    expect(v.reviewedBy).toBeUndefined();
    expect(v.reviewNote).toContain('金额录错');
  });

  it('★ 过账前退回审核：已审核 → 待审核（不是草稿）', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.approve('u');

    expect(() => v.rejectAfterReview('')).toThrow(/必须填写理由/);

    v.rejectAfterReview('该笔进项不应抵扣，属集体福利');
    // 退回「待审核」而不是「草稿」：问题出在审核环节，该让审核人重新看
    expect(v.status).toBe('REVIEWING');
    expect(v.reviewedBy).toBeUndefined();
    expect(v.reviewNote).toContain('不应抵扣');
  });

  it('★ 草稿不能"退回审核"（没有审核过的东西无法退回）', () => {
    const v = makeDraft(officeSupplyLines());
    expect(() => v.rejectAfterReview('理由')).toThrow(InvalidVoucherTransitionError);
  });

  it('★ 已过账凭证三条退回路径全部封死', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.approve('u');
    v.post(1, 'u');

    expect(() => v.reject('u', '理由')).toThrow(InvalidVoucherTransitionError);
    expect(() => v.rejectAfterReview('理由')).toThrow(InvalidVoucherTransitionError);
    expect(() => v.unapprove('理由')).toThrow(InvalidVoucherTransitionError);
    expect(v.status).toBe('POSTED');
  });

  it('★ 审核退回的理由会保留下来（制单人要知道改什么）', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.reject('reviewer', '第2行科目选错，应为管理费用—办公费');
    expect(v.status).toBe('DRAFT');
    expect(v.reviewNote).toBe('第2行科目选错，应为管理费用—办公费');
  });

  it('审核退回也可以回草稿', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.reject('u', '摘要不清楚');
    expect(v.status).toBe('DRAFT');
  });

  it('过账时凭证号必须 ≥ 1（年初凭证用 0 号除外）', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.approve('u');
    expect(() => v.post(0, 'u')).toThrow(/必须从 1 开始/);
  });

  it('年初余额凭证允许使用 0 号', () => {
    const v = makeDraft(officeSupplyLines(), { voucherWord: '年初', sourceType: 'OPENING' });
    v.submit();
    v.approve('u');
    v.post(0, 'u');
    expect(v.voucherNo).toBe(0);
    expect(v.label).toBe('年初-0');
  });

  it('凭证号必须是非负整数', () => {
    const v = makeDraft(officeSupplyLines());
    v.submit();
    v.approve('u');
    expect(() => v.post(1.5, 'u')).toThrow(/非负整数/);
  });
});

// ============================================================================
describe('T27 · 红冲', () => {
  function postedVoucher(): JournalVoucher {
    const v = makeDraft(officeSupplyLines(), { sourceType: 'INVOICE', sourceId: 'inv-1' });
    v.submit();
    v.approve('u');
    v.post(5, 'u');
    return v;
  }

  it('红冲生成的分录方向完全反向', () => {
    const v = postedVoucher();
    const reversal = v.buildReversal({
      reversalDate: new Date('2025-03-20T00:00:00Z'),
      operatorId: 'u',
      reason: '发票作废',
    });

    expect(reversal.lines).toHaveLength(3);
    const byAccount = new Map(reversal.lines.map((l) => [l.accountCode, l]));
    expect(byAccount.get('660202')?.direction).toBe('CREDIT');
    expect(byAccount.get('22210102')?.direction).toBe('CREDIT');
    expect(byAccount.get('2202')?.direction).toBe('DEBIT');
  });

  it('★ 红冲凭证本身也必须借贷平衡', () => {
    const v = postedVoucher();
    const reversal = v.buildReversal({
      reversalDate: new Date('2025-03-20T00:00:00Z'),
      operatorId: 'u',
      reason: '发票作废',
    });
    const reversalVoucher = JournalVoucher.create(reversal);
    expect(reversalVoucher.totalDebit.toFixed(2)).toBe('1130.00');
    expect(reversalVoucher.totalCredit.toFixed(2)).toBe('1130.00');
  });

  it('★ 原凭证 + 红冲凭证，各科目净额必须为 0', () => {
    const v = postedVoucher();
    const reversal = JournalVoucher.create(
      v.buildReversal({
        reversalDate: new Date('2025-03-20T00:00:00Z'),
        operatorId: 'u',
        reason: '发票作废',
      }),
    );

    const net = new Map<string, Decimal>();
    for (const l of [...v.lines, ...reversal.lines]) {
      const cur = net.get(l.accountCode) ?? new Decimal(0);
      const signed = l.direction === 'DEBIT' ? l.amount : l.amount.negated();
      net.set(l.accountCode, cur.plus(signed));
    }

    for (const [code, amount] of net) {
      expect(amount.isZero(), `科目 ${code} 借贷净额应为 0，实际 ${amount.toString()}`).toBe(true);
    }
  });

  it('红冲后原凭证状态变为 REVERSED 并留下反向引用', () => {
    const v = postedVoucher();
    v.markReversed('reversal-voucher-id');
    expect(v.status).toBe('REVERSED');
    expect(v.reversedById).toBe('reversal-voucher-id');
    // 被红冲后仍然属于「已过账」范畴（分录继续参与余额计算）
    expect(v.isPosted).toBe(true);
  });

  it('未过账的凭证不能红冲', () => {
    const v = makeDraft(officeSupplyLines());
    expect(() =>
      v.buildReversal({ reversalDate: new Date(), operatorId: 'u', reason: 'x' }),
    ).toThrow(/只有已过账的凭证才能红冲/);
  });

  it('红冲摘要里保留原凭证号与理由，可追溯', () => {
    const v = postedVoucher();
    const reversal = v.buildReversal({
      reversalDate: new Date('2025-03-20T00:00:00Z'),
      operatorId: 'u',
      reason: '发票作废',
    });
    expect(reversal.summary).toContain('记-5');
    expect(reversal.summary).toContain('发票作废');
  });
});

// ============================================================================
describe('rehydrate · 从数据库记录重建（跳过结构校验）', () => {
  it('可以重建已过账凭证并能构建红冲', () => {
    const v = JournalVoucher.rehydrate({
      entityId: ENTITY_ID,
      periodId: PERIOD_ID,
      periodYear: 2025,
      periodMonth: 3,
      voucherWord: '记',
      voucherNo: 7,
      voucherDate: new Date('2025-03-10T00:00:00Z'),
      summary: '历史凭证',
      sourceType: 'INVOICE',
      lines: officeSupplyLines(),
      status: 'POSTED',
      postedBy: 'u',
      postedAt: new Date('2025-03-10T01:00:00Z'),
    });
    expect(v.label).toBe('记-7');
    expect(v.isPosted).toBe(true);
    const reversal = v.buildReversal({ reversalDate: new Date(), operatorId: 'u', reason: '红冲' });
    expect(reversal.lines).toHaveLength(3);
  });
});

// ============================================================================
describe('汇总与聚合', () => {
  it('按科目聚合并正确区分借贷', () => {
    const v = makeDraft([
      line('660202', 'DEBIT', '1000.00'),
      line('660202', 'DEBIT', '500.00'),
      line('22210102', 'DEBIT', '195.00'),
      line('2202', 'CREDIT', '1695.00'),
    ]);
    const agg = v.aggregateByAccount();
    expect(agg.get('acc-660202')?.debit.toFixed(2)).toBe('1500.00');
    expect(agg.get('acc-660202')?.credit.toFixed(2)).toBe('0.00');
    expect(agg.get('acc-2202')?.credit.toFixed(2)).toBe('1695.00');
  });

  it('状态中文名', () => {
    const v = makeDraft(officeSupplyLines());
    expect(v.statusZh).toBe('草稿');
    v.submit();
    expect(v.statusZh).toBe('待审核');
    v.approve('u');
    expect(v.statusZh).toBe('已审核');
    v.post(1, 'u');
    expect(v.statusZh).toBe('已过账');
  });

  it('未编号凭证的 label 明确标注', () => {
    const v = makeDraft(officeSupplyLines());
    expect(v.label).toBe('记-（未编号）');
  });

  it('命中理由与规则信息被完整保留，可追溯「为什么这么记」', () => {
    const v = makeDraft(officeSupplyLines(), {
      sourceType: 'INVOICE',
      sourceId: 'inv-1',
      idempotencyKey: 'INV:inv-1:v1',
      ruleId: 'rule-office',
      ruleReason: '命中规则「采购办公用品」：卖方名称含"办公"',
      ruleVersion: 1,
      confidence: new Decimal('0.93'),
    });
    expect(v.ruleReason).toContain('采购办公用品');
    expect(v.idempotencyKey).toBe('INV:inv-1:v1');
    expect(v.confidence?.toFixed(2)).toBe('0.93');
  });
});
