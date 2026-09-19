/**
 * Mock Provider —— 开发与测试的关键
 * ============================================================
 * 它决定了开发阶段是否会被 API 成本卡住。
 *
 * 行为：
 *   · 按文件名/内容哈希稳定映射到一个样例票据
 *   · 返回固定的结构化数据与字段级置信度
 *   · 每个样例覆盖至少一条会计交叉校验规则（含故意触发 V4 购销方颠倒的样例）
 *
 * 好处：
 *   · 新人 clone 下来 AI_PROVIDER=mock 就能把全链路跑通
 *   · CI 里跑端到端测试不花钱、不抖动
 *   · 校验规则、规则引擎、报表都能被真实数据形状测试到
 */
import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@bookkeeper/shared';
import {
  AiProviderError,
  estimateTokens,
  type AiProvider,
  type ChatRequest,
  type ChatResponse,
  type ProviderHealth,
  type VisionRequest,
} from './ai-provider.interface';

// ============================================================================
//  样例票据
// ============================================================================

export interface MockInvoiceSample {
  key: string;
  label: string;
  /** 该样例主要覆盖哪条校验规则 */
  covers: string;
  data: Record<string, unknown>;
  fieldConfidence: Record<string, number>;
}

/**
 * 「方向无法判定」样例。
 *
 * 刻意构造：购销双方**都不是**本主体，且 direction=null。
 * 这是扫描件模糊、票面残缺时的真实情形 —— 模型既认不出购买方也认不出销售方。
 *
 * 系统在这种情况下的正确行为是**拒绝落库并要求人工指定方向**，
 * 而不是"不是销项就是进项"地猜一个。方向猜错会让进项票被记成销项，
 * 虚增收入和销项税 —— 这是记错账里最难发现的一类。
 */
export const MOCK_NO_DIRECTION_SAMPLES: MockSample[] = [
  {
    key: 'no-direction',
    label: '★ 购销双方都无法匹配本主体（方向无法判定，必须人工指定）',
    data: {
      direction: null,
      category: 'SPECIAL_VAT',
      invoiceCode: '044001900111',
      invoiceNumber: 'ND-0001',
      invoiceDate: '2024-06-15',
      sellerName: '某某商贸有限公司',
      sellerTaxNo: '91330100MA2XXXXX1B',
      buyerName: '某某服务有限公司',
      buyerTaxNo: '91330100MA2YYYYY2C',
      amountExclTax: '1000.00',
      taxRate: '0.13',
      taxAmount: '130.00',
      amountInclTax: '1130.00',
      isRedFlushed: false,
      items: [{ itemName: '办公用品', amountExclTax: '1000.00', taxRate: '0.13', taxAmount: '130.00' }],
      _warnings: ['购买方与销售方都不是本主体'],
    },
  },
];
/**
 * Mock 样例的统一形状。
 *
 * ★ data 必须放宽成 Record<string, unknown>：
 *   发票、银行回单、资产负债表、增值税申报表、企业所得税申报表的字段
 *   彼此毫无交集。若让 TS 从某个具体样例数组反推类型，
 *   "按识别目标挑样例池"这段代码就会因为样例形状不同而编译不过 ——
 *   而样例池本就应该能装任意类型的样例。
 */
