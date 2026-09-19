/**
 * 科目编码常量（小企业会计准则）
 * ============================================================
 * ⚠️ 这是全系统科目编码的**唯一权威来源**，与 design/09-数据字典-科目表.md 一一对应。
 *    规则模板、报表映射、测试用例一律引用本文件，禁止在业务代码里写裸字符串编码。
 *
 * 关于 6xxx 扩展编码的说明：
 *   准则原文中「5001」同时被用于「生产成本」和「主营业务收入」，编码冲突。
 *   本系统把损益类统一扩展为 6xxx（与企业会计准则习惯一致，用户更熟悉），
 *   详见 design/09 第 5 节。
 */

// ---------------------------------------------------------------- 资产类
export const ASSET = {
  CASH: '1001', // 库存现金
  BANK: '1002', // 银行存款
  OTHER_MONETARY: '1012', // 其他货币资金
  SHORT_INVEST: '1101', // 短期投资
  NOTE_RECEIVABLE: '1121', // 应收票据
  ACCT_RECEIVABLE: '1122', // 应收账款
  PREPAYMENT: '1123', // 预付账款
  DIVIDEND_RECEIVABLE: '1131', // 应收股利
  INTEREST_RECEIVABLE: '1132', // 应收利息
  OTHER_RECEIVABLE: '1221', // 其他应收款
  MATERIAL_PURCHASE: '1401', // 材料采购
  MATERIAL_IN_TRANSIT: '1402', // 在途物资
  RAW_MATERIAL: '1403', // 原材料
  FINISHED_GOODS: '1405', // 库存商品
  TURNOVER_MATERIAL: '1407', // 周转材料
  CONSIGNED_PROCESSING: '1408', // 委托加工物资
  CONSUMABLE_BIO: '1411', // 消耗性生物资产
  LT_BOND_INVEST: '1501', // 长期债券投资
  LT_EQUITY_INVEST: '1511', // 长期股权投资
  FIXED_ASSET: '1601', // 固定资产
  ACCUM_DEPRECIATION: '1602', // 累计折旧
  CONSTRUCTION_IN_PROGRESS: '1604', // 在建工程
  CONSTRUCTION_MATERIAL: '1605', // 工程物资
  FIXED_ASSET_DISPOSAL: '1606', // 固定资产清理
  PRODUCTIVE_BIO: '1621', // 生产性生物资产
  PRODUCTIVE_BIO_DEPR: '1622', // 生产性生物资产累计折旧
  INTANGIBLE: '1701', // 无形资产
  ACCUM_AMORTIZATION: '1702', // 累计摊销
  LT_DEFERRED_EXPENSE: '1801', // 长期待摊费用
  PENDING_PROPERTY_LOSS: '1901', // 待处理财产损溢
} as const;

// ---------------------------------------------------------------- 负债类
export const LIABILITY = {
  SHORT_LOAN: '2001', // 短期借款
  NOTE_PAYABLE: '2201', // 应付票据
  ACCT_PAYABLE: '2202', // 应付账款
  ADVANCE_RECEIPT: '2203', // 预收账款
  PAYROLL_PAYABLE: '2211', // 应付职工薪酬
  TAX_PAYABLE: '2221', // 应交税费
  INTEREST_PAYABLE: '2231', // 应付利息
  DIVIDEND_PAYABLE: '2232', // 应付利润
  OTHER_PAYABLE: '2241', // 其他应付款
  DEFERRED_INCOME: '2401', // 递延收益
  LONG_LOAN: '2501', // 长期借款
  LT_PAYABLE: '2701', // 长期应付款
} as const;

// ---------------------------------------------------------------- 所有者权益类
export const EQUITY = {
  PAID_IN_CAPITAL: '3001', // 实收资本
  CAPITAL_RESERVE: '3002', // 资本公积
  SURPLUS_RESERVE: '3101', // 盈余公积
  CURRENT_YEAR_PROFIT: '3103', // 本年利润
  PROFIT_DISTRIBUTION: '3104', // 利润分配
  UNDISTRIBUTED_PROFIT: '310401', // 利润分配—未分配利润
  APPROPRIATE_LEGAL: '310402', // 利润分配—提取法定盈余公积
  APPROPRIATE_DISCRETIONARY: '310403', // 利润分配—提取任意盈余公积
  APPROPRIATE_DIVIDEND: '310404', // 利润分配—应付利润
} as const;

