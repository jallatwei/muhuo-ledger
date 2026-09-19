/**
 * 认证与账号服务
 * ============================================================
 * 三件事：注册（个人 / 公司）、登录、鉴权。
 *
 * ★ 设计要点：
 *
 *   ① **密码只存哈希**（bcrypt，cost 12）。
 *      明文、可逆加密一律不允许 —— 记账系统里的账号往往复用到别处，
 *      泄露的代价远超这个系统本身。
 *
 *   ② **"能进哪家公司"由服务端判定**，绝不信客户端传的 entityId。
 *      这是本模块最重要的安全边界：现在的接口都接受任意 entityId，
 *      加认证之后必须校验「当前用户是不是这家公司的成员」。
 *
 *   ③ **注册公司 = 建主体 + 建账套**，一次事务完成。
 *      半途失败会留下"有公司没科目表"的废主体，那种状态没法用也没法删。
 *
 *   ④ **首个注册者自动成为平台管理员**。
 *      否则系统装好后没有任何人能管理成员，等于锁死自己。
 *      这是自助部署系统的常见需求，但只在**一个用户都没有时**生效。
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../infrastructure/prisma/audit.service';
import { DomainError } from '../../domain/accounting/errors';
import {
  ACTION,
  MEMBERSHIP_ROLE,
  ROLE_LABEL,
  actionsOf,
  assertCan,
  isMembershipRole,
  type Action,
  type MembershipRole,
} from '../../domain/auth/permissions';
import { BUILTIN_ACCOUNTS } from '../../domain/accounting/chart-of-accounts';
import {
  buildPeriodRows,
  upsertBuiltinAccounts,
  type AccountUpsertClient,
} from '../../domain/accounting/account-tree';
import type { Env } from '../../config/env';

/** bcrypt 成本因子。12 在现代硬件上约 250ms，足够慢到难以暴力破解，又不影响体验 */
const BCRYPT_ROUNDS = 12;

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  accountType: string;
  isPlatformAdmin: boolean;
}

export interface MembershipInfo {
  entityId: string;
  entityName: string;
  role: MembershipRole;
  roleLabel: string;
  actions: Action[];
}

export interface LoginResult {
  token: string;
  expiresIn: string;
  user: AuthUser;
  memberships: MembershipInfo[];
  /** 当前默认进入哪个主体（没有则为 null，前端应引导去注册公司） */
  defaultEntityId: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private get env(): Env {
    return this.config.get<Env>('env') as Env;
  }

  // ==========================================================================
  //  注册
  // ==========================================================================

  /** 系统里是否还没有任何用户 —— 用于判断"首个注册者" */
  async hasAnyUser(): Promise<boolean> {
    const count = await this.prisma.user.count();
    return count > 0;
  }

  /** 注册前的引导信息（前端据此决定显示"个人注册"还是"公司注册"） */
  async registrationInfo() {
    const userCount = await this.prisma.user.count();
    return {
      /** 系统是否尚未初始化 —— 首个注册者会成为平台管理员 */
      isFirstUser: userCount === 0,
      userCount,
      canRegister: true,
      note:
        userCount === 0
          ? '这是系统的第一个账号，将自动成为平台管理员。'
          : '注册后将创建一个新的公司账套，你是该公司的实控人。',
    };
  }

