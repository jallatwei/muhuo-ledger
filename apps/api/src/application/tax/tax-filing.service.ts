/**
 * 税务申报底稿服务
 * ============================================================
 * 把账上的数据组装成可直接对照填报的底稿。
 *
 * 三条口径约定（写在这里，避免以后各处不一致）：
 *
 *   ① 资产负债表用**期末余额**（period 的 closing）
 *   ② 利润表用**本期发生额**（period 的 occurred）—— 不是余额。
 *      损益类科目期末结转到本年利润后余额为 0，用余额取数会得到一张全 0 的表。
 *   ③ 企业所得税用**本年累计**口径（同一年度内各期发生额累加）
 *
 * ★ 这里只生成底稿，**不做任何申报动作**，也不替用户决定申报口径。
 *   底稿上每一格都标了来源；需要判断的地方留空并写明需要什么依据。
 */

import {
  auditExpenses,
  type ExpenseAuditReport,
  type ExpenseVoucherForAudit,
} from '../../domain/tax/expense-audit';
import { Injectable, Logger } from '@nestjs/common';

import { Decimal, round2 } from '@bookkeeper/shared';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';

import { DomainError } from '../../domain/accounting/errors';

import { fromDb } from '../../common/decimal';

import {
  buildBalanceSheet,
  buildIncomeStatement,
  checkReportItemCoverage,
  type AccountFigure,
  type ReportSheet,
} from '../../domain/tax/report-definitions';

import {
  buildVatWorksheet,
  DEFAULT_SURTAX_RATES,
  type SurtaxRates,
  type VatWorksheet,
} from '../../domain/tax/vat-worksheet';

import {
  buildCitWorksheet,
  DEFAULT_CIT_RATES,
  type CitRates,
  type CitWorksheet,
} from '../../domain/tax/cit-worksheet';

export type WorksheetKind = 'FINANCIAL' | 'VAT' | 'CIT_QUARTERLY' | 'CIT_ANNUAL';

export interface MonthlyFilingPackage {
  entityId: string;
  entityName: string;
  periodLabel: string;
  fiscalYear: number;
  month: number;
  /** 该期是否已结账（底稿在结账前后都可生成，但结账前数字还会变） */
  periodStatus: string;
  currentPeriodClosed: boolean;
  financial: {
    balanceSheet: ReportSheet;
    incomeStatement: ReportSheet;
  };
  vat: VatWorksheet;
  /** 季度月份才有 */
  citQuarterly: CitWorksheet | null;
  /** 12 月才有（对应年度汇算清缴） */
  citAnnual: CitWorksheet | null;
  /** 生成过程中发现的数据问题 */
  dataIssues: string[];
  /** 生成时间：底稿是"某一时点的快照"，必须记下来 */
  generatedAt: string;
  disclaimer: string;
}

const DISCLAIMER =
  '本底稿由系统按账面数据与发票数据自动归集，用于对照电子税局填报，**不构成税务意见**。' +
  '标注「需人工判断」的项目必须由你或你的税务专业人士确认后才能申报。' +
  '税收政策会变动，请以申报当期有效的政策文件与主管税务机关口径为准。';

