/**
 * 领域错误
 * ============================================================
 * 每个错误都带：
 *   code        机器可识别（与数据库触发器抛出的 BK_E_* 对应）
 *   userMessage 面向用户的中文说明 —— 必须说清「哪里错了」+「该怎么办」
 *
 * 设计原则：错误信息是给用户看的，不是给日志看的。
 * 「凭证借贷不平」不如「记-5 借方合计 1,000.00，贷方合计 900.00，差额 100.00」。
 */

export class DomainError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly httpStatus: number;

  constructor(code: string, userMessage: string, httpStatus = 400, technicalMessage?: string) {
    super(technicalMessage ?? userMessage);
    this.name = new.target.name;
    this.code = code;
    this.userMessage = userMessage;
    this.httpStatus = httpStatus;
  }
}

/** 借贷不平 —— 最严重的错误，绝不允许落库 */
export class UnbalancedVoucherError extends DomainError {
  constructor(label: string, totalDebit: string, totalCredit: string, difference: string) {
    super(
      'BK_E_UNBALANCED',
      `${label}借贷不平：借方合计 ${totalDebit}，贷方合计 ${totalCredit}，差额 ${difference}。凭证未保存。`,
      400,
    );
  }
}

/** 凭证没有任何分录行 */
export class EmptyVoucherError extends DomainError {
  constructor(label = '凭证') {
    super('BK_E_NO_LINES', `${label}没有任何分录行，无法保存。`, 400);
  }
}

/** 单边凭证（只有借方或只有贷方） */
export class SingleSidedVoucherError extends DomainError {
  constructor(debitCount: number, creditCount: number) {
    super(
      'BK_E_SINGLE_SIDED',
      `凭证必须同时有借方和贷方分录，当前 借 ${debitCount} 条 / 贷 ${creditCount} 条。`,
      400,
    );
  }
}

/** 金额非法（非正数、精度超限、类型错误） */
export class InvalidAmountError extends DomainError {
  constructor(userMessage: string) {
    super('BK_E_INVALID_AMOUNT', userMessage, 400);
  }
}

/** 期间已结账 */
export class PeriodLockedError extends DomainError {
  constructor(periodLabel: string, status: string) {
    super(
      'BK_E_PERIOD_LOCKED',
      `会计期间 ${periodLabel} 已结账（状态 ${status}），不允许写入凭证。` +
        `如需修改，请先在结账页执行「反结账」并填写理由。`,
      409,
    );
  }
}

/** 期间未找到 */
export class PeriodNotFoundError extends DomainError {
  constructor(periodLabel: string) {
    super('BK_E_PERIOD_NOT_FOUND', `找不到会计期间 ${periodLabel}。请先初始化该年度的会计期间。`, 404);
  }
}

/** 非末级科目记账 */
export class NonLeafAccountError extends DomainError {
  constructor(code: string, name: string) {
    super(
      'BK_E_NON_LEAF_ACCOUNT',
      `科目 ${code} ${name} 不是末级科目，不允许记账。请选择其下级明细科目。`,
      400,
    );
  }
}

/** 科目已停用或不存在 */
export class AccountUnavailableError extends DomainError {
  constructor(code: string, reason: string) {
    super('BK_E_ACCOUNT_UNAVAILABLE', `科目 ${code} ${reason}，不允许记账。`, 400);
  }
}

/** 凭证状态机非法迁移 */
export class InvalidVoucherTransitionError extends DomainError {
  constructor(label: string, from: string, to: string, hint?: string) {
    super(
      'BK_E_INVALID_TRANSITION',
      `${label} 不能从「${zhStatus(from)}」变更为「${zhStatus(to)}」。${hint ?? ''}`.trim(),
      409,
    );
  }
}

/** 已过账凭证不可修改 */
export class PostedVoucherImmutableError extends DomainError {
  constructor(label: string) {
    super(
      'BK_E_POSTED_IMMUTABLE',
      `${label} 已过账，不允许修改。如需更正，请对该凭证执行红冲（生成一张反向凭证），` +
        `而不是直接改原凭证。`,
      409,
    );
  }
}

/** 缺少必需的辅助核算维度 */
export class MissingAuxDimensionError extends DomainError {
  constructor(code: string, name: string, missing: string[]) {
    super(
      'BK_E_MISSING_AUX',
      `科目 ${code} ${name} 要求填写辅助核算：${missing.map(zhAux).join('、')}，当前为空。`,
      400,
    );
  }
}

/** 凭证日期与所属期间不符 */
export class PeriodDateMismatchError extends DomainError {
  constructor(date: string, periodLabel: string) {
    super(
      'BK_E_PERIOD_DATE_MISMATCH',
      `凭证日期 ${date} 不在所属会计期间 ${periodLabel} 内。`,
      400,
    );
  }
}

/** 结账检查未通过 */
export class CloseBlockedError extends DomainError {
  constructor(blockers: Array<{ name: string; detail?: string }>) {
    const lines = blockers.map((b) => `  · ${b.name}${b.detail ? `：${b.detail}` : ''}`).join('\n');
    super(
      'BK_E_CLOSE_BLOCKED',
      `结账前检查未通过，存在 ${blockers.length} 项必须解决的问题：\n${lines}`,
      409,
    );
  }
}

/** 已申报的期间不允许反结账 */
export class PeriodAlreadyFiledError extends DomainError {
  constructor(periodLabel: string, taxType: string) {
    super(
      'BK_E_ALREADY_FILED',
      `会计期间 ${periodLabel} 的 ${taxType} 申报表已标记为「已申报」，不允许反结账。` +
        `账与申报表必须保持一致。如需更正，请先办理更正申报。`,
      409,
    );
  }
}

// ---------------------------------------------------------------- 中文映射
const STATUS_ZH: Record<string, string> = {
  DRAFT: '草稿',
  REVIEWING: '待审核',
  APPROVED: '已审核',
  POSTED: '已过账',
  REVERSED: '已红冲',
  VOID: '已作废',
};

const AUX_ZH: Record<string, string> = {
  CUSTOMER: '客户',
  SUPPLIER: '供应商',
  EMPLOYEE: '员工',
  PROJECT: '项目',
  DEPARTMENT: '部门',
  CONTRACT: '合同',
};

export function zhStatus(status: string): string {
  return STATUS_ZH[status] ?? status;
}

export function zhAux(aux: string): string {
  return AUX_ZH[aux] ?? aux;
}

/**
 * 业务规则错误（可安全展示给用户）
 * ============================================================
 * 与 DomainError 的区别：
 *   DomainError  —— 针对某个具体不变式（借贷平衡、期间锁…），有专属错误码
 *   BusinessRuleError —— 通用的"用户操作不合法"，只需一句可读说明
 *
 * 为什么需要它：服务层里会有大量"这类输入不合法"的校验。
 * 如果直接 throw new Error(...)，会落到异常过滤器的兜底分支，
 * 用户看到的是「系统内部错误」，完全不知道自己做错了什么。
 */
export class BusinessRuleError extends DomainError {
  constructor(userMessage: string, code = 'BK_E_BUSINESS_RULE', httpStatus = 400) {
    super(code, userMessage, httpStatus);
  }
}