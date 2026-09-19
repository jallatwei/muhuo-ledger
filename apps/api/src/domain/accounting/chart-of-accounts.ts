/**
 * 内置会计科目表（小企业会计准则）
 * ============================================================
 * ⚠️ 本文件是 design/09-数据字典-科目表.md 的可执行版本，两者必须一致。
 *
 * 编码体系说明（详见 design/09 第 5 节）：
 *   准则原文中「5001」同时用于「生产成本」与「主营业务收入」，编码冲突。
 *   本系统把损益类统一扩展为 6xxx（与企业会计准则编码习惯一致，用户更熟悉），
 *   导出报表与申报表时按 reportItem 映射，不受编码影响。
 *
 * 字段说明：
 *   code        科目编码
 *   name        科目名称
 *   parent      上级科目编码（一级科目为空）
 *   category    ASSET | LIABILITY | EQUITY | COST | PROFIT_LOSS
 *   direction   DEBIT 借方余额 | CREDIT 贷方余额
 *   reportItem  报表行项目标识（design/09 第 8 节）
 *   taxTag      增值税归集标记（design/09 第 6 节）
 *   cashflow    现金流量表归类
 *   aux         必须录入的辅助核算维度
 */

export type AccountCategory = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'COST' | 'PROFIT_LOSS';
export type BalanceDirection = 'DEBIT' | 'CREDIT';
export type AuxDimension = 'CUSTOMER' | 'SUPPLIER' | 'EMPLOYEE' | 'PROJECT' | 'DEPARTMENT' | 'CONTRACT';

export interface BuiltinAccount {
  code: string;
  name: string;
  parent?: string;
  category: AccountCategory;
  direction: BalanceDirection;
  reportItem?: string;
  taxTag?: string;
  cashflow?: string;
  aux?: AuxDimension[];
}

// 报表行项目（与 shared/accounts.ts 的 REPORT_ITEM 一致）
const BS = {
  MONETARY_FUNDS: 'BS_MONETARY_FUNDS',
  SHORT_INVEST: 'BS_SHORT_INVEST',
  NOTE_RECEIVABLE: 'BS_NOTE_RECEIVABLE',
  ACCT_RECEIVABLE: 'BS_ACCT_RECEIVABLE',
  PREPAYMENT: 'BS_PREPAYMENT',
  DIVIDEND_RECEIVABLE: 'BS_DIVIDEND_RECEIVABLE',
  INTEREST_RECEIVABLE: 'BS_INTEREST_RECEIVABLE',
  OTHER_RECEIVABLE: 'BS_OTHER_RECEIVABLE',
  INVENTORY: 'BS_INVENTORY',
  LT_BOND_INVEST: 'BS_LT_BOND_INVEST',
  LT_EQUITY_INVEST: 'BS_LT_EQUITY_INVEST',
  FIXED_ASSET: 'BS_FIXED_ASSET',
  // ★ 备抵科目必须与主科目分开标记，否则会被直接相加
  FIXED_ASSET_DEPRECIATION: 'BS_FIXED_ASSET_DEPRECIATION',
  CONSTRUCTION: 'BS_CONSTRUCTION',
  CONSTRUCTION_MATERIAL: 'BS_CONSTRUCTION_MATERIAL',
  FIXED_DISPOSAL: 'BS_FIXED_DISPOSAL',
  BIO_ASSET: 'BS_BIO_ASSET',
  BIO_ASSET_DEPRECIATION: 'BS_BIO_ASSET_DEPRECIATION',
  INTANGIBLE: 'BS_INTANGIBLE',
  INTANGIBLE_AMORTIZATION: 'BS_INTANGIBLE_AMORTIZATION',
  LT_DEFERRED: 'BS_LT_DEFERRED',
  SHORT_LOAN: 'BS_SHORT_LOAN',
  NOTE_PAYABLE: 'BS_NOTE_PAYABLE',
  ACCT_PAYABLE: 'BS_ACCT_PAYABLE',
  ADVANCE_RECEIPT: 'BS_ADVANCE_RECEIPT',
  PAYROLL_PAYABLE: 'BS_PAYROLL_PAYABLE',
  TAX_PAYABLE: 'BS_TAX_PAYABLE',
  INTEREST_PAYABLE: 'BS_INTEREST_PAYABLE',
  DIVIDEND_PAYABLE: 'BS_DIVIDEND_PAYABLE',
  OTHER_PAYABLE: 'BS_OTHER_PAYABLE',
  DEFERRED_INCOME: 'BS_DEFERRED_INCOME',
  LONG_LOAN: 'BS_LONG_LOAN',
  LT_PAYABLE: 'BS_LT_PAYABLE',
  PAID_IN_CAPITAL: 'BS_PAID_IN_CAPITAL',
  CAPITAL_RESERVE: 'BS_CAPITAL_RESERVE',
  SURPLUS_RESERVE: 'BS_SURPLUS_RESERVE',
  RETAINED_EARNINGS: 'BS_RETAINED_EARNINGS',
} as const;

