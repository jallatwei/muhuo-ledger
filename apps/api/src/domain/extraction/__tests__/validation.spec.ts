/**
 * 会计交叉校验规则测试
 * ============================================================
 * 这组测试验证的是「识别错误能不能被拦下来」——
 * 它比模型本身更重要。模型会看错，但会计恒等式不会骗人。
 */
import { describe, it, expect } from 'vitest';
import {
  validateExtraction,
  decideRouting,
  normalizeName,
  type EntityContext,
  type ExtractionForValidation,
} from '../validation';

const ENTITY: EntityContext = {
  name: '演示科技有限公司',
  unifiedSocialCreditCode: '91310000MA1DEMO001',
  knownSellerTaxNos: new Set(['91310000MA1OFFICE01']),
};

/** 一张完全正常的进项专票 */
function goodInvoice(overrides: Partial<ExtractionForValidation> = {}): ExtractionForValidation {
  return {
    direction: 'INPUT',
    category: 'SPECIAL_VAT',
    invoiceCode: '3100201130',
    invoiceNumber: '12345678',
    invoiceDate: '2025-03-05',
    sellerName: '某某办公用品有限公司',
    sellerTaxNo: '91310000MA1OFFICE01',
    buyerName: '演示科技有限公司',
    buyerTaxNo: '91310000MA1DEMO001',
    amountExclTax: '1000.00',
    taxRate: '0.13',
    taxAmount: '130.00',
    amountInclTax: '1130.00',
    isRedFlushed: false,
    ...overrides,
  };
}

function findByCode(findings: ReturnType<typeof validateExtraction>['findings'], code: string) {
  return findings.filter((f) => f.code === code);
}

describe('名称归一化', () => {
  it('去掉括号内容、空格与常见后缀', () => {
    expect(normalizeName('演示科技有限公司')).toBe('演示科技');
    expect(normalizeName('演示科技（上海）有限公司')).toBe('演示科技');
    expect(normalizeName('演示科技 有限公司')).toBe('演示科技');
    expect(normalizeName('')).toBe('');
    expect(normalizeName(null)).toBe('');
  });
});

describe('V1 · 金额勾稽（拦 OCR 数字错误的关键）', () => {
  it('1000 + 130 = 1130 通过', () => {
    const r = validateExtraction(goodInvoice(), ENTITY);
    const v1 = findByCode(r.findings, 'V1')[0];
    expect(v1?.level).toBe('PASS');
    expect(r.hasFailure).toBe(false);
  });

  it('★ 1000 + 60 ≠ 1090 必须 FAIL，并指出差了多少', () => {
    const r = validateExtraction(
      goodInvoice({ amountExclTax: '1000.00', taxRate: '0.06', taxAmount: '60.00', amountInclTax: '1090.00' }),
      ENTITY,
    );
    const v1 = findByCode(r.findings, 'V1')[0];
    expect(v1?.level).toBe('FAIL');
    expect(v1?.message).toContain('30.00'); // 差额
    expect(r.hasFailure).toBe(true);
    expect(v1?.suggestion).toContain('逐位核对');
  });

  it('2 分以内的票面舍入差异容忍', () => {
    const r = validateExtraction(goodInvoice({ amountInclTax: '1130.02' }), ENTITY);
    expect(findByCode(r.findings, 'V1')[0]?.level).toBe('PASS');
  });

  it('金额字段缺失时给 WARN 而不是误判', () => {
    const r = validateExtraction(goodInvoice({ taxAmount: null }), ENTITY);
    expect(findByCode(r.findings, 'V1')[0]?.level).toBe('WARN');
  });
});

describe('V2 · 税额与税率匹配', () => {
  it('1000 × 0.13 = 130 不报警', () => {
    const r = validateExtraction(goodInvoice(), ENTITY);
    expect(findByCode(r.findings, 'V2')).toHaveLength(0);
  });

  it('金额 1000 税率 0.13 但税额 60 → WARN', () => {
    const r = validateExtraction(goodInvoice({ taxAmount: '60.00', amountInclTax: '1060.00' }), ENTITY);
    const v2 = findByCode(r.findings, 'V2')[0];
    expect(v2?.level).toBe('WARN');
    expect(v2?.message).toContain('130.00');
  });
});

