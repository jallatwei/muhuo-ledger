/**
 * 共享领域类型
 * ============================================================
 * 金额字段一律为 **字符串**（十进制字符串表示），
 * 在前后端之间传递时不做任何浮点转换，避免 JSON 数字精度丢失。
 */
import type Decimal from 'decimal.js';
import type {
  Direction,
  DocType,
  DocumentStatus,
  InvoiceCategory,
  InvoiceDirection,
  InvoiceStatus,
  PeriodStatus,
  RiskCategory,
  RiskLevel,
  RuleTrigger,
  SuggestionSource,
  TaxpayerType,
  UserRole,
  VoucherSource,
  VoucherStatus,
} from './enums';

/** 金额：十进制字符串，固定 2 位小数 */
export type MoneyString = string;
/** 数量/单价 */
export type QuantityString = string;
/** 税率：十进制字符串，如 "0.1300" */
export type TaxRateString = string;
/** 日期：ISO 字符串 YYYY-MM-DD */
export type DateString = string;
/** 时间戳：ISO 8601 */
export type DateTimeString = string;

// ---------------------------------------------------------------- 分录与凭证
export interface JournalLineInput {
  accountId?: string;
  /** 科目编码，模板渲染时使用；落库前会解析成 accountId */
  accountCode: string;
  direction: Direction;
  amount: MoneyString;
  summary?: string;
  partnerId?: string;
  auxProject?: string;
  auxDepartment?: string;
  contractId?: string;
  taxRate?: TaxRateString;
  taxAmount?: MoneyString;
  invoiceId?: string;
}

export interface DraftVoucherSuggestion {
  lines: JournalLineInput[];
  source: SuggestionSource;
  ruleId?: string;
  ruleVersion?: number;
  /** 0~1，字符串形式保留精度 */
  confidence: string;
  /** ★ 人类可读的命中理由，写入凭证备注 */
  reason: string;
  warnings: string[];
  needsReview: boolean;
}

export interface VoucherSummary {
  id: string;
  voucherWord: string;
  voucherNo: number;
  voucherDate: DateString;
  status: VoucherStatus;
  summary: string;
  totalDebit: MoneyString;
  totalCredit: MoneyString;
  sourceType: VoucherSource;
  ruleReason?: string | null;
  confidence?: string | null;
  attachments: number;
}

// ---------------------------------------------------------------- 单据与发票
export interface DocumentSummary {
  id: string;
  docType: DocType;
  detectedType?: DocType | null;
  originalName: string;
  contentHash: string;
  status: DocumentStatus;
  pageCount?: number | null;
  errorMessage?: string | null;
  createdAt: DateTimeString;
}

export interface InvoiceLineInput {
  lineNo: number;
  itemName: string;
  spec?: string;
  unit?: string;
  quantity?: QuantityString;
  unitPrice?: QuantityString;
  amountExclTax: MoneyString;
  taxRate: TaxRateString;
  taxAmount: MoneyString;
  accountCode?: string;
}

export interface InvoiceInput {
  direction: InvoiceDirection;
  category: InvoiceCategory;
  invoiceCode?: string;
  invoiceNumber: string;
  digitalInvoiceNo?: string;
  invoiceDate: DateString;
  sellerName: string;
  sellerTaxNo?: string;
  buyerName: string;
  buyerTaxNo?: string;
  amountExclTax: MoneyString;
  taxRate: TaxRateString;
  taxAmount: MoneyString;
  amountInclTax: MoneyString;
  isRedFlushed: boolean;
  isDeductible: boolean;
  businessType?: string;
  partnerId?: string;
  contractId?: string;
  documentId?: string;
  lines?: InvoiceLineInput[];
}

// ---------------------------------------------------------------- 校验
export type ValidationLevel = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

export interface ValidationFinding {
  /** 规则编号，如 V1、V4 */
  code: string;
  level: ValidationLevel;
  message: string;
  /** 建议动作，便于人工快速处理 */
  suggestion?: string;
  /** 相关字段 */
  fields?: string[];
}

export interface ExtractionPreview {
  documentId: string;
  targetType: 'INVOICE' | 'BANK_SLIP' | 'CONTRACT' | 'BANK_STATEMENT';
  invoice?: InvoiceInput;
  fieldConfidence: Record<string, number>;
  overallConfidence: number;
  findings: ValidationFinding[];
  rawText?: string | null;
}

// ---------------------------------------------------------------- 余额
export interface AccountBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  level: number;
  direction: Direction;
  openingDebit: MoneyString;
  openingCredit: MoneyString;
  debitOccurred: MoneyString;
  creditOccurred: MoneyString;
  closingDebit: MoneyString;
  closingCredit: MoneyString;
}

// ---------------------------------------------------------------- 期间与结账
export interface PeriodSummary {
  id: string;
  fiscalYear: number;
  month: number;
  label: string; // "2025-03"
  status: PeriodStatus;
  closedAt?: DateTimeString | null;
  reopenedCount: number;
}

export interface PeriodCheckItemResult {
  code: string;
  level: 'BLOCKER' | 'WARNING' | 'INFO';
  name: string;
  passed: boolean;
  detail?: string;
  metrics?: Record<string, unknown>;
}

export interface PeriodCheckReport {
  periodId: string;
  canClose: boolean;
  blockers: PeriodCheckItemResult[];
  warnings: PeriodCheckItemResult[];
  infos: PeriodCheckItemResult[];
  checkedAt: DateTimeString;
}

// ---------------------------------------------------------------- 规则
export type ConditionOperator =
  | 'EQ'
  | 'NEQ'
  | 'IN'
  | 'NOT_IN'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'REGEX'
  | 'GT'
  | 'GTE'
  | 'LT'
  | 'LTE'
  | 'BETWEEN'
  | 'IS_NULL'
  | 'NOT_NULL'
  | 'STARTS_WITH'
  | 'ENDS_WITH';

export interface RuleConditionLeaf {
  field: string;
  cmp: ConditionOperator;
  value?: unknown;
}

export interface RuleConditionGroup {
  op: 'AND' | 'OR' | 'NOT';
  children: Array<RuleConditionGroup | RuleConditionLeaf>;
}

export type RuleCondition = RuleConditionGroup | RuleConditionLeaf;

export interface RuleTemplateLine {
  side: Direction;
  /** 科目编码，或模板表达式 {{ ... }} */
  account: string;
  /** 金额模板表达式；缺省表示由 account 推导（如税行） */
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

export interface JournalRuleSummary {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  trigger: RuleTrigger;
  confidence: string;
  autoPost: boolean;
  isSystem: boolean;
  hitCount: number;
  version: number;
}

// ---------------------------------------------------------------- 主体与用户
export interface EntitySummary {
  id: string;
  name: string;
  unifiedSocialCreditCode?: string | null;
  taxpayerType: TaxpayerType;
  baseCurrency: string;
  fiscalYearStartMonth: number;
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  entityIds: string[];
}

// ---------------------------------------------------------------- 风险
export interface RiskAlertSummary {
  id: string;
  ruleCode: string;
  level: RiskLevel;
  category: RiskCategory;
  periodLabel?: string | null;
  subjectType: string;
  subjectId?: string | null;
  title: string;
  detail?: string | null;
  suggestion?: string | null;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';
  createdAt: DateTimeString;
}

// ---------------------------------------------------------------- API 响应
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  /** 面向用户的可读说明 */
  userMessage?: string;
  details?: unknown;
}

/** 金额输入的宽松类型：允许 string / Decimal，但不允许 number（编译期就挡住） */
export type DecimalLike = Decimal | string;
