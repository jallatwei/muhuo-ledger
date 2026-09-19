/**
 * 记账凭证 —— 领域聚合根
 * ============================================================
 * ★ 本文件不 import Nest、不 import Prisma。
 *   会计逻辑的正确性不该依赖框架，这样才能用纯单测覆盖要命的规则。
 *
 * 核心不变式（见 design/03）：
 *   1. 借贷恒等：Σdebit == Σcredit 且 Σ > 0
 *   2. 分录金额恒为正数，方向由 direction 表达
 *   3. 状态迁移遵循白名单，超出即报错
 *   4. 已过账凭证不可修改（要改只能红冲）
 *   5. 凭证号只在过账时分配
 */
import {
  Decimal,
  checkBalance,
  round2,
  VOUCHER_TRANSITIONS,
  type BalanceResult,
  type Direction,
  type VoucherSource,
  type VoucherStatus,
} from '@bookkeeper/shared';
import {
  DomainError,
  EmptyVoucherError,
  InvalidAmountError,
  InvalidVoucherTransitionError,
  MissingAuxDimensionError,
  NonLeafAccountError,
  PeriodDateMismatchError,
  PeriodLockedError,
  PostedVoucherImmutableError,
  SingleSidedVoucherError,
  UnbalancedVoucherError,
  zhStatus,
} from './errors';

// ---------------------------------------------------------------- 值对象
/** 分录行 */
export interface LineDraft {
  accountId: string;
  /** 用于错误提示与辅助校验 */
  accountCode: string;
  accountName?: string;
  /** 科目是否为末级（由调用方从科目表带入；未提供则跳过校验） */
  accountIsLeaf?: boolean;
  accountIsActive?: boolean;
  /** 该科目要求的辅助核算维度 */
  accountAuxRequired?: string[];
  direction: Direction;
  amount: Decimal;
  summary?: string;
  partnerId?: string;
  auxProject?: string;
  auxDepartment?: string;
  contractId?: string;
  taxRate?: Decimal;
  taxAmount?: Decimal;
  invoiceId?: string;
}

export interface VoucherDraft {
  entityId: string;
  periodId: string;
  periodYear: number;
  periodMonth: number;
  voucherWord?: string;
  voucherDate: Date;
  summary: string;
  lines: LineDraft[];
  sourceType: VoucherSource;
  sourceId?: string;
  idempotencyKey?: string;
  ruleId?: string;
  ruleReason?: string;
  ruleVersion?: number;
  confidence?: Decimal;
  attachments?: number;
  createdBy?: string;
}

/**
 * 已确定凭证字的草稿。
 * 红冲等场景需要立刻取号，凭证字不能是 undefined，否则拿不到号。
 */
export type NumberedVoucherDraft = VoucherDraft & { voucherWord: string };

/** 期间的最小信息（避免领域层依赖 Period 实体） */
export interface PeriodInfo {
  id: string;
  fiscalYear: number;
  month: number;
  status: 'OPEN' | 'CLOSING' | 'CLOSED';
  startsOn: Date;
  endsOn: Date;
}

export function periodLabel(p: Pick<PeriodInfo, 'fiscalYear' | 'month'>): string {
  return `${p.fiscalYear}-${String(p.month).padStart(2, '0')}`;
}

/** 年初余额凭证使用的凭证字与凭证号 */
export const OPENING_VOUCHER_WORD = '年初';
export const DEFAULT_VOUCHER_WORD = '记';

// ---------------------------------------------------------------- 聚合根
export class JournalVoucher {
  readonly entityId: string;
  readonly periodId: string;
  readonly periodYear: number;
  readonly periodMonth: number;

  private _voucherWord: string;
  private _voucherNo: number | null = null;
  private _voucherDate: Date;
  private _status: VoucherStatus = 'DRAFT';
  private _summary: string;
  private _lines: LineDraft[];
  private _attachments: number;

  readonly sourceType: VoucherSource;
  readonly sourceId?: string;
  readonly idempotencyKey?: string;
  readonly ruleId?: string;
  readonly ruleReason?: string;
  readonly ruleVersion?: number;
  readonly confidence?: Decimal;
  readonly createdBy?: string;

  private _reviewedBy?: string;
  private _reviewedAt?: Date;
  /** 最近一次退回的理由：回显给制单人，避免「被退了却不知道为什么」 */
  private _reviewNote?: string;
  private _postedBy?: string;
  private _postedAt?: Date;
  private _reversedById?: string;
  private _voidReason?: string;

