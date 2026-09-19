/**
 * 凭证接口
 * ============================================================
 * 路径约定：/api/vouchers
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { VoucherService, type CreateVoucherInput } from './voucher.service';

@ApiTags('凭证')
@Controller('vouchers')
export class VoucherController {
  constructor(private readonly vouchers: VoucherService) {}

  @Post()
  @ApiOperation({ summary: '创建凭证草稿（构造时即校验借贷平衡）' })
  async create(@Body() body: CreateVoucherInput, @Req() req: Request) {
    const userId = (req as Request & { user?: { id: string } }).user?.id;
    return this.vouchers.create(body, userId);
  }

  @Get()
  @ApiOperation({ summary: '凭证列表' })
  async list(
    @Query('entityId') entityId: string,
    @Query('periodId') periodId?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.vouchers.list({
      entityId,
      periodId,
      status: status ? status.split(',') : undefined,
      keyword,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('period-summary')
  @ApiOperation({ summary: '期间凭证汇总（凭证册封面用）' })
  async periodSummary(@Query('entityId') entityId: string, @Query('periodId') periodId: string) {
    return this.vouchers.periodSummary(entityId, periodId);
  }

  @Get(':id')
  @ApiOperation({ summary: '凭证详情' })
  async detail(@Param('id') id: string) {
    return this.vouchers.getById(id);
  }

  @Post(':id/submit')
  @ApiOperation({ summary: '提交审核' })
  async submit(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as Request & { user?: { id: string } }).user?.id;
    await this.vouchers.submit(id, userId);
    return { ok: true };
  }

  @Post(':id/approve')
  @ApiOperation({ summary: '审核通过' })
  async approve(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system';
    await this.vouchers.approve(id, userId);
    return { ok: true };
  }

  @Post(':id/reject')
  @ApiOperation({
    summary: '审核不通过：待审核 → 草稿',
    description: '理由必填，会写入凭证备注并回显给制单人 —— 被退了却不知道为什么，流程就卡住了。',
  })
  async reject(@Param('id') id: string, @Body() body: { reason: string }, @Req() req: Request) {
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system';
    await this.vouchers.reject(id, userId, body.reason);
    return { ok: true, status: 'DRAFT' };
  }

  @Post(':id/reject-after-review')
  @ApiOperation({
    summary: '★ 过账前退回审核（已审核 → 待审核）',
    description:
      '过账是复核动作。复核时发现问题，退回到「待审核」而不是「草稿」—— ' +
      '因为问题多半出在审核环节，该让审核人重新看，而不是让制单人从头再来。' +
      '理由必填并写入凭证备注，制单人/审核人一打开就能看到要改什么。',
  })
  async rejectAfterReview(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @Req() req: Request,
  ) {
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system';
    await this.vouchers.rejectAfterReview(id, userId, body?.reason ?? '');
    return { ok: true, status: 'REVIEWING' };
  }

  @Post(':id/unapprove')
  @ApiOperation({
    summary: '反审核：已审核未过账 → 草稿（退回制单人）',
    description: '与「过账前退回审核」的区别：这条退到草稿，意味着单据本身需要改。',
  })
  async unapprove(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @Req() req: Request,
  ) {
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system';
    await this.vouchers.unapprove(id, userId, body?.reason ?? '');
    return { ok: true, status: 'DRAFT' };
  }

  @Post(':id/post')
  @ApiOperation({ summary: '过账（分配凭证号，此后不可修改）' })
  async post(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system';
    return this.vouchers.post(id, userId);
  }

  @Post(':id/reverse')
  @ApiOperation({ summary: '红冲（生成反向凭证，必须填理由）' })
  async reverse(@Param('id') id: string, @Body() body: { reason: string }, @Req() req: Request) {
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system';
    return this.vouchers.reverse(id, userId, body.reason);
  }

  @Post(':id/void')
  @ApiOperation({ summary: '作废（仅未过账凭证，必须填理由）' })
  async void(@Param('id') id: string, @Body() body: { reason: string }, @Req() req: Request) {
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system';
    await this.vouchers.void(id, userId, body.reason);
    return { ok: true };
  }
}
