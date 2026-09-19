/**
 * 税务填报接口
 * ============================================================
 * 定位：**生成底稿**，不是"一键申报"。
 *
 * 全国统一规范电子税务局目前不提供给普通企业的通用文件导入接口，
 * 所以这里产出的是「与税局表格逐格对照的底稿」——
 * 每个数字都标了来源，照着填 5 分钟能填完。
 *
 * ★ 所有接口都不做任何申报动作，也不替用户决定申报口径。
 *   需要判断的地方留空并写明需要什么依据。
 */
import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TaxFilingService } from '../application/tax/tax-filing.service';
import { TaxPolicyService } from '../application/tax/tax-policy.service';
import { Decimal } from '@bookkeeper/shared';
import type { ReportSheet } from '../domain/tax/report-definitions';
import type { VatWorksheet } from '../domain/tax/vat-worksheet';
import type { CitWorksheet } from '../domain/tax/cit-worksheet';

@ApiTags('税务填报')
@Controller('tax')
export class TaxController {
  constructor(
    private readonly tax: TaxFilingService,
    private readonly policy: TaxPolicyService,
  ) {}

  @Post('worksheets')
  @ApiOperation({
    summary: '★ 生成某期申报底稿（财务报表 + 增值税及附加 + 季度/年度企业所得税）',
    description:
      '产出的是**底稿**：每一格都标明数据来源（账上取数 / 发票聚合 / 上期申报表 / 计算得出）。\n\n' +
      '· 月度：资产负债表 + 利润表 + 增值税及附加税费\n' +
      '· 季度末月（3/6/9/12）：再加企业所得税季度预缴\n' +
      '· 12 月：再加企业所得税年度汇算底稿\n\n' +
      '★ 需要专业判断的项目（纳税调整、优惠适用）会留空并写明依据要求，' +
      '系统不代为判断，也不代为申报。',
  })
  async worksheets(
    @Body()
    body: {
      entityId: string;
      fiscalYear: number;
      month: number;
      /** 报税地的附加税费率（城建税分档：市区 7% / 县镇 5% / 其他 1%） */
      surtaxRates?: { city?: string; education?: string; localEducation?: string };
      /** 所得税率覆盖 */
      citRates?: { standard?: string; smallMicro?: string; smallMicroCap?: string; highTech?: string };
    },
  ) {
    if (!body.entityId) throw new BadRequestException('缺少 entityId');
    if (!body.fiscalYear || !body.month) {
      throw new BadRequestException('请指定要生成底稿的会计期间（fiscalYear / month）。');
    }
    if (body.month < 1 || body.month > 12) {
      throw new BadRequestException(`月份必须在 1~12 之间，收到 ${body.month}。`);
    }

    const pkg = await this.tax.generateMonthly({
      entityId: body.entityId,
      fiscalYear: body.fiscalYear,
      month: body.month,
      surtaxRates: body.surtaxRates,
      citRates: body.citRates,
    });

    // ★ Decimal 不能直接 JSON 序列化（会变成对象），统一转字符串
    return {
      ...pkg,
      financial: {
        balanceSheet: serializeSheet(pkg.financial.balanceSheet),
        incomeStatement: serializeSheet(pkg.financial.incomeStatement),
      },
      vat: serializeVat(pkg.vat),
      citQuarterly: pkg.citQuarterly ? serializeCit(pkg.citQuarterly) : null,
      citAnnual: pkg.citAnnual ? serializeCit(pkg.citAnnual) : null,
    };
  }

  @Post('expense-audit')
  @ApiOperation({
    summary: '★ 报销合规自检（机械核查 + 风险提示，不是税务意见）',
    description:
      '分两类结论，**界面上必须分开呈现**：\n\n' +
      '【数据本身就能证明有问题】同一张票重复报销、凭证日期越界、凭证金额与发票不符\n' +
      '【形态可疑但可能是正常业务】连号发票、大额整数、周末招待、同供应商高频小额、缺附件\n\n' +
      '★ 第二类绝不能说成「违规」：同一供应商一天开多张票可能是正常业务。\n' +
      '本接口不判断「能否税前扣除」—— 那需要看合同与业务实质，属涉税专业判断。\n' +
      '每条结论都带「该怎么核实」，只说有问题不说怎么查等于没说。',
  })
  async expenseAudit(
    @Body()
    body: {
      entityId: string;
      fiscalYear: number;
      month: number;
      /** 内部报销限额（可选；不配则不检查限额，避免误报） */
      limits?: { entertainmentPerMeal?: string };
    },
  ) {
    if (!body.entityId) throw new BadRequestException('缺少 entityId');
    if (!body.fiscalYear || !body.month) {
      throw new BadRequestException('请指定要自检的会计期间（fiscalYear / month）。');
    }
    if (body.month < 1 || body.month > 12) {
      throw new BadRequestException(`月份必须在 1~12 之间，收到 ${body.month}。`);
    }

    const report = await this.tax.auditExpenses({
      entityId: body.entityId,
      fiscalYear: body.fiscalYear,
      month: body.month,
      limits: body.limits,
    });

    return {
      ...report,
      scope: {
        ...report.scope,
        totalExpenseAmount: report.scope.totalExpenseAmount.toFixed(2),
      },
      findings: report.findings.map((f) => ({
        ...f,
        amount: f.amount === null ? null : f.amount.toFixed(2),
      })),
    };
  }