  private constructor(draft: VoucherDraft) {
    this.entityId = draft.entityId;
    this.periodId = draft.periodId;
    this.periodYear = draft.periodYear;
    this.periodMonth = draft.periodMonth;
    this._voucherWord = draft.voucherWord ?? DEFAULT_VOUCHER_WORD;
    this._voucherDate = draft.voucherDate;
    this._summary = draft.summary;
    this._lines = draft.lines;
    this._attachments = draft.attachments ?? 0;
    this.sourceType = draft.sourceType;
    this.sourceId = draft.sourceId;
    this.idempotencyKey = draft.idempotencyKey;
    this.ruleId = draft.ruleId;
    this.ruleReason = draft.ruleReason;
    this.ruleVersion = draft.ruleVersion;
    this.confidence = draft.confidence;
    this.createdBy = draft.createdBy;
  }

  // ------------------------------------------------------------ 工厂
  /**
   * 创建凭证草稿。
   * ★ 创建时就校验借贷平衡 —— 不让不平的凭证进入系统。
   */
  static create(draft: VoucherDraft): JournalVoucher {
    const voucher = new JournalVoucher(draft);
    voucher.validateStructure();
    return voucher;
  }

  /**
   * 从数据库记录重建（跳过结构校验，因为历史数据可能已过账）。
   * 用于红冲、反审核等场景。
   */
  static rehydrate(
    draft: VoucherDraft & {
      voucherNo: number | null;
      status: VoucherStatus;
      reviewedBy?: string;
      reviewedAt?: Date;
      postedBy?: string;
      postedAt?: Date;
      reversedById?: string;
    },
  ): JournalVoucher {
    const v = new JournalVoucher(draft);
    v._voucherNo = draft.voucherNo;
    v._status = draft.status;
    v._reviewedBy = draft.reviewedBy;
    v._reviewedAt = draft.reviewedAt;
    v._postedBy = draft.postedBy;
    v._postedAt = draft.postedAt;
    v._reversedById = draft.reversedById;
    return v;
  }

  // ------------------------------------------------------------ 访问器
  get voucherWord(): string {
    return this._voucherWord;
  }
  get voucherNo(): number | null {
    return this._voucherNo;
  }
  get voucherDate(): Date {
    return this._voucherDate;
  }
  get status(): VoucherStatus {
    return this._status;
  }
  get summary(): string {
    return this._summary;
  }
  get lines(): readonly LineDraft[] {
    return this._lines;
  }
  get attachments(): number {
    return this._attachments;
  }
  get reviewedBy(): string | undefined {
    return this._reviewedBy;
  }
  get reviewNote(): string | undefined {
    return this._reviewNote;
  }

  get reviewedAt(): Date | undefined {
    return this._reviewedAt;
  }
  get postedBy(): string | undefined {
    return this._postedBy;
  }
  get postedAt(): Date | undefined {
    return this._postedAt;
  }
  get reversedById(): string | undefined {
    return this._reversedById;
  }
  get voidReason(): string | undefined {
    return this._voidReason;
  }

  /** 人类可读的凭证标识：记-5 / 记-（未编号） */
  get label(): string {
    if (this._voucherNo === null) return `${this._voucherWord}-（未编号）`;
    return `${this._voucherWord}-${this._voucherNo}`;
  }

  /** 是否已过账（含被红冲的） */
  get isPosted(): boolean {
    return this._status === 'POSTED' || this._status === 'REVERSED';
  }

  /** 是否已分配凭证号 */
  get isNumbered(): boolean {
    return this._voucherNo !== null;
  }