@Injectable()
export class TaxFilingService {
  private readonly logger = new Logger(TaxFilingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 生成某期的完整申报底稿包。
   *
   * 月度：财务报表 + 增值税及附加
   * 季度末月（3/6/9/12）：再加企业所得税季度预缴
   * 12 月：再加企业所得税年度汇算（提示性底稿，多数行次日历年结束后才填）
   */
  async generateMonthly(params: {
    entityId: string;
    fiscalYear: number;
    month: number;
    /** 覆盖默认的附加税费率（报税地不同，城建税档位不同） */
    surtaxRates?: Partial<SurtaxRates>;
    /** 覆盖默认的所得税率 */
    citRates?: Partial<CitRates>;
  }): Promise<MonthlyFilingPackage> {
    const { entityId, fiscalYear, month } = params;

    const entity = await this.prisma.entity.findUnique({ where: { id: entityId } });
    if (!entity) {
      throw new DomainError('NOT_FOUND', '账套主体不存在，无法生成底稿。', 404, `entityId=${entityId}`);
    }

    const period = await this.prisma.period.findFirst({
      where: { entityId, fiscalYear, month },
    });
    if (!period) {
      throw new DomainError(
        'NOT_FOUND',
        `找不到 ${fiscalYear} 年 ${month} 月的会计期间，无法生成底稿。请先在账务设置里初始化该期间。`,
        404,
        `period ${fiscalYear}-${month} 不存在`,
      );
    }

    const periodLabel = `${fiscalYear}-${String(month).padStart(2, '0')}`;
    const dataIssues: string[] = [];

    // ── 1. 科目余额（本期 + 本年累计） ──
    const { currentFigures, ytdFigures, availableItems } = await this.loadFigures({
      entityId,
      fiscalYear,
      month,
      periodId: period.id,
    });

    // 标记完整性：定义里引用的 reportItem 必须都在科目表里
    const coverage = checkReportItemCoverage({ availableItems });
    if (!coverage.ok) {
      dataIssues.push(
        `报表定义引用了 ${coverage.missing.length} 个科目表中不存在的报表标记：` +
          coverage.missing.map((m) => `${m.item}（第 ${m.lineNo} 行 ${m.label}）`).join('、') +
          '。这些行会显示为 0 —— 请检查科目表的 reportItem 配置，不要当成"本期无发生额"。',
      );
    }

    // ── 2. 财务报表 ──
    const balanceSheet = buildBalanceSheet({ figures: currentFigures, periodLabel });
    const incomeStatement = buildIncomeStatement({
      figures: currentFigures,
      periodLabel,
      cumulative: false,
    });

    if (!balanceSheet.checks[0]?.ok) {
      dataIssues.push(
        '资产负债表不平衡。底稿上的数字直接来自科目余额，不平衡说明账本身有问题 —— ' +
          '请先在账上查清，不要在底稿上调整。',
      );
    }

    // ── 3. 发票聚合（按税率分档） ──
    const invoiceByRate = await this.aggregateInvoiceRates({ entityId, fiscalYear, month });

    // ── 4. 上期申报表（取留抵与期初未缴） ──
    const priorFiling = await this.loadPriorFiling({ entityId, fiscalYear, month });

    // ── 5. 增值税明细科目发生额 ──
    const ledger = await this.loadVatLedger({ entityId, periodId: period.id, ytdFigures });

    const vat = buildVatWorksheet({
      periodLabel,
      ledger,
      invoiceByRate,
      priorFiling,
      taxPaidThisPeriod: await this.loadTaxPaid({ entityId, fiscalYear, month }),
      surtaxRates: { ...DEFAULT_SURTAX_RATES, ...(params.surtaxRates ?? {}) },
    });

    // ── 6. 企业所得税 ──
    const isQuarterEnd = [3, 6, 9, 12].includes(month);
    const ytdIncomeStatement = buildIncomeStatement({
      figures: ytdFigures,
      periodLabel: `${fiscalYear} 年 1-${month} 月累计`,
      cumulative: true,
    });

    let citQuarterly: CitWorksheet | null = null;
    let citAnnual: CitWorksheet | null = null;

    if (isQuarterEnd) {
      const quarter = Math.ceil(month / 3);
      const knownAdjustments = await this.loadKnownAdjustments({ entityId, fiscalYear });
      const prepaid = await this.loadCitPrepaid({ entityId, fiscalYear, beforeMonth: month });

      citQuarterly = buildCitWorksheet({
        periodLabel: `${fiscalYear} 年第 ${quarter} 季度（截至 ${month} 月）`,
        kind: 'QUARTERLY',
        incomeStatement: pickIncomeStatement(ytdIncomeStatement),
        knownAdjustments,
        prepaidThisYear: prepaid,
        lossCarryForward: null, // 需要人工提供以前年度可弥补亏损
        rates: { ...DEFAULT_CIT_RATES, ...(params.citRates ?? {}) },
      });

      if (month === 12) {
        citAnnual = buildCitWorksheet({
          periodLabel: `${fiscalYear} 年度`,
          kind: 'ANNUAL',
          incomeStatement: pickIncomeStatement(ytdIncomeStatement),
          knownAdjustments,
          prepaidThisYear: await this.loadCitPrepaid({ entityId, fiscalYear, beforeMonth: 13 }),
          lossCarryForward: null,
          rates: { ...DEFAULT_CIT_RATES, ...(params.citRates ?? {}) },
        });
      }
    }

    // ── 7. 期间状态提示 ──
    if (period.status !== 'CLOSED') {
      dataIssues.push(
        `本期会计期间状态为「${period.status === 'OPEN' ? '未结账' : period.status}」。` +
          '结账前生成的底稿数字还会变动 —— 正式申报请以结账后的数据为准。',
      );
    }

    this.logger.log(
      `生成申报底稿：${periodLabel}（财务报表 + 增值税${isQuarterEnd ? ' + 企业所得税' : ''}）`,
    );

    return {
      entityId,
      entityName: entity.name,
      periodLabel,
      fiscalYear,
      month,
      periodStatus: period.status,
      currentPeriodClosed: period.status === 'CLOSED',
      financial: { balanceSheet, incomeStatement },
      vat,
      citQuarterly,
      citAnnual,
      dataIssues,
      generatedAt: new Date().toISOString(),
      disclaimer: DISCLAIMER,
    };
  }

  // --------------------------------------------------------------------------
  //  取数
  // --------------------------------------------------------------------------

  /** 加载本期与本年累计的科目数据 */
  private async loadFigures(params: {
    entityId: string;
    fiscalYear: number;
    month: number;
    periodId: string;
  }): Promise<{
    currentFigures: AccountFigure[];
    ytdFigures: AccountFigure[];
    availableItems: Set<string>;
  }> {
    const accounts = await this.prisma.account.findMany({
      where: { entityId: params.entityId, isLeaf: true },
      select: {
        id: true,
        code: true,
        name: true,
        direction: true,
        reportItem: true,
      },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const availableItems = new Set(
      accounts.map((a) => a.reportItem).filter((x): x is string => !!x),
    );

    // 本年所有期间（用于累计口径）
    const ytdPeriods = await this.prisma.period.findMany({
      where: { entityId: params.entityId, fiscalYear: params.fiscalYear, month: { lte: params.month } },
      select: { id: true },
    });

    const [currentRows, ytdRows] = await Promise.all([
      this.prisma.accountBalance.findMany({
        where: { entityId: params.entityId, periodId: params.periodId },
      }),
      this.prisma.accountBalance.findMany({
        where: { entityId: params.entityId, periodId: { in: ytdPeriods.map((p) => p.id) } },
      }),
    ]);

    const toFigures = (
      rows: typeof currentRows,
      mode: 'CURRENT' | 'YTD',
    ): AccountFigure[] => {
      const acc = new Map<string, AccountFigure>();
      for (const row of rows) {
        const meta = byId.get(row.accountId);
        if (!meta) continue;
        const key = row.accountId;
        const cur =
          acc.get(key) ??
          ({
            code: meta.code,
            name: meta.name,
            reportItem: meta.reportItem,
            direction: meta.direction as 'DEBIT' | 'CREDIT',
            closingDebit: new Decimal(0),
            closingCredit: new Decimal(0),
            debitOccurred: new Decimal(0),
            creditOccurred: new Decimal(0),
          } satisfies AccountFigure);

        if (mode === 'CURRENT') {
          cur.closingDebit = fromDb(row.closingDebit);
          cur.closingCredit = fromDb(row.closingCredit);
        }
        // 发生额在两种模式下都累加（YTD 就是各期累加）
        cur.debitOccurred = cur.debitOccurred.plus(fromDb(row.debitOccurred));
        cur.creditOccurred = cur.creditOccurred.plus(fromDb(row.creditOccurred));

        acc.set(key, cur);
      }
      return [...acc.values()];
    };

    return {
      currentFigures: toFigures(currentRows, 'CURRENT'),
      ytdFigures: toFigures(ytdRows, 'YTD'),
      availableItems,
    };
  }

  /** 按税率分档聚合发票（销项与进项） */
  private async aggregateInvoiceRates(params: {
    entityId: string;
    fiscalYear: number;
    month: number;
  }): Promise<VatWorksheetInputRates> {
    const start = new Date(Date.UTC(params.fiscalYear, params.month - 1, 1));
    const end = new Date(Date.UTC(params.fiscalYear, params.month, 1));

    const invoices = await this.prisma.invoice.findMany({
      where: {
        entityId: params.entityId,
        invoiceDate: { gte: start, lt: end },
        // ★ InvoiceStatus 里没有 VOID；人工标记不入账的是 IGNORED。\n        //   作废的发票另有 isRedFlushed 红冲标记（红冲票仍要参与申报，不能排除）。\n        status: { not: 'IGNORED' },
      },
      select: {
        direction: true,
        taxRate: true,
        amountExclTax: true,
        taxAmount: true,
      },
    });

    const map = new Map<string, { taxRate: string; amountExclTax: Decimal; taxAmount: Decimal; count: number; direction: 'INPUT' | 'OUTPUT' }>();
    for (const inv of invoices) {
      const rate = fromDb(inv.taxRate).toFixed(4);
      const key = `${inv.direction}|${rate}`;
      const cur =
        map.get(key) ??
        {
          taxRate: rate,
          amountExclTax: new Decimal(0),
          taxAmount: new Decimal(0),
          count: 0,
          direction: inv.direction as 'INPUT' | 'OUTPUT',
        };
      cur.amountExclTax = cur.amountExclTax.plus(fromDb(inv.amountExclTax));
      cur.taxAmount = cur.taxAmount.plus(fromDb(inv.taxAmount));
      cur.count += 1;
      map.set(key, cur);
    }
    return [...map.values()];
  }

  /** 上期申报表（留抵与期初未缴） */
  private async loadPriorFiling(params: {
    entityId: string;
    fiscalYear: number;
    month: number;
  }): Promise<{ creditCarriedForward: Decimal | null; closingUnpaid: Decimal | null } | null> {
    // 上期：上月；1 月的上期是上年 12 月
    const priorYear = params.month === 1 ? params.fiscalYear - 1 : params.fiscalYear;
    const priorMonth = params.month === 1 ? 12 : params.month - 1;
    const label = `${priorYear}-${String(priorMonth).padStart(2, '0')}`;

    const filing = await this.prisma.historyFilingRecord.findFirst({
      where: {
        entityId: params.entityId,
        periodLabel: label,
        filingType: { in: ['VAT_MONTHLY', 'VAT_QUARTERLY'] },
      },
    });
    if (!filing) return null;

    return {
      // 上期期末留抵 → 本期期初留抵（主表第13行）
      creditCarriedForward:
        filing.taxCreditBroughtForward === null ? null : fromDb(filing.taxCreditBroughtForward),
      // 上期期末未缴 → 本期期初未缴（主表第25行）
      closingUnpaid: filing.taxUnpaidEnd === null ? null : fromDb(filing.taxUnpaidEnd),
    };
  }

  /** 本期已缴纳的增值税 */
  private async loadTaxPaid(params: {
    entityId: string;
    fiscalYear: number;
    month: number;
  }): Promise<Decimal | null> {
    // 取本科目「未交增值税」的借方发生额作为本期实际缴纳数
    const account = await this.prisma.account.findFirst({
      where: { entityId: params.entityId, code: '222102' },
      select: { id: true },
    });
    if (!account) return null;

    const period = await this.prisma.period.findFirst({
      where: { entityId: params.entityId, fiscalYear: params.fiscalYear, month: params.month },
      select: { id: true },
    });
    if (!period) return null;

    const row = await this.prisma.accountBalance.findFirst({
      where: { entityId: params.entityId, periodId: period.id, accountId: account.id },
    });
    if (!row) return new Decimal(0);
    // 222102 未交增值税：借方发生额表示本期缴纳
    return fromDb(row.debitOccurred);
  }

  /** 增值税各明细科目的本期发生额 */
  private async loadVatLedger(params: {
    entityId: string;
    periodId: string;
    ytdFigures: AccountFigure[];
  }): Promise<VatLedgerInput> {
    const codes = {
      outputTax: '22210105',
      inputTaxCertified: '22210101',
      inputTaxPending: '22210102',
      inputTaxDeferred: '22210103',
      inputTaxTransferOut: '22210104',
      outputTaxSimple: '22210108',
    };

    const accounts = await this.prisma.account.findMany({
      where: { entityId: params.entityId, code: { in: Object.values(codes) } },
      select: { id: true, code: true },
    });
    const idByCode = new Map(accounts.map((a) => [a.code, a.id]));

    const rows = await this.prisma.accountBalance.findMany({
      where: {
        entityId: params.entityId,
        periodId: params.periodId,
        accountId: { in: [...idByCode.values()] },
      },
    });
    const byAccountId = new Map(rows.map((r) => [r.accountId, r]));

    const debit = (code: string): Decimal => {
      const id = idByCode.get(code);
      if (!id) return new Decimal(0);
      const row = byAccountId.get(id);
      return row ? fromDb(row.debitOccurred) : new Decimal(0);
    };
    const credit = (code: string): Decimal => {
      const id = idByCode.get(code);
      if (!id) return new Decimal(0);
      const row = byAccountId.get(id);
      return row ? fromDb(row.creditOccurred) : new Decimal(0);
    };

    // 收入类科目本期贷方发生额（用于与账面收入交叉核对）
    const revenueOccurred = params.ytdFigures
      .filter((f) => f.reportItem === 'IS_REVENUE')
      .reduce((s, f) => s.plus(f.creditOccurred.minus(f.debitOccurred)), new Decimal(0));

    return {
      outputTax: credit(codes.outputTax),
      inputTaxCertified: debit(codes.inputTaxCertified),
      inputTaxPending: debit(codes.inputTaxPending),
      inputTaxDeferred: debit(codes.inputTaxDeferred),
      inputTaxTransferOut: credit(codes.inputTaxTransferOut),
      outputTaxSimple: credit(codes.outputTaxSimple),
      revenueOccurred,
    };
  }

  /** 从账上能识别出的、需要纳税调整的项目 */
  private async loadKnownAdjustments(params: {
    entityId: string;
    fiscalYear: number;
  }): Promise<{
    entertainment: Decimal;
    advertising: Decimal;
    finesAndPenalties: Decimal;
    publicDonation: Decimal;
    costWithoutInvoice: Decimal;
  }> {
    const periods = await this.prisma.period.findMany({
      where: { entityId: params.entityId, fiscalYear: params.fiscalYear },
      select: { id: true },
    });
    const periodIds = periods.map((p) => p.id);

    // AccountBalance 没有指向 Account 的关系字段（只有 accountId），
    // 所以这里单独取一次科目表做内存关联 —— 比逐行查询少 N 次往返。
    const [rows, accounts] = await Promise.all([
      this.prisma.accountBalance.findMany({
        where: { entityId: params.entityId, periodId: { in: periodIds } },
      }),
      this.prisma.account.findMany({
        where: { entityId: params.entityId },
        select: { id: true, code: true, name: true },
      }),
    ]);
    const metaById = new Map(accounts.map((a) => [a.id, a]));

    const sumBy = (matcher: (code: string, name: string) => boolean): Decimal =>
      rows
        .filter((r) => {
          const meta = metaById.get(r.accountId);
          return meta ? matcher(meta.code, meta.name) : false;
        })
        .reduce(
          (s, r) => s.plus(fromDb(r.debitOccurred).minus(fromDb(r.creditOccurred))),
          new Decimal(0),
        );

    // 无票成本：来自历史重建结果（若做过历史数据重建）
    const recon = await this.prisma.historyReconstruction.findMany({
      where: { entityId: params.entityId, year: params.fiscalYear },
      select: { costWithoutInvoice: true },
    });
    const costWithoutInvoice = recon.reduce(
      (s, r) => s.plus(r.costWithoutInvoice ? fromDb(r.costWithoutInvoice) : 0),
      new Decimal(0),
    );

    return {
      entertainment: sumBy((c, n) => n.includes('业务招待费') || c === '660206'),
      advertising: sumBy((c, n) => n.includes('广告') || n.includes('业务宣传')),
      finesAndPenalties: sumBy(
        (c, n) => c === '671101' || n.includes('罚款') || n.includes('滞纳金'),
      ),
      publicDonation: sumBy((c, n) => n.includes('捐赠') || c === '671103'),
      costWithoutInvoice,
    };
  }

  /** 本年已预缴的企业所得税 */
  private async loadCitPrepaid(params: {
    entityId: string;
    fiscalYear: number;
    beforeMonth: number;
  }): Promise<Decimal | null> {
    const months = Array.from({ length: params.beforeMonth - 1 }, (_, i) => i + 1);
    if (months.length === 0) return new Decimal(0);

    const labels = months.map((m) => `${params.fiscalYear}-${String(m).padStart(2, '0')}`);
    const filings = await this.prisma.historyFilingRecord.findMany({
      where: {
        entityId: params.entityId,
        periodLabel: { in: labels },
        filingType: { in: ['VAT_MONTHLY', 'VAT_QUARTERLY'] },
      },
      select: { citTaxPaid: true },
    });

    const total = filings.reduce(
      (s, f) => s.plus(f.citTaxPaid ? fromDb(f.citTaxPaid) : 0),
      new Decimal(0),
    );
    return total;
  }

  // --------------------------------------------------------------------------
  //  报销合规自检
  // --------------------------------------------------------------------------

  /**
   * 报销自检。
   *
   * ★ 只做机械核查：找数据本身矛盾的地方与形态可疑的地方。
   *   不判断"能不能税前扣除"，那是涉税专业判断。
   */
  async auditExpenses(params: {
    entityId: string;
    fiscalYear: number;
    month: number;
    limits?: { entertainmentPerMeal?: string };
  }): Promise<ExpenseAuditReport> {
    const period = await this.prisma.period.findFirst({
      where: { entityId: params.entityId, fiscalYear: params.fiscalYear, month: params.month },
    });
    if (!period) {
      throw new DomainError(
        'NOT_FOUND',
        `找不到 ${params.fiscalYear} 年 ${params.month} 月的会计期间，无法执行自检。`,
        404,
        'period 不存在',
      );
    }

    const periodLabel = `${params.fiscalYear}-${String(params.month).padStart(2, '0')}`;

    // ── 取本期凭证（含分录与科目、关联发票、附件数）──
    const vouchers = await this.prisma.journalVoucher.findMany({
      where: {
        entityId: params.entityId,
        periodYear: params.fiscalYear,
        periodMonth: params.month,
        status: { not: 'VOID' },
      },
      include: {
        lines: {
          include: {
            account: { select: { code: true, name: true, category: true } },
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                invoiceCode: true,
                invoiceDate: true,
                sellerName: true,
                amountInclTax: true,
                documentId: true,
              },
            },
          },
        },
      },
    });

    // 附件数：凭证下挂的 DocumentLink
    const voucherIds = vouchers.map((v) => v.id);
    const links = voucherIds.length
      ? await this.prisma.documentLink.findMany({
          where: {
            entityId: params.entityId,
            fromType: 'VOUCHER',
            fromId: { in: voucherIds },
            linkType: 'ATTACHMENT',
          },
          select: { fromId: true },
        })
      : [];
    const attachCount = new Map<string, number>();
    for (const l of links) attachCount.set(l.fromId, (attachCount.get(l.fromId) ?? 0) + 1);

    const forAudit: ExpenseVoucherForAudit[] = vouchers.map((v) => {
      // ★ AccountCategory 只有 5 个值：ASSET / LIABILITY / EQUITY / COST / PROFIT_LOSS。
      //   没有 EXPENSE —— 费用类科目归在 PROFIT_LOSS（损益类）下。
      const expenseLines = v.lines.filter(
        (l) => l.account.category === 'COST' || l.account.category === 'PROFIT_LOSS',
      );
      const invoices = v.lines
        .map((l) => l.invoice)
        .filter((x): x is NonNullable<typeof x> => !!x);
      // 同一张票可能被多行引用，去重
      const uniq = new Map(invoices.map((i) => [i.id, i]));

      return {
        id: v.id,
        voucherWord: v.voucherWord,
        voucherNo: v.voucherNo,
        voucherDate: v.voucherDate.toISOString().slice(0, 10),
        status: v.status,
        summary: v.summary,
        totalAmount: fromDb(v.totalDebit),
        expenseAccounts: expenseLines
          .filter((l) => l.direction === 'DEBIT')
          .map((l) => ({
            code: l.account.code,
            name: l.account.name,
            amount: fromDb(l.amount),
          })),
        invoices: [...uniq.values()].map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          invoiceCode: i.invoiceCode,
          invoiceDate: i.invoiceDate.toISOString().slice(0, 10),
          sellerName: i.sellerName,
          amountInclTax: fromDb(i.amountInclTax),
          documentId: i.documentId,
        })),
        counterpartyNames: [],
        attachmentCount: (attachCount.get(v.id) ?? 0) + (v.attachments ?? 0),
      };
    });

    // ── 本期全部发票（用于跨凭证查重与高频统计）──
    const start = new Date(Date.UTC(params.fiscalYear, params.month - 1, 1));
    const end = new Date(Date.UTC(params.fiscalYear, params.month, 1));
    const invoices = await this.prisma.invoice.findMany({
      where: {
        entityId: params.entityId,
        invoiceDate: { gte: start, lt: end },
        status: { not: 'IGNORED' },
      },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceCode: true,
        invoiceDate: true,
        sellerName: true,
        amountInclTax: true,
        journalLines: { select: { voucherId: true }, take: 1 },
      },
    });

    // 凭证引用了哪些票（用于判断"发票是否已入账"）
    const invoiceToVoucher = new Map<string, string>();
    for (const v of vouchers) {
      for (const line of v.lines) {
        if (line.invoice) invoiceToVoucher.set(line.invoice.id, v.id);
      }
    }

    const report = auditExpenses({
      entityId: params.entityId,
      periodLabel,
      periodStartsOn: period.startsOn.toISOString().slice(0, 10),
      periodEndsOn: period.endsOn.toISOString().slice(0, 10),
      vouchers: forAudit,
      invoices: invoices.map((i) => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        invoiceCode: i.invoiceCode,
        invoiceDate: i.invoiceDate.toISOString().slice(0, 10),
        sellerName: i.sellerName,
        amountInclTax: fromDb(i.amountInclTax),
        voucherId: invoiceToVoucher.get(i.id) ?? null,
      })),
      limits: params.limits,
    });

    this.logger.log(
      `报销自检 ${periodLabel}：${report.summary.violationCount} 项硬矛盾、` +
        `${report.summary.suspiciousCount} 项可疑、${report.summary.noticeCount} 项提示`,
    );

    return report;
  }

  /** 某个年度已生成的底稿记录（用于"这期报过了没"的追溯） */
  async listGenerated(params: { entityId: string; fiscalYear?: number }) {
    const where: Record<string, unknown> = { entityId: params.entityId };
    if (params.fiscalYear) where.fiscalYear = params.fiscalYear;

    // 底稿是即时生成的快照，没有单独的表；这里返回"哪些期间已经结账"，
    // 作为"可以正式申报了"的依据。
    return this.prisma.period.findMany({
      where,
      orderBy: [{ fiscalYear: 'desc' }, { month: 'desc' }],
      select: {
        id: true,
        fiscalYear: true,
        month: true,
        status: true,
        closedAt: true,
      },
    });
  }
}