describe('V3 · 税率合法性', () => {
  it('13% / 9% / 6% / 3% / 1% / 0 都合法', () => {
    for (const rate of ['0.13', '0.09', '0.06', '0.03', '0.01', '0']) {
      const r = validateExtraction(goodInvoice({ taxRate: rate }), ENTITY);
      expect(findByCode(r.findings, 'V3'), `税率 ${rate} 应合法`).toHaveLength(0);
    }
  });

  it('★ 0.11 这种非法税率必须 FAIL', () => {
    const r = validateExtraction(goodInvoice({ taxRate: '0.11' }), ENTITY);
    const v3 = findByCode(r.findings, 'V3')[0];
    expect(v3?.level).toBe('FAIL');
    expect(v3?.suggestion).toContain('13%');
  });
});

describe('V4 · 购销方方向（★ 最严重的一类错误）', () => {
  it('进项票购买方为本主体 → 不报警', () => {
    const r = validateExtraction(goodInvoice(), ENTITY);
    expect(findByCode(r.findings, 'V4')).toHaveLength(0);
  });

  it('★ 进项票购买方不是本主体 → FAIL，并提示可能方向颠倒', () => {
    const r = validateExtraction(
      goodInvoice({ buyerName: '另一家公司', buyerTaxNo: '91310000MA1OTHER01' }),
      ENTITY,
    );
    const v4 = findByCode(r.findings, 'V4')[0];
    expect(v4?.level).toBe('FAIL');
    expect(v4?.message).toContain('另一家公司');
    expect(v4?.message).toContain('演示科技');
    expect(v4?.suggestion).toContain('颠倒');
    expect(r.hasFailure).toBe(true);
  });

  it('★ 模型返回的「购销方颠倒」样例必须被拦下', () => {
    // 本主体出现在销售方位置，方向却标为 INPUT
    const r = validateExtraction(
      goodInvoice({
        direction: 'INPUT',
        sellerName: '演示科技有限公司',
        sellerTaxNo: '91310000MA1DEMO001',
        buyerName: '另一家公司',
        buyerTaxNo: '91310000MA1OTHER01',
      }),
      ENTITY,
    );
    expect(r.hasFailure).toBe(true);
    expect(findByCode(r.findings, 'V4')[0]?.level).toBe('FAIL');
  });

  it('销项票销售方为本主体 → 不报警', () => {
    const r = validateExtraction(
      goodInvoice({
        direction: 'OUTPUT',
        sellerName: '演示科技有限公司',
        sellerTaxNo: '91310000MA1DEMO001',
        buyerName: '某某贸易有限公司',
      }),
      ENTITY,
    );
    expect(findByCode(r.findings, 'V4')).toHaveLength(0);
  });

  it('销项票销售方不是本主体 → FAIL', () => {
    const r = validateExtraction(goodInvoice({ direction: 'OUTPUT' }), ENTITY);
    expect(findByCode(r.findings, 'V4')[0]?.level).toBe('FAIL');
  });

  it('方向无法判定时给 WARN 而非 FAIL（可能是别家的票）', () => {
    const r = validateExtraction(
      goodInvoice({ direction: null, buyerName: '甲公司', sellerName: '乙公司' }),
      ENTITY,
    );
    expect(findByCode(r.findings, 'V4')[0]?.level).toBe('WARN');
  });

  it('税号匹配也能判定方向（名称写法不同时）', () => {
    const r = validateExtraction(
      goodInvoice({ buyerName: '演示科技（上海）有限公司' }),
      ENTITY,
    );
    expect(findByCode(r.findings, 'V4')).toHaveLength(0);
  });
});

describe('V5 · 发票号码格式', () => {
  it('老电票 12 位代码 + 8 位号码通过', () => {
    const r = validateExtraction(goodInvoice(), ENTITY);
    expect(findByCode(r.findings, 'V5')).toHaveLength(0);
  });

  it('数电票应为 20 位，位数不对给 WARN', () => {
    const r = validateExtraction(
      goodInvoice({ category: 'E_INVOICE', invoiceCode: null, invoiceNumber: '1234567890' }),
      ENTITY,
    );
    expect(findByCode(r.findings, 'V5')[0]?.level).toBe('WARN');
  });

  it('数电票 20 位通过', () => {
    const r = validateExtraction(
      goodInvoice({ category: 'E_INVOICE', invoiceCode: null, invoiceNumber: '24312000000012345678' }),
      ENTITY,
    );
    expect(findByCode(r.findings, 'V5')).toHaveLength(0);
  });
});