// ---------------------------------------------------------------- 成本类
export const COST = {
  PRODUCTION: '5001', // 生产成本
  PRODUCTION_BASIC: '500101',
  PRODUCTION_AUX: '500102',
  MANUFACTURING_OVERHEAD: '5101', // 制造费用
  SERVICE_COST: '5201', // 劳务成本
} as const;

// ---------------------------------------------------------------- 损益类
export const PROFIT_LOSS = {
  MAIN_REVENUE: '6001', // 主营业务收入
  OTHER_REVENUE: '6051', // 其他业务收入
  INVEST_INCOME: '6111', // 投资收益
  NON_OP_INCOME: '6301', // 营业外收入
  MAIN_COST: '6401', // 主营业务成本
  OTHER_COST: '6402', // 其他业务成本
  TAX_SURCHARGE: '6403', // 税金及附加
  SELLING_EXPENSE: '6601', // 销售费用
  ADMIN_EXPENSE: '6602', // 管理费用
  FINANCE_EXPENSE: '6603', // 财务费用
  NON_OP_EXPENSE: '6711', // 营业外支出
  INCOME_TAX: '6801', // 所得税费用
} as const;

// ---------------------------------------------------------------- 销售费用明细
export const SELLING_EXPENSE = {
  SALARY: '660101', // 工资
  TRAVEL: '660102', // 差旅费
  ENTERTAINMENT: '660103', // 业务招待费 ★ 不可抵扣
  ADVERTISING: '660104', // 广告宣传费
  TRANSPORT: '660105', // 运输费
  DEPRECIATION: '660106', // 折旧费
  OFFICE: '660107', // 办公费
} as const;

// ---------------------------------------------------------------- 管理费用明细
export const ADMIN_EXPENSE = {
  SALARY: '660201', // 工资
  OFFICE: '660202', // 办公费 ★ 最高频
  TRAVEL: '660203', // 差旅费
  ENTERTAINMENT: '660204', // 业务招待费 ★ 不可抵扣
  COMMUNICATION: '660205', // 通讯费
  RENT: '660206', // 房租
  UTILITIES: '660207', // 水电费
  PROPERTY: '660208', // 物业费
  DEPRECIATION: '660209', // 折旧费
  AMORTIZATION: '660210', // 摊销费
  CONSULTING: '660211', // 咨询服务费
  MEETING: '660212', // 会议费
  EXPRESS: '660213', // 快递费
  VEHICLE: '660214', // 车辆使用费
  WELFARE: '660215', // 职工福利费 ★ 不可抵扣
  SOCIAL_INSURANCE: '660216', // 社保费（单位承担）
  HOUSING_FUND: '660217', // 住房公积金
  STAMP_DUTY: '660218', // 印花税
} as const;

// ---------------------------------------------------------------- 财务费用明细
export const FINANCE_EXPENSE = {
  INTEREST_EXPENSE: '660301', // 利息支出
  INTEREST_INCOME: '660302', // 利息收入 ★ 贷方，冲减
  BANK_CHARGE: '660303', // 手续费 ★ 银行手续费
  EXCHANGE_DIFF: '660304', // 汇兑损益（第一版不使用）
} as const;

// ---------------------------------------------------------------- 应交税费明细 ★
/**
 * 增值税自动化的核心。每个明细都对应 `Account.taxTag`，
 * 申报表行次映射见 design/06-税务与报表.md。
 */