// ============================================================================
//  本地类型（仅服务内部使用）
// ============================================================================

type VatWorksheetInputRates = Array<{
  taxRate: string;
  amountExclTax: Decimal;
  taxAmount: Decimal;
  count: number;
  direction: 'INPUT' | 'OUTPUT';
}>;

interface VatLedgerInput {
  outputTax: Decimal;
  inputTaxCertified: Decimal;
  inputTaxPending: Decimal;
  inputTaxDeferred: Decimal;
  inputTaxTransferOut: Decimal;
  outputTaxSimple: Decimal;
  revenueOccurred: Decimal;
}

/** 从利润表底稿里取出所得税底稿需要的几个数 */
function pickIncomeStatement(sheet: ReportSheet): {
  revenue: Decimal;
  cost: Decimal;
  taxSurcharge: Decimal;
  sellingExpense: Decimal;
  adminExpense: Decimal;
  financeExpense: Decimal;
  investIncome: Decimal;
  nonOpIncome: Decimal;
  nonOpExpense: Decimal;
  profitBeforeTax: Decimal;
} {
  const at = (lineNo: string): Decimal =>
    sheet.rows.find((r) => r.lineNo === lineNo)?.amount ?? new Decimal(0);

  return {
    revenue: at('1'),
    cost: at('2'),
    taxSurcharge: at('3'),
    sellingExpense: at('4'),
    adminExpense: at('5'),
    financeExpense: at('6'),
    investIncome: at('7'),
    nonOpIncome: at('9'),
    nonOpExpense: at('10'),
    profitBeforeTax: at('11'),
  };
}

export { round2 };