describe('V6 · 开票日期', () => {
  it('正常历史日期不报警', () => {
    const r = validateExtraction(goodInvoice(), ENTITY);
    expect(findByCode(r.findings, 'V6')).toHaveLength(0);
  });

  it('未来日期给 WARN', () => {
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const r = validateExtraction(goodInvoice({ invoiceDate: future }), ENTITY);
    expect(findByCode(r.findings, 'V6')[0]?.level).toBe('WARN');
  });

  it('无法解析的日期给 WARN', () => {
    const r = validateExtraction(goodInvoice({ invoiceDate: '二〇二五年三月' }), ENTITY);
    expect(findByCode(r.findings, 'V6')[0]?.level).toBe('WARN');
  });
});

describe('V7 · 重复发票', () => {
  it('未重复时不报警', () => {
    const r = validateExtraction(goodInvoice(), ENTITY);
    expect(findByCode(r.findings, 'V7')).toHaveLength(0);
  });

  it('★ 命中业务唯一键 → FAIL，且说明不会重复入账', () => {
    const r = validateExtraction(goodInvoice(), { ...ENTITY, duplicateInvoiceId: 'inv-existing' });
    const v7 = findByCode(r.findings, 'V7')[0];
    expect(v7?.level).toBe('FAIL');
    expect(v7?.suggestion).toContain('不会重复入账');
    expect(v7?.suggestion).toContain('附件');
  });
});

describe('V8 · 金额合理性', () => {
  it('正常金额通过', () => {
    const r = validateExtraction(goodInvoice(), ENTITY);
    expect(findByCode(r.findings, 'V8')).toHaveLength(0);
  });

  it('金额为 0 或负 → FAIL', () => {
    const r = validateExtraction(
      goodInvoice({ amountExclTax: '0', taxAmount: '0', amountInclTax: '0' }),
      ENTITY,
    );
    expect(findByCode(r.findings, 'V8')[0]?.level).toBe('FAIL');
  });

  it('★ 天文数字（识别多打了 0）→ FAIL 并提示', () => {
    const r = validateExtraction(
      goodInvoice({ amountExclTax: '100000000.00', taxAmount: '13000000.00', amountInclTax: '113000000.00' }),
      ENTITY,
    );
    const v8 = findByCode(r.findings, 'V8')[0];
    expect(v8?.level).toBe('FAIL');
    expect(v8?.suggestion).toContain('多识别了数字');
  });
});

describe('V9 · 明细行合计', () => {
  it('明细合计与票面一致时不报警', () => {
    const r = validateExtraction(
      goodInvoice({
        items: [
          { itemName: 'A4纸', amountExclTax: '600.00' },
          { itemName: '签字笔', amountExclTax: '400.00' },
        ],
      }),
      ENTITY,
    );
    expect(findByCode(r.findings, 'V9')).toHaveLength(0);
  });

  it('明细合计与票面不一致 → WARN', () => {
    const r = validateExtraction(
      goodInvoice({ items: [{ itemName: 'A4纸', amountExclTax: '500.00' }] }),
      ENTITY,
    );
    expect(findByCode(r.findings, 'V9')[0]?.level).toBe('WARN');
  });
});

describe('V10 / V11 / V12 · 提示类', () => {
  it('红字发票给 INFO 提示确认原蓝票', () => {
    const r = validateExtraction(goodInvoice({ isRedFlushed: true }), ENTITY);
    expect(findByCode(r.findings, 'V10')[0]?.level).toBe('INFO');
  });

  it('餐饮服务开 13% → INFO 提示税率可能不对', () => {
    const r = validateExtraction(
      goodInvoice({
        sellerName: '某某餐饮管理有限公司',
        items: [{ itemName: '餐饮服务' }],
        taxRate: '0.13',
        taxAmount: '130.00',
      }),
      ENTITY,
    );
    const v11 = findByCode(r.findings, 'V11')[0];
    expect(v11?.level).toBe('INFO');
    expect(v11?.message).toContain('6%');
  });

  it('新供应商给 INFO 提示会建档', () => {
    const r = validateExtraction(goodInvoice({ sellerTaxNo: '91310000MA1NEW00001' }), ENTITY);
    expect(findByCode(r.findings, 'V12')[0]?.level).toBe('INFO');
  });

  it('已知供应商不提示', () => {
    const r = validateExtraction(goodInvoice(), ENTITY);
    expect(findByCode(r.findings, 'V12')).toHaveLength(0);
  });
});

