/**
 * 报销自检规则单元测试
 * ============================================================
 * 为什么这些规则必须用单元测试逐条验证，而不是靠端到端"跑一遍看看":
 *
 *   自检的价值完全取决于**规则准不准**：
 *   漏报 → 真问题被放过；误报 → 人不再看自检结果，真问题也一起被忽略。
 *   所以每条规则都要有一个"必须命中"的用例，
 *   和一个"必须不命中"的反例（正常业务不能被报出来）。
 *
 *   后者同样重要 —— 反例写不出来，说明规则边界没想清楚。
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '@bookkeeper/shared';
import {
  auditExpenses,
  type ExpenseAuditInput,
  type ExpenseVoucherForAudit,
} from '../expense-audit';

// ---------------------------------------------------------------- 造数据

function voucher(over: Partial<ExpenseVoucherForAudit> = {}): ExpenseVoucherForAudit {
  return {
    id: 'v1',
    voucherWord: '记',
    voucherNo: 1,
    voucherDate: '2024-03-15',
    status: 'POSTED',
    summary: '办公费',
    totalAmount: new Decimal('100.00'),
    expenseAccounts: [{ code: '660201', name: '管理费用—办公费', amount: new Decimal('100.00') }],
    invoices: [],
    counterpartyNames: [],
    attachmentCount: 1,
    ...over,
  };
}

function baseInput(over: Partial<ExpenseAuditInput> = {}): ExpenseAuditInput {
  return {
    entityId: 'e1',
    periodLabel: '2024-03',
    periodStartsOn: '2024-03-01',
    periodEndsOn: '2024-03-31',
    vouchers: [],
    invoices: [],
    ...over,
  };
}

function ruleIds(input: ExpenseAuditInput): string[] {
  return auditExpenses(input).findings.map((f) => f.ruleId);
}

// ============================================================================
describe('DUP-001 同一张发票重复报销', () => {
  it('★ 同一张票被两张凭证引用 → 必须报为 VIOLATION', () => {
    const input = baseInput({
      invoices: [
        {
          id: 'i1',
          invoiceNumber: '1001',
          invoiceCode: '0440',
          invoiceDate: '2024-03-10',
          sellerName: '甲公司',
          amountInclTax: new Decimal('500.00'),
          voucherId: 'v1',
        },
        {
          id: 'i1',
          invoiceNumber: '1001',
          invoiceCode: '0440',
          invoiceDate: '2024-03-10',
          sellerName: '甲公司',
          amountInclTax: new Decimal('500.00'),
          voucherId: 'v2',
        },
      ],
    });
    const report = auditExpenses(input);
    const hit = report.findings.find((f) => f.ruleId === 'DUP-001');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('VIOLATION');
    expect(hit!.detail).toContain('2 张凭证');
    // 必须说清怎么核实
    expect(hit!.howToVerify).toContain('红冲');
  });

  it('★★ 反例：同一张票只被一张凭证引用（多行分录是正常的）→ 不得报', () => {
    const input = baseInput({
      invoices: [
        {
          id: 'i1',
          invoiceNumber: '1001',
          invoiceCode: '0440',
          invoiceDate: '2024-03-10',
          sellerName: '甲公司',
          amountInclTax: new Decimal('500.00'),
          voucherId: 'v1',
        },
        {
          id: 'i1',
          invoiceNumber: '1001',
          invoiceCode: '0440',
          invoiceDate: '2024-03-10',
          sellerName: '甲公司',
          amountInclTax: new Decimal('500.00'),
          voucherId: 'v1',
        },
      ],
    });
    expect(ruleIds(input)).not.toContain('DUP-001');
  });

  it('两张不同号码的票 → 不得报', () => {
    const input = baseInput({
      invoices: [
        { id: 'i1', invoiceNumber: '1001', invoiceCode: '0440', invoiceDate: '2024-03-10', sellerName: '甲', amountInclTax: new Decimal('500'), voucherId: 'v1' },
        { id: 'i2', invoiceNumber: '1002', invoiceCode: '0440', invoiceDate: '2024-03-10', sellerName: '甲', amountInclTax: new Decimal('500'), voucherId: 'v2' },
      ],
    });
    expect(ruleIds(input)).not.toContain('DUP-001');
  });
});

// ============================================================================
describe('DATE-001 凭证日期越界', () => {
  it('★ 凭证日期在期间外 → VIOLATION', () => {
    const input = baseInput({ vouchers: [voucher({ voucherDate: '2024-02-28' })] });
    const hit = auditExpenses(input).findings.find((f) => f.ruleId === 'DATE-001');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('VIOLATION');
    expect(hit!.detail).toContain('2024-02-28');
  });

  it('边界日期（期间首尾当天）→ 不得报', () => {
    expect(ruleIds(baseInput({ vouchers: [voucher({ voucherDate: '2024-03-01' })] })))
      .not.toContain('DATE-001');
    expect(ruleIds(baseInput({ vouchers: [voucher({ voucherDate: '2024-03-31' })] })))
      .not.toContain('DATE-001');
  });
});

// ============================================================================
describe('AMT-002 凭证金额与发票不符', () => {
  it('★ 金额差异超过 2 分 → VIOLATION', () => {
    const input = baseInput({
      vouchers: [
        voucher({
          totalAmount: new Decimal('100.00'),
          invoices: [
            {
              id: 'i1',
              invoiceNumber: '1001',
              invoiceCode: null,
              invoiceDate: '2024-03-10',
              sellerName: '甲',
              amountInclTax: new Decimal('80.00'),
              documentId: null,
            },
          ],
        }),
      ],
    });
    const hit = auditExpenses(input).findings.find((f) => f.ruleId === 'AMT-002');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('VIOLATION');
    expect(hit!.amount!.toFixed(2)).toBe('20.00');
  });

  it('★ 反例：差异在 2 分容差内（票面四舍五入）→ 不得报', () => {
    const input = baseInput({
      vouchers: [
        voucher({
          totalAmount: new Decimal('100.00'),
          invoices: [
            {
              id: 'i1',
              invoiceNumber: '1001',
              invoiceCode: null,
              invoiceDate: '2024-03-10',
              sellerName: '甲',
              amountInclTax: new Decimal('99.99'),
              documentId: null,
            },
          ],
        }),
      ],
    });
    expect(ruleIds(input)).not.toContain('AMT-002');
  });
});

// ============================================================================
describe('SEQ-001 连号发票', () => {
  it('★ 同供应商 3 张连号 → SUSPICIOUS（不是 VIOLATION）', () => {
    const input = baseInput({
      invoices: ['2001', '2002', '2003'].map((n, i) => ({
        id: `i${i}`,
        invoiceNumber: n,
        invoiceCode: null,
        invoiceDate: '2024-03-10',
        sellerName: '甲公司',
        amountInclTax: new Decimal('1000.00'),
        voucherId: null,
      })),
    });
    const hit = auditExpenses(input).findings.find((f) => f.ruleId === 'SEQ-001');
    expect(hit).toBeDefined();
    // ★ 连号本身不是问题，绝不能说成违规
    expect(hit!.severity).toBe('SUSPICIOUS');
    expect(hit!.detail).toContain('连号本身不代表有问题');
  });

  it('★★ 反例：只有 2 张连号 → 不得报（样本太小）', () => {
    const input = baseInput({
      invoices: ['2001', '2002'].map((n, i) => ({
        id: `i${i}`,
        invoiceNumber: n,
        invoiceCode: null,
        invoiceDate: '2024-03-10',
        sellerName: '甲',
        amountInclTax: new Decimal('1000'),
        voucherId: null,
      })),
    });
    expect(ruleIds(input)).not.toContain('SEQ-001');
  });

  it('★★ 反例：3 张票但号码不连续 → 不得报', () => {
    const input = baseInput({
      invoices: ['2001', '2005', '2009'].map((n, i) => ({
        id: `i${i}`,
        invoiceNumber: n,
        invoiceCode: null,
        invoiceDate: '2024-03-10',
        sellerName: '甲',
        amountInclTax: new Decimal('1000'),
        voucherId: null,
      })),
    });
    expect(ruleIds(input)).not.toContain('SEQ-001');
  });

  it('不同供应商各自的号码不互相比较', () => {
    const input = baseInput({
      invoices: [
        { id: 'i1', invoiceNumber: '2001', invoiceCode: null, invoiceDate: '2024-03-10', sellerName: '甲公司', amountInclTax: new Decimal('1000'), voucherId: null },
        { id: 'i2', invoiceNumber: '2002', invoiceCode: null, invoiceDate: '2024-03-10', sellerName: '甲公司', amountInclTax: new Decimal('1000'), voucherId: null },
        { id: 'i3', invoiceNumber: '2003', invoiceCode: null, invoiceDate: '2024-03-10', sellerName: '乙公司', amountInclTax: new Decimal('1000'), voucherId: null },
      ],
    });
    expect(ruleIds(input)).not.toContain('SEQ-001');
  });
});

// ============================================================================
describe('AMT-001 大额整数', () => {
  it('≥1 万且整千 → SUSPICIOUS', () => {
    const input = baseInput({ vouchers: [voucher({ totalAmount: new Decimal('50000.00') })] });
    const hit = auditExpenses(input).findings.find((f) => f.ruleId === 'AMT-001');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('SUSPICIOUS');
  });

  it('反例：有零头 → 不得报', () => {
    expect(ruleIds(baseInput({ vouchers: [voucher({ totalAmount: new Decimal('50000.55') })] })))
      .not.toContain('AMT-001');
  });

  it('反例：金额不大（< 1 万）→ 不得报', () => {
    expect(ruleIds(baseInput({ vouchers: [voucher({ totalAmount: new Decimal('5000.00') })] })))
      .not.toContain('AMT-001');
  });
});

// ============================================================================
describe('DATE-002 周末招待费', () => {
  it('周六的业务招待费 → NOTICE（仅提示）', () => {
    const input = baseInput({
      vouchers: [
        voucher({
          voucherDate: '2024-03-16', // 周六
          expenseAccounts: [{ code: '660205', name: '管理费用—业务招待费', amount: new Decimal('800') }],
        }),
      ],
    });
    const hit = auditExpenses(input).findings.find((f) => f.ruleId === 'DATE-002');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('NOTICE');
    expect(hit!.howToVerify).toContain('完全正常');
  });

  it('★★ 反例：周末但不是招待费 → 不得报（避免大量误报）', () => {
    const input = baseInput({
      vouchers: [
        voucher({
          voucherDate: '2024-03-16',
          expenseAccounts: [{ code: '660201', name: '管理费用—办公费', amount: new Decimal('800') }],
        }),
      ],
    });
    expect(ruleIds(input)).not.toContain('DATE-002');
  });

  it('反例：招待费但在工作日 → 不得报', () => {
    const input = baseInput({
      vouchers: [
        voucher({
          voucherDate: '2024-03-15', // 周五
          expenseAccounts: [{ code: '660205', name: '业务招待费', amount: new Decimal('800') }],
        }),
      ],
    });
    expect(ruleIds(input)).not.toContain('DATE-002');
  });
});

// ============================================================================
describe('CP-001 同供应商高频小额', () => {
  it('≥8 笔且平均 < 2000 → NOTICE', () => {
    const input = baseInput({
      invoices: Array.from({ length: 10 }, (_, i) => ({
        id: `i${i}`,
        invoiceNumber: `300${i}`,
        invoiceCode: null,
        invoiceDate: '2024-03-10',
        sellerName: '便利店',
        amountInclTax: new Decimal('100.00'),
        voucherId: null,
      })),
    });
    const hit = auditExpenses(input).findings.find((f) => f.ruleId === 'CP-001');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('NOTICE');
  });

  it('★★ 反例：笔数多但单笔金额大（正常大供应商）→ 不得报', () => {
    const input = baseInput({
      invoices: Array.from({ length: 10 }, (_, i) => ({
        id: `i${i}`,
        invoiceNumber: `300${i}`,
        invoiceCode: null,
        invoiceDate: '2024-03-10',
        sellerName: '大供应商',
        amountInclTax: new Decimal('50000.00'),
        voucherId: null,
      })),
    });
    expect(ruleIds(input)).not.toContain('CP-001');
  });
});

// ============================================================================
describe('CMP-002 费用凭证无附件', () => {
  it('★ 有费用科目但无附件无发票 → NOTICE，且提示税前扣除影响', () => {
    const input = baseInput({ vouchers: [voucher({ attachmentCount: 0, invoices: [] })] });
    const hit = auditExpenses(input).findings.find((f) => f.ruleId === 'CMP-002');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('NOTICE');
    // ★ 必须点明对企业所得税的影响，否则用户不知道这条为什么重要
    expect(hit!.howToVerify).toContain('纳税调增');
  });

  it('反例：有附件 → 不得报', () => {
    expect(ruleIds(baseInput({ vouchers: [voucher({ attachmentCount: 1 })] })))
      .not.toContain('CMP-002');
  });

  it('反例：没有费用科目的凭证（如纯资金划转）→ 不得报', () => {
    expect(ruleIds(baseInput({ vouchers: [voucher({ expenseAccounts: [], attachmentCount: 0 })] })))
      .not.toContain('CMP-002');
  });
});

// ============================================================================
describe('LIM-001 招待费超内部限额', () => {
  const entVoucher = () =>
    voucher({
      expenseAccounts: [{ code: '660205', name: '业务招待费', amount: new Decimal('3000.00') }],
    });

  it('★ 未配置限额 → 完全不做限额检查（避免无意义告警）', () => {
    expect(ruleIds(baseInput({ vouchers: [entVoucher()] }))).not.toContain('LIM-001');
  });

  it('★ 配置了限额且超出 → SUSPICIOUS，并提示税前扣除限额', () => {
    const input = baseInput({ vouchers: [entVoucher()], limits: { entertainmentPerMeal: '2000' } });
    const hit = auditExpenses(input).findings.find((f) => f.ruleId === 'LIM-001');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('SUSPICIOUS');
    expect(hit!.basis).toContain('2000.00');
    // ★ 内部审批通过 ≠ 税前可全额扣除，这一点必须提示
    expect(hit!.howToVerify).toContain('5‰');
  });

  it('未超出限额 → 不得报', () => {
    const input = baseInput({ vouchers: [entVoucher()], limits: { entertainmentPerMeal: '5000' } });
    expect(ruleIds(input)).not.toContain('LIM-001');
  });
});

// ============================================================================
describe('报告结构与边界声明', () => {
  it('★★ 任何时候都必须带"非税务意见"声明', () => {
    const report = auditExpenses(baseInput({ vouchers: [voucher()] }));
    expect(report.disclaimer).toContain('不是税务意见');
    expect(report.disclaimer).toContain('形态可疑');
  });

  it('★ 每条结论都必须给出"该怎么核实"', () => {
    const input = baseInput({
      vouchers: [
        voucher({ voucherDate: '2024-02-01', totalAmount: new Decimal('50000.00') }), // 越界 + 大额整数
        voucher({ attachmentCount: 0, invoices: [] }),
      ],
    });
    const report = auditExpenses(input);
    expect(report.findings.length).toBeGreaterThan(0);
    for (const f of report.findings) {
      expect(f.howToVerify.length, `${f.ruleId} 缺少核实指引`).toBeGreaterThan(10);
      expect(f.basis.length, `${f.ruleId} 缺少规则依据`).toBeGreaterThan(5);
    }
  });

  it('★ 每条结论都必须能定位到具体凭证或发票', () => {
    const input = baseInput({ vouchers: [voucher({ voucherDate: '2024-02-01' })] });
    for (const f of auditExpenses(input).findings) {
      expect(f.subjects.length, `${f.ruleId} 没有涉及对象`).toBeGreaterThan(0);
      for (const s of f.subjects) {
        expect(s.id.length).toBeGreaterThan(0);
      }
    }
  });

  it('★ 排序：硬矛盾在前，同级按金额从大到小', () => {
    const input = baseInput({
      vouchers: [
        voucher({ id: 'vA', voucherNo: 1, voucherDate: '2024-02-01', totalAmount: new Decimal('100.00') }),
        voucher({ id: 'vB', voucherNo: 2, voucherDate: '2024-02-01', totalAmount: new Decimal('9000.00') }),
      ],
    });
    const findings = auditExpenses(input).findings.filter((f) => f.ruleId === 'DATE-001');
    expect(findings).toHaveLength(2);
    expect(findings[0]!.amount!.toFixed(2)).toBe('9000.00');
  });

  it('汇总计数与实际发现一致', () => {
    const input = baseInput({ vouchers: [voucher({ voucherDate: '2024-02-01' })] });
    const report = auditExpenses(input);
    expect(report.summary.violationCount).toBe(
      report.findings.filter((f) => f.severity === 'VIOLATION').length,
    );
    expect(report.summary.noticeCount).toBe(
      report.findings.filter((f) => f.severity === 'NOTICE').length,
    );
  });

  it('干净的账 → 不产生任何 VIOLATION', () => {
    const input = baseInput({
      vouchers: [
        voucher({
          id: 'v1',
          voucherNo: 1,
          voucherDate: '2024-03-15',
          totalAmount: new Decimal('1234.56'),
          attachmentCount: 1,
          invoices: [
            {
              id: 'i1',
              invoiceNumber: '1001',
              invoiceCode: null,
              invoiceDate: '2024-03-15',
              sellerName: '甲',
              amountInclTax: new Decimal('1234.56'),
              documentId: 'd1',
            },
          ],
        }),
      ],
      invoices: [
        {
          id: 'i1',
          invoiceNumber: '1001',
          invoiceCode: null,
          invoiceDate: '2024-03-15',
          sellerName: '甲',
          amountInclTax: new Decimal('1234.56'),
          voucherId: 'v1',
        },
      ],
    });
    const report = auditExpenses(input);
    expect(report.summary.violationCount).toBe(0);
    expect(report.summary.suspiciousCount).toBe(0);
  });
});
