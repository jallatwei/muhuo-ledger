/**
 * API 客户端
 * ============================================================
 * ★ 关键点：金额在前后端之间传递时一律用**字符串**。
 *   JSON 的 number 是 IEEE 754 双精度，1130.00 与 1130.0000000001 无法区分，
 *   对记账系统是不可接受的。所以后端返回 Decimal 序列化为字符串，前端用 Decimal 解析。
 */
import axios, { type AxiosError } from 'axios';
import { ElMessage } from 'element-plus';

const baseURL = import.meta.env.VITE_API_BASE_URL ?? '/api';

/** 令牌在 localStorage 里的键。与 stores/auth.ts 保持一致 */
const TOKEN_KEY = 'bk.auth.token';

export const http = axios.create({
  baseURL,
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * 请求拦截：带上访问令牌。
 *
 * ★ 直接在拦截器里读 localStorage，而不是从 Pinia store 取 ——
 *   拦截器在 store 之前就初始化了（main.ts 里 createPinia 之前
 *   axios 实例就已存在），从 store 取会出现"首次请求没带令牌"的竞态。
 */
http.interceptors.request.use((config) => {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      config.headers = config.headers ?? {};
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // 隐私模式下读不了 localStorage，按未登录处理
  }
  return config;
});

/** 后端统一异常格式（见 apps/api/src/common/filters/all-exceptions.filter.ts） */
export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  /** ★ 面向用户的中文说明，界面上优先展示这个 */
  userMessage: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly statusCode: number;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.userMessage = body.userMessage;
    this.statusCode = body.statusCode;
  }
}

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorBody>) => {
    const body = error.response?.data;

    // ★ 401：令牌过期或不合法。清掉本地令牌并送去登录页，带上"从哪来"。
    //   这里用 location.replace 而不是 router.push ——
    //   拦截器里拿不到 router 实例（会形成循环依赖），
    //   而且需要连 Pinia 里的身份状态一起重置，整页跳转最干净。
    if (error.response?.status === 401) {
      const onLoginPage = window.location.pathname.startsWith('/login');
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {
        // 忽略
      }
      if (!onLoginPage) {
        const here = `${window.location.pathname}${window.location.search}`;
        window.location.replace(`/login?redirect=${encodeURIComponent(here)}&reason=expired`);
      }
    }

    if (body?.userMessage) {
      // 后端已经给出了可读的中文说明，直接透传
      return Promise.reject(new ApiError(body));
    }
    const fallback: ApiErrorBody = {
      statusCode: error.response?.status ?? 0,
      code: 'BK_E_NETWORK',
      message: error.message,
      userMessage:
        error.code === 'ECONNABORTED'
          ? '请求超时，服务可能正在处理大量数据。请稍后刷新查看结果。'
          : '无法连接到后端服务。请确认 API 已启动（默认 http://localhost:3000）。',
    };
    return Promise.reject(new ApiError(fallback));
  },
);

/** 统一的错误提示 */
export function toastError(e: unknown): void {
  const msg = e instanceof ApiError ? e.userMessage : e instanceof Error ? e.message : String(e);
  ElMessage({ type: 'error', message: msg, duration: 6000, showClose: true });
}

// ============================================================================
//  基础数据
// ============================================================================

export interface EntitySummary {
  id: string;
  name: string;
  unifiedSocialCreditCode: string | null;
  taxpayerType: 'GENERAL' | 'SMALL_SCALE';
  baseCurrency: string;
  fiscalYearStartMonth: number;
  /** 我在这家公司是什么角色。只有登录后调用 /entities 才会带 */
  memberships?: Array<{ role: 'OWNER' | 'ACCOUNTANT' | 'VIEWER' }>;
}

export interface PeriodSummary {
  id: string;
  fiscalYear: number;
  month: number;
  status: 'OPEN' | 'CLOSING' | 'CLOSED';
  startsOn: string;
  endsOn: string;
  reopenedCount: number;
}

