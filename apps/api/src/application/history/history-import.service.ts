/**
 * 历史数据导入与重建 —— 应用服务
 * ============================================================
 * 职责：
 *   1. 解析上传的 Excel/CSV，识别表头映射（规则 + AI 兜底）
 *   2. 落库历史发票与申报记录（幂等去重）
 *   3. 跑年度重建：核对 → 倒轧 → 汇总
 *   4. 生成期初建账方案（人工确认后才生成期初凭证）
 *
 * ★ 设计红线：AI 只做「归类与解释」，不做「造数」。
 *   任何倒轧出来的科目都必须带 source=DERIVED 与 needsReview=true。
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal, round2 } from '@bookkeeper/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AccountService } from '../../infrastructure/prisma/account.service';
import { AuditService } from '../../infrastructure/prisma/audit.service';
import { AiService } from '../../infrastructure/ai/ai.service';
import { toDb, fromDb } from '../../common/decimal';
import { buildInvoiceDedupHash, DEDUP_NS_HISTORY } from '../../common/dedup';
import {
  matchByRules,
  mergeAiMappings,
  parseAmount,
  parseDate,
  parseTaxRate,
  parseBoolean,
  type MappingResult,
  type InvoiceField,
} from '../../domain/history/column-mapping';
import { parseBuffer, type ParsedSheet } from '../../domain/history/sheet-parser';
import {
  reconstructYear,
  buildOpeningProposal,
  type InvoiceAggregate,
  type FilingAggregate,
  type YearReconstruction,
  type ManualInputs,
  type OpeningLine,
} from '../../domain/history/reconstruction';
import {
  mapBalanceSheetItems,
  readIncomeStatement,
} from '../../domain/history/statement-mapping';
import type { StatementItem } from '../../domain/history/statement.model';

export interface PreviewResult {
  sheetName: string;
  headerRowIndex: number;
  headers: string[];
  mapping: MappingResult;
  sampleRows: Array<Record<string, unknown>>;
  totalRows: number;
  skippedRows: number;
  warnings: string[];
  detectedSourceType: string;
}

@Injectable()
export class HistoryImportService {
  private readonly logger = new Logger(HistoryImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
  ) {}

  // ==========================================================================
  //  一、预览：解析 + 映射（不落库）
  // ==========================================================================

  /**
   * 上传后先预览，让人确认列映射对不对。
   * 这一步不写业务数据 —— 列映射错了就落库会造成难以清理的脏数据。
   */
  async preview(params: {
    entityId: string;
    fileName: string;
    buffer: Buffer;
    useAi?: boolean;
  }): Promise<PreviewResult> {
    const parsed = await parseBuffer(params.buffer, params.fileName);
    if (parsed.headers.length === 0) {
      throw new Error(`无法从文件「${params.fileName}」中识别出表头。请确认文件格式（支持 .xlsx / .csv）。`);
    }

    let mapping = matchByRules(parsed.headers);

    // 规则未完全识别时，交给 AI 兜底
    if (params.useAi !== false && (mapping.mappings.some((m) => m.target === 'IGNORE') || !mapping.complete)) {
      try {
        const unknown = mapping.mappings.filter((m) => m.target === 'IGNORE').map((m) => m.source);
        if (unknown.length > 0) {
          const aiResult = await this.askAiForMapping(unknown, parsed.rows.slice(0, 5));
          mapping = mergeAiMappings(mapping, aiResult);
        }
      } catch (e) {
        mapping.warnings.push(
          `AI 辅助识别列名失败（${e instanceof Error ? e.message : String(e)}），已仅使用内置词典匹配。请手动指定未识别的列。`,
        );
      }
    }

    const detected = this.detectSourceType(parsed.headers);

    return {
      sheetName: parsed.sheetName,
      headerRowIndex: parsed.headerRowIndex,
      headers: parsed.headers,
      mapping,
      sampleRows: parsed.rows.slice(0, 10),
      totalRows: parsed.rows.length,
      skippedRows: parsed.skippedRows,
      warnings: [...parsed.warnings, ...mapping.warnings],
      detectedSourceType: detected,
    };
  }

  /** 根据表头猜测这张表是销项、进项还是申报表 */
  private detectSourceType(headers: string[]): string {
    const joined = headers.join('|');
    const has = (...kw: string[]) => kw.some((k) => joined.includes(k));

    if (has('销项', '销方', '销售方', '开票')) return 'INVOICE_SALES';
    if (has('进项', '购方', '购买方', '认证', '勾选', '抵扣')) return 'INVOICE_PURCHASE';
    if (has('申报', '应纳税额', '留抵', '销售额', '利润总额', '纳税调整')) return 'VAT_FILING';
    return 'UNKNOWN';
  }

  /** 让 AI 帮未识别的列名找归属 */
  private async askAiForMapping(
    unknownHeaders: string[],
    sampleRows: Array<Record<string, unknown>>,
  ): Promise<Array<{ source: string; target: string; confidence: number; reason?: string }>> {
    const fieldDesc = [
      'invoiceCode=发票代码',
      'invoiceNumber=发票号码',
      'invoiceDate=开票日期',
      'counterpartyName=对方单位名称',
      'counterpartyTaxNo=对方税号',
      'amountExclTax=不含税金额',
      'taxRate=税率',
      'taxAmount=税额',
      'amountInclTax=价税合计',
      'isCertified=认证或勾选状态',
      'isRedFlushed=是否红冲',
      'itemSummary=货物或服务名称',
      'IGNORE=与本业务无关',
    ].join('\n');

    const prompt = [
      '你是财务数据导入助手。下面是一个发票/申报明细表里**未能自动识别**的列名，',
      '以及这些列的前几行样例值。请判断每一列对应哪个标准字段。',
      '',
      '# 可选标准字段',
      fieldDesc,
      '',
      '# 待识别列与样例值',
      JSON.stringify(
        unknownHeaders.map((h) => ({
          column: h,
          样例值: sampleRows.map((r) => r[h]).filter((v) => v !== null && v !== undefined),
        })),
        null,
        2,
      ),
      '',
      '# 输出格式（只输出 JSON）',
      '{"mappings":[{"source":"列名","target":"标准字段","confidence":0.0-1.0,"reason":"一句中文理由"}]}',
      '',
      '不确定的填 IGNORE，不要猜。',
    ].join('\n');

    const res = await this.ai.extractJson({
      system: '你是财务数据导入助手。只输出 JSON，不要解释。',
      userText: prompt,
      promptKey: 'history-column-map',
      promptVersion: 'v1',
    });

    const parsed = res.json as { mappings?: Array<Record<string, unknown>> } | null;
    const list = parsed?.mappings ?? [];
    return list.map((m) => ({
      source: String(m.source ?? ''),
      target: String(m.target ?? 'IGNORE'),
      confidence: Number(m.confidence ?? 0.5),
      reason: m.reason === undefined ? undefined : String(m.reason),
    }));
  }

  // ==========================================================================
  //  二、导入落库
  // ==========================================================================

  /**
   * 按确认后的映射落库。
   *
   * ★ 幂等：发票按 dedupHash 去重，申报记录按 (类型, 期间) 去重。
   *   重复导入同一份文件不会产生重复记录。
   */
  async importRecords(params: {
    entityId: string;
    sourceType: string;
    fileName: string;
    fileHash: string;
    rows: Array<Record<string, unknown>>;
    mapping: Array<{ source: string; target: string }>;
    userId?: string;
  }): Promise<{ batchId: string; imported: number; duplicated: number; failed: number; errors: string[] }> {
    const { entityId, sourceType, fileName, fileHash, rows, mapping, userId } = params;

    // 幂等：同一文件不再重复导入
    const existingBatch = await this.prisma.historyImportBatch.findFirst({
      where: { entityId, fileHash },
    });
    if (existingBatch) {
      throw new Error(
        `该文件已经导入过（批次 ${existingBatch.id}，${existingBatch.createdAt.toISOString().slice(0, 10)}）。` +
          `如确需重新导入，请先删除原批次。`,
      );
    }

    const batch = await this.prisma.historyImportBatch.create({
      data: {
        entityId,
        sourceType: sourceType as never,
        fileName,
        fileHash,
        rowCount: rows.length,
        status: 'PARSING',
        importedBy: userId,
      },
    });

    const fieldMap = new Map<string, string>();
    for (const m of mapping) {
      if (m.target && m.target !== 'IGNORE') fieldMap.set(m.source, m.target);
    }

    let imported = 0;
    let duplicated = 0;
    let failed = 0;
    const errors: string[] = [];

    const isFiling = ['VAT_FILING', 'CIT_FILING'].includes(sourceType);
    const isInvoice = ['INVOICE_SALES', 'INVOICE_PURCHASE'].includes(sourceType);

    for (const [index, row] of rows.entries()) {
      try {
        // 把源行按映射转成标准字段
        const rec: Record<string, unknown> = {};
        for (const [source, target] of fieldMap) {
          rec[target] = row[source];
        }

        if (isInvoice) {
          const result = await this.importInvoiceRow(entityId, batch.id, sourceType, rec);
          if (result === 'DUPLICATE') duplicated += 1;
          else imported += 1;
        } else if (isFiling) {
          const result = await this.importFilingRow(entityId, batch.id, sourceType, rec);
          if (result === 'DUPLICATE') duplicated += 1;
          else imported += 1;
        } else {
          // 类型未定：按是否含发票关键字段自动判断
          const looksLikeInvoice = rec.invoiceDate !== undefined || rec.amountInclTax !== undefined;
          if (looksLikeInvoice) {
            const result = await this.importInvoiceRow(entityId, batch.id, 'INVOICE_SALES', rec);
            if (result === 'DUPLICATE') duplicated += 1;
            else imported += 1;
          } else {
            throw new Error('无法判断该行属于发票还是申报记录，请在上传时明确选择数据类型。');
          }
        }
      } catch (e) {
        failed += 1;
        if (errors.length < 20) {
          errors.push(`第 ${index + 2} 行：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    await this.prisma.historyImportBatch.update({
      where: { id: batch.id },
      data: {
        status: failed > 0 && imported === 0 ? 'FAILED' : 'IMPORTED',
        columnMapping: mapping as never,
        errorLog: errors.length > 0 ? (errors as never) : Prisma.JsonNull,
        finishedAt: new Date(),
      },
    });

    await this.audit.record({
      entityId,
      userId,
      action: 'CREATE',
      subjectType: 'HistoryImportBatch',
      subjectId: batch.id,
      afterData: { sourceType, fileName, imported, duplicated, failed },
    });

    this.logger.log(
      `历史数据导入完成：${sourceType} 成功 ${imported} 条，重复跳过 ${duplicated} 条，失败 ${failed} 条`,
    );

    return { batchId: batch.id, imported, duplicated, failed, errors };
  }

  /** 导入一条发票记录 */
  private async importInvoiceRow(
    entityId: string,
    batchId: string,
    sourceType: string,
    rec: Record<string, unknown>,
  ): Promise<'OK' | 'DUPLICATE'> {
    const direction = sourceType === 'INVOICE_SALES' ? 'OUTPUT' : 'INPUT';
    const invoiceDate = parseDate(rec.invoiceDate);
    if (!invoiceDate) {
      throw new Error(`开票日期无法解析：${JSON.stringify(rec.invoiceDate)}`);
    }

    const amountInclTax = parseAmount(rec.amountInclTax);
    const amountExclTax = parseAmount(rec.amountExclTax);
    const taxAmount = parseAmount(rec.taxAmount);
    const taxRate = parseTaxRate(rec.taxRate);

    // ★ 金额三者缺一就反算，但反算出来的要记下来（后续在方案里标注推算成分）
    let excl = amountExclTax;
    let tax = taxAmount;
    let incl = amountInclTax;

    if (incl === null && excl !== null && tax !== null) {
      incl = round2(excl.plus(tax));
    } else if (excl === null && incl !== null && tax !== null) {
      excl = round2(incl.minus(tax));
    } else if (tax === null && incl !== null && excl !== null) {
      tax = round2(incl.minus(excl));
    } else if (incl === null && excl !== null && taxRate !== null) {
      // 只知道不含税金额与税率
      tax = round2(excl.times(taxRate));
      incl = round2(excl.plus(tax));
    }

    if (incl === null) {
      throw new Error('价税合计无法确定（缺少金额、税额与税率，无法反算）');
    }
    if (excl === null) excl = new Decimal(0);
    if (tax === null) tax = round2(incl.minus(excl));

    const counterpartyName = String(rec.counterpartyName ?? '').trim();
    if (counterpartyName === '') {
      throw new Error('对方单位名称为空');
    }

    const invoiceCode = rec.invoiceCode === null || rec.invoiceCode === undefined ? null : String(rec.invoiceCode).trim() || null;
    const invoiceNumber = rec.invoiceNumber === null || rec.invoiceNumber === undefined ? null : String(rec.invoiceNumber).trim() || null;
    const isRedFlushed = parseBoolean(rec.isRedFlushed) ?? false;

    // ★ 去重键：与在线发票模块同一套规则
    const dedupHash = buildDedupHash({
      entityId,
      direction,
      invoiceCode,
      invoiceNumber,
      invoiceDate,
      counterpartyName,
      amountInclTax: incl,
      isRedFlushed,
    });

    const exists = await this.prisma.historyInvoiceRecord.findFirst({
      where: { entityId, dedupHash },
      select: { id: true },
    });
    if (exists) return 'DUPLICATE';

    const periodYear = invoiceDate.getUTCFullYear();
    const periodMonth = invoiceDate.getUTCMonth() + 1;

    await this.prisma.historyInvoiceRecord.create({
      data: {
        entityId,
        batchId,
        direction,
        kind: guessInvoiceKind(invoiceNumber, invoiceCode),
        invoiceCode,
        invoiceNumber,
        invoiceDate,
        periodYear,
        periodMonth,
        counterpartyName,
        counterpartyTaxNo:
          rec.counterpartyTaxNo === null || rec.counterpartyTaxNo === undefined
            ? null
            : String(rec.counterpartyTaxNo).trim() || null,
        amountExclTax: toDb(excl),
        taxRate: taxRate === null ? new Prisma.Decimal(0) : new Prisma.Decimal(taxRate.toFixed(4)),
        taxAmount: toDb(tax),
        amountInclTax: toDb(incl),
        isCertified: parseBoolean(rec.isCertified) ?? direction === 'INPUT',
        isRedFlushed,
        itemSummary:
          rec.itemSummary === null || rec.itemSummary === undefined
            ? null
            : String(rec.itemSummary).slice(0, 200),
        dedupHash,
      },
    });

    return 'OK';
  }

  /** 导入一条申报记录 */
  private async importFilingRow(
    entityId: string,
    batchId: string,
    sourceType: string,
    rec: Record<string, unknown>,
  ): Promise<'OK' | 'DUPLICATE'> {
    const filingType = sourceType === 'CIT_FILING' ? 'CIT_ANNUAL' : 'VAT_MONTHLY';

    // 期间：可能是 "2024-01" / "2024年1月" / "2024Q1" / "2024"
    const periodLabel = normalizePeriodLabel(rec.periodLabel ?? rec.invoiceDate ?? rec.period);
    if (!periodLabel) {
      throw new Error(`申报期间无法解析：${JSON.stringify(rec.periodLabel ?? rec.invoiceDate ?? rec.period)}`);
    }

    const exists = await this.prisma.historyFilingRecord.findFirst({
      where: { entityId, filingType, periodLabel },
      select: { id: true },
    });
    if (exists) return 'DUPLICATE';

    const year = Number(periodLabel.slice(0, 4));
    const monthMatch = /^\d{4}-(\d{2})$/.exec(periodLabel);
    const quarterMatch = /^\d{4}Q(\d)$/.exec(periodLabel);

    await this.prisma.historyFilingRecord.create({
      data: {
        entityId,
        batchId,
        filingType,
        periodLabel,
        periodYear: year,
        periodMonth: monthMatch ? Number(monthMatch[1]) : null,
        periodQuarter: quarterMatch ? Number(quarterMatch[1]) : null,
        salesExclTax: toDbNullable(parseAmount(rec.amountExclTax ?? rec.salesExclTax)),
        outputTax: toDbNullable(parseAmount(rec.taxAmount ?? rec.outputTax)),
        inputTax: toDbNullable(parseAmount(rec.inputTax)),
        inputTaxTransferOut: toDbNullable(parseAmount(rec.inputTaxTransferOut)),
        taxPayable: toDbNullable(parseAmount(rec.taxPayable)),
        taxPaid: toDbNullable(parseAmount(rec.taxPaid)),
        taxUnpaidEnd: toDbNullable(parseAmount(rec.taxUnpaidEnd)),
        surtax: toDbNullable(parseAmount(rec.surtax)),
        citRevenue: toDbNullable(parseAmount(rec.citRevenue)),
        citCost: toDbNullable(parseAmount(rec.citCost)),
        citProfitBefore: toDbNullable(parseAmount(rec.citProfitBefore)),
        citTaxPayable: toDbNullable(parseAmount(rec.citTaxPayable)),
        citTaxPaid: toDbNullable(parseAmount(rec.citTaxPaid)),
        citAdjustUp: toDbNullable(parseAmount(rec.citAdjustUp)),
        rawRow: rec as never,
      },
    });

    return 'OK';
  }

  // ==========================================================================
  //  三、年度重建
  // ==========================================================================

  /** 汇总某年的发票聚合数据 */
  async aggregateInvoices(entityId: string, year: number): Promise<{
    sales: InvoiceAggregate | null;
    purchases: InvoiceAggregate | null;
  }> {
    const records = await this.prisma.historyInvoiceRecord.findMany({
      where: { entityId, periodYear: year },
    });

    const build = (direction: 'OUTPUT' | 'INPUT'): InvoiceAggregate | null => {
      const subset = records.filter((r) => r.direction === direction);
      if (subset.length === 0) return null;

      const agg: InvoiceAggregate = {
        direction,
        year,
        count: subset.length,
        amountExclTax: new Decimal(0),
        taxAmount: new Decimal(0),
        amountInclTax: new Decimal(0),
        certifiedTaxAmount: new Decimal(0),
        byCategory: new Map(),
      };

      for (const r of subset) {
        // 红字发票按负数冲减
        const sign = r.isRedFlushed ? -1 : 1;
        const excl = fromDb(r.amountExclTax).times(sign);
        const tax = fromDb(r.taxAmount).times(sign);
        const incl = fromDb(r.amountInclTax).times(sign);

        agg.amountExclTax = agg.amountExclTax.plus(excl);
        agg.taxAmount = agg.taxAmount.plus(tax);
        agg.amountInclTax = agg.amountInclTax.plus(incl);
        if (r.isCertified) agg.certifiedTaxAmount = agg.certifiedTaxAmount.plus(tax);

        const cat = r.aiCategory ?? '未分类';
        const cur = agg.byCategory.get(cat) ?? {
          amountExclTax: new Decimal(0),
          taxAmount: new Decimal(0),
          count: 0,
        };
        cur.amountExclTax = cur.amountExclTax.plus(excl);
        cur.taxAmount = cur.taxAmount.plus(tax);
        cur.count += 1;
        agg.byCategory.set(cat, cur);
      }

      agg.amountExclTax = round2(agg.amountExclTax);
      agg.taxAmount = round2(agg.taxAmount);
      agg.amountInclTax = round2(agg.amountInclTax);
      agg.certifiedTaxAmount = round2(agg.certifiedTaxAmount);
      return agg;
    };

    return { sales: build('OUTPUT'), purchases: build('INPUT') };
  }

  /** 汇总某年的申报数据 */
  async aggregateFilings(entityId: string, year: number): Promise<FilingAggregate | null> {
    const records = await this.prisma.historyFilingRecord.findMany({
      where: { entityId, periodYear: year },
      orderBy: { periodLabel: 'asc' },
    });
    if (records.length === 0) return null;

    const vatRecords = records.filter((r) => r.filingType.startsWith('VAT'));
    const citRecord = records.find((r) => r.filingType.startsWith('CIT')) ?? null;

    const sum = (pick: (r: (typeof records)[number]) => Prisma.Decimal | null): Decimal | null => {
      const vals = vatRecords.map(pick).filter((v): v is Prisma.Decimal => v !== null);
      if (vals.length === 0) return null;
      return round2(vals.reduce((s, v) => s.plus(fromDb(v)), new Decimal(0)));
    };

    // 年末未缴税额：取最后一个有值的月份
    const lastUnpaid = [...vatRecords]
      .reverse()
      .map((r) => r.taxUnpaidEnd)
      .find((v) => v !== null);

    return {
      year,
      vat: {
        salesExclTax: sum((r) => r.salesExclTax),
        outputTax: sum((r) => r.outputTax),
        inputTax: sum((r) => r.inputTax),
        inputTaxTransferOut: sum((r) => r.inputTaxTransferOut),
        taxPayable: sum((r) => r.taxPayable),
        taxPaid: sum((r) => r.taxPaid),
        taxUnpaidYearEnd: lastUnpaid ? fromDb(lastUnpaid) : null,
        surtax: sum((r) => r.surtax),
        monthCount: vatRecords.length,
      },
      cit: citRecord
        ? {
            revenue: citRecord.citRevenue ? fromDb(citRecord.citRevenue) : null,
            cost: citRecord.citCost ? fromDb(citRecord.citCost) : null,
            profitBeforeTax: citRecord.citProfitBefore ? fromDb(citRecord.citProfitBefore) : null,
            taxPayable: citRecord.citTaxPayable ? fromDb(citRecord.citTaxPayable) : null,
            taxPaid: citRecord.citTaxPaid ? fromDb(citRecord.citTaxPaid) : null,
            adjustUp: citRecord.citAdjustUp ? fromDb(citRecord.citAdjustUp) : null,
          }
        : null,
    };
  }

  /** 重建指定年度，并落库结果 */
  async reconstructYearRecords(entityId: string, year: number): Promise<YearReconstruction> {
    const { sales, purchases } = await this.aggregateInvoices(entityId, year);
    const filing = await this.aggregateFilings(entityId, year);

    if (!sales && !purchases && !filing) {
      throw new NotFoundException(
        `${year} 年没有任何历史数据。请先导入该年度的销项发票、进项发票或申报记录。`,
      );
    }

    const profile = await this.prisma.taxProfile.findUnique({ where: { entityId } });
    const effectiveRate = profile?.smallProfitTaxRate
      ? fromDb(profile.smallProfitTaxRate).times(
          profile.smallProfitDeductionRate ? fromDb(profile.smallProfitDeductionRate) : new Decimal(1),
        )
      : new Decimal('0.05');

    const result = reconstructYear({
      year,
      salesInvoices: sales,
      purchaseInvoices: purchases,
      filing,
      smallProfitEffectiveRate: effectiveRate,
    });

    // 落库（幂等 upsert）
    await this.prisma.historyReconstruction.upsert({
      where: { entityId_year: { entityId, year } },
      create: {
        entityId,
        year,
        status: result.requiredInputs.length > 0 ? 'NEEDS_INPUT' : 'READY',
        salesInvoiceCount: result.sales?.count ?? 0,
        salesAmountExclTax: toDb(result.sales?.amountExclTax ?? 0),
        salesTaxAmount: toDb(result.sales?.taxAmount ?? 0),
        purchaseInvoiceCount: result.purchases?.count ?? 0,
        purchaseAmountExclTax: toDb(result.purchases?.amountExclTax ?? 0),
        purchaseTaxAmount: toDb(result.purchases?.taxAmount ?? 0),
        certifiedTaxAmount: toDb(result.purchases?.certifiedTaxAmount ?? 0),
        declaredSalesExclTax: toDbNullable(filing?.vat.salesExclTax),
        declaredOutputTax: toDbNullable(filing?.vat.outputTax),
        declaredInputTax: toDbNullable(filing?.vat.inputTax),
        declaredTaxPayable: toDbNullable(filing?.vat.taxPayable),
        declaredTaxPaid: toDbNullable(filing?.vat.taxPaid),
        declaredSurtax: toDbNullable(filing?.vat.surtax),
        profitBeforeTax: toDbNullable(result.profitBeforeTax),
        derivedCost: toDbNullable(result.derivedCostTotal),
        invoicedCost: toDb(result.invoicedCost),
        costWithoutInvoice: toDbNullable(result.costWithoutInvoice),
        incomeTaxExpense: toDbNullable(result.incomeTaxExpense),
        incomeTaxPayable: toDbNullable(filing?.cit?.taxPayable),
        netProfit: toDbNullable(result.netProfit),
        requiredInputs: result.requiredInputs as never,
        aiWarnings: result.warnings as never,
      },
      update: {
        status: result.requiredInputs.length > 0 ? 'NEEDS_INPUT' : 'READY',
        salesInvoiceCount: result.sales?.count ?? 0,
        salesAmountExclTax: toDb(result.sales?.amountExclTax ?? 0),
        salesTaxAmount: toDb(result.sales?.taxAmount ?? 0),
        purchaseInvoiceCount: result.purchases?.count ?? 0,
        purchaseAmountExclTax: toDb(result.purchases?.amountExclTax ?? 0),
        purchaseTaxAmount: toDb(result.purchases?.taxAmount ?? 0),
        certifiedTaxAmount: toDb(result.purchases?.certifiedTaxAmount ?? 0),
        declaredSalesExclTax: toDbNullable(filing?.vat.salesExclTax),
        declaredOutputTax: toDbNullable(filing?.vat.outputTax),
        declaredInputTax: toDbNullable(filing?.vat.inputTax),
        declaredTaxPayable: toDbNullable(filing?.vat.taxPayable),
        declaredTaxPaid: toDbNullable(filing?.vat.taxPaid),
        declaredSurtax: toDbNullable(filing?.vat.surtax),
        profitBeforeTax: toDbNullable(result.profitBeforeTax),
        derivedCost: toDbNullable(result.derivedCostTotal),
        invoicedCost: toDb(result.invoicedCost),
        costWithoutInvoice: toDbNullable(result.costWithoutInvoice),
        incomeTaxExpense: toDbNullable(result.incomeTaxExpense),
        incomeTaxPayable: toDbNullable(filing?.cit?.taxPayable),
        netProfit: toDbNullable(result.netProfit),
        requiredInputs: result.requiredInputs as never,
        aiWarnings: result.warnings as never,
      },
    });

    return result;
  }

  /** 重建全部历史年度 */
  async reconstructAll(entityId: string): Promise<{
    years: YearReconstruction[];
    combinedRequiredInputs: ReturnType<typeof dedupeRequiredInputs>;
  }> {
    const yearRows = await this.prisma.historyInvoiceRecord.findMany({
      where: { entityId },
      select: { periodYear: true },
      distinct: ['periodYear'],
      orderBy: { periodYear: 'asc' },
    });
    const filingYears = await this.prisma.historyFilingRecord.findMany({
      where: { entityId },
      select: { periodYear: true },
      distinct: ['periodYear'],
      orderBy: { periodYear: 'asc' },
    });

    const years = [...new Set([...yearRows.map((r) => r.periodYear), ...filingYears.map((r) => r.periodYear)])].sort();

    if (years.length === 0) {
      throw new NotFoundException('还没有导入任何历史数据。请先上传销项发票、进项发票与申报记录。');
    }

    const results: YearReconstruction[] = [];
    for (const y of years) {
      results.push(await this.reconstructYearRecords(entityId, y));
    }

    return { years: results, combinedRequiredInputs: dedupeRequiredInputs(results) };
  }

  // ==========================================================================
  //  四、生成期初建账方案
  // ==========================================================================

  /**
   * 读取已建档的财务报表，转成期初方案可用的科目余额。
   *
   * 取数策略（**只取"启用前最近一期"**）：
   *   期初建账要的是"启用前一日的余额"，所以：
   *     ① 优先取 statementDate 早于启用期间起点的**最近一期**资产负债表；
   *     ② 没有更早的，才退而取最早一期（并明确标注期间，让人知道口径不对）。
   *   绝不把不同期间的表混在一起 —— 混用会产生一个任何时点都不成立的余额表。
   */
  private async loadDeclaredFromStatements(
    entityId: string,
    targetYear: number,
  ): Promise<{
    balances: Map<string, { amount: string; label: string; direction: 'DEBIT' | 'CREDIT' }>;
    note: string | null;
  }> {
    const empty = { balances: new Map(), note: null as string | null };

    try {
      const cutoff = new Date(Date.UTC(targetYear, 0, 1));

      const before = await this.prisma.financialStatementRecord.findFirst({
        where: {
          entityId,
          statementType: 'BALANCE_SHEET',
          statementDate: { lt: cutoff },
        },
        orderBy: { statementDate: 'desc' },
      });
      const bs =
        before ??
        (await this.prisma.financialStatementRecord.findFirst({
          where: { entityId, statementType: 'BALANCE_SHEET' },
          orderBy: { statementDate: 'asc' },
        }));

      if (!bs) return empty;

      const items = (bs.items ?? []) as unknown as StatementItem[];
      const mapped = mapBalanceSheetItems(items);
      if (mapped.balances.size === 0) return empty;

      const dateLabel = bs.statementDate.toISOString().slice(0, 10);
      const note =
        `${dateLabel} 资产负债表` + (before ? '' : '（★ 该表期间晚于启用日，口径可能不符，请核对）');

      this.logger.log(
        `期初方案取用已建档报表：${dateLabel} 资产负债表，` +
          `映射到 ${mapped.balances.size} 个科目；跳过 ${mapped.skipped.length} 行`,
      );

      return { balances: mapped.balances, note };
    } catch (e) {
      // 报表取数失败不能阻断期初建账 —— 退回倒轧，并在日志里说清
      this.logger.warn(
        `读取已建档财务报表失败，本次期初方案将不使用报表数据：` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
      return empty;
    }
  }

  /** 已建档报表的映射明细（给界面看：哪些行用上了、哪些没用上） */
  async describeDeclaredStatements(entityId: string, targetYear: number) {
    const bs = await this.prisma.financialStatementRecord.findFirst({
      where: { entityId, statementType: 'BALANCE_SHEET' },
      orderBy: { statementDate: 'desc' },
    });
    const is = await this.prisma.financialStatementRecord.findFirst({
      where: { entityId, statementType: 'INCOME_STATEMENT' },
      orderBy: { statementDate: 'desc' },
    });

    const bsItems = bs ? ((bs.items ?? []) as unknown as StatementItem[]) : [];
    const isItems = is ? ((is.items ?? []) as unknown as StatementItem[]) : [];
    const mapped = mapBalanceSheetItems(bsItems);
    const income = readIncomeStatement(isItems);

    return {
      targetYear,
      balanceSheet: bs
        ? {
            id: bs.id,
            statementDate: bs.statementDate.toISOString().slice(0, 10),
            isBalanced: bs.isBalanced,
            balanceDifference: bs.balanceDifference ? fromDb(bs.balanceDifference).toFixed(2) : null,
            itemCount: bsItems.length,
            mapped: [...mapped.balances.entries()].map(([code, v]) => ({
              accountCode: code,
              label: v.label,
              amount: v.amount,
              direction: v.direction,
            })),
            skipped: mapped.skipped,
          }
        : null,
      incomeStatement: is
        ? {
            id: is.id,
            statementDate: is.statementDate.toISOString().slice(0, 10),
            itemCount: isItems.length,
            ...income,
          }
        : null,
      explanation: bs
        ? '★ 已建档资产负债表会被期初建账方案自动取用，优先级高于人工输入。' +
          '合计行不会被映射（映射过去会让资产被重复确认）。'
        : '还没有已建档的资产负债表。到「识别录入」上传后，货币资金、存货、固定资产、' +
          '实收资本这些"算不出来只能问人"的科目就能自动取数，不必再倒轧。',
    };
  }

  async buildProposal(params: {
    entityId: string;
    targetYear: number;
    targetMonth: number;
    manual?: ManualInputs;
    userId?: string;
  }): Promise<{ proposalId: string; proposal: ReturnType<typeof buildOpeningProposal> }> {
    const { entityId, targetYear, targetMonth, manual = {}, userId } = params;

    const reconstructions = await this.prisma.historyReconstruction.findMany({
      where: { entityId },
      orderBy: { year: 'asc' },
    });
    if (reconstructions.length === 0) {
      throw new NotFoundException('还没有年度重建结果。请先执行「重建全部年度」。');
    }

    // 复用重建结果（不重跑聚合，保证与页面上看到的一致）
    const years: YearReconstruction[] = reconstructions.map((r) => ({
      year: r.year,
      sales: null,
      purchases: null,
      filing: null,
      reconciliations: [],
      reconciled: true,
      revenue: fromDb(r.declaredSalesExclTax ?? r.salesAmountExclTax),
      revenueSource: r.declaredSalesExclTax ? 'DECLARED' : 'INVOICE',
      invoicedCost: fromDb(r.invoicedCost),
      derivedCostTotal: r.derivedCost ? fromDb(r.derivedCost) : null,
      costWithoutInvoice: r.costWithoutInvoice ? fromDb(r.costWithoutInvoice) : null,
      profitBeforeTax: r.profitBeforeTax ? fromDb(r.profitBeforeTax) : null,
      incomeTaxExpense: r.incomeTaxExpense ? fromDb(r.incomeTaxExpense) : null,
      netProfit: r.netProfit ? fromDb(r.netProfit) : null,
      requiredInputs: (r.requiredInputs ?? []) as never,
      warnings: (r.aiWarnings ?? []) as never as string[],
    }));

    // ★ 方案生成需要发票聚合（应收账款要靠价税合计），所以这里补一次聚合
    for (const y of years) {
      const { sales, purchases } = await this.aggregateInvoices(entityId, y.year);
      y.sales = sales;
      y.purchases = purchases;
      y.filing = await this.aggregateFilings(entityId, y.year);
    }

    // ★ 已建档的财务报表是最可信的数据来源，必须接进方案。
    //   否则用户在「识别录入」里辛苦上传的资产负债表就只是躺在库里，
    //   期初建账依然要靠倒轧 —— 那正是"账能平但资产负债表是错的"的根源。
    const declared = await this.loadDeclaredFromStatements(entityId, targetYear);

    const proposal = buildOpeningProposal({
      targetYear,
      targetMonth,
      years,
      manual: {
        ...manual,
        // 已建档报表优先于人工输入（报表是别人出的表，人工输入是"我记得"）
        declaredBalances: declared.balances,
        declaredStatementNote: declared.note,
      },
    });

    // 找到目标会计期间
    const period = await this.prisma.period.findFirst({
      where: { entityId, fiscalYear: targetYear, month: targetMonth },
    });
    if (!period) {
      throw new NotFoundException(
        `找不到会计期间 ${targetYear}-${String(targetMonth).padStart(2, '0')}。请先初始化该年度的会计期间。`,
      );
    }

    // 解析科目编码 → id
    const codes = proposal.lines.map((l) => l.accountCode);
    const accountMap = await this.accounts.resolveMany(entityId, codes);

    // 已有草稿方案则替换
    await this.prisma.openingBalanceProposal.deleteMany({
      where: { entityId, status: { in: ['DRAFT', 'REJECTED'] } },
    });

    const created = await this.prisma.openingBalanceProposal.create({
      data: {
        entityId,
        targetPeriodId: period.id,
        targetYear,
        targetMonth,
        status: 'DRAFT',
        totalDebit: toDb(proposal.totalDebit),
        totalCredit: toDb(proposal.totalCredit),
        difference: toDb(proposal.difference),
        cashBasis: proposal.cashBasis,
        actualCashBalance: toDbNullable(
          manual.cashBalanceByYear?.[targetYear - 1]
            ? new Decimal(manual.cashBalanceByYear[targetYear - 1]!)
            : null,
        ),
        aiSummary: proposal.summary,
        warnings: proposal.warnings as never,
        createdBy: userId,
        lines: {
          create: proposal.lines.map((l, i) => ({
            lineNo: i + 1,
            accountId: accountMap.get(l.accountCode)!.id,
            accountCode: l.accountCode,
            accountName: accountMap.get(l.accountCode)!.fullName,
            direction: l.direction,
            amount: toDb(l.amount),
            source: l.source,
            sourceNote: l.sourceNote,
            breakdown: (l.breakdown ?? null) as never,
            needsReview: l.needsReview,
          })),
        },
        sources: {
          create: years.map((y) => ({
            refType: 'HISTORY_RECONSTRUCTION',
            refId: null,
            note:
              `${y.year} 年：销项 ${y.sales?.count ?? 0} 张（价税合计 ` +
              `${round2(y.sales?.amountInclTax ?? 0).toFixed(2)}），` +
              `进项 ${y.purchases?.count ?? 0} 张，净利润 ${round2(y.netProfit ?? 0).toFixed(2)}`,
            amount: toDbNullable(y.netProfit),
          })),
        },
      },
    });

    await this.audit.record({
      entityId,
      userId,
      action: 'CREATE',
      subjectType: 'OpeningBalanceProposal',
      subjectId: created.id,
      afterData: {
        targetPeriod: `${targetYear}-${String(targetMonth).padStart(2, '0')}`,
        lines: proposal.lines.length,
        balanced: proposal.balanced,
        cashBasis: proposal.cashBasis,
      },
    });

    return { proposalId: created.id, proposal };
  }
}

// ============================================================================
//  辅助
// ============================================================================

/**
 * 去重键：与在线发票模块共用同一份公式（见 common/dedup）。
 * 命名空间用 H（历史原始素材表），因此同一张票可以同时在
 * history_invoice_record 与 invoice 两张表里各存在一条 —— 这是有意的。
 */
function buildDedupHash(p: {
  entityId: string;
  direction: string;
  invoiceCode: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date;
  counterpartyName: string;
  amountInclTax: Decimal;
  isRedFlushed: boolean;
}): string {
  return buildInvoiceDedupHash(DEDUP_NS_HISTORY, {
    direction: p.direction,
    invoiceCode: p.invoiceCode,
    invoiceNumber: p.invoiceNumber,
    invoiceDate: p.invoiceDate,
    isRedFlushed: p.isRedFlushed,
    counterpartyName: p.counterpartyName,
    amountInclTax: p.amountInclTax,
  });
}

function guessInvoiceKind(
  invoiceNumber: string | null,
  invoiceCode: string | null,
): 'SPECIAL_VAT' | 'GENERAL_VAT' | 'E_INVOICE' | 'OTHER' {
  if (invoiceNumber && /^\d{20}$/.test(invoiceNumber)) return 'E_INVOICE';
  if (invoiceCode && /^\d{10}$|^\d{12}$/.test(invoiceCode)) return 'SPECIAL_VAT';
  return 'OTHER';
}

/** "2024-01" / "2024年1月" / "2024Q1" / "2024" → 标准化 */
function normalizePeriodLabel(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;

  m = /^(\d{4})年(\d{1,2})月$/.exec(s);
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;

  m = /^(\d{4})[Qq]([1-4])$/.exec(s);
  if (m) return `${m[1]}Q${m[2]}`;

  m = /^(\d{4})年?$/.exec(s);
  if (m) return m[1]!;

  // 完整日期 → 取年月
  const d = parseDate(s);
  if (d) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  return null;
}

/** 可空金额转 Prisma：null / undefined 都表示"该字段没有值" */
function toDbNullable(v: Decimal | null | undefined): Prisma.Decimal | null {
  return v === null || v === undefined ? null : toDb(v);
}

/** 跨年度合并待补录项（同名字段只保留一条，避免让人重复填） */
function dedupeRequiredInputs(years: YearReconstruction[]): Array<{
  field: string;
  label: string;
  reason: string;
  suggestion: string;
}> {
  const seen = new Map<string, { field: string; label: string; reason: string; suggestion: string }>();
  for (const y of years) {
    for (const r of y.requiredInputs) {
      // 按 field 去重（年份相关的字段保留，因为要按年填）
      const key = r.field === 'cashBalance' || r.field === 'paidInCapital' ? r.field : `${y.year}:${r.field}`;
      if (!seen.has(key)) seen.set(key, r);
    }
  }
  return [...seen.values()];
}

export type { OpeningLine, ManualInputs };
export type { ParsedSheet };
export type { InvoiceField };
