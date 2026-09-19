/**
 * 报表 / 申报表 识别结果的持久化
 * ============================================================
 * 与发票识别最大的区别：
 *
 *   发票 → 生成凭证 → 影响账簿。
 *   报表 → **只建档案，绝不过账、绝不生成凭证**。
 *
 * 为什么这条边界必须硬：
 *   报表是"结果"，凭证是"原因"。拿一张资产负债表的期末数去生成凭证，
 *   等于把结果当原因记账 —— 会导致资产被重复确认（明细账已有数，又加一遍表数）。
 *   报表的正确用途只有一个：为**启用期初余额**提供真实数据，
 *   由重建流程（reconstruction）去用，而不是直接进账。
 *
 * 另外，本服务不做任何"平衡修正"：
 *   报表不平就如实记录 isBalanced=false 与差额，写进 reconNote，
 *   让人去核对原件。抹平差额会让后面的期初建账建立在一个编造的数字上。
 */
import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@bookkeeper/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DomainError } from '../../domain/accounting/errors';
import type {
  StatementExtraction,
  StatementValidation,
  VatReturnExtraction,
} from '../../domain/history/statement.model';
import {
  buildVatReturnExtraction,
  buildCitReturnExtraction,
} from '../../domain/history/statement.model';
import type { CitReturnExtraction } from '../../domain/history/statement.model';

export type RecognizedStatementType =
  | 'BALANCE_SHEET'
  | 'INCOME_STATEMENT'
  | 'CASH_FLOW'
  | 'TAX_RETURN';

export interface SaveStatementInput {
  entityId: string;
  statementType: RecognizedStatementType;
  /** 人工确认后的报表期间（识别不出来时由界面补） */
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
  /** 识别来源单据，便于回看原件 */
  documentId?: string | null;
  batchId?: string | null;
  /** 人工说明（例如"原表确实不平，原因：…"） */
  reconNote?: string | null;
  /** VAT 口径下的附加信息 */
  filingType?: 'VAT_MONTHLY' | 'VAT_QUARTERLY' | 'CIT_QUARTERLY' | 'CIT_ANNUAL';
  /** 原始抽取结果，原样留存便于追溯 */
  rawRow?: Record<string, unknown>;
}

export interface SaveStatementResult {
  kind: 'FINANCIAL_STATEMENT' | 'TAX_RETURN';
  id: string;
  created: boolean;
  periodLabel: string;
  /** 必须人工确认的提示（不平、期间缺失等） */
  warnings: string[];
}