export interface AccountSummary {
  id: string;
  code: string;
  name: string;
  fullName: string;
  level: number;
  category: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'COST' | 'PROFIT_LOSS';
  direction: 'DEBIT' | 'CREDIT';
  isLeaf: boolean;
  isActive: boolean;
  isSystem: boolean;
  reportItem: string | null;
  taxTag: string | null;
  auxRequired: string[];
}

// ============================================================================
//  账号与登录
// ============================================================================

export interface AuthMembership {
  entityId: string;
  entityName: string;
  role: 'OWNER' | 'ACCOUNTANT' | 'VIEWER';
  roleLabel: string;
  actions: string[];
}

export interface AuthUserDto {
  id: string;
  email: string;
  displayName: string;
  accountType: 'PERSONAL' | 'COMPANY_STAFF' | string;
  isPlatformAdmin: boolean;
}

export interface LoginResultDto {
  token: string;
  expiresIn: string;
  user: AuthUserDto;
  memberships: AuthMembership[];
  defaultEntityId: string | null;
}

export interface CompanyInputDto {
  name: string;
  unifiedSocialCreditCode?: string;
  taxpayerType?: 'GENERAL' | 'SMALL_SCALE';
  legalPerson?: string;
  address?: string;
  phone?: string;
  startYear?: number;
}

export interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: 'OWNER' | 'ACCOUNTANT' | 'VIEWER';
  roleLabel: string;
  isActive: boolean;
  createdAt: string;
}

export interface MemberListResult {
  entityId: string;
  entityName: string;
  myRole: string;
  myRoleLabel: string;
  canManage: boolean;
  roles: Array<{ value: string; label: string }>;
  members: MemberRow[];
  selfUserId: string;
}

export const authApi = {
  /** 注册引导：系统里有没有用户、首个注册者会不会成为平台管理员 */
  registrationInfo: () =>
    http
      .get<{
        isFirstUser: boolean;
        userCount: number;
        canRegister: boolean;
        note: string;
        roles: Array<{ value: string; label: string; actions: string[] }>;
      }>('/auth/registration-info')
      .then((r) => r.data),

  login: (email: string, password: string) =>
    http.post<LoginResultDto>('/auth/login', { email, password }).then((r) => r.data),

  register: (payload: {
    email: string;
    password: string;
    displayName: string;
    phone?: string;
    accountType?: 'PERSONAL' | 'COMPANY_STAFF';
    company?: CompanyInputDto;
  }) => http.post<LoginResultDto>('/auth/register', payload).then((r) => r.data),

  me: () =>
    http
      .get<{ user: AuthUserDto; memberships: AuthMembership[]; defaultEntityId: string | null }>(
        '/auth/me',
      )
      .then((r) => r.data),

  changePassword: (currentPassword: string, newPassword: string) =>
    http.post('/auth/change-password', { currentPassword, newPassword }).then((r) => r.data),

  /** 我能访问的公司（按成员关系过滤，看不到别家） */
  myEntities: () =>
    http
      .get<{
        entities: Array<{ entityId: string; name: string; role: string; roleLabel: string; actions: string[] }>;
        defaultEntityId: string | null;
      }>('/auth/entities')
      .then((r) => r.data),

  /** 公司注册：再建一个主体与账套 */
  registerEntity: (company: CompanyInputDto) =>
    http
      .post<{ entityId: string; entityName: string }>('/auth/entities', { company })
      .then((r) => r.data),

  members: (entityId: string) =>
    http.get<MemberListResult>(`/auth/entities/${entityId}/members`).then((r) => r.data),

  addMember: (entityId: string, email: string, role: string) =>
    http
      .post<{ membershipId: string }>(`/auth/entities/${entityId}/members`, { email, role })
      .then((r) => r.data),

  changeMemberRole: (entityId: string, membershipId: string, role: string) =>
    http
      .patch(`/auth/entities/${entityId}/members/${membershipId}`, { role })
      .then((r) => r.data),
};

