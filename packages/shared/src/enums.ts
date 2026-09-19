/**
 * 领域枚举与常量
 * ============================================================
 * 这些取值必须与 apps/api/prisma/schema.prisma 中的 enum 完全一致。
 * 修改时两边必须同步（有 CI 校验脚本，见 tools/check-enum-sync.ts）。
 */

// ---------------------------------------------------------------- 凭证
export const VOUCHER_STATUS = {
  DRAFT: 'DRAFT',
  REVIEWING: 'REVIEWING',
  APPROVED: 'APPROVED',
  POSTED: 'POSTED',
  REVERSED: 'REVERSED',
  VOID: 'VOID',
} as const;
export type VoucherStatus = (typeof VOUCHER_STATUS)[keyof typeof VOUCHER_STATUS];

/**
 * ★ 凭证状态机白名单。超出即抛错（见 design/03 章第 1 节）
 *
 * 两条「退回」路径必须都存在，否则流程只能前进不能后退 ——
 * 而审核与过账是两个人、两个时间点做的事，后一个人发现问题时必须能退回去：
 *
 *   REVIEWING → DRAFT      审核不通过，退回制单人改
 *   APPROVED  → REVIEWING  过账前发现问题，退回审核人复议
 *   APPROVED  → DRAFT      直接退回制单人（反审核）
 *
 * ⚠️ POSTED 没有任何退回路径：已过账的账只能红冲，不能改。
 *    这是「已结账的账改不动」这条红线的具体落点。
 */
export const VOUCHER_TRANSITIONS: Record<VoucherStatus, VoucherStatus[]> = {
  DRAFT: ['REVIEWING', 'VOID'],
  REVIEWING: ['APPROVED', 'DRAFT', 'VOID'],
  APPROVED: ['POSTED', 'REVIEWING', 'DRAFT'],
  POSTED: ['REVERSED'],
  REVERSED: [],
  VOID: [],
};

/** 状态中文名：日志、错误提示、界面共用一份，避免各处写法不一致 */
export const VOUCHER_STATUS_LABEL: Record<VoucherStatus, string> = {
  DRAFT: '草稿',
  REVIEWING: '待审核',
  APPROVED: '已审核',
  POSTED: '已过账',
  REVERSED: '已红冲',
  VOID: '已作废',
};

/** 只有这些状态的分录参与余额计算 */
export const POSTED_STATUSES: VoucherStatus[] = ['POSTED', 'REVERSED'];

/** 已过账后不可再修改的字段（仅 status / reversedById 可变） */
export const POSTED_IMMUTABLE = true;

export const VOUCHER_SOURCE = {
  MANUAL: 'MANUAL',
  INVOICE: 'INVOICE',
  BANK: 'BANK',
  PAYROLL: 'PAYROLL',
  CLOSING: 'CLOSING',
  OPENING: 'OPENING',
} as const;
export type VoucherSource = (typeof VOUCHER_SOURCE)[keyof typeof VOUCHER_SOURCE];

/** 年初余额凭证使用 voucherNo = 0，正常凭证从 1 开始 */
export const OPENING_VOUCHER_NO = 0;
export const OPENING_VOUCHER_WORD = '年初';
export const DEFAULT_VOUCHER_WORD = '记';

// ---------------------------------------------------------------- 期间
export const PERIOD_STATUS = {
  OPEN: 'OPEN',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
} as const;
export type PeriodStatus = (typeof PERIOD_STATUS)[keyof typeof PERIOD_STATUS];

/** 只有 OPEN 期间允许写入凭证 */
export function periodAllowsWrite(status: PeriodStatus): boolean {
  return status === 'OPEN';
}

// ---------------------------------------------------------------- 借贷方向
export const DIRECTION = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;
export type Direction = (typeof DIRECTION)[keyof typeof DIRECTION];

// ---------------------------------------------------------------- 发票
export const INVOICE_DIRECTION = {
  OUTPUT: 'OUTPUT', // 销项
  INPUT: 'INPUT', // 进项
} as const;
export type InvoiceDirection = (typeof INVOICE_DIRECTION)[keyof typeof INVOICE_DIRECTION];

export const INVOICE_CATEGORY = {
  SPECIAL_VAT: 'SPECIAL_VAT', // 增值税专用发票
  GENERAL_VAT: 'GENERAL_VAT', // 增值税普通发票
  E_INVOICE: 'E_INVOICE', // 全电发票（数电票）
  TRAIN: 'TRAIN', // 火车票
  AIR: 'AIR', // 航空运输电子客票行程单
  TOLL: 'TOLL', // 通行费发票
  OTHER: 'OTHER',
} as const;
export type InvoiceCategory = (typeof INVOICE_CATEGORY)[keyof typeof INVOICE_CATEGORY];

/** 可抵扣的发票种类（进项） */
export const DEDUCTIBLE_CATEGORIES: InvoiceCategory[] = ['SPECIAL_VAT', 'E_INVOICE', 'TRAIN', 'AIR', 'TOLL'];