@Injectable()
export class StatementImportService {
  private readonly logger = new Logger(StatementImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 把识别结果从「AI 预览」转成「可保存的报表输入」。
   *
   * ★ 这是识别 → 保存之间唯一的桥。
   *   界面上的"确认并保存"按钮拿到的就是这个结构，
   *   也就是说人工看到并确认的字段，和落库的字段是同一份数据。
   */
  static fromPreview(params: {
    statementType: RecognizedStatementType;
    data: Record<string, unknown>;
    validation?: {
      isBalanced?: boolean | null;
      balanceDifference?: string | null;
    } | null;
    documentId?: string | null;
    periodOverride?: { periodStart?: string | null; periodEnd?: string | null } | null;
    filingType?: SaveStatementInput['filingType'];
  }): SaveStatementInput {
    const data = params.data;
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const items = rawItems
      .map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        const label = String(o.label ?? o.name ?? '').trim();
        if (!label) return null;
        return {
          lineNo: o.lineNo === null || o.lineNo === undefined ? null : String(o.lineNo),
          label,
          endBalance: moneyOrNull(o.endBalance),
          beginBalance: moneyOrNull(o.beginBalance),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const totals: Record<string, string | null> = {};
    for (const key of [
      'totalAssets',
      'totalLiabilities',
      'totalEquity',
      'revenue',
      'cost',
      'profitBeforeTax',
      'netProfit',
    ]) {
      totals[key] = moneyOrNull(data[key]);
    }

    return {
      entityId: '',
      statementType: params.statementType,
      periodStart: params.periodOverride?.periodStart ?? textOrNull(data.periodStart),
      periodEnd:
        params.periodOverride?.periodEnd ??
        textOrNull(data.periodEnd) ??
        textOrNull(data.date),
      items,
      totals,
      isBalanced: params.validation?.isBalanced ?? null,
      balanceDifference: params.validation?.balanceDifference ?? null,
      documentId: params.documentId ?? null,
      filingType: params.filingType,
      rawRow: data,
    };
  }

  /**
   * 保存识别出的报表 / 申报表。
   *
   * 幂等：靠数据库唯一键（同主体 + 报表类型 + 报表日期）做 upsert，
   * 因此同一份报表重复识别上传不会产生第二份档案。
   */
  async save(input: SaveStatementInput): Promise<SaveStatementResult> {
    if (!input.entityId) {
      throw new DomainError('BAD_REQUEST', '保存报表前必须先选择主体。', 400, '缺少 entityId');
    }
    if (!input.periodEnd) {
      throw new DomainError(
        'BAD_REQUEST',
        '报表期间是历史归集的前提 —— 没有它就归不到年份上。请先补充报表所属期间（如 2024-12-31）。',
        400,
        'periodEnd 为空',
      );
    }

    const periodEnd = parseDateStrict(input.periodEnd);
    if (!periodEnd) {
      throw new DomainError(
        'BAD_REQUEST',
        `无法从「${input.periodEnd}」解析出日期。请使用 YYYY-MM-DD（如 2024-12-31）、YYYY-MM（如 2024-12）或 YYYY（如 2024）。`,
        400,
        'periodEnd 格式无法解析',
      );
    }

    const warnings: string[] = [];
    if (input.isBalanced === false) {
      warnings.push(
        `该报表资产与负债+权益相差 ${input.balanceDifference ?? '（未给出差额）'}。` +
          `★ 系统不做平衡修正，已按原值存档；请核对原件后在备注中说明原因。`,
      );
    }
    if (input.items.length === 0) {
      warnings.push('没有识别出任何行项目，存档后无法用于期初建账，建议重新识别。');
    }

    return input.statementType === 'TAX_RETURN'
      ? this.saveTaxReturn(input, periodEnd, warnings)
      : this.saveFinancialStatement(input, periodEnd, warnings);
  }

  // --------------------------------------------------------------------------
  //  财务报表
  // --------------------------------------------------------------------------

  private async saveFinancialStatement(
    input: SaveStatementInput,
    periodEnd: Date,
    warnings: string[],
  ): Promise<SaveStatementResult> {
    const statementType = input.statementType as
      | 'BALANCE_SHEET'
      | 'INCOME_STATEMENT'
      | 'CASH_FLOW';
    const fiscalYear = periodEnd.getUTCFullYear();
    const fiscalMonth = periodEnd.getUTCMonth() + 1;

    // ★ items 用数组存：顺序就是报表上的顺序，重建时按行次取用更直观
    const items = input.items;

    const existing = await this.prisma.financialStatementRecord.findUnique({
      where: {
        entityId_statementType_statementDate: {
          entityId: input.entityId,
          statementType,
          statementDate: periodEnd,
        },
      },
      select: { id: true },
    });

    const payload = {
      entityId: input.entityId,
      statementType,
      statementDate: periodEnd,
      fiscalYear,
      fiscalMonth: statementType === 'BALANCE_SHEET' ? fiscalMonth : null,
      items: items as never,
      totalAssets: toDb(input.totals?.totalAssets),
      totalLiabilities: toDb(input.totals?.totalLiabilities),
      totalEquity: toDb(input.totals?.totalEquity),
      revenue: toDb(input.totals?.revenue),
      cost: toDb(input.totals?.cost),
      profitBeforeTax: toDb(input.totals?.profitBeforeTax),
      netProfit: toDb(input.totals?.netProfit),
      // 未知（null）时按"未标不平"处理，并把警告写进备注，避免误报为已平衡
      isBalanced: input.isBalanced !== false,
      balanceDifference: toDb(input.balanceDifference),
      rawRow: (input.rawRow ?? null) as never,
      documentId: input.documentId ?? null,
      reconNote: input.reconNote ?? (warnings.length ? warnings.join('\n') : null),
      batchId: input.batchId ?? null,
      source: 'RECOGNITION',
    };

    const saved = await this.prisma.financialStatementRecord.upsert({
      where: {
        entityId_statementType_statementDate: {
          entityId: input.entityId,
          statementType,
          statementDate: periodEnd,
        },
      },
      create: payload,
      update: payload,
      select: { id: true },
    });

    this.logger.log(
      `报表存档：${statementType} ${formatDate(periodEnd)}（${items.length} 行，` +
        `${existing ? '覆盖已有档案' : '新建档案'}）`,
    );

    return {
      kind: 'FINANCIAL_STATEMENT',
      id: saved.id,
      created: !existing,
      periodLabel: formatDate(periodEnd),
      warnings,
    };
  }

  // --------------------------------------------------------------------------
  //  申报表
  // --------------------------------------------------------------------------

  private async saveTaxReturn(
    input: SaveStatementInput,
    periodEnd: Date,
    warnings: string[],
  ): Promise<SaveStatementResult> {
    const raw = input.rawRow ?? {};
    const vat: VatReturnExtraction = buildVatReturnExtraction(raw);
    const cit: CitReturnExtraction = buildCitReturnExtraction(raw);
    const rawPeriod = String(input.periodEnd ?? '');
    const periodLabel = normalizePeriodLabel(rawPeriod);
    if (!periodLabel) {
      throw new DomainError(
        'BAD_REQUEST',
        `无法从「${input.periodEnd}」解析出申报所属期。请使用 2024-12 / 2024Q4 / 2024 之一。`,
        400,
        'periodLabel 无法解析',
      );
    }

    const monthMatch = /^(\d{4})-(\d{2})$/.exec(periodLabel);
    const quarterMatch = /^(\d{4})Q([1-4])$/.exec(periodLabel);
    const periodYear = Number(periodLabel.slice(0, 4));
    const periodMonth = monthMatch ? Number(monthMatch[2]) : null;
    const periodQuarter = quarterMatch ? Number(quarterMatch[2]) : null;

    // 是增值税还是企业所得税，由调用方指定；默认按增值税月报处理
    const filingType =
      input.filingType ??
      (periodQuarter ? 'VAT_QUARTERLY' : ('VAT_MONTHLY' as const));

    const isCit = filingType.startsWith('CIT');

    const payload = {
      entityId: input.entityId,
      filingType,
      periodLabel,
      periodYear,
      periodMonth: isCit && periodQuarter ? null : periodMonth,
      periodQuarter,
      // 增值税字段：所得税申报记录一律写 null ——
      // 混写会让"历史税负"报表把所得税的利润总额当成增值税销售额统计。
      salesExclTax: isCit ? null : toDb(vat.line1SalesTaxable),
      outputTax: isCit ? null : toDb(vat.line11OutputTax),
      inputTax: isCit ? null : toDb(vat.line12InputTax),
      inputTaxTransferOut: isCit ? null : toDb(vat.line14InputTaxTransferOut),
      taxCreditBroughtForward: isCit ? null : toDb(vat.line13CreditBroughtForward),
      taxPayable: isCit
        ? toDb(cit.line12TaxPayable)
        : toDb(vat.line24TaxPayableTotal ?? vat.line19TaxPayable),
      taxPaid: isCit ? toDb(cit.line14PaidThisYear) : toDb(vat.line27TaxPaidThisPeriod),
      taxUnpaidEnd: isCit ? null : toDb(vat.line32ClosingUnpaid),
      surtax: toDb(vat.surtaxTotal),

      // ★ 企业所得税是另一套字段：增值税的行次与所得税完全没有对应关系。
      //   按 isCit 分开写，避免把增值税的数写进所得税字段（那会让税负基线整体错位）。
      citRevenue: isCit ? toDb(cit.line1Revenue) : null,
      citCost: isCit ? toDb(cit.line2Cost) : null,
      citProfitBefore: isCit ? toDb(cit.line3ProfitTotal) : null,
      citTaxPayable: isCit ? toDb(cit.line12TaxPayable) : null,
      citTaxPaid: isCit ? toDb(cit.line14PaidThisYear) : null,
      // 纳税调整增加额：不征税/免税/加计扣除的反向口径，只在不征税收入为负向调整时有意义
      citAdjustUp: isCit ? toDb(cit.line4SpecificAdjust) : null,

      rawRow: {
        ...(input.rawRow ?? {}),
        _items: input.items,
        _totals: input.totals ?? {},
      } as never,
      batchId: input.batchId ?? null,
      reconStatus: 'PENDING' as const,
      reconNote: input.reconNote ?? (warnings.length ? warnings.join('\n') : null),
    };

    const existing = await this.prisma.historyFilingRecord.findUnique({
      where: {
        entityId_filingType_periodLabel: {
          entityId: input.entityId,
          filingType,
          periodLabel,
        },
      },
      select: { id: true },
    });

    const saved = await this.prisma.historyFilingRecord.upsert({
      where: {
        entityId_filingType_periodLabel: {
          entityId: input.entityId,
          filingType,
          periodLabel,
        },
      },
      create: payload,
      update: payload,
      select: { id: true },
    });

    this.logger.log(
      `申报表存档：${filingType} ${periodLabel}（${existing ? '覆盖已有记录' : '新建记录'}）`,
    );

    return {
      kind: 'TAX_RETURN',
      id: saved.id,
      created: !existing,
      periodLabel,
      warnings,
    };
  }

  // --------------------------------------------------------------------------
  //  查询
  // --------------------------------------------------------------------------

  /** 已存档的历史报表清单 */
  async listStatements(entityId: string, statementType?: RecognizedStatementType) {
    return this.prisma.financialStatementRecord.findMany({
      where: {
        entityId,
        ...(statementType && statementType !== 'TAX_RETURN'
          ? { statementType }
          : {}),
      },
      orderBy: { statementDate: 'desc' },
      select: {
        id: true,
        statementType: true,
        statementDate: true,
        fiscalYear: true,
        fiscalMonth: true,
        source: true,
        isBalanced: true,
        balanceDifference: true,
        totalAssets: true,
        totalLiabilities: true,
        totalEquity: true,
        revenue: true,
        netProfit: true,
        documentId: true,
        reconNote: true,
        createdAt: true,
      },
    });
  }

  /** 已存档的申报表清单 */
  async listFilings(entityId: string) {
    return this.prisma.historyFilingRecord.findMany({
      where: { entityId },
      orderBy: [{ periodYear: 'desc' }, { periodLabel: 'desc' }],
    });
  }

  /** 删除一份报表档案（识别错了要能撤销） */
  async removeStatement(entityId: string, id: string): Promise<{ deleted: boolean }> {
    const row = await this.prisma.financialStatementRecord.findFirst({
      where: { id, entityId },
      select: { id: true },
    });
    if (!row) {
      throw new DomainError('NOT_FOUND', '该报表档案不存在或不属于当前主体。', 404);
    }
    await this.prisma.financialStatementRecord.delete({ where: { id } });
    return { deleted: true };
  }

  /** 删除一条申报记录 */
  async removeFiling(entityId: string, id: string): Promise<{ deleted: boolean }> {
    const row = await this.prisma.historyFilingRecord.findFirst({
      where: { id, entityId },
      select: { id: true },
    });
    if (!row) {
      throw new DomainError('NOT_FOUND', '该申报记录不存在或不属于当前主体。', 404);
    }
    await this.prisma.historyFilingRecord.delete({ where: { id } });
    return { deleted: true };
  }
}

// ============================================================================
//  工具
// ============================================================================

function moneyOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  const s = String(raw).trim();
  if (s === '' || s === '-' || s === '—' || s === '/') return null;
  return s;
}

function textOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/** 金额字符串 → Prisma.Decimal（保留原值精度，不做四舍五入抹平） */
function toDb(v: string | null | undefined): Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const d = new Decimal(String(v).replace(/[¥￥,\s]/g, ''));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** 严格日期解析：不接受 "2024" 这种只有年份的输入（报表必须有明确时点） */
function parseDateStrict(raw: string): Date | null {
  const s = raw.trim();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  m = /^(\d{4})[-/年](\d{1,2})[月]?$/.exec(s);
  if (m) {
    // 只有年月 → 取月末（资产负债表是时点数，月末才是它的时点）
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return new Date(Date.UTC(y, mo, 0));
  }

  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  // ★ 只有年份：这是合法的申报口径，不是格式错误。
  //   企业所得税汇算清缴的所属期就是「2023」这样的年度；
  //   资产负债表的年度报表时点也是 12-31。
  //   所以取该年 12-31 作为时点，而不是拒绝。
  m = /^(\d{4})(?:年)?$/.exec(s);
  if (m) {
    return new Date(Date.UTC(Number(m[1]), 11, 31));
  }

  return null;
}

/** 报表时点 → "2024-12-31" */
function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** 申报所属期标准化："2024-12" / "2024Q4" / "2024" */
export function normalizePeriodLabel(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null;

  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;

  m = /^(\d{4})年(\d{1,2})月$/.exec(s);
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;

  m = /^(\d{4})[Qq]([1-4])$/.exec(s);
  if (m) return `${m[1]}Q${m[2]}`;

  m = /^(\d{4})(?:年)?$/.exec(s);
  if (m) return m[1]!;

  // 完整日期 → 归到月
  const d = parseDateStrict(s);
  if (d) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  return null;
}

/** 供校验层复用的导出，避免控制器重复实现 */
export type { StatementExtraction, StatementValidation };
