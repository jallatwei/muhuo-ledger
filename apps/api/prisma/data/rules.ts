/**
 * 内置自动记账规则库
 * ============================================================
 * 覆盖 design/05 第 3 节场景表的 A1~E2，开箱可用。
 *
 * 规则结构说明：
 *   conditions  条件树（AND/OR/NOT + 叶子比较），见 design/05 第 2.1 节
 *   template    分录模板，见 design/05 第 2.2 节
 *
 * ★ 关于税务科目的写法：
 *   模板里 **不要硬编码进项税额科目**（22210101 / 22210102），
 *   统一用 `{{ tax.account }}`。它由系统按以下决策算出（design/05 第 2.3 节）：
 *     · 税额为 0 或不可抵扣     → null（不产生税行，税额并入成本）
 *     · 小规模纳税人            → null（不可抵扣）
 *     · 专票/数电票 + 自动认证  → 22210102 待认证进项税额
 *     · 已在本期勾选认证        → 22210101 进项税额
 *
 * ★ `{{ costAmount }}` 同样由系统派生：
 *   可抵扣 → invoice.amountExclTax；不可抵扣 → invoice.amountInclTax。
 *   这条最容易写错（把不可抵扣的税额漏进成本），所以做成内建变量。
 *
 * ★ priority 数字小者先匹配。内置规则占用 100~999，用户自建规则从 1000 起。
 */

export type RuleCondition =
  | { field: string; cmp: string; value?: unknown }
  | { op: 'AND' | 'OR' | 'NOT'; children: RuleCondition[] };

export interface RuleTemplateLine {
  side: 'DEBIT' | 'CREDIT';
  account: string;
  amount: string;
  summary?: string;
  partnerId?: string;
  /** 条件表达式，为假时整行省略 */
  when?: string;
}

export interface RuleTemplate {
  summary: string;
  attachments?: number;
  lines: RuleTemplateLine[];
}

export interface BuiltinRule {
  code: string;
  name: string;
  priority: number;
  trigger:
    | 'INVOICE_INPUT'
    | 'INVOICE_OUTPUT'
    | 'BANK_IN'
    | 'BANK_OUT'
    | 'BANK_FEE'
    | 'BANK_INTEREST'
    | 'SALARY_ACCRUAL'
    | 'SALARY_PAYMENT'
    | 'DEPRECIATION'
    | 'AMORTIZATION'
    | 'TAX_PAYMENT'
    | 'OTHER';
  conditions: RuleCondition;
  template: RuleTemplate;
  confidence: string;
  /** ★ 内置规则一律不允许自动过账 */
  autoPost: boolean;
  remark?: string;
}

// ---------------------------------------------------------------- 条件片段复用
const isInput = (): RuleCondition => ({ field: 'invoice.direction', cmp: 'EQ', value: 'INPUT' });
const isOutput = (): RuleCondition => ({ field: 'invoice.direction', cmp: 'EQ', value: 'OUTPUT' });
const isRed = (): RuleCondition => ({ field: 'invoice.isRedFlushed', cmp: 'EQ', value: true });
const notRed = (): RuleCondition => ({ field: 'invoice.isRedFlushed', cmp: 'EQ', value: false });
/** 品名/名称命中关键词 */
const itemHits = (...keywords: string[]): RuleCondition => ({
  op: 'OR',
  children: [
    { field: 'invoice.itemSummary', cmp: 'REGEX', value: keywords.join('|') },
    { field: 'invoice.sellerName', cmp: 'REGEX', value: keywords.join('|') },
  ],
});