export interface MockSample {
  key: string;
  label: string;
  data: Record<string, unknown>;
  /** 逐字段置信度：只有部分样例提供（用于验证低置信度路由分支） */
  fieldConfidence?: Record<string, number>;
}
export const MOCK_INVOICE_SAMPLES: MockInvoiceSample[] = [
  {
    key: 'purchase-office-supplies',
    label: '进项专票 — 采购办公用品（正常）',
    covers: 'V1 金额勾稽通过，走自动记账',
    data: {
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
      items: [{ itemName: 'A4复印纸', spec: '70g/500张', unit: '箱', quantity: '10', unitPrice: '100.00' }],
    },
    fieldConfidence: {
      invoiceNumber: 0.98,
      invoiceDate: 0.99,
      amountExclTax: 0.97,
      taxAmount: 0.97,
      amountInclTax: 0.99,
      sellerName: 0.96,
      buyerName: 0.98,
    },
  },
  {
    key: 'input-entertainment',
    label: '进项专票 — 餐饮招待（不可抵扣）',
    covers: 'B5 不可抵扣场景，税额应并入成本',
    data: {
      direction: 'INPUT',
      category: 'SPECIAL_VAT',
      invoiceCode: '3100201130',
      invoiceNumber: '22334455',
      invoiceDate: '2025-03-08',
      sellerName: '某某餐饮管理有限公司',
      sellerTaxNo: '91310000MA1FOOD001',
      buyerName: '演示科技有限公司',
      buyerTaxNo: '91310000MA1DEMO001',
      amountExclTax: '1000.00',
      taxRate: '0.06',
      taxAmount: '60.00',
      amountInclTax: '1060.00',
      isRedFlushed: false,
      items: [{ itemName: '餐饮服务', spec: '', unit: '', quantity: '1', unitPrice: '1000.00' }],
    },
    fieldConfidence: {
      invoiceNumber: 0.95,
      amountExclTax: 0.96,
      taxAmount: 0.96,
      amountInclTax: 0.98,
      sellerName: 0.93,
    },
  },
  {
    key: 'output-sales',
    label: '销项专票 — 销售货物（正常）',
    covers: 'A1 开票确认收入',
    data: {
      direction: 'OUTPUT',
      category: 'SPECIAL_VAT',
      invoiceCode: '3100201130',
      invoiceNumber: '55667788',
      invoiceDate: '2025-03-12',
      sellerName: '演示科技有限公司',
      sellerTaxNo: '91310000MA1DEMO001',
      buyerName: '某某贸易有限公司',
      buyerTaxNo: '91310000MA1TRADE01',
      amountExclTax: '10000.00',
      taxRate: '0.13',
      taxAmount: '1300.00',
      amountInclTax: '11300.00',
      isRedFlushed: false,
      items: [{ itemName: '软件产品', spec: 'V1.0', unit: '套', quantity: '1', unitPrice: '10000.00' }],
    },
    fieldConfidence: {
      invoiceNumber: 0.97,
      amountExclTax: 0.98,
      taxAmount: 0.98,
      amountInclTax: 0.99,
    },
  },
  {
    key: 'direction-swapped',
    label: '★ 购销方颠倒（故意构造的错误样例）',
    covers: 'V4 购买方非本主体 —— 必须被拦下并提示可能方向错误',
    data: {
      direction: 'INPUT',
      category: 'SPECIAL_VAT',
      invoiceCode: '3100201130',
      invoiceNumber: '99887766',
      invoiceDate: '2025-03-15',
      // 注意：本主体出现在「销售方」位置，方向却标记为进项 → 应触发 V4 FAIL
      sellerName: '演示科技有限公司',
      sellerTaxNo: '91310000MA1DEMO001',
      buyerName: '另一家公司',
      buyerTaxNo: '91310000MA1OTHER01',
      amountExclTax: '5000.00',
      taxRate: '0.13',
      taxAmount: '650.00',
      amountInclTax: '5650.00',
      isRedFlushed: false,
    },
    fieldConfidence: { invoiceNumber: 0.92, amountInclTax: 0.95, sellerName: 0.94 },
  },
  {
    key: 'amount-mismatch',
    label: '★ 金额勾稽不成立（故意构造的错误样例）',
    covers: 'V1 金额 + 税额 ≠ 价税合计 —— 典型的 OCR 数字错误',
    data: {
      direction: 'INPUT',
      category: 'SPECIAL_VAT',
      invoiceCode: '3100201130',
      invoiceNumber: '11223344',
      invoiceDate: '2025-03-18',
      sellerName: '某某咨询服务有限公司',
      sellerTaxNo: '91310000MA1CONSULT1',
      buyerName: '演示科技有限公司',
      buyerTaxNo: '91310000MA1DEMO001',
      amountExclTax: '1000.00',
      taxRate: '0.06',
      taxAmount: '60.00',
      // 1000 + 60 = 1060，但票面（被误识别为）1090 → V1 应 FAIL
      amountInclTax: '1090.00',
      isRedFlushed: false,
    },
    fieldConfidence: { amountExclTax: 0.72, taxAmount: 0.68, amountInclTax: 0.65 },
  },
  {
    key: 'output-red-flush',
    label: '销项红字发票',
    covers: 'A5 红冲处理',
    data: {
      direction: 'OUTPUT',
      category: 'SPECIAL_VAT',
      invoiceCode: '3100201130',
      invoiceNumber: '44332211',
      invoiceDate: '2025-03-20',
      sellerName: '演示科技有限公司',
      sellerTaxNo: '91310000MA1DEMO001',
      buyerName: '某某贸易有限公司',
      buyerTaxNo: '91310000MA1TRADE01',
      amountExclTax: '10000.00',
      taxRate: '0.13',
      taxAmount: '1300.00',
      amountInclTax: '11300.00',
      isRedFlushed: true,
    },
    fieldConfidence: { invoiceNumber: 0.93, amountInclTax: 0.97, isRedFlushed: 0.91 },
  },
  {
    key: 'purchase-fixed-asset',
    label: '进项专票 — 购进设备',
    covers: 'B7 固定资产进项一次性抵扣',
    data: {
      direction: 'INPUT',
      category: 'SPECIAL_VAT',
      invoiceCode: '3100201130',
      invoiceNumber: '66778899',
      invoiceDate: '2025-03-22',
      sellerName: '某某电子设备有限公司',
      sellerTaxNo: '91310000MA1DEVICE01',
      buyerName: '演示科技有限公司',
      buyerTaxNo: '91310000MA1DEMO001',
      amountExclTax: '10000.00',
      taxRate: '0.13',
      taxAmount: '1300.00',
      amountInclTax: '11300.00',
      isRedFlushed: false,
      items: [{ itemName: '服务器设备', spec: 'R740', unit: '台', quantity: '1', unitPrice: '10000.00' }],
    },
    fieldConfidence: { invoiceNumber: 0.96, amountExclTax: 0.96, amountInclTax: 0.98 },
  },
  {
    key: 'travel-train',
    label: '火车票（旅客运输，普票可计算抵扣）',
    covers: 'B12 旅客运输按 9% 计算抵扣',
    data: {
      direction: 'INPUT',
      category: 'TRAIN',
      invoiceNumber: 'E123456789',
      invoiceDate: '2025-03-25',
      sellerName: '中国铁路上海局集团有限公司',
      sellerTaxNo: '91310000MA1RAIL001',
      buyerName: '演示科技有限公司',
      buyerTaxNo: '91310000MA1DEMO001',
      amountExclTax: '200.00',
      taxRate: '0.09',
      taxAmount: '18.00',
      amountInclTax: '218.00',
      isRedFlushed: false,
      items: [{ itemName: '旅客运输服务', spec: '上海-北京', unit: '张', quantity: '1', unitPrice: '218.00' }],
    },
    fieldConfidence: { invoiceNumber: 0.9, amountInclTax: 0.95, taxRate: 0.85 },
  },
];