  // ------------------------------------------------------------ 校验
  /**
   * ★★ 结构校验：借贷平衡 + 金额正数 + 末级科目 + 辅助核算完整性
   *
   * 这是全系统最重要的一个方法。任何写入路径都必须先过它。
   */
  validateStructure(): BalanceResult {
    if (this._lines.length === 0) {
      throw new EmptyVoucherError(this.label);
    }

    // ---- 金额精度与正数 ----
    for (const [i, line] of this._lines.entries()) {
      const pos = `${this.label} 第 ${i + 1} 行`;
      if (!(line.amount instanceof Decimal)) {
        throw new InvalidAmountError(`${pos}金额不是 Decimal。金额运算禁止使用 number。`);
      }
      if (!line.amount.isFinite()) {
        throw new InvalidAmountError(`${pos}金额不是有效数值。`);
      }
      if (line.amount.decimalPlaces() > 2) {
        throw new InvalidAmountError(
          `${pos}金额精度超过 2 位小数：${line.amount.toString()}。请先四舍五入到分，不要依赖静默舍入。`,
        );
      }
      if (line.amount.lte(0)) {
        throw new InvalidAmountError(
          `${pos}金额必须大于 0（当前 ${line.amount.toFixed(2)}）。` +
            `负数金额请改用相反方向的 direction。`,
        );
      }
      if (line.direction !== 'DEBIT' && line.direction !== 'CREDIT') {
        throw new InvalidAmountError(`${pos}的借贷方向非法：${String(line.direction)}。`);
      }
    }

    // ---- 末级科目校验（仅当调用方提供了科目信息时）----
    for (const line of this._lines) {
      if (line.accountIsLeaf === false) {
        throw new NonLeafAccountError(line.accountCode, line.accountName ?? '');
      }
    }

    // ---- 辅助核算完整性 ----
    for (const line of this._lines) {
      const required = line.accountAuxRequired ?? [];
      if (required.length === 0) continue;
      const missing: string[] = [];
      for (const dim of required) {
        if (dim === 'CUSTOMER' || dim === 'SUPPLIER' || dim === 'EMPLOYEE') {
          if (!line.partnerId) missing.push(dim);
        } else if (dim === 'CONTRACT') {
          if (!line.contractId) missing.push(dim);
        } else if (dim === 'PROJECT') {
          if (!line.auxProject) missing.push(dim);
        } else if (dim === 'DEPARTMENT') {
          if (!line.auxDepartment) missing.push(dim);
        }
      }
      if (missing.length > 0) {
        throw new MissingAuxDimensionError(line.accountCode, line.accountName ?? '', missing);
      }
    }

    // ---- ★ 借贷平衡 ----
    //
    // checkBalance 会在单边凭证、金额非正、方向非法时抛 MoneyError。
    // 单边不是"不平"而是结构不合法，必须翻译成用户能看懂的中文错误，
    // 而不是把一个英文的 MoneyError 抛到界面上。
    let debitCount = 0;
    let creditCount = 0;
    for (const l of this._lines) {
      if (l.direction === 'DEBIT') debitCount += 1;
      else if (l.direction === 'CREDIT') creditCount += 1;
    }
    if (debitCount === 0 || creditCount === 0) {
      throw new SingleSidedVoucherError(debitCount, creditCount);
    }

    const lines = this._lines.map((l) => ({ direction: l.direction, amount: l.amount }));

    let result: BalanceResult;
    try {
      result = checkBalance(lines);
    } catch (e) {
      throw new InvalidAmountError(
        e instanceof Error ? `${this.label}：${e.message}` : `${this.label} 金额校验失败。`,
      );
    }

    if (!result.balanced) {
      throw new UnbalancedVoucherError(
        this.label,
        result.totalDebit.toFixed(2),
        result.totalCredit.toFixed(2),
        result.difference.toFixed(2),
      );
    }
    return result;
  }

  /** 校验期间是否允许写入 */
  assertPeriodWritable(period: PeriodInfo): void {
    if (period.status !== 'OPEN') {
      // 结账流程自身的结转凭证由调用方显式放行，领域层只负责拒绝普通写入
      throw new PeriodLockedError(periodLabel(period), period.status);
    }
    // 凭证日期必须落在期间内
    const d = this._voucherDate;
    if (d < period.startsOn || d > period.endsOn) {
      throw new PeriodDateMismatchError(d.toISOString().slice(0, 10), periodLabel(period));
    }
  }

  // ------------------------------------------------------------ 状态迁移
  /**
   * 状态迁移校验。
   *
   * ★ 只校验"目标状态是否可达"是不够的 —— 不同的操作可能共享同一个目标状态。
   *   真实踩到的坑：`rejectAfterReview`（已审核 → 待审核）的目标是 REVIEWING，
   *   而 DRAFT → REVIEWING 本来就是合法的「提交审核」，
   *   于是在草稿上调用"退回审核"不会报错，反而静默地把草稿又"提交"了一次。
   *
   *   所以这里再要求声明**来源状态**：操作必须从它语义上该有的状态出发，
   *   否则拒绝。这样每个动作的适用条件在领域层是明确的，不靠调用方自觉。
   */
  private assertTransition(
    to: VoucherStatus,
    hint?: string,
    from?: VoucherStatus | VoucherStatus[],
  ): void {
    const allowed = VOUCHER_TRANSITIONS[this._status] ?? [];
    if (!allowed.includes(to)) {
      throw new InvalidVoucherTransitionError(this.label, this._status, to, hint);
    }
    if (from !== undefined) {
      const fromList = Array.isArray(from) ? from : [from];
      if (!fromList.includes(this._status)) {
        const names = fromList.map((s) => zhStatus(s)).join(' 或 ');
        throw new InvalidVoucherTransitionError(
          this.label,
          this._status,
          to,
          `${hint ?? ''}本操作只能对「${names}」状态的凭证执行。`.trim(),
        );
      }
    }
  }