export const api = {
  health: () => http.get('/health').then((r) => r.data),
  entities: () => http.get<EntitySummary[]>('/entities').then((r) => r.data),
  periods: (entityId: string, year?: number) =>
    http
      .get<PeriodSummary[]>('/periods', { params: { entityId, year } })
      .then((r) => r.data),
  accounts: (entityId: string, leafOnly = false, keyword?: string) =>
    http
      .get<AccountSummary[]>('/accounts', { params: { entityId, leafOnly, keyword } })
      .then((r) => r.data),
  accountIntegrity: (entityId: string) =>
    http.get('/accounts/integrity', { params: { entityId } }).then((r) => r.data),
};

// ============================================================================
//  凭证
// ============================================================================

export interface JournalLineDto {
  id: string;
  lineNo: number;
  accountId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  summary: string | null;
  partnerId: string | null;
  taxRate: string | null;
  taxAmount: string | null;
  account: { code: string; name: string; fullName: string; direction?: string };
}

export interface VoucherDto {
  id: string;
  voucherWord: string;
  voucherNo: number;
  periodYear: number;
  periodMonth: number;
  voucherDate: string;
  status: 'DRAFT' | 'REVIEWING' | 'APPROVED' | 'POSTED' | 'REVERSED' | 'VOID';
  totalDebit: string;
  totalCredit: string;
  summary: string;
  attachments: number;
  sourceType: string;
  sourceId: string | null;
  idempotencyKey: string | null;
  ruleId: string | null;
  ruleReason: string | null;
  ruleVersion: number | null;
  confidence: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** 最近一次退回的理由（审核退回 / 过账前退回 / 反审核） */
  reviewNote: string | null;
  postedBy: string | null;
  postedAt: string | null;
  reversesId: string | null;
  reversedById: string | null;
  voidReason: string | null;
  lines?: JournalLineDto[];
}

export interface VoucherLineInput {
  accountCode: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  summary?: string;
  partnerId?: string;
  taxRate?: string;
  taxAmount?: string;
}

export interface CreateVoucherInput {
  entityId: string;
  periodId?: string;
  voucherDate: string;
  summary: string;
  voucherWord?: string;
  sourceType?: string;
  idempotencyKey?: string;
  lines: VoucherLineInput[];
}

export const voucherApi = {
  list: (params: {
    entityId: string;
    periodId?: string;
    status?: string;
    keyword?: string;
    page?: number;
    pageSize?: number;
  }) => http.get('/vouchers', { params }).then((r) => r.data),

  get: (id: string) => http.get<VoucherDto>(`/vouchers/${id}`).then((r) => r.data),

  create: (body: CreateVoucherInput) =>
    http.post<{ id: string; alreadyExists: boolean }>('/vouchers', body).then((r) => r.data),

  submit: (id: string) => http.post(`/vouchers/${id}/submit`, {}).then((r) => r.data),
  approve: (id: string) => http.post(`/vouchers/${id}/approve`, {}).then((r) => r.data),
  /** 审核不通过：待审核 → 草稿 */
  reject: (id: string, reason: string) =>
    http.post(`/vouchers/${id}/reject`, { reason }).then((r) => r.data),
  /** 过账前退回审核：已审核 → 待审核（问题出在审核环节） */
  rejectAfterReview: (id: string, reason: string) =>
    http.post(`/vouchers/${id}/reject-after-review`, { reason }).then((r) => r.data),
  /** 反审核：已审核 → 草稿（单据本身要改） */
  unapprove: (id: string, reason: string) =>
    http.post(`/vouchers/${id}/unapprove`, { reason }).then((r) => r.data),
  post: (id: string) => http.post<{ voucherNo: number }>(`/vouchers/${id}/post`, {}).then((r) => r.data),
  reverse: (id: string, reason: string) =>
    http.post(`/vouchers/${id}/reverse`, { reason }).then((r) => r.data),
  void: (id: string, reason: string) =>
    http.post(`/vouchers/${id}/void`, { reason }).then((r) => r.data),

  periodSummary: (entityId: string, periodId: string) =>
    http.get('/vouchers/period-summary', { params: { entityId, periodId } }).then((r) => r.data),

  listLines: (entityId: string, periodId: string) =>
    http
      .get('/vouchers', { params: { entityId, periodId, pageSize: 200 } })
      .then((r) => r.data),
};

// ============================================================================
//  AI 与自检
// ============================================================================