/** 银行回单样例 */
export const MOCK_BANK_SAMPLES: MockSample[] = [
  {
    key: 'bank-receipt-in',
    label: '银行回单 — 收到货款',
    data: {
      direction: 'IN',
      txnDate: '2025-03-28',
      amount: '11300.00',
      counterpartyName: '某某贸易有限公司',
      counterpartyAccountNo: '6222021234567890123',
      summary: '货款',
      bankSerialNo: '2025032800001',
      balanceAfter: '125300.00',
    },
    fieldConfidence: { amount: 0.98, txnDate: 0.97, counterpartyName: 0.95 },
  },
  {
    key: 'bank-fee',
    label: '银行回单 — 手续费',
    data: {
      direction: 'OUT',
      txnDate: '2025-03-31',
      amount: '10.00',
      counterpartyName: '中国银行',
      counterpartyAccountNo: '',
      summary: '账户管理费',
      bankSerialNo: '2025033100009',
      balanceAfter: '125290.00',
    },
    fieldConfidence: { amount: 0.99, summary: 0.94 },
  },
  {
    key: 'bank-interest',
    label: '银行回单 — 利息收入',
    data: {
      direction: 'IN',
      txnDate: '2025-03-21',
      amount: '89.50',
      counterpartyName: '中国银行',
      counterpartyAccountNo: '',
      summary: '季度结息',
      bankSerialNo: '2025032100003',
      balanceAfter: '125379.50',
    },
    fieldConfidence: { amount: 0.98, summary: 0.93 },
  },
  {
    key: 'bank-internal-transfer',
    label: '★ 银行内部转账（自动记账的经典翻车点）',
    data: {
      direction: 'OUT',
      txnDate: '2025-03-29',
      amount: '100000.00',
      counterpartyName: '演示科技有限公司',
      // 对方账号属于本主体已知账户 → 判为内部转账，绝不能记成费用
      counterpartyAccountNo: '6222029876543210987',
      summary: '转账',
      bankSerialNo: '2025032900007',
      balanceAfter: '25290.00',
    },
    fieldConfidence: { amount: 0.99, counterpartyAccountNo: 0.92 },
  },
];