export const TAX = {
  PAYABLE: '2221', // 应交税费

  // --- 应交增值税（二级归集科目）---
  VAT: '222101',

  // --- 应交增值税三级明细 ---
  INPUT_TAX: '22210101', // 进项税额            → 附列资料二 第2行
  INPUT_TAX_PENDING: '22210102', // 待认证进项税额      → 附列资料二 第26行
  INPUT_TAX_DEFERRED: '22210103', // 待抵扣进项税额      → 附列资料二 第27行
  VAT_PAID: '22210104', // 已交税金            → 主表 第27行
  OUTPUT_TAX: '22210105', // 销项税额            → 附列资料一 第2列
  INPUT_TAX_TRANSFER_OUT: '22210106', // 进项税额转出        → 附列资料二 第13行
  MULTI_PAID_TRANSFER_OUT: '22210107', // 转出多交增值税
  EXPORT_REFUND: '22210108', // 出口退税
  OUTPUT_TAX_DEFERRED: '22210109', // 待转销项税额 ★ 收入已确认未开票
  SIMPLE_LEVY: '22210110', // 简易计税            → 附列资料一 第9~14行
  PREPAID_VAT: '22210111', // 预交增值税（异地预缴）
  VAT_INSPECTION_ADJ: '22210112', // 增值税检查调整
  UNPAID_TRANSFER_OUT: '22210113', // 转出未交增值税（月末结转）

  // --- 独立明细 ---
  UNPAID_VAT: '222102', // 未交增值税 ★ 主表 第32行 勾稽对象
  INCOME_TAX: '222103', // 应交企业所得税      → 预缴表 第16行
  INDIVIDUAL_INCOME_TAX: '222104', // 应交个人所得税（代扣代缴）
  CITY_MAINTENANCE_TAX: '222105', // 应交城市维护建设税
  EDUCATION_SURCHARGE: '222106', // 应交教育费附加
  LOCAL_EDUCATION_SURCHARGE: '222107', // 应交地方教育附加
  PROPERTY_TAX: '222108', // 应交房产税
  LAND_USE_TAX: '222109', // 应交土地使用税
  STAMP_DUTY: '222110', // 应交印花税
  VEHICLE_VESSEL_TAX: '222111', // 应交车船税
  CULTURAL_UNDERTAKING_FEE: '222112', // 应交文化事业建设费
} as const;

// ---------------------------------------------------------------- 税标记
/** 与 Account.taxTag 一一对应，用于增值税归集与申报表取数 */
export const TAX_TAG = {
  INPUT_TAX_CERTIFIED: 'INPUT_TAX_CERTIFIED',
  INPUT_TAX_PENDING: 'INPUT_TAX_PENDING',
  INPUT_TAX_DEFERRED: 'INPUT_TAX_DEFERRED',
  INPUT_TAX_TRANSFER_OUT: 'INPUT_TAX_TRANSFER_OUT',
  OUTPUT_TAX: 'OUTPUT_TAX',
  OUTPUT_TAX_SIMPLE: 'OUTPUT_TAX_SIMPLE',
  OUTPUT_TAX_DEFERRED: 'OUTPUT_TAX_DEFERRED',
  VAT_PAYABLE: 'VAT_PAYABLE',
  VAT_UNPAID: 'VAT_UNPAID',
  VAT_PAID: 'VAT_PAID',
  VAT_TRANSFER_OUT_UNPAID: 'VAT_TRANSFER_OUT_UNPAID',
  VAT_TRANSFER_OUT_MULTI_PAID: 'VAT_TRANSFER_OUT_MULTI_PAID',
  SURTAX_BASE: 'SURTAX_BASE',
} as const;

export type TaxTag = (typeof TAX_TAG)[keyof typeof TAX_TAG];