  /** 确保凭证未过账（过账后不可改） */
  private assertMutable(): void {
    if (this.isPosted) {
      throw new PostedVoucherImmutableError(this.label);
    }
  }

  // ---- 编辑（仅未过账时允许）----
  setLines(lines: LineDraft[]): void {
    this.assertMutable();
    this._lines = lines;
    this.validateStructure();
  }

  setSummary(summary: string): void {
    this.assertMutable();
    this._summary = summary;
  }

  setVoucherDate(date: Date): void {
    this.assertMutable();
    this._voucherDate = date;
  }

  setAttachments(n: number): void {
    this.assertMutable();
    this._attachments = Math.max(0, Math.trunc(n));
  }

  // ---- 提交流程 ----
  submit(): void {
    this.assertTransition('REVIEWING', undefined, ['DRAFT']);
    this.validateStructure();
    this._status = 'REVIEWING';
  }

  approve(reviewerId: string, at: Date = new Date()): void {
    this.assertTransition('APPROVED', undefined, ['REVIEWING']);
    this.validateStructure();
    this._status = 'APPROVED';
    this._reviewedBy = reviewerId;
    this._reviewedAt = at;
  }

  /**
   * 审核退回（待审核 → 草稿）。
   *
   * ★ 退回理由不是可选装饰：制单人看到「被退回了」却不知道为什么，
   *   只能靠猜或来问，流程就断了。所以理由必须记下来并回显。
   */
  reject(reviewerId: string, reason: string): void {
    // ★ 理由先校验：用户漏填理由时，"请填写理由"比"状态不对"有用得多；
    //   反过来会在状态也不对时报一个跟真实问题无关的错。
    const note = normalizeReason(reason, '审核退回');
    this.assertTransition('DRAFT', '如需修改请先退回草稿。', ['REVIEWING']);
    this._status = 'DRAFT';
    this._reviewedBy = reviewerId;
    this._reviewedAt = new Date();
    this._reviewNote = note;
  }

  /**
   * 过账前退回审核（已审核 → 待审核）。
   *
   * 为什么单独一条路径，而不是直接退到草稿：
   *   过账是复核动作。复核的人发现的是「审核那一步看漏了」，
   *   把状态退回「待审核」语义才对 —— 账已经审过一次，
   *   不该让制单人从头再来一遍，而该让审核人重新看。
   */
  rejectAfterReview(reason: string): void {
    const note = normalizeReason(reason, '过账前退回');
    this.assertTransition('REVIEWING', '只有已审核未过账的凭证可以退回审核。', ['APPROVED']);
    this._status = 'REVIEWING';
    this._reviewedBy = undefined;
    this._reviewedAt = undefined;
    this._reviewNote = note;
  }

  /** 反审核（已审核未过账 → 草稿） */
  unapprove(reason?: string): void {
    const note = normalizeReason(reason, '反审核退回');
    this.assertTransition('DRAFT', undefined, ['APPROVED']);
    this._status = 'DRAFT';
    this._reviewedBy = undefined;
    this._reviewedAt = undefined;
    this._reviewNote = note;
  }

  /**
   * ★ 过账：分配凭证号 + 标记状态。
   *   voucherNo 由调用方从 VoucherSequence 行锁取得后传入 —— 绝不用 MAX()+1。
   */
  post(voucherNo: number, postedBy: string, at: Date = new Date()): void {
    this.assertTransition('POSTED');
    this.validateStructure();

    if (!Number.isInteger(voucherNo) || voucherNo < 0) {
      throw new InvalidAmountError(`凭证号必须是非负整数，收到 ${voucherNo}。`);
    }
    // 年初余额凭证使用 0 号，正常凭证从 1 开始
    if (this._voucherWord !== OPENING_VOUCHER_WORD && voucherNo < 1) {
      throw new InvalidAmountError(`正常凭证的凭证号必须从 1 开始，收到 ${voucherNo}。`);
    }

    this._voucherNo = voucherNo;
    this._status = 'POSTED';
    this._postedBy = postedBy;
    this._postedAt = at;
  }

  /** 作废：仅未过账可作废，且必须填理由 */
  void(reason: string): void {
    this.assertTransition('VOID');
    if (!reason || reason.trim().length === 0) {
      throw new InvalidAmountError('作废凭证必须填写理由。');
    }
    this._voidReason = reason.trim();
    this._status = 'VOID';
  }