describe('★ 置信度路由 decideRouting', () => {
  const noIssues = { findings: [], hasFailure: false, warnCount: 0, failCount: 0 };

  it('高置信度 + 无问题 → 自动生成待确认凭证', () => {
    const d = decideRouting({
      overallConfidence: 0.95,
      fieldConfidence: { amountInclTax: 0.98, sellerName: 0.96 },
      outcome: noIssues,
      threshold: 0.85,
    });
    expect(d.status).toBe('AUTO_DRAFTED');
    expect(d.reason).toContain('校验全部通过');
  });

  it('★ 存在 FAIL → 强制人工，不允许自动', () => {
    const d = decideRouting({
      overallConfidence: 0.99,
      fieldConfidence: {},
      outcome: {
        findings: [{ code: 'V4', level: 'FAIL', message: '方向不一致' }],
        hasFailure: true,
        warnCount: 0,
        failCount: 1,
      },
      threshold: 0.85,
    });
    expect(d.status).toBe('NEEDS_REVIEW');
    expect(d.reason).toContain('V4');
  });

  it('★ 即使置信度 1.0，有 FAIL 也必须人工', () => {
    const d = decideRouting({
      overallConfidence: 1.0,
      fieldConfidence: {},
      outcome: {
        findings: [{ code: 'V1', level: 'FAIL', message: '金额勾稽不成立' }],
        hasFailure: true,
        warnCount: 0,
        failCount: 1,
      },
      threshold: 0.85,
    });
    expect(d.status).toBe('NEEDS_REVIEW');
  });

  it('WARN 会折减置信度', () => {
    const d = decideRouting({
      overallConfidence: 0.9,
      fieldConfidence: {},
      outcome: {
        findings: [{ code: 'V2', level: 'WARN', message: '税额不匹配' }],
        hasFailure: false,
        warnCount: 1,
        failCount: 0,
      },
      threshold: 0.85,
    });
    // 0.9 - 0.15 = 0.75 < 0.85 → 人工
    expect(d.status).toBe('NEEDS_REVIEW');
    expect(d.reason).toContain('折减');
  });

  it('单个字段置信度低 → 人工，并列出字段名', () => {
    const d = decideRouting({
      overallConfidence: 0.96,
      fieldConfidence: { amountInclTax: 0.98, invoiceNumber: 0.55 },
      outcome: noIssues,
      threshold: 0.85,
    });
    expect(d.status).toBe('NEEDS_REVIEW');
    expect(d.lowConfidenceFields).toContain('invoiceNumber');
    expect(d.reason).toContain('invoiceNumber');
  });

  it('置信度不足阈值 → 人工', () => {
    const d = decideRouting({
      overallConfidence: 0.7,
      fieldConfidence: {},
      outcome: noIssues,
      threshold: 0.85,
    });
    expect(d.status).toBe('NEEDS_REVIEW');
  });
});

describe('综合场景：Mock 样例的实际表现', () => {
  it('正常办公用品专票 → 无 FAIL，可自动', () => {
    const r = validateExtraction(goodInvoice(), ENTITY);
    expect(r.failCount).toBe(0);
  });

  it('★ 餐饮招待专票（不可抵扣场景）→ 无 FAIL（抵扣判定由规则层负责）', () => {
    const r = validateExtraction(
      goodInvoice({
        sellerName: '某某餐饮管理有限公司',
        sellerTaxNo: '91310000MA1FOOD001',
        taxRate: '0.06',
        taxAmount: '60.00',
        amountInclTax: '1060.00',
        items: [{ itemName: '餐饮服务' }],
      }),
      ENTITY,
    );
    expect(r.hasFailure).toBe(false);
  });

  it('★ 金额勾稽错误的样例 → 必须被拦下', () => {
    const r = validateExtraction(
      goodInvoice({
        amountExclTax: '1000.00',
        taxRate: '0.06',
        taxAmount: '60.00',
        amountInclTax: '1090.00',
      }),
      ENTITY,
    );
    expect(r.hasFailure).toBe(true);
    expect(r.failCount).toBeGreaterThanOrEqual(1);
  });
});