// ---------------------------------------------------------------- 报表行项目
export const REPORT_ITEM = {
  BS_MONETARY_FUNDS: 'BS_MONETARY_FUNDS',
  BS_SHORT_INVEST: 'BS_SHORT_INVEST',
  BS_NOTE_RECEIVABLE: 'BS_NOTE_RECEIVABLE',
  BS_ACCT_RECEIVABLE: 'BS_ACCT_RECEIVABLE',
  BS_PREPAYMENT: 'BS_PREPAYMENT',
  BS_DIVIDEND_RECEIVABLE: 'BS_DIVIDEND_RECEIVABLE',
  BS_INTEREST_RECEIVABLE: 'BS_INTEREST_RECEIVABLE',
  BS_OTHER_RECEIVABLE: 'BS_OTHER_RECEIVABLE',
  BS_INVENTORY: 'BS_INVENTORY',
  BS_LT_BOND_INVEST: 'BS_LT_BOND_INVEST',
  BS_LT_EQUITY_INVEST: 'BS_LT_EQUITY_INVEST',
  BS_FIXED_ASSET: 'BS_FIXED_ASSET',
  /// ★ 累计折旧必须与固定资产**分开**标记。
  ///   两者合并到一个 reportItem 会被直接相加，导致固定资产虚增一个折旧额。
  ///   备抵科目的方向与主科目相反，报表上是减项，不能混在一起归集。
  BS_FIXED_ASSET_DEPRECIATION: 'BS_FIXED_ASSET_DEPRECIATION',
  BS_CONSTRUCTION_MATERIAL: 'BS_CONSTRUCTION_MATERIAL',
  BS_BIO_ASSET_DEPRECIATION: 'BS_BIO_ASSET_DEPRECIATION',
  BS_INTANGIBLE_AMORTIZATION: 'BS_INTANGIBLE_AMORTIZATION',
  BS_CONSTRUCTION: 'BS_CONSTRUCTION',
  BS_FIXED_DISPOSAL: 'BS_FIXED_DISPOSAL',
  BS_BIO_ASSET: 'BS_BIO_ASSET',
  BS_INTANGIBLE: 'BS_INTANGIBLE',
  BS_LT_DEFERRED: 'BS_LT_DEFERRED',
  BS_SHORT_LOAN: 'BS_SHORT_LOAN',
  BS_NOTE_PAYABLE: 'BS_NOTE_PAYABLE',
  BS_ACCT_PAYABLE: 'BS_ACCT_PAYABLE',
  BS_ADVANCE_RECEIPT: 'BS_ADVANCE_RECEIPT',
  BS_PAYROLL_PAYABLE: 'BS_PAYROLL_PAYABLE',
  BS_TAX_PAYABLE: 'BS_TAX_PAYABLE',
  BS_INTEREST_PAYABLE: 'BS_INTEREST_PAYABLE',
  BS_DIVIDEND_PAYABLE: 'BS_DIVIDEND_PAYABLE',
  BS_OTHER_PAYABLE: 'BS_OTHER_PAYABLE',
  BS_DEFERRED_INCOME: 'BS_DEFERRED_INCOME',
  BS_LONG_LOAN: 'BS_LONG_LOAN',
  BS_LT_PAYABLE: 'BS_LT_PAYABLE',
  BS_PAID_IN_CAPITAL: 'BS_PAID_IN_CAPITAL',
  BS_CAPITAL_RESERVE: 'BS_CAPITAL_RESERVE',
  BS_SURPLUS_RESERVE: 'BS_SURPLUS_RESERVE',
  BS_RETAINED_EARNINGS: 'BS_RETAINED_EARNINGS',

  IS_REVENUE: 'IS_REVENUE',
  IS_COST: 'IS_COST',
  IS_TAX_SURCHARGE: 'IS_TAX_SURCHARGE',
  IS_SELLING_EXPENSE: 'IS_SELLING_EXPENSE',
  IS_ADMIN_EXPENSE: 'IS_ADMIN_EXPENSE',
  IS_FINANCE_EXPENSE: 'IS_FINANCE_EXPENSE',
  IS_INVEST_INCOME: 'IS_INVEST_INCOME',
  IS_NON_OP_INCOME: 'IS_NON_OP_INCOME',
  IS_NON_OP_EXPENSE: 'IS_NON_OP_EXPENSE',
  IS_INCOME_TAX: 'IS_INCOME_TAX',
} as const;

export type ReportItem = (typeof REPORT_ITEM)[keyof typeof REPORT_ITEM];

// ---------------------------------------------------------------- 汇总便于遍历
export const ALL_ACCOUNT_CODES = {
  ...ASSET,
  ...LIABILITY,
  ...EQUITY,
  ...COST,
  ...PROFIT_LOSS,
  ...SELLING_EXPENSE,
  ...ADMIN_EXPENSE,
  ...FINANCE_EXPENSE,
  ...TAX,
} as const;