  /**
   * ★ 红冲：生成一张借贷方向与金额完全反向的新凭证。
   *
   * 为什么不是删原凭证？
   *   会计凭证是审计证据，只能追加冲销，不能抹掉历史。
   *   红冲后原凭证状态置 REVERSED，但**两者分录都参与余额计算**，
   *   相加净额为 0 —— 这正是很多自制记账工具翻车的地方。
   */
  buildReversal(options: {
    reversalDate: Date;
    operatorId: string;
    reason: string;
  }): NumberedVoucherDraft {
    if (this._status !== 'POSTED') {
      throw new InvalidVoucherTransitionError(
        this.label,
        this._status,
        'REVERSED',
        '只有已过账的凭证才能红冲。',
      );
    }

    const reversedLines: LineDraft[] = this._lines.map((l) => ({
      ...l,
      direction: l.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      amount: round2(l.amount),
      summary: `红冲：${l.summary ?? this._summary}`,
    }));

    // 幂等键用原凭证的稳定标识
    const stabilityKey = this.idempotencyKey ?? `${this.entityId}:${this.periodId}:${this.label}`;

    return {
      entityId: this.entityId,
      periodId: this.periodId,
      periodYear: this.periodYear,
      periodMonth: this.periodMonth,
      voucherWord: this._voucherWord,
      voucherDate: options.reversalDate,
      summary: `红冲 ${this.label}：${options.reason}`,
      lines: reversedLines,
      sourceType: 'MANUAL',
      sourceId: `REVERSE:${stabilityKey}`,
      idempotencyKey: `REVERSE:${stabilityKey}`,
      attachments: 0,
      createdBy: options.operatorId,
    };
  }

  /** 标记为已被红冲 */
  markReversed(reversalVoucherId: string): void {
    if (this._status !== 'POSTED') {
      throw new InvalidVoucherTransitionError(this.label, this._status, 'REVERSED');
    }
    this._status = 'REVERSED';
    this._reversedById = reversalVoucherId;
  }

  // ------------------------------------------------------------ 汇总
  /** 借方合计 */
  get totalDebit(): Decimal {
    return this._lines
      .filter((l) => l.direction === 'DEBIT')
      .reduce((s, l) => s.plus(l.amount), new Decimal(0));
  }

  /** 贷方合计 */
  get totalCredit(): Decimal {
    return this._lines
      .filter((l) => l.direction === 'CREDIT')
      .reduce((s, l) => s.plus(l.amount), new Decimal(0));
  }

  /** 借贷发生额是否相等 */
  get isBalanced(): boolean {
    return this.totalDebit.equals(this.totalCredit) && this.totalDebit.gt(0);
  }

  /** 按科目聚合（用于余额计算预览） */
  aggregateByAccount(): Map<
    string,
    { accountId: string; accountCode: string; debit: Decimal; credit: Decimal }
  > {
    const map = new Map<
      string,
      { accountId: string; accountCode: string; debit: Decimal; credit: Decimal }
    >();
    for (const line of this._lines) {
      const key = line.accountId;
      const cur = map.get(key) ?? {
        accountId: line.accountId,
        accountCode: line.accountCode,
        debit: new Decimal(0),
        credit: new Decimal(0),
      };
      if (line.direction === 'DEBIT') cur.debit = cur.debit.plus(line.amount);
      else cur.credit = cur.credit.plus(line.amount);
      map.set(key, cur);
    }
    return map;
  }

  /** 状态中文名，用于界面 */
  get statusZh(): string {
    return zhStatus(this._status);
  }
}


/**
 * 退回理由的规范化。
 *
 * 退回是「有后果的动作」（凭证被打回、制单人被要求返工），
 * 所以理由不允许留空 —— 留空的退回等于把人卡住却不说原因。
 * 这条规则放在领域层，不靠界面校验（界面可以被绕过）。
 */
function normalizeReason(reason: string | undefined, fallback: string): string {
  const s = (reason ?? '').trim();
  if (s === '') {
    // ★ 必须抛 DomainError 而不是 Error：
    //   异常过滤器只认 DomainError，普通 Error 会掉进兜底分支变成
    //   "系统内部错误（500）" —— 用户看到 500 会以为系统坏了、会去重试，
    //   而这其实是一个"你没填理由"的入参问题。
    // ★ 不传 technicalMessage：DomainError 用它当 Error.message，
    //   于是日志与异常过滤器里看到的是 "reason 为空" 而不是那句人话。
    //   这句提示本身既是给用户的、也是给日志的，不必另造一句更短的。
    throw new DomainError(
      'BK_E_REASON_REQUIRED',
      `${fallback}必须填写理由 —— 否则被退回的人不知道要改什么，只能来问，流程就卡住了。`,
      400,
    );
  }
  return s;
}