/**
 * 财务报表样例（资产负债表）
 *
 * 刻意构造为**平衡**的：资产 1,238,400 = 负债 356,900 + 所有者权益 881,500。
 * 另有一个故意不平衡的样例用于验证「只报不改」的平衡校验。
 */
export const MOCK_BALANCE_SHEET_SAMPLES: MockSample[] = [
  {
    key: 'balance-sheet-balanced',
    label: '资产负债表 — 平衡（正常）',
    data: {
      statementType: 'BALANCE_SHEET',
      periodStart: '2024-12-31',
      periodEnd: '2024-12-31',
      unit: '元',
      items: [
        { lineNo: '1', label: '货币资金', endBalance: '386400.00', beginBalance: '298000.00' },
        { lineNo: '4', label: '应收账款', endBalance: '215000.00', beginBalance: '186000.00' },
        { lineNo: '9', label: '存货', endBalance: '420000.00', beginBalance: '365000.00' },
        { lineNo: '15', label: '流动资产合计', endBalance: '1021400.00', beginBalance: '849000.00' },
        { lineNo: '20', label: '固定资产原价', endBalance: '280000.00', beginBalance: '260000.00' },
        { lineNo: '21', label: '减：累计折旧', endBalance: '63000.00', beginBalance: '47000.00' },
        { lineNo: '30', label: '资产总计', endBalance: '1238400.00', beginBalance: '1062000.00' },
        { lineNo: '33', label: '应付账款', endBalance: '168900.00', beginBalance: '142000.00' },
        { lineNo: '36', label: '应交税费', endBalance: '52000.00', beginBalance: '41000.00' },
        { lineNo: '37', label: '应付职工薪酬', endBalance: '86000.00', beginBalance: '78000.00' },
        { lineNo: '41', label: '流动负债合计', endBalance: '306900.00', beginBalance: '261000.00' },
        { lineNo: '43', label: '长期借款', endBalance: '50000.00', beginBalance: '60000.00' },
        { lineNo: '47', label: '负债合计', endBalance: '356900.00', beginBalance: '321000.00' },
        { lineNo: '48', label: '实收资本', endBalance: '500000.00', beginBalance: '500000.00' },
        { lineNo: '51', label: '未分配利润', endBalance: '381500.00', beginBalance: '241000.00' },
        { lineNo: '52', label: '所有者权益合计', endBalance: '881500.00', beginBalance: '741000.00' },
        { lineNo: '53', label: '负债和所有者权益总计', endBalance: '1238400.00', beginBalance: '1062000.00' },
      ],
      totalAssets: '1238400.00',
      totalLiabilities: '356900.00',
      totalEquity: '881500.00',
      _selfCheck: { balanced: true, difference: '0.00' },
      _warnings: [],
    },
  },
  {
    key: 'balance-sheet-unbalanced',
    label: '★ 资产负债表 — 不平衡（故意构造的错误样例）',
    data: {
      statementType: 'BALANCE_SHEET',
      periodStart: '2023-12-31',
      periodEnd: '2023-12-31',
      unit: '元',
      items: [
        { lineNo: '1', label: '货币资金', endBalance: '298000.00', beginBalance: '265000.00' },
        { lineNo: '9', label: '存货', endBalance: '365000.00', beginBalance: '330000.00' },
        { lineNo: '30', label: '资产总计', endBalance: '1062000.00', beginBalance: '985000.00' },
        // 负债与权益侧少算了 120000，导致两边不等
        { lineNo: '47', label: '负债合计', endBalance: '321000.00', beginBalance: '298000.00' },
        { lineNo: '52', label: '所有者权益合计', endBalance: '621000.00', beginBalance: '567000.00' },
        { lineNo: '53', label: '负债和所有者权益总计', endBalance: '942000.00', beginBalance: '865000.00' },
      ],
      totalAssets: '1062000.00',
      totalLiabilities: '321000.00',
      totalEquity: '621000.00',
      _selfCheck: { balanced: false, difference: '120000.00' },
      _warnings: ['资产总计与负债和所有者权益总计不相等'],
    },
  },
];

