/**
 * 认证与账号接口
 * ============================================================
 * 四条流程：登录 → 新用户注册 → 公司注册 → 账套注册。
 *
 * ★ 路由划分刻意区分了「@Public」（无需登录）和需要登录的：
 *   注册引导 / 注册 / 登录 → @Public
 *   我有哪些公司 / 建第二家 / 改密码 / 成员管理 → 需要登录
 *
 * ★ 所有需要登录的接口都从**令牌**里取 userId，绝不接受请求方传的 userId ——
 *   否则任何人都能冒充别人建公司、改密码。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthService } from '../application/auth/auth.service';
import { Public } from '../application/auth/auth.decorators';
import { ACTION, MEMBERSHIP_ROLE, ROLE_LABEL, actionsOf } from '../domain/auth/permissions';
import type { AuthedRequest } from '../application/auth/auth.guard';
import type { MembershipInfo } from '../application/auth/auth.service';

/** 从请求上取已认证身份（Guard 挂上去的） */
function actorOf(req: AuthedRequest): { userId: string; email: string } {
  if (!req.actor) {
    // 走到这里说明路由没标 @Public 却也没经过 Guard —— 属于装配错误，必须吵
    throw new BadRequestException('请求缺少认证信息，请重新登录。');
  }
  return req.actor;
}

function membershipOf(req: AuthedRequest): MembershipInfo {
  const m = (req as AuthedRequest & { membership?: MembershipInfo }).membership;
  if (!m) {
    throw new BadRequestException('该请求未经过主体归属校验，无法确定你在该公司的身份。');
  }
  return m;
}