export const INVOICE_STATUS = {
  IMPORTED: 'IMPORTED', // 已识别，待入账
  AUTO_DRAFTED: 'AUTO_DRAFTED', // 已自动生成待确认凭证
  POSTED: 'POSTED', // 已入账
  MATCHED: 'MATCHED', // 已匹配收付款
  RECONCILED: 'RECONCILED', // 已对账归档
  IGNORED: 'IGNORED', // 人工标记不入账（需填理由）
  NEEDS_REVIEW: 'NEEDS_REVIEW', // 置信度低或校验冲突
} as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

// ---------------------------------------------------------------- 单据
export const DOC_TYPE = {
  INVOICE_SALES: 'INVOICE_SALES',
  INVOICE_PURCHASE: 'INVOICE_PURCHASE',
  BANK_SLIP: 'BANK_SLIP',
  BANK_STATEMENT: 'BANK_STATEMENT',
  CONTRACT: 'CONTRACT',
  RECEIPT: 'RECEIPT',
  OTHER: 'OTHER',
} as const;
export type DocType = (typeof DOC_TYPE)[keyof typeof DOC_TYPE];

export const DOCUMENT_STATUS = {
  PENDING: 'PENDING',
  EXTRACTING: 'EXTRACTING',
  EXTRACTED: 'EXTRACTED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  FAILED: 'FAILED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type DocumentStatus = (typeof DOCUMENT_STATUS)[keyof typeof DOCUMENT_STATUS];

// ---------------------------------------------------------------- 规则引擎
export const RULE_TRIGGER = {
  INVOICE_INPUT: 'INVOICE_INPUT',
  INVOICE_OUTPUT: 'INVOICE_OUTPUT',
  BANK_IN: 'BANK_IN',
  BANK_OUT: 'BANK_OUT',
  BANK_FEE: 'BANK_FEE',
  BANK_INTEREST: 'BANK_INTEREST',
  SALARY_ACCRUAL: 'SALARY_ACCRUAL',
  SALARY_PAYMENT: 'SALARY_PAYMENT',
  DEPRECIATION: 'DEPRECIATION',
  AMORTIZATION: 'AMORTIZATION',
  TAX_PAYMENT: 'TAX_PAYMENT',
  OTHER: 'OTHER',
} as const;
export type RuleTrigger = (typeof RULE_TRIGGER)[keyof typeof RULE_TRIGGER];

export const SUGGESTION_SOURCE = {
  RULE: 'RULE',
  LEARNED: 'LEARNED',
  AI: 'AI',
  MANUAL: 'MANUAL',
} as const;
export type SuggestionSource = (typeof SUGGESTION_SOURCE)[keyof typeof SUGGESTION_SOURCE];

// ---------------------------------------------------------------- 纳税人
export const TAXPAYER_TYPE = {
  GENERAL: 'GENERAL', // 一般纳税人
  SMALL_SCALE: 'SMALL_SCALE', // 小规模纳税人
} as const;
export type TaxpayerType = (typeof TAXPAYER_TYPE)[keyof typeof TAXPAYER_TYPE];

// ---------------------------------------------------------------- 税率
/** 中国现行增值税税率与征收率 */
export const VAT_RATES = {
  RATE_13: '0.13',
  RATE_9: '0.09',
  RATE_6: '0.06',
  RATE_5: '0.05', // 简易计税征收率
  RATE_3: '0.03', // 简易计税征收率（小规模）
  RATE_1: '0.01', // 小规模减按 1%
  RATE_0_5: '0.005', // 二手车等
  ZERO: '0',
} as const;

/** 合法税率枚举（识别阶段校验规则 V3 使用） */
export const VALID_TAX_RATES: string[] = [
  '0',
  '0.005',
  '0.01',
  '0.015',
  '0.03',
  '0.05',
  '0.06',
  '0.09',
  '0.13',
];

// ---------------------------------------------------------------- 风险
export const RISK_LEVEL = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
} as const;
export type RiskLevel = (typeof RISK_LEVEL)[keyof typeof RISK_LEVEL];

export const RISK_CATEGORY = {
  TAX: 'TAX',
  ACCOUNTING: 'ACCOUNTING',
  FRAUD: 'FRAUD',
  COMPLIANCE: 'COMPLIANCE',
  AI: 'AI',
} as const;
export type RiskCategory = (typeof RISK_CATEGORY)[keyof typeof RISK_CATEGORY];

export const RISK_ALERT_STATUS = {
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
} as const;