/** 利润表样例 */
export const MOCK_INCOME_STATEMENT_SAMPLES: MockSample[] = [
  {
    key: 'income-statement',
    label: '利润表 — 正常',
    data: {
      statementType: 'INCOME_STATEMENT',
      periodStart: '2024-01-01',
      periodEnd: '2024-12-31',
      unit: '元',
      items: [
        { lineNo: '1', label: '一、营业收入', endBalance: '2680000.00', beginBalance: '2310000.00' },
        { lineNo: '2', label: '减：营业成本', endBalance: '1890000.00', beginBalance: '1640000.00' },
        { lineNo: '3', label: '税金及附加', endBalance: '18600.00', beginBalance: '16200.00' },
        { lineNo: '4', label: '销售费用', endBalance: '142000.00', beginBalance: '128000.00' },
        { lineNo: '5', label: '管理费用', endBalance: '286000.00', beginBalance: '251000.00' },
        { lineNo: '6', label: '财务费用', endBalance: '12400.00', beginBalance: '13800.00' },
        { lineNo: '8', label: '二、营业利润', endBalance: '331000.00', beginBalance: '261000.00' },
        { lineNo: '9', label: '加：营业外收入', endBalance: '8600.00', beginBalance: '4200.00' },
        { lineNo: '10', label: '减：营业外支出', endBalance: '14600.00', beginBalance: '11200.00' },
        { lineNo: '11', label: '三、利润总额', endBalance: '325000.00', beginBalance: '254000.00' },
        { lineNo: '12', label: '减：所得税费用', endBalance: '16250.00', beginBalance: '12700.00' },
        { lineNo: '13', label: '四、净利润', endBalance: '308750.00', beginBalance: '241300.00' },
      ],
      revenue: '2680000.00',
      cost: '1890000.00',
      profitBeforeTax: '325000.00',
      netProfit: '308750.00',
      _warnings: [],
    },
  },
];

/** 增值税申报表样例 */
export const MOCK_VAT_RETURN_SAMPLES: MockSample[] = [
  {
    key: 'vat-return-main',
    label: '增值税申报表主表 — 一般纳税人月报',
    data: {
      periodStart: '2024-12-01',
      periodEnd: '2024-12-31',
      line1SalesTaxable: '412000.00',
      line11OutputTax: '53560.00',
      line12InputTax: '38600.00',
      line13CreditBroughtForward: '0.00',
      line14InputTaxTransferOut: '0.00',
      line17DeductibleTotal: '38600.00',
      line18ActualDeducted: '38600.00',
      line19TaxPayable: '14960.00',
      line20CreditCarriedForward: '0.00',
      line24TaxPayableTotal: '14960.00',
      line25OpeningUnpaid: '0.00',
      line27TaxPaidThisPeriod: '0.00',
      line32ClosingUnpaid: '14960.00',
      line34PayableOrRefund: '14960.00',
      surtaxBase: '14960.00',
      surtaxCity: '523.60',
      surtaxEducation: '224.40',
      surtaxLocalEducation: '149.60',
      surtaxTotal: '897.60',
      _warnings: [],
    },
  },
];

/** 企业所得税年度申报表样例 */
export const MOCK_CIT_RETURN_SAMPLES: MockSample[] = [
  {
    key: 'cit-return-annual',
    label: '企业所得税年度申报表 — 汇算清缴',
    data: {
      periodStart: '2024-01-01',
      periodEnd: '2024-12-31',
      taxType: 'CIT',
      line1Revenue: '2680000.00',
      line2Cost: '1890000.00',
      line3ProfitTotal: '325000.00',
      line4SpecificAdjust: '0.00',
      line5NonTaxableIncome: '0.00',
      line7TaxFreeIncome: '0.00',
      line9LossOffset: '0.00',
      line10TaxableIncome: '325000.00',
      line11TaxRate: '0.05',
      line12TaxPayable: '16250.00',
      line13TaxRelief: '0.00',
      line14PaidThisYear: '0.00',
      line16PayableOrRefund: '16250.00',
      _warnings: [
        '小微企业优惠：应纳税所得额 325000.00 在 300 万以内，按 5% 实际税负计算（系统按表上数字照抄，未自行套用优惠）',
      ],
    },
  },
];
// ============================================================================
//  Provider 实现
//  Provider 实现
// ============================================================================