export interface ValidationFinding {
  code: string;
  level: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
  message: string;
  suggestion?: string;
  fields?: string[];
}

/** 识别目标类型：单据两类 + 报表三类 */
export type ExtractTargetType =
  | 'INVOICE'
  | 'BANK_SLIP'
  | 'BANK_STATEMENT'
  | 'BALANCE_SHEET'
  | 'INCOME_STATEMENT'
  | 'TAX_RETURN';

export interface ExtractTargetMeta {
  value: ExtractTargetType;
  label: string;
  group: '单据' | '报表';
  hint: string;
}

/** 报表 / 申报表的行项目（保留表上原样，不映射科目） */
export interface StatementItemRow {
  lineNo?: string | null;
  label: string;
  endBalance: string | null;
  beginBalance: string | null;
}

export interface ExtractResult {
  preview: {
    targetType: ExtractTargetType;
    data: Record<string, unknown>;
    fieldConfidence: Record<string, number>;
    overallConfidence: number;
    model: string;
    latencyMs: number;
    provider: string;
    warnings: string[];
  };
  validation: {
    hasFailure: boolean;
    failCount: number;
    warnCount: number;
    findings: ValidationFinding[];
    /** 报表类专有：平衡自检结果（★ 只报告，不做修正） */
    balanced?: boolean | null;
    balanceDifference?: string | null;
    periodLabel?: string | null;
  } | null;
  routing: { status: string; reason: string; lowConfidenceFields: string[] } | null;
  explanation: string;
}