const IS = {
  REVENUE: 'IS_REVENUE',
  COST: 'IS_COST',
  TAX_SURCHARGE: 'IS_TAX_SURCHARGE',
  SELLING_EXPENSE: 'IS_SELLING_EXPENSE',
  ADMIN_EXPENSE: 'IS_ADMIN_EXPENSE',
  FINANCE_EXPENSE: 'IS_FINANCE_EXPENSE',
  INVEST_INCOME: 'IS_INVEST_INCOME',
  NON_OP_INCOME: 'IS_NON_OP_INCOME',
  NON_OP_EXPENSE: 'IS_NON_OP_EXPENSE',
  INCOME_TAX: 'IS_INCOME_TAX',
} as const;

// 现金流量表归类
const CF = {
  OPER_IN: 'CF_OPER_IN',
  OPER_OUT: 'CF_OPER_OUT',
  INVEST_IN: 'CF_INVEST_IN',
  INVEST_OUT: 'CF_INVEST_OUT',
  FINANCE_IN: 'CF_FINANCE_IN',
  FINANCE_OUT: 'CF_FINANCE_OUT',
} as const;

export const BUILTIN_ACCOUNTS: BuiltinAccount[] = [
  // ============================================================ 资产类 1xxx
  { code: '1001', name: '库存现金', category: 'ASSET', direction: 'DEBIT', reportItem: BS.MONETARY_FUNDS, cashflow: CF.OPER_IN },
  { code: '1002', name: '银行存款', category: 'ASSET', direction: 'DEBIT', reportItem: BS.MONETARY_FUNDS, cashflow: CF.OPER_IN },
  { code: '1012', name: '其他货币资金', category: 'ASSET', direction: 'DEBIT', reportItem: BS.MONETARY_FUNDS },

  { code: '1101', name: '短期投资', category: 'ASSET', direction: 'DEBIT', reportItem: BS.SHORT_INVEST },
  { code: '1111', name: '应收股利', category: 'ASSET', direction: 'DEBIT', reportItem: BS.DIVIDEND_RECEIVABLE, aux: ['CUSTOMER'] },
  { code: '1121', name: '应收票据', category: 'ASSET', direction: 'DEBIT', reportItem: BS.NOTE_RECEIVABLE, aux: ['CUSTOMER'] },
  { code: '1122', name: '应收账款', category: 'ASSET', direction: 'DEBIT', reportItem: BS.ACCT_RECEIVABLE, aux: ['CUSTOMER'] },
  { code: '1123', name: '预付账款', category: 'ASSET', direction: 'DEBIT', reportItem: BS.PREPAYMENT, aux: ['SUPPLIER'] },
  { code: '1131', name: '应收股利', category: 'ASSET', direction: 'DEBIT', reportItem: BS.DIVIDEND_RECEIVABLE, aux: ['CUSTOMER'] },
  { code: '1132', name: '应收利息', category: 'ASSET', direction: 'DEBIT', reportItem: BS.INTEREST_RECEIVABLE, aux: ['CUSTOMER'] },
  { code: '1221', name: '其他应收款', category: 'ASSET', direction: 'DEBIT', reportItem: BS.OTHER_RECEIVABLE, aux: ['CUSTOMER', 'EMPLOYEE'] },

  // ---- 存货 ----
  { code: '1401', name: '材料采购', category: 'ASSET', direction: 'DEBIT', reportItem: BS.INVENTORY, aux: ['SUPPLIER'] },
  { code: '1402', name: '在途物资', category: 'ASSET', direction: 'DEBIT', reportItem: BS.INVENTORY, aux: ['SUPPLIER'] },
  { code: '1403', name: '原材料', category: 'ASSET', direction: 'DEBIT', reportItem: BS.INVENTORY },
  { code: '1405', name: '库存商品', category: 'ASSET', direction: 'DEBIT', reportItem: BS.INVENTORY },
  { code: '1407', name: '周转材料', category: 'ASSET', direction: 'DEBIT', reportItem: BS.INVENTORY },
  { code: '1408', name: '委托加工物资', category: 'ASSET', direction: 'DEBIT', reportItem: BS.INVENTORY, aux: ['SUPPLIER'] },
  { code: '1411', name: '消耗性生物资产', category: 'ASSET', direction: 'DEBIT', reportItem: BS.INVENTORY },

  { code: '1501', name: '长期债券投资', category: 'ASSET', direction: 'DEBIT', reportItem: BS.LT_BOND_INVEST },
  { code: '1511', name: '长期股权投资', category: 'ASSET', direction: 'DEBIT', reportItem: BS.LT_EQUITY_INVEST, aux: ['CUSTOMER'] },

  { code: '1601', name: '固定资产', category: 'ASSET', direction: 'DEBIT', reportItem: BS.FIXED_ASSET },
  { code: '1602', name: '累计折旧', category: 'ASSET', direction: 'CREDIT', reportItem: BS.FIXED_ASSET_DEPRECIATION },
  { code: '1604', name: '在建工程', category: 'ASSET', direction: 'DEBIT', reportItem: BS.CONSTRUCTION, aux: ['SUPPLIER'] },
  { code: '1605', name: '工程物资', category: 'ASSET', direction: 'DEBIT', reportItem: BS.CONSTRUCTION_MATERIAL, aux: ['SUPPLIER'] },
  { code: '1606', name: '固定资产清理', category: 'ASSET', direction: 'DEBIT', reportItem: BS.FIXED_DISPOSAL },
  { code: '1621', name: '生产性生物资产', category: 'ASSET', direction: 'DEBIT', reportItem: BS.BIO_ASSET },
  { code: '1622', name: '生产性生物资产累计折旧', category: 'ASSET', direction: 'CREDIT', reportItem: BS.BIO_ASSET_DEPRECIATION },

  { code: '1701', name: '无形资产', category: 'ASSET', direction: 'DEBIT', reportItem: BS.INTANGIBLE },
  { code: '1702', name: '累计摊销', category: 'ASSET', direction: 'CREDIT', reportItem: BS.INTANGIBLE_AMORTIZATION },
  { code: '1801', name: '长期待摊费用', category: 'ASSET', direction: 'DEBIT', reportItem: BS.LT_DEFERRED },
  { code: '1901', name: '待处理财产损溢', category: 'ASSET', direction: 'DEBIT', reportItem: BS.OTHER_RECEIVABLE },

  // ============================================================ 负债类 2xxx
  { code: '2001', name: '短期借款', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.SHORT_LOAN, cashflow: CF.FINANCE_IN },
  { code: '2201', name: '应付票据', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.NOTE_PAYABLE, aux: ['SUPPLIER'] },
  { code: '2202', name: '应付账款', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.ACCT_PAYABLE, aux: ['SUPPLIER'] },
  { code: '2203', name: '预收账款', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.ADVANCE_RECEIPT, aux: ['CUSTOMER'] },
  { code: '2211', name: '应付职工薪酬', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.PAYROLL_PAYABLE, aux: ['EMPLOYEE'] },

  // ---- 应交税费（增值税自动化的核心，编码不可变动）----
  { code: '2221', name: '应交税费', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE },
  { code: '222101', name: '应交增值税', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, taxTag: 'VAT_PAYABLE' },
  { code: '22210101', name: '进项税额', parent: '222101', category: 'LIABILITY', direction: 'DEBIT', reportItem: BS.TAX_PAYABLE, taxTag: 'INPUT_TAX_CERTIFIED' },
  { code: '22210102', name: '待认证进项税额', parent: '222101', category: 'LIABILITY', direction: 'DEBIT', reportItem: BS.TAX_PAYABLE, taxTag: 'INPUT_TAX_PENDING' },
  { code: '22210103', name: '待抵扣进项税额', parent: '222101', category: 'LIABILITY', direction: 'DEBIT', reportItem: BS.TAX_PAYABLE, taxTag: 'INPUT_TAX_DEFERRED' },
  { code: '22210104', name: '已交税金', parent: '222101', category: 'LIABILITY', direction: 'DEBIT', reportItem: BS.TAX_PAYABLE, taxTag: 'VAT_PAID' },
  { code: '22210105', name: '销项税额', parent: '222101', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, taxTag: 'OUTPUT_TAX' },
  { code: '22210106', name: '进项税额转出', parent: '222101', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, taxTag: 'INPUT_TAX_TRANSFER_OUT' },
  { code: '22210107', name: '转出多交增值税', parent: '222101', category: 'LIABILITY', direction: 'DEBIT', reportItem: BS.TAX_PAYABLE, taxTag: 'VAT_TRANSFER_OUT_MULTI_PAID' },
  { code: '22210108', name: '出口退税', parent: '222101', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE },
  { code: '22210109', name: '待转销项税额', parent: '222101', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, taxTag: 'OUTPUT_TAX_DEFERRED' },
  { code: '22210110', name: '简易计税', parent: '222101', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, taxTag: 'OUTPUT_TAX_SIMPLE' },
  { code: '22210111', name: '预交增值税', parent: '222101', category: 'LIABILITY', direction: 'DEBIT', reportItem: BS.TAX_PAYABLE },
  { code: '22210112', name: '增值税检查调整', parent: '222101', category: 'LIABILITY', direction: 'DEBIT', reportItem: BS.TAX_PAYABLE },
  { code: '22210113', name: '转出未交增值税', parent: '222101', category: 'LIABILITY', direction: 'DEBIT', reportItem: BS.TAX_PAYABLE, taxTag: 'VAT_TRANSFER_OUT_UNPAID' },
  { code: '222102', name: '未交增值税', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, taxTag: 'VAT_UNPAID', cashflow: CF.OPER_OUT },
  { code: '222103', name: '应交企业所得税', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },
  { code: '222104', name: '应交个人所得税', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },
  { code: '222105', name: '应交城市维护建设税', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },
  { code: '222106', name: '应交教育费附加', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },
  { code: '222107', name: '应交地方教育附加', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },
  { code: '222108', name: '应交房产税', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },
  { code: '222109', name: '应交土地使用税', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },
  { code: '222110', name: '应交印花税', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },
  { code: '222111', name: '应交车船税', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },
  { code: '222112', name: '应交文化事业建设费', parent: '2221', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.TAX_PAYABLE, cashflow: CF.OPER_OUT },

  { code: '2231', name: '应付利息', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.INTEREST_PAYABLE },
  { code: '2232', name: '应付利润', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.DIVIDEND_PAYABLE },
  { code: '2241', name: '其他应付款', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.OTHER_PAYABLE, aux: ['SUPPLIER', 'EMPLOYEE'] },
  { code: '2401', name: '递延收益', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.DEFERRED_INCOME },
  { code: '2501', name: '长期借款', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.LONG_LOAN, cashflow: CF.FINANCE_IN },
  { code: '2701', name: '长期应付款', category: 'LIABILITY', direction: 'CREDIT', reportItem: BS.LT_PAYABLE },

  // ============================================================ 所有者权益 3xxx
  { code: '3001', name: '实收资本', category: 'EQUITY', direction: 'CREDIT', reportItem: BS.PAID_IN_CAPITAL, cashflow: CF.FINANCE_IN },
  { code: '3002', name: '资本公积', category: 'EQUITY', direction: 'CREDIT', reportItem: BS.CAPITAL_RESERVE },
  { code: '3101', name: '盈余公积', category: 'EQUITY', direction: 'CREDIT', reportItem: BS.SURPLUS_RESERVE },
  { code: '3103', name: '本年利润', category: 'EQUITY', direction: 'CREDIT', reportItem: BS.RETAINED_EARNINGS },
  { code: '3104', name: '利润分配', category: 'EQUITY', direction: 'CREDIT', reportItem: BS.RETAINED_EARNINGS },
  { code: '310401', name: '未分配利润', parent: '3104', category: 'EQUITY', direction: 'CREDIT', reportItem: BS.RETAINED_EARNINGS },
  { code: '310402', name: '提取法定盈余公积', parent: '3104', category: 'EQUITY', direction: 'DEBIT', reportItem: BS.RETAINED_EARNINGS },
  { code: '310403', name: '提取任意盈余公积', parent: '3104', category: 'EQUITY', direction: 'DEBIT', reportItem: BS.RETAINED_EARNINGS },
  { code: '310404', name: '应付利润', parent: '3104', category: 'EQUITY', direction: 'DEBIT', reportItem: BS.RETAINED_EARNINGS },

  // ============================================================ 成本类 5xxx
  { code: '5001', name: '生产成本', category: 'COST', direction: 'DEBIT', reportItem: BS.INVENTORY },
  { code: '500101', name: '基本生产成本', parent: '5001', category: 'COST', direction: 'DEBIT', reportItem: BS.INVENTORY },
  { code: '500102', name: '辅助生产成本', parent: '5001', category: 'COST', direction: 'DEBIT', reportItem: BS.INVENTORY },
  { code: '5101', name: '制造费用', category: 'COST', direction: 'DEBIT', reportItem: BS.INVENTORY },
  { code: '5201', name: '劳务成本', category: 'COST', direction: 'DEBIT', reportItem: BS.INVENTORY },

  // ============================================================ 损益类 6xxx
  { code: '6001', name: '主营业务收入', category: 'PROFIT_LOSS', direction: 'CREDIT', reportItem: IS.REVENUE, cashflow: CF.OPER_IN },
  { code: '6051', name: '其他业务收入', category: 'PROFIT_LOSS', direction: 'CREDIT', reportItem: IS.REVENUE, cashflow: CF.OPER_IN },
  { code: '6111', name: '投资收益', category: 'PROFIT_LOSS', direction: 'CREDIT', reportItem: IS.INVEST_INCOME, cashflow: CF.INVEST_IN },
  { code: '6301', name: '营业外收入', category: 'PROFIT_LOSS', direction: 'CREDIT', reportItem: IS.NON_OP_INCOME },
  { code: '6401', name: '主营业务成本', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.COST, cashflow: CF.OPER_OUT },
  { code: '6402', name: '其他业务成本', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.COST, cashflow: CF.OPER_OUT },
  { code: '6403', name: '税金及附加', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.TAX_SURCHARGE, cashflow: CF.OPER_OUT },
  { code: '6711', name: '营业外支出', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.NON_OP_EXPENSE },
  { code: '6801', name: '所得税费用', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.INCOME_TAX },

  // ---- 销售费用 6601 ----
  { code: '6601', name: '销售费用', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.SELLING_EXPENSE, cashflow: CF.OPER_OUT },
  { code: '660101', name: '工资', parent: '6601', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.SELLING_EXPENSE },
  { code: '660102', name: '差旅费', parent: '6601', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.SELLING_EXPENSE },
  { code: '660103', name: '业务招待费', parent: '6601', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.SELLING_EXPENSE },
  { code: '660104', name: '广告宣传费', parent: '6601', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.SELLING_EXPENSE },
  { code: '660105', name: '运输费', parent: '6601', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.SELLING_EXPENSE },
  { code: '660106', name: '折旧费', parent: '6601', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.SELLING_EXPENSE },
  { code: '660107', name: '办公费', parent: '6601', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.SELLING_EXPENSE },

  // ---- 管理费用 6602 ----
  { code: '6602', name: '管理费用', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE, cashflow: CF.OPER_OUT },
  { code: '660201', name: '工资', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660202', name: '办公费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660203', name: '差旅费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660204', name: '业务招待费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660205', name: '通讯费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660206', name: '房租', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660207', name: '水电费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660208', name: '物业费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660209', name: '折旧费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660210', name: '摊销费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660211', name: '咨询服务费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660212', name: '会议费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660213', name: '快递费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660214', name: '车辆使用费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660215', name: '职工福利费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660216', name: '社保费', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660217', name: '住房公积金', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },
  { code: '660218', name: '印花税', parent: '6602', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.ADMIN_EXPENSE },

  // ---- 财务费用 6603 ----
  { code: '6603', name: '财务费用', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.FINANCE_EXPENSE, cashflow: CF.OPER_OUT },
  { code: '660301', name: '利息支出', parent: '6603', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.FINANCE_EXPENSE, cashflow: CF.FINANCE_OUT },
  { code: '660302', name: '利息收入', parent: '6603', category: 'PROFIT_LOSS', direction: 'CREDIT', reportItem: IS.FINANCE_EXPENSE },
  { code: '660303', name: '手续费', parent: '6603', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.FINANCE_EXPENSE },
  { code: '660304', name: '汇兑损益', parent: '6603', category: 'PROFIT_LOSS', direction: 'DEBIT', reportItem: IS.FINANCE_EXPENSE },
];

/** 需要计提折旧/摊销的科目（用于月结检查项 7） */
export const DEPRECIATION_ACCOUNTS = ['1602', '1622', '1702'];

/** 损益类科目编码集合（结转损益用） */
export const PROFIT_LOSS_CODES = BUILTIN_ACCOUNTS.filter((a) => a.category === 'PROFIT_LOSS').map((a) => a.code);

/** 末级科目编码集合（只有这些允许记账） */
export const LEAF_CODES = new Set(
  BUILTIN_ACCOUNTS.filter((a) => !BUILTIN_ACCOUNTS.some((b) => b.parent === a.code)).map((a) => a.code),
);