export const BUILTIN_RULES: BuiltinRule[] = [
  // ======================================================== A. 销项（4 条）
  {
    code: 'sys-sales-invoice-revenue',
    name: '销项开票确认收入',
    priority: 100,
    trigger: 'INVOICE_OUTPUT',
    conditions: { op: 'AND', children: [isOutput(), notRed()] },
    template: {
      summary: '销售{{ invoice.itemSummary || "货物" }}（{{ partner.name }}）',
      attachments: 1,
      lines: [
        {
          side: 'DEBIT',
          account: '1122',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应收 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
        { side: 'CREDIT', account: '6001', amount: '{{ invoice.amountExclTax }}', summary: '主营业务收入' },
        {
          side: 'CREDIT',
          account: '22210105',
          amount: '{{ invoice.taxAmount }}',
          summary: '销项税额',
          when: '{{ invoice.taxAmount > 0 }}',
        },
      ],
    },
    confidence: '0.9500',
    autoPost: false,
    remark: 'standard/05 A1；纳税义务已发生（已开票）',
  },
  {
    code: 'sys-sales-red-flush',
    name: '销项红字发票冲销',
    priority: 101,
    trigger: 'INVOICE_OUTPUT',
    conditions: { op: 'AND', children: [isOutput(), isRed()] },
    template: {
      summary: '红冲销售{{ invoice.itemSummary || "货物" }}（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '6001', amount: '{{ invoice.amountExclTax }}', summary: '冲减主营业务收入' },
        {
          side: 'DEBIT',
          account: '22210105',
          amount: '{{ invoice.taxAmount }}',
          summary: '冲减销项税额',
          when: '{{ invoice.taxAmount > 0 }}',
        },
        {
          side: 'CREDIT',
          account: '1122',
          amount: '{{ invoice.amountInclTax }}',
          summary: '冲减应收 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9300',
    autoPost: false,
    remark: 'standard/05 A5',
  },
  {
    code: 'sys-sales-advance-offset',
    name: '预收账款开票结转',
    priority: 102,
    trigger: 'INVOICE_OUTPUT',
    conditions: {
      op: 'AND',
      children: [isOutput(), notRed(), { field: 'partner.hasAdvanceBalance', cmp: 'EQ', value: true }],
    },
    template: {
      summary: '预收结转开票（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '2203', amount: '{{ invoice.amountInclTax }}', summary: '冲减预收账款', partnerId: '{{ partner.id }}' },
        { side: 'CREDIT', account: '6001', amount: '{{ invoice.amountExclTax }}', summary: '主营业务收入' },
        {
          side: 'CREDIT',
          account: '22210105',
          amount: '{{ invoice.taxAmount }}',
          summary: '销项税额',
          when: '{{ invoice.taxAmount > 0 }}',
        },
      ],
    },
    confidence: '0.8800',
    autoPost: false,
    remark: 'standard/05 A2',
  },
  {
    code: 'sys-sales-cost-carry',
    name: '结转销售成本',
    priority: 150,
    trigger: 'OTHER',
    conditions: { op: 'AND', children: [{ field: 'manual.operation', cmp: 'EQ', value: 'CARRY_SALES_COST' }] },
    template: {
      summary: '结转销售成本',
      lines: [
        { side: 'DEBIT', account: '6401', amount: '{{ manual.amount }}', summary: '主营业务成本' },
        { side: 'CREDIT', account: '1405', amount: '{{ manual.amount }}', summary: '库存商品' },
      ],
    },
    confidence: '1.0000',
    autoPost: false,
    remark: 'standard/05 A6；需人工指定金额',
  },

  // ======================================================== B. 进项（12 条）
  {
    code: 'sys-purchase-entertainment',
    name: '业务招待费（不可抵扣）',
    priority: 110,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('餐饮', '招待', '娱乐', '礼品', '酒水')] },
    template: {
      summary: '业务招待费（{{ partner.name }}）',
      attachments: 1,
      lines: [
        // ★ 不可抵扣：全额（价税合计）计入费用，不产生税行
        { side: 'DEBIT', account: '660204', amount: '{{ invoice.amountInclTax }}', summary: '业务招待费' },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9000',
    autoPost: false,
    remark: 'standard/05 B5；财税〔2016〕36号附件1第二十七条，餐饮娱乐等不得抵扣',
  },
  {
    code: 'sys-purchase-welfare',
    name: '职工福利费（不可抵扣）',
    priority: 111,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('福利', '劳保', '职工', '慰问')] },
    template: {
      summary: '职工福利费（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660215', amount: '{{ invoice.amountInclTax }}', summary: '职工福利费' },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.8800',
    autoPost: false,
    remark: 'standard/05 B5；用于集体福利的进项不得抵扣',
  },
  {
    code: 'sys-purchase-office',
    name: '采购办公用品',
    priority: 120,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('办公', '文具', '耗材', '纸张', '打印')] },
    template: {
      summary: '采购办公用品（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660202', amount: '{{ costAmount }}', summary: '办公费' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9300',
    autoPost: false,
    remark: 'standard/05 B4',
  },
  {
    code: 'sys-purchase-consulting',
    name: '咨询服务费',
    priority: 121,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('咨询', '服务费', '顾问', '技术服务')] },
    template: {
      summary: '咨询服务费（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660211', amount: '{{ costAmount }}', summary: '咨询服务费' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9000',
    autoPost: false,
    remark: 'standard/05 B4',
  },
  {
    code: 'sys-expense-travel',
    name: '差旅费（含旅客运输）',
    priority: 122,
    trigger: 'INVOICE_INPUT',
    conditions: {
      op: 'AND',
      children: [
        isInput(),
        notRed(),
        {
          op: 'OR',
          children: [
            itemHits('差旅', '住宿', '客运', '旅客运输', '火车', '机票', '航空'),
            { field: 'invoice.category', cmp: 'IN', value: ['TRAIN', 'AIR'] },
          ],
        },
      ],
    },
    template: {
      summary: '差旅费（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660203', amount: '{{ costAmount }}', summary: '差旅费' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9000',
    autoPost: false,
    remark: 'standard/05 B12；火车票/机票等旅客运输普票也可计算抵扣',
  },
  {
    code: 'sys-expense-communication',
    name: '通讯费',
    priority: 123,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('通讯', '话费', '电信', '移动', '联通', '宽带')] },
    template: {
      summary: '通讯费（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660205', amount: '{{ costAmount }}', summary: '通讯费' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9000',
    autoPost: false,
  },
  {
    code: 'sys-expense-rent',
    name: '房租',
    priority: 124,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('房租', '租赁', '租金', '场地')] },
    template: {
      summary: '房租（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660206', amount: '{{ costAmount }}', summary: '房租' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9200',
    autoPost: false,
  },
  {
    code: 'sys-expense-utilities',
    name: '水电费',
    priority: 125,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('水费', '电费', '水电', '燃气', '供水', '供电')] },
    template: {
      summary: '水电费（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660207', amount: '{{ costAmount }}', summary: '水电费' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9200',
    autoPost: false,
  },
  {
    code: 'sys-expense-property',
    name: '物业费',
    priority: 126,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('物业', '管理费')] },
    template: {
      summary: '物业费（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660208', amount: '{{ costAmount }}', summary: '物业费' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9000',
    autoPost: false,
  },
  {
    code: 'sys-expense-express',
    name: '快递费',
    priority: 127,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('快递', '物流', '运输费', '货运')] },
    template: {
      summary: '快递费（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660213', amount: '{{ costAmount }}', summary: '快递费' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9000',
    autoPost: false,
  },
  {
    code: 'sys-expense-meeting',
    name: '会议费',
    priority: 128,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed(), itemHits('会议', '会务')] },
    template: {
      summary: '会议费（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660212', amount: '{{ costAmount }}', summary: '会议费' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.8800',
    autoPost: false,
    remark: '会议费中的餐费若单独开具餐饮发票仍不可抵扣，需人工确认',
  },
  {
    code: 'sys-purchase-material',
    name: '采购原材料/存货',
    priority: 130,
    trigger: 'INVOICE_INPUT',
    conditions: {
      op: 'AND',
      children: [
        isInput(),
        notRed(),
        {
          op: 'OR',
          children: [
            { field: 'invoice.businessType', cmp: 'EQ', value: 'PURCHASE_MATERIAL' },
            itemHits('原料', '材料', '配件', '钢材', '包装', '元器件', '库存商品'),
          ],
        },
      ],
    },
    template: {
      summary: '采购{{ invoice.itemSummary || "原材料" }}（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '1403', amount: '{{ costAmount }}', summary: '原材料' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9200',
    autoPost: false,
    remark: 'standard/05 B1/B2；未认证时税科目自动落到「待认证进项税额」',
  },
  {
    code: 'sys-input-red-flush',
    name: '进项红字发票冲销',
    priority: 131,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), isRed()] },
    template: {
      summary: '红冲采购（{{ partner.name }}）',
      attachments: 1,
      lines: [
        {
          side: 'DEBIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '冲减应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
        { side: 'CREDIT', account: '1403', amount: '{{ costAmount }}', summary: '冲减原材料' },
        {
          side: 'CREDIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '冲减进项税额',
          when: '{{ tax.hasLine }}',
        },
      ],
    },
    confidence: '0.9000',
    autoPost: false,
    remark: 'standard/05 B9',
  },
  {
    code: 'sys-purchase-fixed-asset',
    name: '购进固定资产（设备）',
    priority: 140,
    trigger: 'INVOICE_INPUT',
    conditions: {
      op: 'AND',
      children: [
        isInput(),
        notRed(),
        {
          op: 'OR',
          children: [
            { field: 'invoice.businessType', cmp: 'EQ', value: 'FIXED_ASSET' },
            itemHits('设备', '机器', '电脑', '服务器', '空调', '车辆'),
          ],
        },
      ],
    },
    template: {
      summary: '购进固定资产（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '1601', amount: '{{ costAmount }}', summary: '固定资产' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9000',
    autoPost: false,
    remark: 'standard/05 B7/B8；现行政策固定资产（含不动产）进项可一次性抵扣',
  },
  {
    code: 'sys-input-tax-transfer-out',
    name: '进项税额转出（已抵扣后改变用途）',
    priority: 145,
    trigger: 'OTHER',
    conditions: { op: 'AND', children: [{ field: 'manual.operation', cmp: 'EQ', value: 'INPUT_TAX_TRANSFER_OUT' }] },
    template: {
      summary: '进项税额转出（{{ manual.reason }}）',
      lines: [
        { side: 'DEBIT', account: '{{ manual.targetAccount }}', amount: '{{ manual.amount }}', summary: '转入成本/费用' },
        { side: 'CREDIT', account: '22210106', amount: '{{ manual.amount }}', summary: '进项税额转出' },
      ],
    },
    confidence: '1.0000',
    autoPost: false,
    remark: 'standard/05 B6；用于集体福利/个人消费等，需人工指定转入科目',
  },

  // ======================================================== C. 银行（6 条）
  {
    code: 'sys-bank-invoice-receipt',
    name: '收到货款并核销应收',
    priority: 160,
    trigger: 'BANK_IN',
    conditions: {
      op: 'AND',
      children: [
        { field: 'bank.direction', cmp: 'EQ', value: 'IN' },
        { field: 'bank.isInternalTransfer', cmp: 'EQ', value: false },
        { field: 'bank.matchedInvoiceCount', cmp: 'GT', value: 0 },
      ],
    },
    template: {
      summary: '收到货款（{{ bank.counterpartyName }}）',
      lines: [
        { side: 'DEBIT', account: '1002', amount: '{{ bank.amount }}', summary: '银行存款' },
        {
          side: 'CREDIT',
          account: '1122',
          amount: '{{ bank.amount }}',
          summary: '应收 {{ bank.counterpartyName }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.9500',
    autoPost: false,
    remark: 'standard/05 C1；同时写入 PaymentAllocation 核销',
  },
  {
    code: 'sys-bank-invoice-payment',
    name: '支付货款并核销应付',
    priority: 161,
    trigger: 'BANK_OUT',
    conditions: {
      op: 'AND',
      children: [
        { field: 'bank.direction', cmp: 'EQ', value: 'OUT' },
        { field: 'bank.isInternalTransfer', cmp: 'EQ', value: false },
        { field: 'bank.matchedInvoiceCount', cmp: 'GT', value: 0 },
      ],
    },
    template: {
      summary: '支付货款（{{ bank.counterpartyName }}）',
      lines: [
        {
          side: 'DEBIT',
          account: '2202',
          amount: '{{ bank.amount }}',
          summary: '应付 {{ bank.counterpartyName }}',
          partnerId: '{{ partner.id }}',
        },
        { side: 'CREDIT', account: '1002', amount: '{{ bank.amount }}', summary: '银行存款' },
      ],
    },
    confidence: '0.9500',
    autoPost: false,
    remark: 'standard/05 C2',
  },
  {
    code: 'sys-bank-internal-transfer',
    name: '银行内部转账',
    priority: 165,
    trigger: 'BANK_OUT',
    conditions: {
      op: 'AND',
      children: [
        { field: 'bank.isInternalTransfer', cmp: 'EQ', value: true },
      ],
    },
    template: {
      summary: '银行内部转账 {{ bank.bankAccountNo }} → {{ bank.counterpartyAccountNo }}',
      lines: [
        { side: 'DEBIT', account: '1002', amount: '{{ bank.amount }}', summary: '转入 {{ bank.counterpartyAccountNo }}' },
        { side: 'CREDIT', account: '1002', amount: '{{ bank.amount }}', summary: '转出 {{ bank.bankAccountNo }}' },
      ],
    },
    confidence: '0.9600',
    autoPost: false,
    remark:
      '★ standard/05 C3；自动记账的经典翻车点——模型看到"付出 10 万"就记成费用。' +
      '判据：对方账户号属于本主体已知账户列表。', 
  },
  {
    code: 'sys-bank-charge',
    name: '银行手续费',
    priority: 166,
    trigger: 'BANK_FEE',
    conditions: {
      op: 'OR',
      children: [
        { field: 'bank.summary', cmp: 'REGEX', value: '(手续费|工本费|账户管理费|短信费|电子汇划费)' },
      ],
    },
    template: {
      summary: '银行手续费',
      lines: [
        { side: 'DEBIT', account: '660303', amount: '{{ bank.amount }}', summary: '手续费' },
        { side: 'CREDIT', account: '1002', amount: '{{ bank.amount }}', summary: '银行存款' },
      ],
    },
    confidence: '0.9500',
    autoPost: false,
    remark: 'standard/05 C4',
  },
  {
    code: 'sys-bank-interest-income',
    name: '银行存款利息收入',
    priority: 167,
    trigger: 'BANK_INTEREST',
    conditions: {
      op: 'AND',
      children: [
        { field: 'bank.direction', cmp: 'EQ', value: 'IN' },
        { field: 'bank.summary', cmp: 'REGEX', value: '(利息|结息)' },
      ],
    },
    template: {
      summary: '银行存款利息收入',
      lines: [
        { side: 'DEBIT', account: '1002', amount: '{{ bank.amount }}', summary: '银行存款' },
        // ★ 利息收入冲减财务费用（贷方），不记入收入科目
        { side: 'CREDIT', account: '660302', amount: '{{ bank.amount }}', summary: '利息收入' },
      ],
    },
    confidence: '0.9500',
    autoPost: false,
    remark: 'standard/05 C5；★ 不得记为「营业收入」',
  },
  {
    code: 'sys-bank-tax-payment',
    name: '缴纳税费',
    priority: 168,
    trigger: 'TAX_PAYMENT',
    conditions: {
      op: 'OR',
      children: [
        { field: 'bank.summary', cmp: 'REGEX', value: '(税|社保|公积金)' },
        { field: 'bank.matchedTaxType', cmp: 'NOT_NULL', value: true },
      ],
    },
    template: {
      summary: '缴纳税费（{{ bank.summary }}）',
      lines: [
        { side: 'DEBIT', account: '{{ tax.paymentAccount }}', amount: '{{ bank.amount }}', summary: '应交税费' },
        { side: 'CREDIT', account: '1002', amount: '{{ bank.amount }}', summary: '银行存款' },
      ],
    },
    confidence: '0.8500',
    autoPost: false,
    remark: 'standard/05 C9；具体税种科目由 AI 或人工确认（增值税/所得税/附加税/个税）',
  },

  // ======================================================== D. 兜底（1 条）
  {
    code: 'sys-input-expense-generic',
    name: '通用费用（兜底）',
    priority: 900,
    trigger: 'INVOICE_INPUT',
    conditions: { op: 'AND', children: [isInput(), notRed()] },
    template: {
      summary: '费用支出（{{ partner.name }}）',
      attachments: 1,
      lines: [
        { side: 'DEBIT', account: '660202', amount: '{{ costAmount }}', summary: '{{ invoice.itemSummary || "办公费" }}' },
        {
          side: 'DEBIT',
          account: '{{ tax.account }}',
          amount: '{{ invoice.taxAmount }}',
          summary: '进项税额',
          when: '{{ tax.hasLine }}',
        },
        {
          side: 'CREDIT',
          account: '2202',
          amount: '{{ invoice.amountInclTax }}',
          summary: '应付 {{ partner.name }}',
          partnerId: '{{ partner.id }}',
        },
      ],
    },
    confidence: '0.6000',
    autoPost: false,
    remark:
      '兜底规则：所有具体规则都没命中时使用。置信度仅 0.60，必然进人工队列，' +
      '并由系统提示"是否创建专属规则"。宁可让人确认，也不猜科目。',
  },
];

/** 内置风险规则（见 design/07 第 5.2 节） */
export interface BuiltinRiskRule {
  code: string;
  name: string;
  category: 'TAX' | 'ACCOUNTING' | 'FRAUD' | 'COMPLIANCE' | 'AI';
  level: 'INFO' | 'WARNING' | 'CRITICAL';
  engine: 'SQL' | 'AI' | 'SQL+AI';
  definition: Record<string, unknown>;
}

export const BUILTIN_RISK_RULES: BuiltinRiskRule[] = [
  {
    code: 'TAX_VAT_BALANCE_MISMATCH',
    name: '未交增值税与申报表不符',
    category: 'TAX',
    level: 'CRITICAL',
    engine: 'SQL',
    definition: {
      accountCode: '222102',
      compareWith: 'VAT_MAIN_LINE_32',
      tolerance: 0.01,
      messageTemplate: '账上未交增值税余额 {ledger}，申报表期末未缴 {filing}，差异 {diff} 元',
      suggestionTemplate: '检查月结 S3「转出未交增值税」凭证是否生成，或申报表是否填错',
    },
  },
  {
    code: 'ACC_BALANCE_INVARIANT',
    name: '账务不变式校验未通过',
    category: 'ACCOUNTING',
    level: 'CRITICAL',
    engine: 'SQL',
    definition: {
      invariants: ['I2', 'I3', 'I4'],
      messageTemplate: '不变式 {invariant} 未通过：{detail}',
      suggestionTemplate: '点击「账务自检 → 重算余额」，系统会按凭证重算余额表',
    },
  },
  {
    code: 'TAX_INPUT_NO_OUTPUT',
    name: '有进项无销项',
    category: 'TAX',
    level: 'WARNING',
    engine: 'SQL',
    definition: {
      consecutiveMonths: 3,
      messageTemplate: '连续 {months} 个月进项税额大于 0 而销项税额为 0',
      suggestionTemplate: '确认是否存在未开票收入，或进项票是否属于本主体',
    },
  },
  {
    code: 'ACC_CASH_NEGATIVE',
    name: '库存现金或银行存款出现贷方余额',
    category: 'ACCOUNTING',
    level: 'WARNING',
    engine: 'SQL',
    definition: {
      accountCodes: ['1001', '1002'],
      messageTemplate: '科目 {accountName} 出现贷方余额 {amount}',
      suggestionTemplate: '多为漏记收入或错记支出，请核对银行流水',
    },
  },
  {
    code: 'ACC_GROSS_MARGIN_NEGATIVE',
    name: '毛利率为负',
    category: 'ACCOUNTING',
    level: 'WARNING',
    engine: 'SQL',
    definition: {
      messageTemplate: '本期营业收入 {revenue}，营业成本 {cost}，毛利率 {margin}',
      suggestionTemplate: '检查营业成本是否与收入期间匹配，或成本结转是否重复',
    },
  },
  {
    code: 'TAX_DEDUCT_INELIGIBLE',
    name: '疑似不得抵扣项目已抵扣',
    category: 'TAX',
    level: 'WARNING',
    engine: 'SQL+AI',
    definition: {
      keywords: ['餐饮', '娱乐', '福利', '礼品', '贷款利息'],
      messageTemplate: '发票「{itemName}」税额 {taxAmount} 已计入进项税额，但通常不得抵扣',
      suggestionTemplate: '确认用途；若属集体福利或个人消费，需做进项税额转出',
    },
  },
  {
    code: 'CMP_INVOICE_DIRECTION',
    name: '进项票购买方非本主体',
    category: 'COMPLIANCE',
    level: 'CRITICAL',
    engine: 'SQL',
    definition: {
      messageTemplate: '发票 {invoiceNo} 购买方「{buyerName}」与本主体「{entityName}」不一致',
      suggestionTemplate: '可能是识别或录入方向错误，请核对原始票面后修正',
    },
  },
  {
    code: 'ACC_DUPLICATE_SUMMARY',
    name: '疑似重复入账',
    category: 'ACCOUNTING',
    level: 'WARNING',
    engine: 'SQL',
    definition: {
      threshold: 3,
      messageTemplate: '本期存在 {count} 张金额 {amount} 且摘要相同的凭证：{voucherNos}',
      suggestionTemplate: '确认为重复入账后红冲多余凭证',
    },
  },
  {
    code: 'FRD_SAME_AMOUNT_BURST',
    name: '同一供应商短期内大量同额发票',
    category: 'FRAUD',
    level: 'WARNING',
    engine: 'SQL',
    definition: {
      windowDays: 30,
      minCount: 5,
      tolerancePct: 1,
      messageTemplate: '供应商 {partnerName} 在 {days} 天内开具 {count} 张金额相近的发票',
      suggestionTemplate: '核实业务真实性，保留合同与验收单据',
    },
  },
  {
    code: 'CMP_CONTRACT_OVER_INVOICE',
    name: '累计开票额超过合同额',
    category: 'COMPLIANCE',
    level: 'WARNING',
    engine: 'SQL',
    definition: {
      ratio: 1.1,
      messageTemplate: '合同「{contractName}」金额 {contractAmount}，累计开票 {invoicedAmount}（{ratio}）',
      suggestionTemplate: '确认是否已签订补充协议，或存在超合同开票',
    },
  },
  {
    code: 'TAX_UNCERTIFIED_AGING',
    name: '未认证进项税额挂账过久',
    category: 'TAX',
    level: 'WARNING',
    engine: 'SQL',
    definition: {
      accountCode: '22210102',
      agingDays: 180,
      messageTemplate: '待认证进项税额余额 {amount}，最早挂账已 {days} 天',
      suggestionTemplate: '尽快勾选认证；逾期将无法抵扣',
    },
  },
  {
    code: 'AI_PROVIDER_DOWN',
    name: 'AI 识图服务连续失败',
    category: 'AI',
    level: 'CRITICAL',
    engine: 'SQL',
    definition: {
      consecutiveFailures: 5,
      messageTemplate: 'AI Provider 连续失败 {count} 次，已熔断',
      suggestionTemplate: '检查 API Key 与额度；期间请使用手工录入',
    },
  },
];
