/**
 * 账务自检
 * ============================================================
 * 一次性跑完不变式 I2 / I4 / I5，并给出可一键修复的选项。
 * 任何时候怀疑「账不对」，先跑这个。
 */
import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

@ApiTags('账务自检')
@Controller('accounting')
export class SelfCheckController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('self-check')
  @ApiOperation({ summary: '跑一遍不变式 I2 / I4 / I5' })
  async selfCheck(@Query('entityId') entityId: string, @Query('periodId') periodId: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{ invariant: string; passed: boolean; detail: string }>
    >`SELECT * FROM bk_check_invariants(${entityId}, ${periodId})`;

    const names: Record<string, string> = {
      I2: '借方余额合计 == 贷方余额合计',
      I4: '本期发生额 == 凭证分录聚合',
      I5: '凭证号连续无空洞',
    };

    const results = rows.map((r) => ({
      code: r.invariant,
      name: names[r.invariant] ?? r.invariant,
      passed: r.passed,
      detail: r.detail,
    }));

    return {
      ok: results.every((r) => r.passed),
      checkedAt: new Date().toISOString(),
      results,
      canRepair: results.some((r) => !r.passed && (r.code === 'I2' || r.code === 'I4')),
      repairHint: 'POST /api/accounting/rebuild-balances 可按凭证重算余额表（幂等操作）',
    };
  }

  @Post('rebuild-balances')
  @ApiOperation({ summary: '重算指定期间的科目余额（幂等）' })
  async rebuildBalances(@Query('entityId') entityId: string, @Query('periodId') periodId: string) {
    const affected = await this.prisma.$queryRaw<Array<{ bk_rebuild_balances: number }>>`
      SELECT bk_rebuild_balances(${entityId}, ${periodId})
    `;
    const count = affected[0]?.bk_rebuild_balances ?? 0;

    // 重算后再跑一遍自检，让用户立刻看到结果
    const after = await this.prisma.$queryRaw<
      Array<{ invariant: string; passed: boolean; detail: string }>
    >`SELECT * FROM bk_check_invariants(${entityId}, ${periodId})`;

    return {
      rebuiltRows: count,
      after: after.map((r) => ({ code: r.invariant, passed: r.passed, detail: r.detail })),
      ok: after.every((r) => r.passed),
    };
  }
}