export const aiApi = {
  health: () => http.get('/ai/health').then((r) => r.data),
  samples: () =>
    http
      .get<{ provider: string; note: string; samples: Array<{ key: string; label: string; covers: string }> }>(
        '/ai/samples',
      )
      .then((r) => r.data),
  targets: () =>
    http
      .get<{ targets: ExtractTargetMeta[] }>('/ai/targets')
      .then((r) => r.data.targets),
  extract: (
    entityId: string,
    caseKey?: string,
    targetType: ExtractTargetType = 'INVOICE',
  ) =>
    http
      .post<ExtractResult>('/ai/extract', {}, { params: { entityId, case: caseKey, targetType } })
      .then((r) => r.data),
  /**
   * ★ 识别录入：上传真实文件。
   * 后端按扩展名分流：图片 → 视觉识别；PDF → 优先文本层；Excel/CSV → 逐单元格精确读取。
   */
  recognize: (
    entityId: string,
    file: File,
    /** ★ 可选。不传时由服务端按文件内容自动判定 */
    targetType?: ExtractTargetType,
  ): Promise<RecognizeResult> => {
    const form = new FormData();
    form.append('file', file);
    form.append('entityId', entityId);
    if (targetType) form.append('targetType', targetType);
    return http
      .post<RecognizeResult>('/ai/recognize', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },
};

/** 文件识别的返回：在普通抽取结果上多了"文件是怎么被读进来的" */
/** ★ 系统对「这是什么单据」的自动判定结果 */
export interface DocClassification {
  label: string;
  kind: string;
  docType: string;
  statementType: string | null;
  targetType: ExtractTargetType | null;
  confidence: number;
  needsConfirmation: boolean;
  evidence: Array<{ signal: string; strength: 'FILE_TYPE' | 'TITLE' | 'FIELD' }>;
  reason: string;
  hint: string;
  chosenBy: 'SYSTEM' | 'USER' | null;
  conflictsWithUserChoice: boolean;
}

export interface RecognizeResult {
  ingested: {
    kind: 'IMAGE' | 'PDF' | 'SHEET';
    fileName: string;
    sizeBytes: number;
    textChars: number;
    textPreview: string | null;
    notes: string[];
  };
  /** ★ 系统判成了什么、依据是什么、是系统选的还是你选的 */
  classification: DocClassification;
  /** true 表示系统判不出来，需要你手工选识别目标 */
  needsTargetChoice?: boolean;
  /** 判不出来时为 null */
  preview: ExtractResult['preview'] | null;
  validation: ExtractResult['validation'] & { balanced?: boolean | null; balanceDifference?: string | null };
  routing: ExtractResult['routing'];
  explanation: string;
}

// ────────────────────────────────────────────────────────────── 报表 / 申报表存档

export interface SavedStatement {
  id: string;
  statementType: 'BALANCE_SHEET' | 'INCOME_STATEMENT' | 'CASH_FLOW';
  statementDate: string;
  fiscalYear: number;
  fiscalMonth: number | null;
  source: string;
  isBalanced: boolean;
  balanceDifference: string | null;
  totalAssets: string | null;
  totalLiabilities: string | null;
  totalEquity: string | null;
  revenue: string | null;
  netProfit: string | null;
  documentId: string | null;
  reconNote: string | null;
  createdAt: string;
}

export interface SaveStatementPayload {
  entityId: string;
  statementType: ExtractTargetType;
  periodStart?: string | null;
  periodEnd: string | null;
  items: StatementItemRow[];
  totals?: Record<string, string | null>;
  isBalanced?: boolean | null;
  balanceDifference?: string | null;
  documentId?: string | null;
  reconNote?: string | null;
  filingType?: 'VAT_MONTHLY' | 'VAT_QUARTERLY' | 'CIT_QUARTERLY' | 'CIT_ANNUAL';
  rawRow?: Record<string, unknown>;
}

export interface SaveStatementResult {
  kind: 'FINANCIAL_STATEMENT' | 'TAX_RETURN';
  id: string;
  created: boolean;
  periodLabel: string;
  warnings: string[];
}

/** 已建档报表被期初建账取用的明细 */
export interface DeclaredStatementSummary {
  targetYear: number;
  balanceSheet: {
    id: string;
    statementDate: string;
    isBalanced: boolean;
    balanceDifference: string | null;
    itemCount: number;
    mapped: Array<{
      accountCode: string;
      label: string;
      amount: string;
      direction: 'DEBIT' | 'CREDIT';
    }>;
    skipped: Array<{ label: string; reason: string }>;
  } | null;
  incomeStatement: {
    id: string;
    statementDate: string;
    itemCount: number;
    revenue: string | null;
    cost: string | null;
    profitBeforeTax: string | null;
    netProfit: string | null;
  } | null;
  explanation: string;
}

export const statementApi = {
  /** ★ 已建档报表会被期初建账取用哪些数（映射明细） */
  declared: (entityId: string, targetYear: number) =>
    http
      .get<DeclaredStatementSummary>('/history/declared-statements', {
        params: { entityId, targetYear },
      })
      .then((r) => r.data),
  save: (payload: SaveStatementPayload) =>
    http.post<SaveStatementResult>('/history/statements', payload).then((r) => r.data),
  list: (entityId: string, statementType?: string) =>
    http
      .get<SavedStatement[]>('/history/statements', { params: { entityId, statementType } })
      .then((r) => r.data),
  detail: (id: string, entityId: string) =>
    http.get(`/history/statements/${id}/detail`, { params: { entityId } }).then((r) => r.data),
  remove: (id: string, entityId: string) =>
    http.delete(`/history/statements/${id}`, { params: { entityId } }).then((r) => r.data),
  listFilings: (entityId: string) =>
    http.get('/history/filings', { params: { entityId } }).then((r) => r.data),
  removeFiling: (id: string, entityId: string) =>
    http.delete(`/history/filings/${id}`, { params: { entityId } }).then((r) => r.data),
};

export const auditApi = {
  selfCheck: (entityId: string, periodId: string) =>
    http
      .get('/accounting/self-check', { params: { entityId, periodId } })
      .then((r) => r.data),
  rebuildBalances: (entityId: string, periodId: string) =>
    http
      .post('/accounting/rebuild-balances', {}, { params: { entityId, periodId } })
      .then((r) => r.data),
};

// ────────────────────────────────────────────────────────────── 单据仓库

export interface UploadedDocument {
  documentId: string;
  duplicated: boolean;
  message?: string;
  originalName?: string;
  sizeBytes?: number;
}

export interface RecognizeDocumentResult {
  documentId: string;
  status: 'SAVED' | 'DUPLICATE' | 'NEEDS_REVIEW' | 'REJECTED';
  invoiceId: string | null;
  extracted: Record<string, unknown>;
  validation: {
    hasFailure: boolean;
    failCount: number;
    warnCount: number;
    findings: ValidationFinding[];
  };
  routing: { status: string; reason: string; lowConfidenceFields: string[] } | null;
  message: string;
  nextSteps: string[];
}

export const documentsApi = {
  /** 上传原始单据（无损入库，按内容哈希去重） */
  upload: (entityId: string, file: File, docType?: string): Promise<UploadedDocument> => {
    const form = new FormData();
    form.append('file', file);
    form.append('entityId', entityId);
    if (docType) form.append('docType', docType);
    return http
      .post<UploadedDocument>('/documents/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },
  /** ★ 识别已入库的单据 → 校验 → 落为发票台账 */
  recognize: (
    documentId: string,
    entityId: string,
    opts: { targetType?: string; force?: boolean; mockCase?: string } = {},
  ) =>
    http
      .post<RecognizeDocumentResult>(`/documents/${documentId}/recognize`, {
        entityId,
        ...opts,
      })
      .then((r) => r.data),
  list: (entityId: string, params: Record<string, unknown> = {}) =>
    http.get('/documents', { params: { entityId, ...params } }).then((r) => r.data),
};

// ────────────────────────────────────────────────────────────── 税务填报

export interface WorksheetCell {
  line: string;
  label: string;
  amount: string | null;
  source: 'LEDGER' | 'INVOICE' | 'PRIOR_FILING' | 'CALCULATED' | 'MANUAL' | 'UNKNOWN' | 'JUDGEMENT';
  sourceNote: string;
  blocked?: string;
  judgement?: string;
}

export interface ReportRowDto {
  lineNo: string;
  label: string;
  amount: string | null;
  compareAmount: string | null;
  source: string;
  accounts?: Array<{ code: string; name: string; amount: string }>;
  note?: string;
  highlight?: boolean;
}

export interface ReportSheetDto {
  title: string;
  formNo: string;
  periodLabel: string;
  unit: string;
  rows: ReportRowDto[];
  checks: Array<{ name: string; ok: boolean; expected?: string; actual?: string; detail: string }>;
  warnings: string[];
}

export interface TaxWorksheetPackage {
  entityId: string;
  entityName: string;
  periodLabel: string;
  fiscalYear: number;
  month: number;
  periodStatus: string;
  currentPeriodClosed: boolean;
  financial: { balanceSheet: ReportSheetDto; incomeStatement: ReportSheetDto };
  vat: {
    title: string;
    periodLabel: string;
    taxpayerKind: string;
    mainForm: WorksheetCell[];
    annex1: Array<{ taxRate: string; salesExclTax: string; outputTax: string; invoiceCount: number; note: string }>;
    annex2: Array<{ item: string; amount: string; source: string; sourceNote: string }>;
    surtax: {
      base: string;
      baseNote: string;
      city: string;
      education: string;
      localEducation: string;
      total: string;
      rates: { city: string; education: string; localEducation: string };
      reductionHint: string | null;
    };
    checks: Array<{ name: string; ok: boolean; expected?: string; actual?: string; detail: string }>;
    warnings: string[];
    policyNote: string[];
  };
  citQuarterly: CitWorksheetDto | null;
  citAnnual: CitWorksheetDto | null;
  dataIssues: string[];
  generatedAt: string;
  disclaimer: string;
}

export interface CitWorksheetDto {
  title: string;
  periodLabel: string;
  kind: 'QUARTERLY' | 'ANNUAL';
  cells: WorksheetCell[];
  adjustments: Array<{ item: string; amount: string | null; basis: string; needJudgement: boolean }>;
  preferences: Array<{ name: string; applicable: 'YES' | 'NO' | 'UNKNOWN'; condition: string; note: string }>;
  checks: Array<{ name: string; ok: boolean; expected?: string; actual?: string; detail: string }>;
  warnings: string[];
  requiresHumanDecision: string[];
}

export interface PolicyRecordDto {
  id: string;
  jurisdiction: string;
  issuer: string | null;
  title: string;
  sourceUrl: string;
  sourceName: string | null;
  documentNo: string | null;
  publishedAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  rawContent: string | null;
  fetchedAt: string;
  status: 'EFFECTIVE' | 'UPCOMING' | 'EXPIRED';
  displayStatus: string;
  taxTypes: string[];
  keywords: string[];
  needsReview: boolean;
  conditions: string[];
}

export interface PolicySearchResultDto {
  runId: string;
  jurisdiction: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  fetcher: string;
  sourcesTried: number;
  sourcesFailed: number;
  policiesFound: number;
  policiesNew: number;
  policiesChanged: number;
  unchanged: number;
  added: Array<{ id: string; title: string; documentNo: string | null; effectiveFrom: string | null }>;
  changed: Array<{ id: string; title: string; note: string }>;
  warnings: string[];
  fetchedAt: string;
  disclaimer: string;
}

export interface ExpenseAuditDto {
  entityId: string;
  periodLabel: string;
  generatedAt: string;
  scope: {
    voucherCount: number;
    invoiceCount: number;
    expenseVoucherCount: number;
    totalExpenseAmount: string;
  };
  findings: Array<{
    ruleId: string;
    severity: 'VIOLATION' | 'SUSPICIOUS' | 'NOTICE';
    category: string;
    title: string;
    detail: string;
    howToVerify: string;
    subjects: Array<{ type: string; id: string; label: string }>;
    amount: string | null;
    basis: string;
  }>;
  summary: { violationCount: number; suspiciousCount: number; noticeCount: number };
  disclaimer: string;
}

export const taxApi = {
  /** ★ 生成申报底稿（不申报，只出底稿） */
  worksheets: (payload: {
    entityId: string;
    fiscalYear: number;
    month: number;
    surtaxRates?: { city?: string };
  }) => http.post<TaxWorksheetPackage>('/tax/worksheets', payload).then((r) => r.data),

  periods: (entityId: string, fiscalYear?: number) =>
    http
      .get<Array<{ id: string; fiscalYear: number; month: number; status: string; closedAt: string | null }>>(
        '/tax/periods',
        { params: { entityId, fiscalYear } },
      )
      .then((r) => r.data),

  /** 报销自检（机械核查 + 风险提示，不是税务意见） */
  expenseAudit: (payload: {
    entityId: string;
    fiscalYear: number;
    month: number;
    limits?: { entertainmentPerMeal?: string };
  }) => http.post<ExpenseAuditDto>('/tax/expense-audit', payload).then((r) => r.data),

  /** 执行税务政策检索（抓官方来源 → 比对 → 留痕） */
  searchPolicies: (jurisdiction: string) =>
    http
      .post<PolicySearchResultDto>('/tax/policies/search', { jurisdiction })
      .then((r) => r.data),

  policies: (params: { jurisdiction?: string; taxType?: string; needsReviewOnly?: boolean } = {}) =>
    http.get<PolicyRecordDto[]>('/tax/policies', { params }).then((r) => r.data),

  policyDetail: (id: string) =>
    http
      .get<PolicyRecordDto & { fetchedAtLabel: string; disclaimer: string }>(`/tax/policies/${id}`)
      .then((r) => r.data),

  policySources: (jurisdiction?: string) =>
    http
      .get<{
        sources: Array<{ key: string; name: string; jurisdiction: string; url: string; covers: string }>;
        note: string;
      }>('/tax/policies/sources', { params: { jurisdiction } })
      .then((r) => r.data),

  policyRuns: (jurisdiction?: string) =>
    http
      .get<
        Array<{
          id: string;
          jurisdiction: string;
          startedAt: string;
          status: string;
          statusLabel: string;
          sourcesTried: number;
          sourcesFailed: number;
          policiesNew: number;
          policiesChanged: number;
        }>
      >('/tax/policies/runs', { params: { jurisdiction } })
      .then((r) => r.data),

  reviewPolicy: (id: string, notes?: string) =>
    http.post(`/tax/policies/${id}/review`, { notes }).then((r) => r.data),
};