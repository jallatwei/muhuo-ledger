import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { AccountService } from '../infrastructure/prisma/account.service';
import { AuthService } from '../application/auth/auth.service';
import { NoEntityScope } from '../application/auth/auth.decorators';
import type { AuthedRequest } from '../application/auth/auth.guard';

/** 主体列表的公共字段（含/不含成员关系两处共用，避免口径分叉） */
const BASIC_FIELDS = {
  id: true,
  name: true,
  unifiedSocialCreditCode: true,
  taxpayerType: true,
  baseCurrency: true,
  fiscalYearStartMonth: true,
} as const;

@ApiTags('基础数据')
@Controller()
export class BasicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly auth: AuthService,
  ) {}

  @Get('entities')
  @NoEntityScope()
  @ApiOperation({
    summary: '核算主体列表（仅当前用户是成员的）',
    description:
      '★ 这里以前返回**全部**主体。加了账号体系之后必须按成员关系过滤 —— ' +
      '否则登录任何账号都能在主体下拉里看到别人公司的名字。',
  })
  async entities(@Req() req: AuthedRequest) {
    // 未登录时（AUTH_REQUIRED=false 的本地验证场景）保持老行为，返回全部
    if (!req.actor) {
      return this.prisma.entity.findMany({
        where: { isActive: true },
        select: BASIC_FIELDS,
        orderBy: { createdAt: 'asc' },
      });
    }

    const { memberships } = await this.auth.me(req.actor.userId);
    if (memberships.length === 0) return [];

    return this.prisma.entity.findMany({
      where: { isActive: true, id: { in: memberships.map((m) => m.entityId) } },
      select: {
        ...BASIC_FIELDS,
        // 顺带把"我在这家公司是什么角色"带上，前端据此禁用按钮
        memberships: {
          where: { userId: req.actor.userId },
          select: { role: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Get('periods')
  @ApiOperation({ summary: '会计期间列表' })
  async periods(@Query('entityId') entityId: string, @Query('year') year?: string) {
    return this.prisma.period.findMany({
      where: {
        entityId,
        ...(year ? { fiscalYear: Number(year) } : {}),
      },
      orderBy: [{ fiscalYear: 'asc' }, { month: 'asc' }],
    });
  }

  @Get('accounts')
  @ApiOperation({ summary: '会计科目表（小企业会计准则）' })
  async accounts_(
    @Query('entityId') entityId: string,
    @Query('leafOnly') leafOnly?: string,
    @Query('keyword') keyword?: string,
  ) {
    const list = await this.prisma.account.findMany({
      where: {
        entityId,
        ...(leafOnly === 'true' ? { isLeaf: true, isActive: true } : {}),
        ...(keyword
          ? {
              OR: [
                { code: { contains: keyword } },
                { name: { contains: keyword } },
                { fullName: { contains: keyword } },
              ],
            }
          : {}),
      },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        fullName: true,
        level: true,
        category: true,
        direction: true,
        isLeaf: true,
        isActive: true,
        isSystem: true,
        reportItem: true,
        taxTag: true,
        cashflowTag: true,
        auxRequired: true,
      },
    });
    return list;
  }

  @Get('accounts/integrity')
  @ApiOperation({ summary: '科目表完整性自检（末级科目是否都能映射到报表行）' })
  async accountIntegrity(@Query('entityId') entityId: string) {
    const { unmapped } = await this.accounts.checkReportMapping(entityId);
    return {
      ok: unmapped.length === 0,
      unmappedCount: unmapped.length,
      unmapped: unmapped.map((a) => ({ code: a.code, name: a.name })),
      hint:
        unmapped.length === 0
          ? '全部末级科目均已映射到报表行项目'
          : '以下科目未设置报表行项目，报表取数时会漏掉这些科目的余额',
    };
  }
}
