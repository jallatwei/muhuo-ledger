/**
 * 历史数据导入与重建接口
 * ============================================================
 * 完整流程：
 *   1. POST /history/preview        上传文件 → 解析 + 列名映射（不落库）
 *   2. POST /history/import         确认映射后落库
 *   3. POST /history/reconstruct    跑年度重建（核对 + 倒轧）
 *   4. POST /history/proposal       生成期初建账方案
 *   5. POST /history/proposal/:id/confirm  人工确认 → 生成期初凭证
 *
 * ★ 第 5 步是全流程唯一的写账动作，且必须人工确认。
 *   前四步都只产出"给人看的方案"，绝不自动入账。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Decimal, round2 } from '@bookkeeper/shared';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { AuditService } from '../infrastructure/prisma/audit.service';
import { HistoryImportService } from '../application/history/history-import.service';
import {
  StatementImportService,
  type RecognizedStatementType,
} from '../application/history/statement-import.service';
import { VoucherService } from '../domain/accounting/voucher.service';
import { fromDb, toDb } from '../common/decimal';
import type { ManualInputs } from '../domain/history/reconstruction';

@ApiTags('历史数据导入')
@Controller('history')
export class HistoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: HistoryImportService,
    private readonly statements: StatementImportService,
    private readonly vouchers: VoucherService,
    private readonly audit: AuditService,
  ) {}

  // ==========================================================================
  //  1. 预览
  // ==========================================================================

  @Post('preview')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: '上传历史数据文件并预览列名映射（不写入任何业务数据）',
    description:
      '支持税局导出、开票软件导出、代账公司提供的 Excel/CSV。' +
      '系统自动识别表头行与列名（内置别名词典 + AI 兜底），并给出必填字段缺失与歧义提示。' +
      '★ 列映射错了会导致整批数据错位，所以这一步必须人工确认。',
  })
  async preview(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { entityId: string; useAi?: string },
  ) {
    if (!file) throw new BadRequestException('未收到文件');
    if (!body.entityId) throw new BadRequestException('缺少 entityId');

    return this.history.preview({
      entityId: body.entityId,
      fileName: file.originalname,
      buffer: file.buffer,
      useAi: body.useAi !== 'false',
    });
  }

  // ==========================================================================
  //  2. 导入
  // ==========================================================================

  @Post('import')
  @ApiOperation({
    summary: '按确认后的映射导入历史记录（幂等，同一文件不会重复导入）',
    description:
      '支持三种数据：销项开票明细（INVOICE_SALES）、进项发票明细（INVOICE_PURCHASE）、申报记录（VAT_FILING / CIT_FILING）。' +
      '发票按「方向+代码+号码」去重；申报记录按「类型+期间」去重。',
  })
  async import(@Body() body: {
    entityId: string;
    sourceType: string;
    fileName: string;
    rows: Array<Record<string, unknown>>;
    mapping: Array<{ source: string; target: string }>;
    userId?: string;
  }) {
    if (!body.rows?.length) throw new BadRequestException('没有可导入的数据行');
    if (!body.mapping?.length) throw new BadRequestException('缺少列映射');

    // 数据行可能很大，用文件名+行数做内容指纹
    const fileHash = simpleHash(`${body.sourceType}|${body.fileName}|${body.rows.length}|${JSON.stringify(body.rows[0] ?? {})}`);

    return this.history.importRecords({
      entityId: body.entityId,
      sourceType: body.sourceType,
      fileName: body.fileName,
      fileHash,
      rows: body.rows,
      mapping: body.mapping,
      userId: body.userId,
    });
  }

  @Get('batches')
  @ApiOperation({ summary: '导入批次列表' })
  async batches(@Query('entityId') entityId: string) {
    return this.prisma.historyImportBatch.findMany({
      where: { entityId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Delete('batches/:id')
  @ApiOperation({
    summary: '删除导入批次及其数据（用于导错了重来）',
    description: '只有还没生成期初凭证时才允许删除，避免账与数据脱节。',
  })
  async deleteBatch(@Param('id') id: string, @Query('entityId') entityId: string) {
    const proposalPosted = await this.prisma.openingBalanceProposal.count({
      where: { entityId, status: 'POSTED' },
    });
    if (proposalPosted > 0) {
      throw new BadRequestException(
        '已经生成过期初凭证，不能再删除导入数据。' +
          '如需重来，请先删除期初凭证（红冲）后再操作。',
      );
    }

    const batch = await this.prisma.historyImportBatch.findFirst({ where: { id, entityId } });
    if (!batch) throw new NotFoundException(`批次不存在：${id}`);

    const [invoices, filings] = await Promise.all([
      this.prisma.historyInvoiceRecord.deleteMany({ where: { batchId: id } }),
      this.prisma.historyFilingRecord.deleteMany({ where: { batchId: id } }),
    ]);
    await this.prisma.historyImportBatch.delete({ where: { id } });

    return { deletedInvoices: invoices.count, deletedFilings: filings.count };
  }

  // ==========================================================================
  //  2.5 报表 / 申报表存档（识别录入的第二类目标）
  // ==========================================================================

  @Post('statements')
  @ApiOperation({
    summary: '保存识别出的财务报表 / 纳税申报表（★ 只建档，不生成凭证）',
    description:
      '报表是"结果"，凭证是"原因"。拿资产负债表的期末数去生成凭证会把资产重复确认一遍，' +
      '所以报表只进档案，供期初建账（reconstruction）取数，绝不直接入账。' +
      '同一主体 + 同类型 + 同报表日期 视为同一份档案，重复上传会覆盖而不是新增。' +
      '★ 报表不平衡时如实记录差额与备注，系统不做任何平衡修正。',
  })
  async saveStatement(
    @Body()
    body: {
      entityId: string;
      statementType: RecognizedStatementType;
      periodStart?: string | null;
      periodEnd: string | null;
      items: Array<{
        lineNo?: string | null;
        label: string;
        endBalance: string | null;
        beginBalance: string | null;
      }>;
      totals?: Record<string, string | null>;
      isBalanced?: boolean | null;
      balanceDifference?: string | null;
      documentId?: string | null;
      reconNote?: string | null;
      filingType?: 'VAT_MONTHLY' | 'VAT_QUARTERLY' | 'CIT_QUARTERLY' | 'CIT_ANNUAL';
      rawRow?: Record<string, unknown>;
    },
  ) {
    if (!body.entityId) throw new BadRequestException('缺少 entityId');
    if (!body.statementType) throw new BadRequestException('缺少 statementType');

    return this.statements.save({
      entityId: body.entityId,
      statementType: body.statementType,
      periodStart: body.periodStart ?? null,
      periodEnd: body.periodEnd ?? null,
      items: body.items ?? [],
      totals: body.totals ?? {},
      isBalanced: body.isBalanced ?? null,
      balanceDifference: body.balanceDifference ?? null,
      documentId: body.documentId ?? null,
      reconNote: body.reconNote ?? null,
      filingType: body.filingType,
      rawRow: body.rawRow ?? {},
    });
  }

  @Get('statements')
  @ApiOperation({ summary: '已存档的历史财务报表清单' })
  async listStatements(
    @Query('entityId') entityId: string,
    @Query('statementType') statementType?: RecognizedStatementType,
  ) {
    if (!entityId) throw new BadRequestException('缺少 entityId');
    return this.statements.listStatements(entityId, statementType);
  }

  @Get('statements/:id/detail')
  @ApiOperation({ summary: '单份报表档案的完整行项目（用于回看识别结果）' })
  async statementDetail(@Param('id') id: string, @Query('entityId') entityId: string) {
    const row = await this.prisma.financialStatementRecord.findFirst({
      where: { id, entityId },
    });
    if (!row) throw new NotFoundException(`报表档案不存在：${id}`);
    return {
      ...row,
      totalAssets: row.totalAssets === null ? null : round2(fromDb(row.totalAssets)).toFixed(2),
      totalLiabilities:
        row.totalLiabilities === null ? null : round2(fromDb(row.totalLiabilities)).toFixed(2),
      totalEquity: row.totalEquity === null ? null : round2(fromDb(row.totalEquity)).toFixed(2),
      revenue: row.revenue === null ? null : round2(fromDb(row.revenue)).toFixed(2),
      cost: row.cost === null ? null : round2(fromDb(row.cost)).toFixed(2),
      profitBeforeTax:
        row.profitBeforeTax === null ? null : round2(fromDb(row.profitBeforeTax)).toFixed(2),
      netProfit: row.netProfit === null ? null : round2(fromDb(row.netProfit)).toFixed(2),
      balanceDifference:
        row.balanceDifference === null ? null : round2(fromDb(row.balanceDifference)).toFixed(2),
    };
  }

  @Delete('statements/:id')
  @ApiOperation({ summary: '删除一份报表档案（识别错了要能撤销）' })
  async deleteStatement(@Param('id') id: string, @Query('entityId') entityId: string) {
    return this.statements.removeStatement(entityId, id);
  }

  @Get('declared-statements')
  @ApiOperation({
    summary: '★ 已建档报表会被期初建账取用哪些数（映射明细）',
    description:
      '回答一个用户最关心的问题："我上传的那张资产负债表到底用上了没有？"\n' +
      '返回：映射成功的科目余额、被跳过的行项目及原因（合计行、应交税费等）。\n' +
      '★ 已建档报表的优先级高于人工输入 —— 报表是别人出的表，人工输入是"我记得"。',
  })
  async declaredStatements(
    @Query('entityId') entityId: string,
    @Query('targetYear') targetYear?: string,
  ) {
    if (!entityId) throw new BadRequestException('缺少 entityId');
    const year = targetYear ? Number(targetYear) : new Date().getFullYear();
    return this.history.describeDeclaredStatements(entityId, year);
  }

  @Get('filings')
  @ApiOperation({ summary: '已存档的纳税申报记录清单' })
  async listFilings(@Query('entityId') entityId: string) {
    if (!entityId) throw new BadRequestException('缺少 entityId');
    return this.statements.listFilings(entityId);
  }

  @Delete('filings/:id')
  @ApiOperation({ summary: '删除一条申报记录' })
  async deleteFiling(@Param('id') id: string, @Query('entityId') entityId: string) {
    return this.statements.removeFiling(entityId, id);
  }

  // ==========================================================================
  //  3. 重建
  // ==========================================================================

  @Post('reconstruct')
  @ApiOperation({
    summary: '重建全部历史年度（核对发票与申报表 → 倒轧成本与利润）',
    description:
      '产出：每年度的发票聚合、申报汇总、两者核对差异、倒轧出的成本与净利润、以及必须人工补录的清单。' +
      '★ 倒轧项一律标注为「推算」，不会被当成事实。',
  })
  async reconstruct(@Body() body: { entityId: string }) {
    const result = await this.history.reconstructAll(body.entityId);
    return {
      years: result.years.map((y) => ({
        year: y.year,
        sales: y.sales
          ? {
              count: y.sales.count,
              amountExclTax: round2(y.sales.amountExclTax).toFixed(2),
              taxAmount: round2(y.sales.taxAmount).toFixed(2),
              amountInclTax: round2(y.sales.amountInclTax).toFixed(2),
            }
          : null,
        purchases: y.purchases
          ? {
              count: y.purchases.count,
              amountExclTax: round2(y.purchases.amountExclTax).toFixed(2),
              taxAmount: round2(y.purchases.taxAmount).toFixed(2),
              amountInclTax: round2(y.purchases.amountInclTax).toFixed(2),
              certifiedTaxAmount: round2(y.purchases.certifiedTaxAmount).toFixed(2),
            }
          : null,
        revenue: round2(y.revenue).toFixed(2),
        revenueSource: y.revenueSource,
        invoicedCost: round2(y.invoicedCost).toFixed(2),
        derivedCostTotal: y.derivedCostTotal ? round2(y.derivedCostTotal).toFixed(2) : null,
        costWithoutInvoice: y.costWithoutInvoice ? round2(y.costWithoutInvoice).toFixed(2) : null,
        profitBeforeTax: y.profitBeforeTax ? round2(y.profitBeforeTax).toFixed(2) : null,
        incomeTaxExpense: y.incomeTaxExpense ? round2(y.incomeTaxExpense).toFixed(2) : null,
        netProfit: y.netProfit ? round2(y.netProfit).toFixed(2) : null,
        reconciliations: y.reconciliations.map((r) => ({
          item: r.item,
          level: r.level,
          explanation: r.explanation,
          suggestion: r.suggestion,
          difference: r.difference ? r.difference.toFixed(2) : null,
        })),
        requiredInputs: y.requiredInputs,
        warnings: y.warnings,
      })),
      combinedRequiredInputs: result.combinedRequiredInputs,
    };
  }

  @Get('reconstructions')
  @ApiOperation({ summary: '已保存的重建结果' })
  async reconstructions(@Query('entityId') entityId: string) {
    return this.prisma.historyReconstruction.findMany({
      where: { entityId },
      orderBy: { year: 'asc' },
    });
  }

  // ==========================================================================
  //  4. 期初方案
  // ==========================================================================

  @Post('proposal')
  @ApiOperation({
    summary: '生成期初建账方案（每一行都标明数据来源）',
    description:
      '数据来源分四类：DECLARED 申报表直接取数 / INVOICE 发票聚合 / DERIVED 倒轧推算 / MANUAL 人工补录。' +
      '★ DERIVED 行只是让账能平，不代表账对，必须逐行核对。',
  })
  async buildProposal(
    @Body()
    body: {
      entityId: string;
      targetYear: number;
      targetMonth: number;
      manual?: ManualInputs;
      userId?: string;
    },
  ) {
    if (!body.targetYear || !body.targetMonth) {
      throw new BadRequestException('请指定启用年月的会计期间（targetYear / targetMonth）');
    }

    const result = await this.history.buildProposal({
      entityId: body.entityId,
      targetYear: body.targetYear,
      targetMonth: body.targetMonth,
      manual: body.manual ?? {},
      userId: body.userId,
    });

    const saved = await this.prisma.openingBalanceProposal.findUnique({
      where: { id: result.proposalId },
      include: { lines: { orderBy: { lineNo: 'asc' } }, sources: true },
    });

    return {
      proposalId: result.proposalId,
      summary: result.proposal.summary,
      balanced: result.proposal.balanced,
      totalDebit: result.proposal.totalDebit.toFixed(2),
      totalCredit: result.proposal.totalCredit.toFixed(2),
      difference: result.proposal.difference.toFixed(2),
      cashBasis: result.proposal.cashBasis,
      cashBalance: result.proposal.cashBalance.toFixed(2),
      warnings: result.proposal.warnings,
      requiredInputs: result.proposal.requiredInputs,
      lines: (saved?.lines ?? []).map((l) => ({
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        accountName: l.accountName,
        direction: l.direction,
        amount: round2(fromDb(l.amount)).toFixed(2),
        source: l.source,
        sourceNote: l.sourceNote,
        needsReview: l.needsReview,
        breakdown: l.breakdown,
      })),
      sources: saved?.sources ?? [],
    };
  }

  @Get('proposal')
  @ApiOperation({ summary: '当前草稿期初方案' })
  async getProposal(@Query('entityId') entityId: string) {
    const proposal = await this.prisma.openingBalanceProposal.findFirst({
      where: { entityId, status: { in: ['DRAFT', 'CONFIRMED', 'POSTED'] } },
      orderBy: { createdAt: 'desc' },
      include: { lines: { orderBy: { lineNo: 'asc' } }, sources: true },
    });
    if (!proposal) return null;

    return {
      ...proposal,
      totalDebit: round2(fromDb(proposal.totalDebit)).toFixed(2),
      totalCredit: round2(fromDb(proposal.totalCredit)).toFixed(2),
      difference: round2(fromDb(proposal.difference)).toFixed(2),
      lines: proposal.lines.map((l) => ({
        ...l,
        amount: round2(fromDb(l.amount)).toFixed(2),
      })),
    };
  }

  @Post('proposal/:id/adjust')
  @ApiOperation({ summary: '人工调整方案中的某一行（改金额或删除该行）' })
  async adjustLine(
    @Param('id') proposalId: string,
    @Body() body: { lineNo: number; amount?: string; remove?: boolean; note?: string },
  ) {
    const proposal = await this.prisma.openingBalanceProposal.findUnique({
      where: { id: proposalId },
      include: { lines: true },
    });
    if (!proposal) throw new NotFoundException(`期初方案不存在：${proposalId}`);
    if (proposal.status === 'POSTED') {
      throw new BadRequestException('该方案已生成期初凭证，不能再调整。如需修改请先红冲期初凭证。');
    }

    const line = proposal.lines.find((l) => l.lineNo === body.lineNo);
    if (!line) throw new NotFoundException(`方案中不存在第 ${body.lineNo} 行`);

    if (body.remove) {
      await this.prisma.openingBalanceLine.delete({ where: { id: line.id } });
    } else if (body.amount !== undefined) {
      const amount = round2(new Decimal(body.amount));
      if (amount.lt(0)) throw new BadRequestException('金额不能为负数；如需反向余额请改用相反方向。');
      await this.prisma.openingBalanceLine.update({
        where: { id: line.id },
        data: {
          amount: toDb(amount),
          source: 'MANUAL',
          sourceNote: `${line.sourceNote}　→ 人工调整为 ${amount.toFixed(2)}${body.note ? `（${body.note}）` : ''}`,
          needsReview: false,
        },
      });
    }

    // 重算合计
    const lines = await this.prisma.openingBalanceLine.findMany({ where: { proposalId } });
    const debit = lines.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s.plus(fromDb(l.amount)), new Decimal(0));
    const credit = lines.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s.plus(fromDb(l.amount)), new Decimal(0));

    await this.prisma.openingBalanceProposal.update({
      where: { id: proposalId },
      data: {
        totalDebit: toDb(debit),
        totalCredit: toDb(credit),
        difference: toDb(debit.minus(credit)),
        status: 'DRAFT',
      },
    });

    return {
      totalDebit: round2(debit).toFixed(2),
      totalCredit: round2(credit).toFixed(2),
      difference: round2(debit.minus(credit)).toFixed(2),
      balanced: debit.equals(credit) && debit.gt(0),
    };
  }

  @Post('proposal/:id/confirm')
  @ApiOperation({
    summary: '★ 确认期初方案 → 生成期初余额凭证（全流程唯一的写账动作）',
    description:
      '生成的凭证使用「年初」凭证字与 0 号，借贷必须平衡。' +
      '生成后仍处于草稿状态，需要按正常流程审核、过账。',
  })
  async confirmProposal(
    @Param('id') proposalId: string,
    @Body() body: { userId?: string; reason?: string },
  ) {
    const proposal = await this.prisma.openingBalanceProposal.findUnique({
      where: { id: proposalId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!proposal) throw new NotFoundException(`期初方案不存在：${proposalId}`);
    if (proposal.status === 'POSTED') {
      throw new BadRequestException('该方案已经生成过期初凭证，请勿重复生成。');
    }

    const debit = proposal.lines
      .filter((l) => l.direction === 'DEBIT')
      .reduce((s, l) => s.plus(fromDb(l.amount)), new Decimal(0));
    const credit = proposal.lines
      .filter((l) => l.direction === 'CREDIT')
      .reduce((s, l) => s.plus(fromDb(l.amount)), new Decimal(0));

    if (!debit.equals(credit)) {
      throw new BadRequestException(
        `期初方案借贷不平：借方 ${round2(debit).toFixed(2)}，贷方 ${round2(credit).toFixed(2)}，` +
          `差额 ${round2(debit.minus(credit)).toFixed(2)}。请先调整方案使借贷相等。`,
      );
    }
    if (proposal.lines.length === 0) {
      throw new BadRequestException('期初方案没有任何科目行，无法生成凭证。');
    }

    // 生成期初凭证（「年初」凭证字 + 0 号 + sourceType=OPENING）
    const period = await this.prisma.period.findUnique({ where: { id: proposal.targetPeriodId } });
    if (!period) throw new NotFoundException('方案对应的会计期间不存在');

    const created = await this.vouchers.create(
      {
        entityId: proposal.entityId,
        periodId: proposal.targetPeriodId,
        voucherDate: `${proposal.targetYear}-${String(proposal.targetMonth).padStart(2, '0')}-01`,
        summary: `期初余额（由历史数据重建，${proposal.targetYear}-${String(proposal.targetMonth).padStart(2, '0')} 启用）`,
        voucherWord: '年初',
        sourceType: 'OPENING',
        sourceId: proposal.id,
        idempotencyKey: `OPENING:${proposal.id}`,
        lines: proposal.lines.map((l) => ({
          accountCode: l.accountCode,
          direction: l.direction,
          amount: round2(fromDb(l.amount)).toFixed(2),
          summary: `期初余额（${sourceLabel(l.source)}）`,
        })),
      },
      body.userId,
    );

    await this.prisma.openingBalanceProposal.update({
      where: { id: proposalId },
      data: {
        status: 'POSTED',
        voucherId: created.id,
        postedAt: new Date(),
        confirmedBy: body.userId ?? null,
        confirmedAt: new Date(),
      },
    });

    await this.audit.record({
      entityId: proposal.entityId,
      userId: body.userId,
      action: 'POST',
      subjectType: 'OpeningBalanceProposal',
      subjectId: proposalId,
      reason: body.reason ?? '确认期初方案并生成期初余额凭证',
      afterData: { voucherId: created.id, lines: proposal.lines.length, totalDebit: debit.toFixed(2) },
    });

    return {
      proposalId,
      voucherId: created.id,
      alreadyExists: created.alreadyExists,
      totalDebit: round2(debit).toFixed(2),
      lineCount: proposal.lines.length,
      nextSteps: [
        '期初凭证已生成为草稿，请到凭证页确认分录无误。',
        '确认后依次执行「提交审核 → 审核通过 → 过账」。',
        '过账后建议运行「账务自检」确认不变式成立。',
      ],
    };
  }

  @Delete('proposal/:id')
  @ApiOperation({ summary: '删除草稿期初方案（不删除已生成的凭证）' })
  async deleteProposal(@Param('id') proposalId: string) {
    const proposal = await this.prisma.openingBalanceProposal.findUnique({ where: { id: proposalId } });
    if (!proposal) throw new NotFoundException(`期初方案不存在：${proposalId}`);
    if (proposal.status === 'POSTED') {
      throw new BadRequestException('该方案已生成期初凭证，不能删除。如需重做请先红冲期初凭证。');
    }
    await this.prisma.openingBalanceProposal.delete({ where: { id: proposalId } });
    return { ok: true };
  }
}

function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    DECLARED: '申报表取数',
    INVOICE: '发票聚合',
    DERIVED: '倒轧推算，需核对',
    MANUAL: '人工录入',
  };
  return map[source] ?? source;
}

/** 轻量指纹，用于导入幂等判断 */
function simpleHash(input: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `h${h1.toString(16).padStart(8, '0')}`;
}
