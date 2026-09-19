/**
 * 历史数据重建 —— 算法测试
 * ============================================================
 * 这组测试的核心目的：**守住「有据重建」与「倒轧推算」的边界**。
 *
 * 历史重建最危险的地方不是算不出来，而是算出来的数字看起来像真的。
 * 所以测试重点验证：
 *   · 有申报依据的科目必须与申报表一致
 *   · 倒轧出来的科目必须被标记为 DERIVED 且 needsReview
 *   · 无票成本必须被识别出来（汇算清缴纳税调增的风险点）
 *   · 发票口径与申报口径的合理差异不能被误判为错误
 *   · 数据矛盾（货币资金倒轧为负）必须显式报警而不是悄悄产出一个负数
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  reconcile,
  reconstructYear,
  buildOpeningProposal,
  type InvoiceAggregate,
  type FilingAggregate,
} from '../reconstruction';

// ---------------------------------------------------------------- 夹具
function invoiceAgg(
  direction: 'OUTPUT' | 'INPUT',
  year: number,
  opts: {
    count?: number;
    amountExclTax: string;
    taxAmount: string;
    certifiedTaxAmount?: string;
    byCategory?: Record<string, { amountExclTax: string; taxAmount: string; count: number }>;
  },
): InvoiceAggregate {
  const amountExclTax = new Decimal(opts.amountExclTax);
  const taxAmount = new Decimal(opts.taxAmount);
  return {
    direction,
    year,
    count: opts.count ?? 10,
    amountExclTax,
    taxAmount,
    amountInclTax: amountExclTax.plus(taxAmount),
    certifiedTaxAmount: new Decimal(opts.certifiedTaxAmount ?? opts.taxAmount),
    byCategory: new Map(
      Object.entries(opts.byCategory ?? {}).map(([k, v]) => [
        k,
        {
          amountExclTax: new Decimal(v.amountExclTax),
          taxAmount: new Decimal(v.taxAmount),
          count: v.count,
        },
      ]),
    ),
  };
}

function filingAgg(
  year: number,
  opts: {
    salesExclTax?: string;
    outputTax?: string;
    inputTax?: string;
    inputTaxTransferOut?: string;
    taxPayable?: string;
    taxPaid?: string;
    taxUnpaidYearEnd?: string;
    surtax?: string;
    cit?: {
      revenue?: string;
      cost?: string;
      profitBeforeTax?: string;
      taxPayable?: string;
      taxPaid?: string;
      adjustUp?: string;
    };
  },
): FilingAggregate {
  const d = (v?: string) => (v === undefined ? null : new Decimal(v));
  return {
    year,
    vat: {
      salesExclTax: d(opts.salesExclTax),
      outputTax: d(opts.outputTax),
      inputTax: d(opts.inputTax),
      inputTaxTransferOut: d(opts.inputTaxTransferOut),
      taxPayable: d(opts.taxPayable),
      taxPaid: d(opts.taxPaid),
      taxUnpaidYearEnd: d(opts.taxUnpaidYearEnd),
      surtax: d(opts.surtax),
      monthCount: 12,
    },
    cit: opts.cit
      ? {
          revenue: d(opts.cit.revenue),
          cost: d(opts.cit.cost),
          profitBeforeTax: d(opts.cit.profitBeforeTax),
          taxPayable: d(opts.cit.taxPayable),
          taxPaid: d(opts.cit.taxPaid),
          adjustUp: d(opts.cit.adjustUp),
        }
      : null,
  };
}

// ============================================================================
describe('核对：发票聚合 vs 申报表', () => {
  it('发票与申报完全一致 → PASS', () => {
    const f = reconcile(
      invoiceAgg('OUTPUT', 2024, { amountExclTax: '1000000.00', taxAmount: '130000.00' }),
      filingAgg(2024, { salesExclTax: '1000000.00', outputTax: '130000.00' }),
    );
    const sales = f.find((x) => x.item === '销售额（不含税）');
    expect(sales?.level).toBe('PASS');
    expect(sales?.difference?.toFixed(2)).toBe('0.00');
  });

  it('★ 申报额大于开票额（存在未开票收入）→ WARN 且解释正确', () => {
    const f = reconcile(
      invoiceAgg('OUTPUT', 2024, { amountExclTax: '1000000.00', taxAmount: '130000.00' }),
      filingAgg(2024, { salesExclTax: '1050000.00', outputTax: '136500.00' }),
    );
    const sales = f.find((x) => x.item === '销售额（不含税）')!;
    expect(sales.level).toBe('WARN');
    expect(sales.explanation).toContain('相差 -50000.00');
    expect(sales.explanation).toContain('发票少于申报');
    expect(sales.suggestion).toContain('未开票收入');
  });

  it('★ 差异过大（>15%）→ FAIL 并提示数据可能不完整', () => {
    const f = reconcile(
      invoiceAgg('OUTPUT', 2024, { amountExclTax: '500000.00', taxAmount: '65000.00' }),
      filingAgg(2024, { salesExclTax: '1000000.00', outputTax: '130000.00' }),
    );
    const sales = f.find((x) => x.item === '销售额（不含税）')!;
    expect(sales.level).toBe('FAIL');
    expect(sales.suggestion).toContain('不完整');
  });

  it('小额差异在容差内（≥100 元或 1%）→ PASS', () => {
    const f = reconcile(
      invoiceAgg('OUTPUT', 2024, { amountExclTax: '1000000.00', taxAmount: '130000.00' }),
      filingAgg(2024, { salesExclTax: '1000050.00', outputTax: '130000.00' }),
    );
    expect(f.find((x) => x.item === '销售额（不含税）')?.level).toBe('PASS');
  });

  it('缺少申报记录 → WARN 并提示会漏掉未开票收入', () => {
    const f = reconcile(
      invoiceAgg('OUTPUT', 2024, { amountExclTax: '1000000.00', taxAmount: '130000.00' }),
      filingAgg(2024, {}),
    );
    const sales = f.find((x) => x.item === '销售额（不含税）')!;
    expect(sales.level).toBe('WARN');
    expect(sales.suggestion).toContain('未开票收入');
  });

  it('★ 已勾稽进项 > 申报抵扣 → WARN 并提示挂待抵扣', () => {
    const f = reconcile(
      invoiceAgg('INPUT', 2024, {
        amountExclTax: '800000.00',
        taxAmount: '104000.00',
        certifiedTaxAmount: '104000.00',
      }),
      filingAgg(2024, { inputTax: '90000.00' }),
    );
    const inp = f.find((x) => x.item === '进项税额')!;
    expect(inp.level).toBe('WARN');
    expect(inp.explanation).toContain('留抵');
    expect(inp.suggestion).toContain('待抵扣');
  });

  it('申报抵扣 > 已勾稽 → WARN 并提示可能有其他扣税凭证', () => {
    const f = reconcile(
      invoiceAgg('INPUT', 2024, {
        amountExclTax: '800000.00',
        taxAmount: '80000.00',
        certifiedTaxAmount: '80000.00',
      }),
      filingAgg(2024, { inputTax: '104000.00' }),
    );
    const inp = f.find((x) => x.item === '进项税额')!;
    expect(inp.level).toBe('WARN');
    expect(inp.suggestion).toContain('海关缴款书');
  });

  it('存在进项税额转出 → WARN 并提示成本需调增', () => {
    const f = reconcile(null, filingAgg(2024, { inputTaxTransferOut: '5200.00' }));
    const t = f.find((x) => x.item === '进项税额转出');
    expect(t?.level).toBe('WARN');
    expect(t?.suggestion).toContain('成本');
  });

  it('年末有未缴增值税 → PASS 且说明会计入期初', () => {
    const f = reconcile(null, filingAgg(2024, { taxUnpaidYearEnd: '12000.00' }));
    const t = f.find((x) => x.item === '年末未缴增值税');
    expect(t?.level).toBe('PASS');
    expect(t?.explanation).toContain('应交税费');
  });

  it('所得税营业收入与增值税销售额口径差异 → WARN 且说明属正常', () => {
    const f = reconcile(
      invoiceAgg('OUTPUT', 2024, { amountExclTax: '1000000.00', taxAmount: '130000.00' }),
      filingAgg(2024, {
        salesExclTax: '1000000.00',
        outputTax: '130000.00',
        cit: { revenue: '1030000.00' },
      }),
    );
    const t = f.find((x) => x.item === '所得税营业收入 vs 增值税销售额')!;
    expect(t.level).toBe('WARN');
    expect(t.suggestion).toContain('视同销售');
  });
});

// ============================================================================
describe('年度重建：收入确认优先级', () => {
  const salesInv = invoiceAgg('OUTPUT', 2024, { amountExclTax: '1000000.00', taxAmount: '130000.00' });

  it('★ 优先取所得税年报营业收入', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: salesInv,
      purchaseInvoices: null,
      filing: filingAgg(2024, {
        salesExclTax: '1000000.00',
        cit: { revenue: '1030000.00', profitBeforeTax: '200000.00' },
      }),
    });
    expect(r.revenue.toFixed(2)).toBe('1030000.00');
    expect(r.revenueSource).toBe('DECLARED');
  });

  it('无年报时取增值税申报销售额', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: salesInv,
      purchaseInvoices: null,
      filing: filingAgg(2024, { salesExclTax: '1050000.00' }),
    });
    expect(r.revenue.toFixed(2)).toBe('1050000.00');
    expect(r.revenueSource).toBe('DECLARED');
  });

  it('★ 两者都没有时退回发票聚合，并警告可能漏未开票收入', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: salesInv,
      purchaseInvoices: null,
      filing: filingAgg(2024, {}),
    });
    expect(r.revenue.toFixed(2)).toBe('1000000.00');
    expect(r.revenueSource).toBe('INVOICE');
    expect(r.warnings.some((w) => w.includes('未开票收入'))).toBe(true);
  });

  it('完全没有收入数据 → 收入为 0 且警告', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: null,
      purchaseInvoices: null,
      filing: null,
    });
    expect(r.revenue.toFixed(2)).toBe('0.00');
    expect(r.warnings.some((w) => w.includes('没有任何收入数据'))).toBe(true);
  });
});

// ============================================================================
describe('★ 年度重建：无票成本识别（汇算清缴风险点）', () => {
  it('倒轧出无票成本并明确提示纳税调增风险', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: invoiceAgg('OUTPUT', 2024, { amountExclTax: '1000000.00', taxAmount: '130000.00' }),
      purchaseInvoices: invoiceAgg('INPUT', 2024, { amountExclTax: '600000.00', taxAmount: '78000.00' }),
      filing: filingAgg(2024, {
        salesExclTax: '1000000.00',
        cit: { revenue: '1000000.00', profitBeforeTax: '200000.00', taxPayable: '10000.00' },
      }),
    });

    // 倒轧成本 = 1000000 − 200000 = 800000
    expect(r.derivedCostTotal?.toFixed(2)).toBe('800000.00');
    // 有票成本 600000 → 无票成本 200000
    expect(r.costWithoutInvoice?.toFixed(2)).toBe('200000.00');
    expect(r.warnings.some((w) => w.includes('无票成本') && w.includes('纳税调增'))).toBe(true);
  });

  it('有票成本大于倒轧成本 → 警告可能含存货/固定资产', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: invoiceAgg('OUTPUT', 2024, { amountExclTax: '1000000.00', taxAmount: '130000.00' }),
      purchaseInvoices: invoiceAgg('INPUT', 2024, { amountExclTax: '900000.00', taxAmount: '117000.00' }),
      filing: filingAgg(2024, {
        cit: { revenue: '1000000.00', profitBeforeTax: '200000.00', taxPayable: '10000.00' },
      }),
    });
    expect(r.costWithoutInvoice?.toFixed(2)).toBe('-100000.00');
    expect(r.warnings.some((w) => w.includes('存货') && w.includes('固定资产'))).toBe(true);
  });

  it('利润总额大于收入（有营业外收入）→ 警告并说明', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: null,
      purchaseInvoices: null,
      filing: filingAgg(2024, {
        cit: { revenue: '100000.00', profitBeforeTax: '150000.00', taxPayable: '7500.00' },
      }),
    });
    expect(r.derivedCostTotal?.toFixed(2)).toBe('-50000.00');
    expect(r.warnings.some((w) => w.includes('营业外收入'))).toBe(true);
  });

  it('没有进项发票 → 警告无票成本风险', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: invoiceAgg('OUTPUT', 2024, { amountExclTax: '500000.00', taxAmount: '65000.00' }),
      purchaseInvoices: null,
      filing: filingAgg(2024, { cit: { revenue: '500000.00', profitBeforeTax: '100000.00' } }),
    });
    expect(r.warnings.some((w) => w.includes('没有进项发票'))).toBe(true);
  });
});

// ============================================================================
describe('年度重建：所得税与净利润', () => {
  it('有年报税额 → 直接取用', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: null,
      purchaseInvoices: null,
      filing: filingAgg(2024, {
        cit: { revenue: '1000000.00', profitBeforeTax: '200000.00', taxPayable: '10000.00' },
      }),
    });
    expect(r.incomeTaxExpense?.toFixed(2)).toBe('10000.00');
    expect(r.netProfit?.toFixed(2)).toBe('190000.00');
  });

  it('★ 无年报税额 → 按小微 5% 倒轧并警告', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: null,
      purchaseInvoices: null,
      filing: filingAgg(2024, { cit: { revenue: '1000000.00', profitBeforeTax: '200000.00' } }),
    });
    expect(r.incomeTaxExpense?.toFixed(2)).toBe('10000.00');
    expect(r.warnings.some((w) => w.includes('5.0%') && w.includes('倒轧'))).toBe(true);
  });

  it('亏损年度所得税为 0，净利润为负', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: null,
      purchaseInvoices: null,
      filing: filingAgg(2024, {
        cit: { revenue: '500000.00', profitBeforeTax: '-80000.00', taxPayable: '0.00' },
      }),
    });
    expect(r.incomeTaxExpense?.toFixed(2)).toBe('0.00');
    expect(r.netProfit?.toFixed(2)).toBe('-80000.00');
  });

  it('缺利润总额 → 列入待人工补录', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: invoiceAgg('OUTPUT', 2024, { amountExclTax: '500000.00', taxAmount: '65000.00' }),
      purchaseInvoices: null,
      filing: filingAgg(2024, { salesExclTax: '500000.00' }),
    });
    expect(r.requiredInputs.some((x) => x.field === 'costTotal')).toBe(true);
  });
});

// ============================================================================
describe('年度重建：待人工补录清单', () => {
  it('★ 永远要求补录货币资金（发票与申报都推不出）', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: null,
      purchaseInvoices: null,
      filing: filingAgg(2024, { cit: { revenue: '100.00', profitBeforeTax: '10.00' } }),
    });
    const cash = r.requiredInputs.find((x) => x.field === 'cashBalance');
    expect(cash).toBeDefined();
    expect(cash?.reason).toContain('资金流水');
  });

  it('★ 永远要求补录实收资本', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: null,
      purchaseInvoices: null,
      filing: null,
    });
    expect(r.requiredInputs.some((x) => x.field === 'paidInCapital')).toBe(true);
  });

  it('缺所得税年报时提示补充', () => {
    const r = reconstructYear({
      year: 2024,
      salesInvoices: null,
      purchaseInvoices: null,
      filing: filingAgg(2024, { salesExclTax: '100.00' }),
    });
    expect(r.requiredInputs.some((x) => x.field === 'citAnnual')).toBe(true);
  });
});

// ============================================================================
describe('★ 期初建账方案生成', () => {
  function buildYears() {
    return [
      reconstructYear({
        year: 2023,
        salesInvoices: invoiceAgg('OUTPUT', 2023, {
          amountExclTax: '800000.00',
          taxAmount: '104000.00',
          count: 60,
        }),
        purchaseInvoices: invoiceAgg('INPUT', 2023, {
          amountExclTax: '500000.00',
          taxAmount: '65000.00',
          count: 40,
        }),
        filing: filingAgg(2023, {
          salesExclTax: '800000.00',
          outputTax: '104000.00',
          inputTax: '65000.00',
          taxUnpaidYearEnd: '39000.00',
          cit: { revenue: '800000.00', profitBeforeTax: '150000.00', taxPayable: '7500.00' },
        }),
      }),
      reconstructYear({
        year: 2024,
        salesInvoices: invoiceAgg('OUTPUT', 2024, {
          amountExclTax: '1000000.00',
          taxAmount: '130000.00',
          count: 75,
        }),
        purchaseInvoices: invoiceAgg('INPUT', 2024, {
          amountExclTax: '600000.00',
          taxAmount: '78000.00',
          count: 50,
        }),
        filing: filingAgg(2024, {
          salesExclTax: '1000000.00',
          outputTax: '130000.00',
          inputTax: '78000.00',
          taxUnpaidYearEnd: '52000.00',
          cit: { revenue: '1000000.00', profitBeforeTax: '200000.00', taxPayable: '10000.00', taxPaid: '10000.00' },
        }),
      }),
    ];
  }

  it('★ 每行都必须标明数据来源，倒轧项必须标记需复核', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });
    for (const line of p.lines) {
      expect(['DECLARED', 'INVOICE', 'DERIVED', 'MANUAL']).toContain(line.source);
      expect(line.sourceNote.length).toBeGreaterThan(0);
    }
    const derived = p.lines.filter((l) => l.source === 'DERIVED');
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((l) => l.needsReview)).toBe(true);
  });

  it('★ 未交增值税取申报表期末未缴（DECLARED，无需复核）', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });
    const vat = p.lines.find((l) => l.accountCode === '222102')!;
    expect(vat.amount.toFixed(2)).toBe('52000.00');
    expect(vat.source).toBe('DECLARED');
    expect(vat.needsReview).toBe(false);
    expect(vat.sourceNote).toContain('2024');
  });

  it('★ 应收账款按价税合计累计，且明确标注这是上限值', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });
    const ar = p.lines.find((l) => l.accountCode === '1122')!;
    // 2023: 800000+104000=904000；2024: 1000000+130000=1130000；合计 2034000
    expect(ar.amount.toFixed(2)).toBe('2034000.00');
    expect(ar.source).toBe('INVOICE');
    expect(ar.needsReview).toBe(true);
    expect(ar.sourceNote).toContain('上限');
    expect(ar.breakdown?.['2023 年']).toContain('60 张');
  });

  it('★ 未提供现金余额 → 方案中不出现货币资金行，并明确告知会漏资产', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });

    expect(p.cashBasis).toBe('DERIVED');

    // 该场景下资产侧（应收账款）远大于负债侧，未分配利润吸收了全部差额，
    // 因此不存在"需要倒挤货币资金"的情形 —— 货币资金是「不详」而不是「被凑出来」。
    // 这两种情况必须区分，否则会误导用户以为银行余额已经被推算好了。
    const bank = p.lines.find((l) => l.accountCode === '1002');
    expect(bank).toBeUndefined();

    expect(
      p.warnings.some((w) => w.includes('没有货币资金这一行') && w.includes('漏掉这笔资产')),
    ).toBe(true);
    expect(p.requiredInputs.some((r) => r.field === 'cashBalance')).toBe(true);
  });

  it('★ 提供实际银行余额 → 货币资金为 MANUAL 且可信', () => {
    const p = buildOpeningProposal({
      targetYear: 2025,
      targetMonth: 1,
      years: buildYears(),
      manual: { cashBalanceByYear: { 2024: '300000.00' } },
    });
    expect(p.cashBasis).toBe('DECLARED');
    const bank = p.lines.find((l) => l.accountCode === '1002')!;
    expect(bank.amount.toFixed(2)).toBe('300000.00');
    expect(bank.source).toBe('MANUAL');
    expect(bank.needsReview).toBe(false);
    expect(p.warnings.some((w) => w.includes('可信度高'))).toBe(true);
  });

  it('★ 方案必须借贷平衡（这是能生成期初凭证的前提）', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });
    expect(p.balanced).toBe(true);
    expect(p.difference.toFixed(2)).toBe('0.00');
    expect(p.totalDebit.eq(p.totalCredit)).toBe(true);
  });

  it('提供完整人工输入后方案仍然平衡', () => {
    const p = buildOpeningProposal({
      targetYear: 2025,
      targetMonth: 1,
      years: buildYears(),
      manual: {
        cashBalanceByYear: { 2024: '300000.00' },
        paidInCapital: '100000.00',
        inventory: '50000.00',
        fixedAsset: '80000.00',
        accumulatedDepreciation: '16000.00',
        otherPayable: '20000.00',
      },
    });
    expect(p.balanced).toBe(true);
  });

  it('★ 未分配利润同时展示「真实累计净利润」与「倒轧差额」', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });
    const re = p.lines.find((l) => l.accountCode === '310401')!;
    expect(re.source).toBe('DERIVED');
    expect(re.needsReview).toBe(true);
    // 真实累计净利润 = 2023 (150000-7500) + 2024 (200000-10000) = 332500
    expect(re.sourceNote).toContain('332500.00');
    expect(re.sourceNote).toContain('缺口');
    expect(re.breakdown?.['2023 年净利润']).toBe('142500.00');
    expect(re.breakdown?.['2024 年净利润']).toBe('190000.00');
  });

  it('★ 缺实收资本与存货 → 列入待补录清单', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });
    const fields = p.requiredInputs.map((x) => x.field);
    expect(fields).toContain('cashBalance');
    expect(fields).toContain('paidInCapital');
    expect(fields).toContain('1403');
    expect(fields).toContain('1601');
    expect(fields).toContain('receivableAdjust');
  });

  it('★ 待抵扣进项税额：已勾稽 > 申报抵扣时才产生', () => {
    const years = [
      reconstructYear({
        year: 2024,
        salesInvoices: invoiceAgg('OUTPUT', 2024, { amountExclTax: '500000.00', taxAmount: '65000.00' }),
        purchaseInvoices: invoiceAgg('INPUT', 2024, {
          amountExclTax: '400000.00',
          taxAmount: '52000.00',
          certifiedTaxAmount: '52000.00',
        }),
        filing: filingAgg(2024, {
          salesExclTax: '500000.00',
          inputTax: '40000.00',
          cit: { revenue: '500000.00', profitBeforeTax: '100000.00', taxPayable: '5000.00' },
        }),
      }),
    ];
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years });
    const pending = p.lines.find((l) => l.accountCode === '22210103');
    expect(pending).toBeDefined();
    expect(pending!.amount.toFixed(2)).toBe('12000.00');
    expect(pending!.source).toBe('DERIVED');
  });

  it('★ 数据矛盾导致货币资金倒轧为贷方余额 → 必须显式报警，绝不悄悄产出', () => {
    // 构造：只有巨额实收资本与未缴增值税，资产侧几乎没有
    // → 负债(1,500,000) 远超资产(0)，方案必然出问题
    const years = [
      reconstructYear({
        year: 2024,
        salesInvoices: null,
        purchaseInvoices: null,
        filing: filingAgg(2024, {
          taxUnpaidYearEnd: '500000.00',
          cit: { revenue: '0.00', profitBeforeTax: '0.00', taxPayable: '0.00' },
        }),
      }),
    ];
    const p = buildOpeningProposal({
      targetYear: 2025,
      targetMonth: 1,
      years,
      manual: { paidInCapital: '1000000.00' },
    });

    // ★ 必须报警：缺口被未分配利润吸收，账能平但资产负债表是错的
    expect(p.warnings.some((w) => w.includes('数据缺口') && w.includes('资产侧漏记'))).toBe(true);

    // ★ 还要指出矛盾本身：倒轧出亏损，但历年净利润是盈利
    expect(
      p.warnings.some((w) => w.includes('累计亏损') && w.includes('矛盾')),
    ).toBe(true);

    // 缺口被记为未分配利润借方（累计亏损），并标记为推算 + 需复核
    const re = p.lines.find((l) => l.accountCode === '310401')!;
    expect(re.direction).toBe('DEBIT');
    expect(re.source).toBe('DERIVED');
    expect(re.needsReview).toBe(true);

    // 方案仍然保持借贷平衡 —— 让问题显式暴露在科目上，而不是破坏平衡
    expect(p.balanced).toBe(true);
  });

  it('零余额科目不入方案', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });
    expect(p.lines.every((l) => l.amount.gt(0))).toBe(true);
  });

  it('汇总说明包含年度与需复核行数', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });
    expect(p.summary).toContain('2023、2024');
    expect(p.summary).toContain('需人工确认');
  });

  it('方案行按科目编码排序（便于人工逐行核对）', () => {
    const p = buildOpeningProposal({ targetYear: 2025, targetMonth: 1, years: buildYears() });
    const codes = p.lines.map((l) => l.accountCode);
    expect([...codes].sort()).toEqual(codes);
  });
});

// ============================================================================
describe('端到端场景：三年历史，数据逐步补齐', () => {
  const years = [2022, 2023, 2024].map((y, i) =>
    reconstructYear({
      year: y,
      salesInvoices: invoiceAgg('OUTPUT', y, {
        amountExclTax: `${(600 + i * 200) * 1000}.00`,
        taxAmount: `${(600 + i * 200) * 130}.00`,
        count: 40 + i * 15,
      }),
      purchaseInvoices: invoiceAgg('INPUT', y, {
        amountExclTax: `${(380 + i * 110) * 1000}.00`,
        taxAmount: `${(380 + i * 110) * 130}.00`,
        count: 25 + i * 10,
      }),
      filing: filingAgg(y, {
        salesExclTax: `${(600 + i * 200) * 1000}.00`,
        outputTax: `${(600 + i * 200) * 130}.00`,
        inputTax: `${(380 + i * 110) * 130}.00`,
        taxUnpaidYearEnd: '30000.00',
        cit: {
          revenue: `${(600 + i * 200) * 1000}.00`,
          profitBeforeTax: '120000.00',
          taxPayable: '6000.00',
          taxPaid: '6000.00',
        },
      }),
    }),
  );

  it('三年度重建 → 方案平衡，且区分出可信与推算两类科目', () => {
    const p = buildOpeningProposal({
      targetYear: 2025,
      targetMonth: 1,
      years,
      manual: { cashBalanceByYear: { 2024: '450000.00' }, paidInCapital: '200000.00' },
    });

    expect(p.balanced).toBe(true);

    const trusted = p.lines.filter((l) => l.source === 'DECLARED' || l.source === 'MANUAL');
    const derived = p.lines.filter((l) => l.source === 'DERIVED' || l.source === 'INVOICE');
    expect(trusted.length).toBeGreaterThan(0);
    expect(derived.length).toBeGreaterThan(0);

    // 可信科目：未交增值税、货币资金、实收资本
    expect(trusted.map((l) => l.accountCode)).toEqual(
      expect.arrayContaining(['222102', '1002', '3001']),
    );
  });

  it('★ 存在数据缺口时必须有明确警告（避免账平但资产负债表错）', () => {
    const p = buildOpeningProposal({
      targetYear: 2025,
      targetMonth: 1,
      years,
      manual: { cashBalanceByYear: { 2024: '450000.00' }, paidInCapital: '200000.00' },
    });
    expect(p.warnings.some((w) => w.includes('数据缺口'))).toBe(true);
  });

  it('核对无 FAIL 时视为可继续', () => {
    expect(years.every((y) => y.reconciled)).toBe(true);
  });
});