@ApiTags('认证与账号')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

  // ==========================================================================
  //  注册引导
  // ==========================================================================

  @Public()
  @Get('registration-info')
  @ApiOperation({
    summary: '注册引导信息',
    description:
      '前端据此决定显示哪种注册形态。系统里一个用户都没有时，首个注册者会自动成为平台管理员。',
  })
  async registrationInfo() {
    const info = await this.auth.registrationInfo();
    return {
      ...info,
      // 把三种角色能做什么直接给前端 —— 注册页要让人知道"会计"和"只读"的区别，
      // 否则邀请成员时只能瞎选
      roles: (Object.values(MEMBERSHIP_ROLE) as Array<(typeof MEMBERSHIP_ROLE)[keyof typeof MEMBERSHIP_ROLE]>).map(
        (r) => ({
          value: r,
          label: ROLE_LABEL[r],
          actions: actionsOf(r),
        }),
      ),
    };
  }

  // ==========================================================================
  //  注册
  // ==========================================================================

  @Public()
  @Post('register')
  @ApiOperation({
    summary: '注册新用户（可同时创建公司账套）',
    description:
      '不传 company 就是个人账号；传了 company 则一步到位：建账号 + 建主体 + 建科目表与 12 个会计期间 + 建立实控人关系，全部在一个事务里完成。',
  })
  @HttpCode(201)
  async register(
    @Body()
    body: {
      email?: string;
      password?: string;
      displayName?: string;
      phone?: string;
      accountType?: 'PERSONAL' | 'COMPANY_STAFF';
      company?: RegisterCompanyBody;
    },
    @Req() req: AuthedRequest,
  ) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException('请填写邮箱与密码。');
    }
    return this.auth.register({
      email: body.email,
      password: body.password,
      displayName: body.displayName ?? '',
      phone: body.phone,
      accountType: body.accountType,
      company: body.company ? normalizeCompany(body.company) : undefined,
    });
  }

  // ==========================================================================
  //  登录 / 当前身份
  // ==========================================================================

  @Public()
  @Post('login')
  @ApiOperation({ summary: '登录，返回 JWT 与可访问的公司列表' })
  @HttpCode(200)
  async login(@Body() body: { email?: string; password?: string }, @Req() req: AuthedRequest) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException('请填写邮箱与密码。');
    }
    return this.auth.login({
      email: body.email,
      password: body.password,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
  }

  @Get('me')
  @ApiOperation({
    summary: '当前登录身份',
    description: '返回账号信息 + 可访问的公司与在每个公司里的角色权限。前端据此渲染菜单与按钮。',
  })
  async me(@Req() req: AuthedRequest) {
    const actor = actorOf(req);
    return this.auth.me(actor.userId);
  }

  @Post('change-password')
  @ApiOperation({ summary: '修改自己的密码' })
  @HttpCode(200)
  async changePassword(
    @Req() req: AuthedRequest,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    const actor = actorOf(req);
    if (!body?.currentPassword || !body?.newPassword) {
      throw new BadRequestException('请填写当前密码与新密码。');
    }
    return this.auth.changePassword({
      userId: actor.userId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
  }

  // ==========================================================================
  //  公司注册（建第二个及以后的账套）
  // ==========================================================================

  @Get('entities')
  @ApiOperation({
    summary: '我能访问的公司列表',
    description:
      '★ 只返回当前用户是成员的公司 —— 这是"看不到别家公司的账"的入口级保证。',
  })
  async myEntities(@Req() req: AuthedRequest) {
    const actor = actorOf(req);
    const me = await this.auth.me(actor.userId);
    return {
      entities: me.memberships.map((m) => ({
        entityId: m.entityId,
        name: m.entityName,
        role: m.role,
        roleLabel: m.roleLabel,
        actions: m.actions,
      })),
      defaultEntityId: me.defaultEntityId,
    };
  }

  @Post('entities')
  @ApiOperation({
    summary: '公司注册：再建一个主体与账套',
    description:
      '同一个账号可以拥有多家公司。建主体、建科目表、建 12 个会计期间、建立实控人关系在同一事务里完成，失败不留半成品主体。',
  })
  @HttpCode(201)
  async registerEntity(@Req() req: AuthedRequest, @Body() body: { company?: RegisterCompanyBody }) {
    const actor = actorOf(req);
    if (!body?.company?.name) {
      throw new BadRequestException('请填写公司名称。');
    }
    return this.auth.registerEntity({
      userId: actor.userId,
      company: normalizeCompany(body.company),
    });
  }

  // ==========================================================================
  //  成员管理（只能管自己所在的公司）
  // ==========================================================================

  @Get('entities/:entityId/members')
  @ApiOperation({ summary: '公司成员列表' })
  async members(@Req() req: AuthedRequest, @Param('entityId') entityId: string) {
    const membership = membershipOf(req);
    const actor = actorOf(req);
    this.auth.assertAction(membership, ACTION.READ, '查看成员列表');

    return {
      entityId,
      entityName: membership.entityName,
      myRole: membership.role,
      myRoleLabel: membership.roleLabel,
      canManage: membership.actions.includes(ACTION.MANAGE_MEMBERS),
      roles: (Object.keys(MEMBERSHIP_ROLE) as Array<keyof typeof MEMBERSHIP_ROLE>).map((r) => ({
        value: MEMBERSHIP_ROLE[r],
        label: ROLE_LABEL[MEMBERSHIP_ROLE[r]],
      })),
      members: await this.auth.listMembers(entityId),
      selfUserId: actor.userId,
    };
  }

  @Post('entities/:entityId/members')
  @ApiOperation({
    summary: '把已注册用户加入公司',
    description:
      '只接受**已注册**的邮箱。系统不会替别人创建账号 —— 那等于你能拿别人的邮箱开户而对方毫不知情。',
  })
  @HttpCode(201)
  async addMember(
    @Req() req: AuthedRequest,
    @Param('entityId') entityId: string,
    @Body() body: { email?: string; role?: string },
  ) {
    const membership = membershipOf(req);
    const actor = actorOf(req);
    this.auth.assertAction(
      membership,
      ACTION.MANAGE_MEMBERS,
      `邀请成员（仅${ROLE_LABEL.OWNER}可做）`,
    );

    if (!body?.email) {
      throw new BadRequestException('请填写对方的注册邮箱。');
    }
    return this.auth.addMember({
      entityId,
      operatorId: actor.userId,
      email: body.email,
      role: body.role ?? MEMBERSHIP_ROLE.ACCOUNTANT,
    });
  }

  @Patch('entities/:entityId/members/:membershipId')
  @ApiOperation({
    summary: '变更成员角色',
    description: '不允许把最后一个实控人降级 —— 否则这家公司再也没人能管成员。',
  })
  @HttpCode(200)
  async changeMemberRole(
    @Req() req: AuthedRequest,
    @Param('entityId') entityId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: { role?: string },
  ) {
    const membership = membershipOf(req);
    const actor = actorOf(req);
    this.auth.assertAction(
      membership,
      ACTION.MANAGE_MEMBERS,
      `调整成员角色（仅${ROLE_LABEL.OWNER}可做）`,
    );

    if (!body?.role) {
      throw new BadRequestException('请选择新角色。');
    }
    return this.auth.changeMemberRole({
      entityId,
      operatorId: actor.userId,
      membershipId,
      role: body.role,
    });
  }
}

// ============================================================================
//  小工具
// ============================================================================

interface RegisterCompanyBody {
  name?: string;
  unifiedSocialCreditCode?: string;
  taxpayerType?: 'GENERAL' | 'SMALL_SCALE';
  legalPerson?: string;
  address?: string;
  phone?: string;
  startYear?: number | string;
}

function normalizeCompany(c: RegisterCompanyBody) {
  return {
    name: c.name ?? '',
    unifiedSocialCreditCode: c.unifiedSocialCreditCode,
    taxpayerType: c.taxpayerType,
    legalPerson: c.legalPerson,
    address: c.address,
    phone: c.phone,
    startYear: c.startYear === undefined || c.startYear === '' ? undefined : Number(c.startYear),
  };
}

/** 取客户端 IP（审计日志要记"从哪登录的"） */
function clientIp(req: AuthedRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0]!.trim();
  return req.ip ?? '';
}
