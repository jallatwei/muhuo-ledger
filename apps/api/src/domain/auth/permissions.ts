/**
 * 权限模型
 * ============================================================
 * 三种角色，权限边界写死在代码里（不靠调用方自觉）：
 *
 *   OWNER      实控人 —— 全部权限。注册公司的人默认是这个角色。
 *   ACCOUNTANT 会计   —— 记账、结账、报税全都能做，但**不能删除主体**，
 *                       也不能改主体的税务登记信息（那会改变报表口径）。
 *   VIEWER     只读   —— 能看账、看报表、打印，不能做任何写操作。
 *
 * ★ 为什么要做成显式权限表，而不是在每个接口里写 `if (role === 'OWNER')`：
 *   散落的角色判断会出现"这个接口忘了加检查"的漏洞，而且没人能一眼看出
 *   「会计到底能做什么」。集中成一张表之后：
 *     · 新增接口时按 action 声明所需权限，忘了声明会走到拒绝分支
 *     · 权限变更只改一处，审计时能直接回答"某角色能否做某操作"
 */
import { DomainError } from '../accounting/errors';

export const MEMBERSHIP_ROLE = {
  OWNER: 'OWNER',
  ACCOUNTANT: 'ACCOUNTANT',
  VIEWER: 'VIEWER',
} as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLE)[keyof typeof MEMBERSHIP_ROLE];

export const ROLE_LABEL: Record<MembershipRole, string> = {
  OWNER: '实控人',
  ACCOUNTANT: '会计',
  VIEWER: '只读',
};

/**
 * 权限动作清单。
 *
 * ★ 按"业务动作"而不是按"接口"划分 —— 一个动作可能被多个接口使用，
 *   而接口会增删；动作是稳定的。
 */
export const ACTION = {
  /** 读账簿、报表、凭证 */
  READ: 'READ',
  /** 新建/修改凭证 */
  WRITE_VOUCHER: 'WRITE_VOUCHER',
  /** 审核凭证 */
  APPROVE_VOUCHER: 'APPROVE_VOUCHER',
  /** 过账（分配凭证号，影响余额） */
  POST_VOUCHER: 'POST_VOUCHER',
  /** 红冲 / 作废 */
  REVERSE_VOUCHER: 'REVERSE_VOUCHER',
  /** 月末结账 / 反结账 */
  CLOSE_PERIOD: 'CLOSE_PERIOD',
  /** 导入单据、识别录入 */
  IMPORT_DOCUMENT: 'IMPORT_DOCUMENT',
  /** 历史数据导入与期初建账 */
  IMPORT_HISTORY: 'IMPORT_HISTORY',
  /** 生成申报底稿 */
  GENERATE_TAX_WORKSHEET: 'GENERATE_TAX_WORKSHEET',
  /** 执行税务政策检索 */
  RUN_POLICY_SEARCH: 'RUN_POLICY_SEARCH',
  /** 维护科目表、往来单位、规则 */
  MANAGE_MASTER_DATA: 'MANAGE_MASTER_DATA',
  /** 修改主体的税务登记信息、会计准则 */
  MANAGE_ENTITY_SETTINGS: 'MANAGE_ENTITY_SETTINGS',
  /** 邀请/移除成员、改角色 */
  MANAGE_MEMBERS: 'MANAGE_MEMBERS',
  /** 删除主体（不可逆） */
  DELETE_ENTITY: 'DELETE_ENTITY',
} as const;

export type Action = (typeof ACTION)[keyof typeof ACTION];

/**
 * 角色 → 允许的动作。
 *
 * ★ 三处刻意的限制，都是"做了就难挽回"的操作：
 *   ① 会计不能 DELETE_ENTITY —— 删主体会连账簿一起删
 *   ② 会计不能 MANAGE_ENTITY_SETTINGS —— 改会计准则/纳税人身份会让历史报表口径变化
 *   ③ 只读连 IMPORT_DOCUMENT 都不给 —— 导入会写数据
 */
const ROLE_ACTIONS: Record<MembershipRole, readonly Action[]> = {
  OWNER: Object.values(ACTION),

  ACCOUNTANT: [
    ACTION.READ,
    ACTION.WRITE_VOUCHER,
    ACTION.APPROVE_VOUCHER,
    ACTION.POST_VOUCHER,
    ACTION.REVERSE_VOUCHER,
    ACTION.CLOSE_PERIOD,
    ACTION.IMPORT_DOCUMENT,
    ACTION.IMPORT_HISTORY,
    ACTION.GENERATE_TAX_WORKSHEET,
    ACTION.RUN_POLICY_SEARCH,
    ACTION.MANAGE_MASTER_DATA,
    // 不含 MANAGE_ENTITY_SETTINGS / MANAGE_MEMBERS / DELETE_ENTITY
  ],

  VIEWER: [ACTION.READ],
};

export function can(role: MembershipRole, action: Action): boolean {
  return (ROLE_ACTIONS[role] ?? []).includes(action);
}

/**
 * 断言权限。不通过时抛出**说清楚原因**的错误。
 *
 * ★ 错误信息里要写"你是什么角色、这个操作需要什么" ——
 *   只回一句"无权限"会让人反复重试或来问，而实际上他需要做的是
 *   请实控人改角色。把出路写在错误里。
 */
export function assertCan(role: MembershipRole, action: Action, actionLabel: string): void {
  if (can(role, action)) return;

  const need = requiredRolesFor(action);
  throw new DomainError(
    'BK_E_FORBIDDEN',
    `当前身份是「${ROLE_LABEL[role]}」，无权执行「${actionLabel}」。` +
      `该操作需要「${need.map((r) => ROLE_LABEL[r]).join(' 或 ')}」权限 —— ` +
      '请联系这家公司的实控人在成员管理里调整你的角色。',
    403,
    `role=${role} action=${action}`,
  );
}

/** 哪些角色可以做某动作（用于错误提示与界面按钮禁用） */
export function requiredRolesFor(action: Action): MembershipRole[] {
  return (Object.keys(ROLE_ACTIONS) as MembershipRole[]).filter((r) => can(r, action));
}

/** 某角色的全部权限（给界面渲染权限矩阵用） */
export function actionsOf(role: MembershipRole): Action[] {
  return [...(ROLE_ACTIONS[role] ?? [])];
}

/** 是否为合法角色字符串 */
export function isMembershipRole(v: unknown): v is MembershipRole {
  return typeof v === 'string' && v in ROLE_ACTIONS;
}