  /**
   * 注册用户（可同时创建公司账套）。
   *
   * 两种用法：
   *   · 只传用户信息 → 个人账号，之后再去「公司注册」建主体
   *   · 同时传 company → 一步到位：建账号 + 建主体 + 建账套 + 建立 OWNER 关系
   */
  async register(input: {
    email: string;
    password: string;
    displayName: string;
    phone?: string;
    accountType?: 'PERSONAL' | 'COMPANY_STAFF';
    company?: {
      name: string;
      unifiedSocialCreditCode?: string;
      taxpayerType?: 'GENERAL' | 'SMALL_SCALE';
      legalPerson?: string;
      address?: string;
      phone?: string;
      /** 账套启用年度（默认今年） */
      startYear?: number;
    };
  }): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    assertEmail(email);
    assertPassword(input.password);

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new DomainError(
        'BK_E_EMAIL_TAKEN',
        `邮箱 ${email} 已被注册。请直接登录；若忘记密码，请联系平台管理员重置。`,
        409,
        'email 已存在',
      );
    }

    const isFirstUser = (await this.prisma.user.count()) === 0;
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // ★ 整个注册（含建主体与账套）放在一个事务里。
    //   半途失败会留下"有公司没科目表"的废主体 —— 那种状态既不能用也不能删。
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          displayName: input.displayName.trim() || email.split('@')[0]!,
          phone: input.phone ?? null,
          accountType: input.accountType ?? (input.company ? 'COMPANY_STAFF' : 'PERSONAL'),
          // 首个注册者成为平台管理员，否则装好后没人能管理成员
          isPlatformAdmin: isFirstUser,
        },
      });

      let entityId: string | null = null;

      if (input.company) {
        const company = input.company;
        const entity = await tx.entity.create({
          data: {
            name: company.name.trim(),
            unifiedSocialCreditCode: company.unifiedSocialCreditCode?.trim() || null,
            taxpayerType: company.taxpayerType ?? 'GENERAL',
            legalPerson: company.legalPerson?.trim() || null,
            address: company.address?.trim() || null,
            phone: company.phone?.trim() || null,
            // 会计准则固定为小企业会计准则 —— 本系统的科目表与报表口径都基于它，
            // 允许改会让所有内置映射失效
            accountingStandard: 'SMALL_ENTERPRISE_2013',
          },
        });
        entityId = entity.id;

        // 建立 OWNER 关系（谁注册的公司谁是实控人）
        await tx.membership.create({
          data: {
            userId: user.id,
            entityId: entity.id,
            role: MEMBERSHIP_ROLE.OWNER,
          },
        });

        // 建账套：科目表 + 会计期间
        await this.initializeLedger(tx, entity.id, company.startYear ?? new Date().getFullYear());
      }

      return { user, entityId };
    });

    const memberships = await this.listMemberships(result.user.id);
    const token = await this.signToken(result.user.id, result.user.email);

    await this.audit.record({
      entityId: result.entityId ?? '',
      userId: result.user.id,
      action: 'CREATE',
      subjectType: 'User',
      subjectId: result.user.id,
      reason: '注册账号',
      afterData: {
        email,
        accountType: result.user.accountType,
        isPlatformAdmin: isFirstUser,
        companyCreated: !!input.company,
      },
    });

    this.logger.log(
      `注册：${email}${isFirstUser ? '（首个用户，已设为平台管理员）' : ''}` +
        `${input.company ? `，并创建公司「${input.company.name}」` : ''}`,
    );

    return {
      token,
      expiresIn: this.env.JWT_EXPIRES_IN,
      user: toAuthUser(result.user),
      memberships,
      defaultEntityId: memberships[0]?.entityId ?? null,
    };
  }

  /**
   * 为公司注册账套（已有账号，再建一家公司）。
   *
   * 与注册时的建账套走同一段逻辑，避免两处口径不一致 ——
   * 小企业主开第二家公司是常见需求。
   */
  async registerEntity(params: {
    userId: string;
    company: {
      name: string;
      unifiedSocialCreditCode?: string;
      taxpayerType?: 'GENERAL' | 'SMALL_SCALE';
      legalPerson?: string;
      address?: string;
      phone?: string;
      startYear?: number;
    };
  }): Promise<{ entityId: string; entityName: string; membership: MembershipInfo }> {
    const userId = params.userId;
    const company = params.company;

    if (!company?.name || company.name.trim() === '') {
      throw new DomainError('BK_E_BAD_REQUEST', '请填写公司名称。', 400, 'company.name 为空');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new DomainError('BK_E_UNAUTHORIZED', '登录状态已失效，请重新登录。', 401, 'user 不存在');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const entity = await tx.entity.create({
        data: {
          name: company.name.trim(),
          unifiedSocialCreditCode: company.unifiedSocialCreditCode?.trim() || null,
          taxpayerType: company.taxpayerType ?? 'GENERAL',
          legalPerson: company.legalPerson?.trim() || null,
          address: company.address?.trim() || null,
          phone: company.phone?.trim() || null,
          accountingStandard: 'SMALL_ENTERPRISE_2013',
        },
      });

      await tx.membership.create({
        data: { userId, entityId: entity.id, role: MEMBERSHIP_ROLE.OWNER },
      });

      const year = company.startYear ?? new Date().getFullYear();
      await this.initializeLedger(tx, entity.id, year);

      return entity;
    });

    await this.audit.record({
      entityId: created.id,
      userId,
      action: 'CREATE',
      subjectType: 'Entity',
      subjectId: created.id,
      reason: `注册公司账套：${created.name}`,
    });

    this.logger.log(`新账套：${created.name}（${created.id}），实控人 ${user.email}`);

    const memberships = await this.listMemberships(userId);
    const membership = memberships.find((m) => m.entityId === created.id)!;

    return { entityId: created.id, entityName: created.name, membership };
  }

  // ==========================================================================
  //  登录
  // ==========================================================================

  async login(params: { email: string; password: string; ip?: string; userAgent?: string }): Promise<LoginResult> {
    const email = normalizeEmail(params.email);

    const user = await this.prisma.user.findUnique({ where: { email } });

    // ★ 用户不存在与密码错误返回**同一个**错误。
    //   区分开会让攻击者能枚举出哪些邮箱已注册。
    if (!user || !(await bcrypt.compare(params.password, user.passwordHash))) {
      throw new DomainError(
        'BK_E_BAD_CREDENTIALS',
        '邮箱或密码不正确。请检查后重试；连续失败过多请联系平台管理员。',
        401,
        '凭据不匹配',
      );
    }

    if (!user.isActive) {
      throw new DomainError(
        'BK_E_ACCOUNT_DISABLED',
        '该账号已被停用。请联系平台管理员。',
        403,
        'isActive=false',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const memberships = await this.listMemberships(user.id);
    const token = await this.signToken(user.id, user.email);

    await this.audit.record({
      entityId: memberships[0]?.entityId ?? '',
      userId: user.id,
      action: 'LOGIN',
      subjectType: 'User',
      subjectId: user.id,
      ip: params.ip,
      userAgent: params.userAgent,
    });

    return {
      token,
      expiresIn: this.env.JWT_EXPIRES_IN,
      user: toAuthUser(user),
      memberships,
      defaultEntityId: memberships[0]?.entityId ?? null,
    };
  }

  /** 校验令牌并返回当前身份（含可访问的主体列表） */
  async me(userId: string): Promise<{
    user: AuthUser;
    memberships: MembershipInfo[];
    defaultEntityId: string | null;
  }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new DomainError('BK_E_UNAUTHORIZED', '登录状态已失效，请重新登录。', 401, 'user 不存在');
    }
    if (!user.isActive) {
      throw new DomainError('BK_E_ACCOUNT_DISABLED', '该账号已被停用。', 403, 'isActive=false');
    }

    const memberships = await this.listMemberships(user.id);
    return { user: toAuthUser(user), memberships, defaultEntityId: memberships[0]?.entityId ?? null };
  }

  async changePassword(params: {
    userId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: params.userId } });
    if (!user) {
      throw new DomainError('BK_E_UNAUTHORIZED', '登录状态已失效，请重新登录。', 401, 'user 不存在');
    }

    if (!(await bcrypt.compare(params.currentPassword, user.passwordHash))) {
      throw new DomainError('BK_E_BAD_CREDENTIALS', '当前密码不正确。', 401, '旧密码不匹配');
    }
    assertPassword(params.newPassword);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(params.newPassword, BCRYPT_ROUNDS) },
    });

    await this.audit.record({
      entityId: '',
      userId: user.id,
      action: 'UPDATE',
      subjectType: 'User',
      subjectId: user.id,
      reason: '修改密码',
    });

    return { ok: true };
  }

  // ==========================================================================
  //  鉴权（被 Guard 调用）
  // ==========================================================================

  /**
   * 校验「当前用户能否以某角色访问某个主体」。
   *
   * ★ 这是整个认证体系的核心边界：在此之前，任何请求都能带任意 entityId，
   *   也就是说任何登录用户都能看到别家公司的账 —— 对小企业来说这是致命的。
   */
  async resolveMembership(userId: string, entityId: string): Promise<MembershipInfo> {
    const m = await this.prisma.membership.findUnique({
      where: { userId_entityId: { userId, entityId } },
      include: { entity: { select: { name: true, isActive: true } } },
    });

    if (!m || !m.isActive) {
      throw new DomainError(
        'BK_E_NOT_MEMBER',
        '你不是这家公司的成员，无法访问其数据。' +
          '若确认应该有权限，请联系该公司的实控人把你加入成员。',
        403,
        `userId=${userId} entityId=${entityId}`,
      );
    }
    if (!m.entity.isActive) {
      throw new DomainError(
        'BK_E_ENTITY_DISABLED',
        `公司「${m.entity.name}」已停用，无法访问。`,
        403,
        'entity.isActive=false',
      );
    }

    const role = isMembershipRole(m.role) ? m.role : MEMBERSHIP_ROLE.VIEWER;
    return {
      entityId,
      entityName: m.entity.name,
      role,
      roleLabel: ROLE_LABEL[role],
      actions: actionsOf(role),
    };
  }

  /** 校验权限。供 Guard 与控制器调用 */
  assertAction(membership: MembershipInfo, action: Action, label: string): void {
    assertCan(membership.role, action, label);
  }

  // ==========================================================================
  //  成员管理
  // ==========================================================================

  async listMembers(entityId: string): Promise<
    Array<{
      membershipId: string;
      userId: string;
      email: string;
      displayName: string;
      role: MembershipRole;
      roleLabel: string;
      isActive: boolean;
      createdAt: Date;
    }>
  > {
    const rows = await this.prisma.membership.findMany({
      where: { entityId },
      include: { user: { select: { email: true, displayName: true, isActive: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      email: m.user.email,
      displayName: m.user.displayName,
      role: isMembershipRole(m.role) ? m.role : MEMBERSHIP_ROLE.VIEWER,
      roleLabel: ROLE_LABEL[isMembershipRole(m.role) ? m.role : MEMBERSHIP_ROLE.VIEWER],
      isActive: m.isActive,
      createdAt: m.createdAt,
    }));
  }

  /**
   * 把已注册用户加入公司。
   *
   * ★ 只允许加入**已注册**的邮箱，不自动创建账号：
   *   自动建号意味着实控人能用别人的邮箱开户，而对方毫不知情。
   *   正确流程是让对方先自己注册，再由实控人邀请进来。
   */
  async addMember(params: {
    entityId: string;
    operatorId: string;
    email: string;
    role: string;
  }): Promise<{ membershipId: string }> {
    if (!isMembershipRole(params.role)) {
      throw new DomainError(
        'BK_E_BAD_REQUEST',
        `未知角色「${params.role}」。可选：OWNER（实控人）/ ACCOUNTANT（会计）/ VIEWER（只读）。`,
        400,
        'role 非法',
      );
    }

    const email = normalizeEmail(params.email);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new DomainError(
        'BK_E_USER_NOT_FOUND',
        `邮箱 ${email} 还没有注册账号。请让对方先自行注册，然后再加入成员 —— ` +
          '系统不会替别人创建账号。',
        404,
        'user 不存在',
      );
    }

    const existing = await this.prisma.membership.findUnique({
      where: { userId_entityId: { userId: user.id, entityId: params.entityId } },
    });
    if (existing) {
      const role = isMembershipRole(existing.role) ? existing.role : 'VIEWER';
      throw new DomainError(
        'BK_E_ALREADY_MEMBER',
        `${email} 已是本公司成员（当前角色：${ROLE_LABEL[role]}）。` +
          '如需变更角色，请直接修改该成员的角色。',
        409,
        'membership 已存在',
      );
    }

    const created = await this.prisma.membership.create({
      data: {
        userId: user.id,
        entityId: params.entityId,
        role: params.role,
        invitedBy: params.operatorId,
      },
    });

    await this.audit.record({
      entityId: params.entityId,
      userId: params.operatorId,
      action: 'CREATE',
      subjectType: 'Membership',
      subjectId: created.id,
      reason: `加入成员 ${email}，角色 ${ROLE_LABEL[params.role]}`,
    });

    return { membershipId: created.id };
  }

  /**
   * 变更成员角色。
   *
   * ★ 不允许把最后一个实控人降级 —— 否则这家公司再也没人能管成员，
   *   变成谁也改不动的僵尸主体。
   */
  async changeMemberRole(params: {
    entityId: string;
    operatorId: string;
    membershipId: string;
    role: string;
  }): Promise<{ ok: true }> {
    if (!isMembershipRole(params.role)) {
      throw new DomainError('BK_E_BAD_REQUEST', `未知角色「${params.role}」。`, 400, 'role 非法');
    }

    const target = await this.prisma.membership.findFirst({
      where: { id: params.membershipId, entityId: params.entityId },
      include: { user: { select: { email: true } } },
    });
    if (!target) {
      throw new DomainError('BK_E_NOT_FOUND', '该成员不存在。', 404, 'membership 不存在');
    }

    const currentRole = isMembershipRole(target.role) ? target.role : 'VIEWER';
    if (currentRole === MEMBERSHIP_ROLE.OWNER && params.role !== MEMBERSHIP_ROLE.OWNER) {
      const ownerCount = await this.prisma.membership.count({
        where: { entityId: params.entityId, role: MEMBERSHIP_ROLE.OWNER, isActive: true },
      });
      if (ownerCount <= 1) {
        throw new DomainError(
          'BK_E_LAST_OWNER',
          '这是本公司唯一的实控人，不能降级 —— 否则将没有人能管理成员，' +
            '公司会变成谁也改不动的状态。请先指定另一位实控人。',
          400,
          '最后一个 OWNER',
        );
      }
    }

    await this.prisma.membership.update({
      where: { id: target.id },
      data: { role: params.role },
    });

    await this.audit.record({
      entityId: params.entityId,
      userId: params.operatorId,
      action: 'UPDATE',
      subjectType: 'Membership',
      subjectId: target.id,
      reason: `角色变更：${ROLE_LABEL[currentRole]} → ${ROLE_LABEL[params.role]}（${target.user.email}）`,
      beforeData: { role: currentRole },
      afterData: { role: params.role },
    });

    return { ok: true };
  }

  // ==========================================================================
  //  内部
  // ==========================================================================

  /**
   * 初始化账套：科目表 + 当年会计期间。
   *
   * ★ 与 seed 脚本共用同一份实现（upsertBuiltinAccounts / buildPeriodRows）。
   *   两处各写一份的话，只要有一处口径变了（fullName 分隔符、isLeaf 判定），
   *   新老主体的科目表就会不一致，而科目表不一致会让报表口径分叉 ——
   *   这类问题要等到出报表时才暴露，那时已经录了几个月的账。
   */
  private async initializeLedger(
    tx: {
      account: {
        upsert: (args: never) => Promise<{ id: string }>;
        updateMany: (args: never) => Promise<unknown>;
      };
      period: { createMany: (args: never) => Promise<unknown> };
    },
    entityId: string,
    year: number,
  ): Promise<void> {
    // ① 科目表：约 138 个，含父子层级
    await upsertBuiltinAccounts(
      { account: tx.account } as unknown as AccountUpsertClient,
      entityId,
      BUILTIN_ACCOUNTS,
    );

    // ② 会计期间：建 12 个月
    await tx.period.createMany({ data: buildPeriodRows(entityId, year) } as never);

    // ③ 凭证号分配器不预建：VoucherNumberService 首次过账时用行锁创建，
    //    预建反而会因为期间增删而失配。
  }

  private async listMemberships(userId: string): Promise<MembershipInfo[]> {
    const rows = await this.prisma.membership.findMany({
      where: { userId, isActive: true, entity: { isActive: true } },
      include: { entity: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((m) => {
      const role = isMembershipRole(m.role) ? m.role : MEMBERSHIP_ROLE.VIEWER;
      return {
        entityId: m.entity.id,
        entityName: m.entity.name,
        role,
        roleLabel: ROLE_LABEL[role],
        actions: actionsOf(role),
      };
    });
  }

  private async signToken(userId: string, email: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, email },
      { secret: this.env.JWT_SECRET, expiresIn: this.env.JWT_EXPIRES_IN },
    );
  }

  /** 校验令牌（由 Guard 调用） */
  async verifyToken(token: string): Promise<{ sub: string; email: string }> {
    try {
      return await this.jwt.verifyAsync<{ sub: string; email: string }>(token, {
        secret: this.env.JWT_SECRET,
      });
    } catch {
      throw new DomainError(
        'BK_E_UNAUTHORIZED',
        '登录已过期或令牌无效，请重新登录。',
        401,
        'jwt verify 失败',
      );
    }
  }
}

// ============================================================================
//  校验
// ============================================================================

function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

function assertEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DomainError(
      'BK_E_BAD_EMAIL',
      `邮箱格式不正确：${email || '（空）'}。请输入形如 name@example.com 的邮箱。`,
      400,
      'email 格式非法',
    );
  }
}

/**
 * 密码强度校验。
 *
 * ★ 只要求 8 位且不含纯数字 —— 不强推"大小写+符号"。
 *   过严的规则会把人逼去用 `Passw0rd!` 这类可预测的组合，反而更弱。
 *   这里拦的是真正危险的：太短、纯数字、以及把邮箱当密码。
 */
function assertPassword(pwd: string): void {
  if (!pwd || pwd.length < 8) {
    throw new DomainError(
      'BK_E_WEAK_PASSWORD',
      '密码至少 8 位。建议用一句只有你记得住的话（如「我家猫叫豆豆2019」），比复杂但记不住的组合更安全。',
      400,
      '密码过短',
    );
  }
  if (/^\d+$/.test(pwd)) {
    throw new DomainError(
      'BK_E_WEAK_PASSWORD',
      '密码不能是纯数字。请混合字母或符号 —— 纯数字在几秒内就能被穷举。',
      400,
      '密码为纯数字',
    );
  }
}

function toAuthUser(u: {
  id: string;
  email: string;
  displayName: string;
  accountType: string;
  isPlatformAdmin: boolean;
}): AuthUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    accountType: u.accountType,
    isPlatformAdmin: u.isPlatformAdmin,
  };
}