  // ==========================================================================
  //  税务政策检索
  // ==========================================================================

  @Post('policies/search')
  @ApiOperation({
    summary: '★ 执行一次税务政策检索（抓官方来源 → 比对 → 留痕）',
    description:
      '从已登记的官方来源抓取政策，把**原文、发文机关、文号、发文日期、施行日期、失效日期、' +
      '来源链接、抓取时间**存下来；内容有变化时单独提示。\n\n' +
      '★ 本接口**不判断政策是否适用于你**，也不替你决定申报口径 —— ' +
      '政策的适用通常取决于正文中的限定条件，请阅读原文或咨询税务专业人士。\n\n' +
      '★ 每次执行都会留下记录（含失败的）：没有执行记录就无法分辨' +
      '「本期确实没有新政策」与「抓取全挂了」。',
  })
  async searchPolicies(
    @Body() body: { jurisdiction?: string; triggeredBy?: string },
  ) {
    return this.policy.runSearch({
      jurisdiction: body.jurisdiction ?? 'CN-GENERAL',
      triggeredBy: body.triggeredBy ?? 'MANUAL',
    });
  }

  @Get('policies')
  @ApiOperation({ summary: '政策库（含"按公布日期推算"的状态与限定条件）' })
  async policies(
    @Query('jurisdiction') jurisdiction?: string,
    @Query('status') status?: 'EFFECTIVE' | 'UPCOMING' | 'EXPIRED',
    @Query('taxType') taxType?: string,
    @Query('needsReviewOnly') needsReviewOnly?: string,
  ) {
    return this.policy.listPolicies({
      jurisdiction,
      status,
      taxType,
      needsReviewOnly: needsReviewOnly === 'true',
    });
  }

  @Get('policies/sources')
  @ApiOperation({ summary: '已登记的官方来源清单（"没搜到"≠"没有这条政策"）' })
  sources(@Query('jurisdiction') jurisdiction?: string) {
    return this.policy.listSources(jurisdiction);
  }

  @Get('policies/runs')
  @ApiOperation({ summary: '检索执行历史（★ 含失败的，用于分辨"没新政策"与"抓取挂了"）' })
  async runs(@Query('jurisdiction') jurisdiction?: string) {
    return this.policy.listRuns({ jurisdiction });
  }

  @Get('policies/:id')
  @ApiOperation({ summary: '某条政策的完整原文与限定条件' })
  async policyDetail(@Param('id') id: string) {
    return this.policy.getPolicy(id);
  }

  @Post('policies/:id/review')
  @ApiOperation({
    summary: '标记该政策已阅',
    description: '系统不做适用性判断，"这条跟我有没有关系"必须由人确认。',
  })
  async reviewPolicy(
    @Param('id') id: string,
    @Body() body: { userId?: string; notes?: string },
  ) {
    return this.policy.markReviewed({ id, userId: body?.userId, notes: body?.notes });
  }

  @Get('periods')
  @ApiOperation({
    summary: '可用于生成底稿的期间清单（含结账状态）',
    description: '底稿在结账前后都可生成，但只有结账后的数字才是最终的 —— 正式申报请以结账后的为准。',
  })
  async periods(@Query('entityId') entityId: string, @Query('fiscalYear') fiscalYear?: string) {
    if (!entityId) throw new BadRequestException('缺少 entityId');
    return this.tax.listGenerated({
      entityId,
      fiscalYear: fiscalYear ? Number(fiscalYear) : undefined,
    });
  }
}

// ============================================================================
//  序列化：Decimal → 字符串
// ============================================================================

function money(v: Decimal | null): string | null {
  return v === null ? null : v.toFixed(2);
}

function serializeSheet(sheet: ReportSheet) {
  return {
    ...sheet,
    rows: sheet.rows.map((r) => ({
      ...r,
      amount: money(r.amount),
      compareAmount: money(r.compareAmount),
    })),
    checks: sheet.checks.map((c) => ({ ...c })),
  };
}

function serializeVat(vat: VatWorksheet) {
  return {
    ...vat,
    mainForm: vat.mainForm.map((c) => ({ ...c, amount: money(c.amount) })),
    annex1: vat.annex1.map((r) => ({
      ...r,
      salesExclTax: r.salesExclTax.toFixed(2),
      outputTax: r.outputTax.toFixed(2),
    })),
    annex2: vat.annex2.map((r) => ({
      ...r,
      amount: r.amount.toFixed(2),
    })),
    surtax: {
      ...vat.surtax,
      base: vat.surtax.base.toFixed(2),
      city: vat.surtax.city.toFixed(2),
      education: vat.surtax.education.toFixed(2),
      localEducation: vat.surtax.localEducation.toFixed(2),
      total: vat.surtax.total.toFixed(2),
    },
  };
}

function serializeCit(cit: CitWorksheet) {
  return {
    ...cit,
    cells: cit.cells.map((c) => ({ ...c, amount: money(c.amount) })),
    adjustments: cit.adjustments.map((a) => ({ ...a, amount: money(a.amount) })),
  };
}