// ---------------------------------------------------------------- 结账检查项
export const PERIOD_CHECK = {
  DRAFT_VOUCHERS: { code: 'DRAFT_VOUCHERS', level: 'BLOCKER', name: '存在未提交审核的草稿凭证' },
  UNPOSTED_VOUCHERS: { code: 'UNPOSTED_VOUCHERS', level: 'BLOCKER', name: '存在已审核未过账的凭证' },
  PENDING_INVOICES: { code: 'PENDING_INVOICES', level: 'BLOCKER', name: '存在未入账的发票' },
  UNCERTIFIED_INPUT: { code: 'UNCERTIFIED_INPUT', level: 'WARNING', name: '存在未认证的进项专票' },
  UNMATCHED_INVOICE_TAX: { code: 'UNMATCHED_INVOICE_TAX', level: 'WARNING', name: '发票税额与凭证税额不一致' },
  BANK_UNRECONCILED: { code: 'BANK_UNRECONCILED', level: 'WARNING', name: '存在未匹配的银行流水' },
  VOUCHER_NO_GAP: { code: 'VOUCHER_NO_GAP', level: 'BLOCKER', name: '凭证号不连续' },
  BALANCE_INVARIANT: { code: 'BALANCE_INVARIANT', level: 'BLOCKER', name: '账务不变式校验未通过' },
  AUX_MISSING: { code: 'AUX_MISSING', level: 'WARNING', name: '缺少必需的辅助核算维度' },
  CASH_NEGATIVE: { code: 'CASH_NEGATIVE', level: 'WARNING', name: '库存现金或银行存款出现贷方余额' },
  RISK_ALERTS_OPEN: { code: 'RISK_ALERTS_OPEN', level: 'WARNING', name: '存在未处理的严重风险提示' },
  PERIOD_DATE_MISMATCH: { code: 'PERIOD_DATE_MISMATCH', level: 'BLOCKER', name: '凭证日期与所属期间不符' },
} as const;

export type PeriodCheckLevel = 'BLOCKER' | 'WARNING' | 'INFO';
export type PeriodCheckCode = keyof typeof PERIOD_CHECK;

// ---------------------------------------------------------------- 结账步骤
export const CLOSE_STEP = {
  S0_CHECKLIST: 'S0_CHECKLIST',
  S1_VAT_AGGREGATE: 'S1_VAT_AGGREGATE',
  S2_CERT_TRANSFER: 'S2_CERT_TRANSFER',
  S3_VAT_TRANSFER: 'S3_VAT_TRANSFER',
  S4_SURTAX: 'S4_SURTAX',
  S5_CARRY_PROFIT_LOSS: 'S5_CARRY_PROFIT_LOSS',
  S6_INCOME_TAX: 'S6_INCOME_TAX',
  S7_FREEZE_BALANCE: 'S7_FREEZE_BALANCE',
  S8_REPORT_SNAPSHOT: 'S8_REPORT_SNAPSHOT',
  S9_LOCK_PERIOD: 'S9_LOCK_PERIOD',
  S10_RISK_SCAN: 'S10_RISK_SCAN',
} as const;
export type CloseStep = (typeof CLOSE_STEP)[keyof typeof CLOSE_STEP];

export const CLOSE_STEP_ORDER: CloseStep[] = [
  CLOSE_STEP.S0_CHECKLIST,
  CLOSE_STEP.S1_VAT_AGGREGATE,
  CLOSE_STEP.S2_CERT_TRANSFER,
  CLOSE_STEP.S3_VAT_TRANSFER,
  CLOSE_STEP.S4_SURTAX,
  CLOSE_STEP.S5_CARRY_PROFIT_LOSS,
  CLOSE_STEP.S6_INCOME_TAX,
  CLOSE_STEP.S7_FREEZE_BALANCE,
  CLOSE_STEP.S8_REPORT_SNAPSHOT,
  CLOSE_STEP.S9_LOCK_PERIOD,
  CLOSE_STEP.S10_RISK_SCAN,
];

// ---------------------------------------------------------------- 幂等键
/**
 * ★ 幂等键构造规则。同一来源 + 同一版本只会产生一张非作废凭证。
 * 修改此函数会导致历史幂等键失效，务必谨慎。
 */
export const IDEMPOTENCY = {
  invoice: (invoiceId: string, ruleVersion = 1) => `INV:${invoiceId}:v${ruleVersion}`,
  bankTxn: (txnId: string, ruleVersion = 1) => `BANK:${txnId}:v${ruleVersion}`,
  vatAggregate: (periodId: string) => `VATAGG:${periodId}`,
  certTransfer: (periodId: string) => `VAT-CERT-TRANSFER:${periodId}`,
  vatTransfer: (periodId: string) => `VAT-TRANSFER:${periodId}`,
  surtax: (periodId: string) => `SURTAX:${periodId}`,
  carryProfitLoss: (periodId: string) => `PL-CARRY:${periodId}`,
  incomeTax: (periodId: string) => `CIT:${periodId}`,
  reportSnapshot: (periodId: string) => `REPORT:${periodId}`,
} as const;

// ---------------------------------------------------------------- 用户角色
export const USER_ROLE = {
  OWNER: 'OWNER', // 老板/会计本人：全部操作，含结账、反结账、规则配置
  OPERATOR: 'OPERATOR', // 助理：导入单据、复核凭证，不能过账与结账
} as const;
export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE];