@Injectable()
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockAiProvider.name);

  /** 允许通过 message 内容指定样例：__case=xxx */
  /**
   * 从 hint 里取显式指定的样例名（`__case=xxx`）。
   *
   * ★ 为什么单独抽一个方法：
   *   「选哪个样例池」（增值税 vs 所得税）和「池里选哪个样例」这两个判断
   *   必须用**同一个**显式样例名，否则会出现
   *   "指定了增值税样例、却因为池选错而返回所得税数据"这种自相矛盾的结果。
   */
  private explicitCaseKey(hint: string | undefined): string | null {
    return /__case=([a-z0-9-]+)/i.exec(hint ?? '')?.[1] ?? null;
  }

  private pickSample<T extends MockSample>(
    samples: T[],
    hint: string,
  ): T {
    const explicit = /__case=([a-z0-9-]+)/i.exec(hint)?.[1];

    /*
     * ★ 显式指定了样例名却找不到时**必须抛错**，绝不能回退到哈希选样。
     *
     *   原来的写法是 `if (found) return found;`，找不到就继续往下走哈希选择。
     *   后果：验证脚本传一个拼错的样例名（比如 purchase-office-supplie），
     *   会拿到一个**完全不相干的样例**却被判为通过 —— 断言全绿，功能其实是坏的。
     *   实测踩到：传 case=nonexistent-case-xyz 返回了火车票数据，HTTP 201，
     *   而且校验还报 PASS。这类"假绿"比直接报错危险得多。
     *
     *   错误信息里把可选样例名列出来，省得去翻源码。
     */
    if (explicit) {
      const found = samples.find((s) => s.key === explicit);
      if (found) return found;
      throw new AiProviderError(
        `Mock Provider 没有名为「${explicit}」的样例。可选：${samples
          .map((s) => s.key)
          .join('、')}（样例名拼错时故意报错，而不是随便给一个 —— ` +
          `否则验证脚本会拿着不相干的数据假通过）`,
        this.name,
        false,
        undefined,
        // ★ 调用方参数错误，不是上游故障 —— 声明 400 而不是默认的 502。
        //   否则用户看到"AI 服务暂时不可用"，会一直重试一个永远不会成功的请求。
        400,
      );
    }

    // 未指定样例名时按内容哈希稳定选择，保证同一输入永远返回同一结果（可复现）
    let hash = 0;
    for (let i = 0; i < hint.length; i += 1) {
      hash = (hash * 31 + hint.charCodeAt(i)) >>> 0;
    }
    const index = hash % samples.length;
    return samples[index] as T;
  }

  async ping(): Promise<ProviderHealth> {
    return {
      ok: true,
      provider: this.name,
      model: 'mock-v1',
      latencyMs: 0,
      message: 'Mock Provider：离线运行，返回固定样例，不消耗任何 API 额度',
    };
  }

  async vision(req: VisionRequest): Promise<ChatResponse> {
    const start = Date.now();
    const hint = `${req.text} ${req.images.map((i) => i.path ?? '').join(' ')}`;

    let payload: Record<string, unknown>;
    let fieldConfidence: Record<string, number>;
    let label: string;

    if (req.purpose === 'EXTRACT_BANK_SLIP') {
      const sample = this.pickSample(MOCK_BANK_SAMPLES, hint);
      payload = sample.data;
      fieldConfidence = {};
      label = sample.label;
    } else if (req.purpose === 'EXTRACT_BALANCE_SHEET') {
      const sample = this.pickSample(MOCK_BALANCE_SHEET_SAMPLES, hint);
      payload = sample.data;
      fieldConfidence = {};
      label = sample.label;
    } else if (req.purpose === 'EXTRACT_INCOME_STATEMENT') {
      const sample = this.pickSample(MOCK_INCOME_STATEMENT_SAMPLES, hint);
      payload = sample.data;
      fieldConfidence = {};
      label = sample.label;
    } else if (req.purpose === 'EXTRACT_TAX_RETURN') {
      const explicit = this.explicitCaseKey(hint);
      const isCit = explicit ? /cit|所得税/i.test(explicit) : /CIT|所得税/.test(hint ?? '');
      const pool = isCit ? MOCK_CIT_RETURN_SAMPLES : MOCK_VAT_RETURN_SAMPLES;
      const sample = this.pickSample(pool, hint);
      payload = sample.data;
      fieldConfidence = {};
      label = sample.label;
    } else {
      const pool = this.explicitCaseKey(hint) === 'no-direction'
        ? MOCK_NO_DIRECTION_SAMPLES
        : MOCK_INVOICE_SAMPLES;
      const sample = this.pickSample(pool, hint);
      payload = sample.data;
      // 发票样例都带逐字段置信度；万一某个样例没给，退回空对象而不是 undefined
      fieldConfidence = sample.fieldConfidence ?? {};
      label = sample.label;
    }

    this.logger.log(`[Mock] 识图命中样例：${label}（purpose=${req.purpose}）`);

    const result = {
      ...payload,
      _fieldConfidence: fieldConfidence,
      _warnings: [],
      _mockSample: label,
    };

    return {
      text: JSON.stringify(result, null, 2),
      json: result,
      usage: {
        promptTokens: estimateTokens(req.text) + req.images.length * 1200,
        completionTokens: estimateTokens(JSON.stringify(result)),
      },
      model: 'mock-v1',
      latencyMs: Date.now() - start,
      raw: { mock: true, sample: label },
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const start = Date.now();
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    if (req.purpose === 'SUGGEST_ACCOUNT') {
      // 兜底建议：置信度刻意给低，强制人工确认
      const result = {
        suggestions: [
          {
            lines: [{ accountCode: '660202', direction: 'DEBIT' }],
            confidence: 0.55,
            reason: 'Mock Provider 无法判断业务实质，默认建议计入管理费用—办公费，请人工确认。',
          },
        ],
        warnings: ['当前为 Mock 模式，科目建议不具参考价值'],
      };
      return {
        text: JSON.stringify(result),
        json: result,
        usage: { promptTokens: estimateTokens(lastUser), completionTokens: 80 },
        model: 'mock-v1',
        latencyMs: Date.now() - start,
        raw: { mock: true },
      };
    }

    const text = 'Mock Provider：未实现该用途的模拟响应。';
    return {
      text,
      usage: { promptTokens: estimateTokens(lastUser), completionTokens: estimateTokens(text) },
      model: 'mock-v1',
      latencyMs: Date.now() - start,
      raw: { mock: true },
    };
  }

  async estimateCost(): Promise<Decimal | null> {
    // 离线运行零成本
    return new Decimal(0);
  }
}

/** 供测试与自检使用：列出所有可用样例 */
export function listMockSamples(): Array<{ key: string; label: string; covers: string }> {
  return [
    ...MOCK_INVOICE_SAMPLES.map((s) => ({ key: s.key, label: s.label, covers: s.covers })),
    ...MOCK_BANK_SAMPLES.map((s) => ({ key: s.key, label: s.label, covers: '银行流水识别' })),
    ...MOCK_BALANCE_SHEET_SAMPLES.map((s) => ({ key: s.key, label: s.label, covers: '资产负债表识别与平衡校验' })),
    ...MOCK_INCOME_STATEMENT_SAMPLES.map((s) => ({ key: s.key, label: s.label, covers: '利润表识别' })),
    ...MOCK_VAT_RETURN_SAMPLES.map((s) => ({ key: s.key, label: s.label, covers: '增值税申报表识别' })),
    ...MOCK_CIT_RETURN_SAMPLES.map((s) => ({ key: s.key, label: s.label, covers: '企业所得税年报识别' })),
    ...MOCK_NO_DIRECTION_SAMPLES.map((s) => ({ key: s.key, label: s.label, covers: 'V4 购销方都无法匹配 —— 方向无法判定，必须人工指定' })),
  ];
}
