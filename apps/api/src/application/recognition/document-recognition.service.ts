/**
 * 单据识别落库：从仓库里的一份文件 → 一张结构化发票
 * ============================================================
 * 这条链路把「电子发票仓库」真正闭合起来：
 *
 *   POST /documents/upload      文件入库（哈希去重，只存原件）
 *          ↓
 *   POST /documents/:id/recognize   识别 → 会计交叉校验 → 落为 Invoice
 *          ↓
 *   凭证册打印时就能带出这张票的原件
 *
 * 为什么识别与入库分成两步，而不是"上传即自动识别"：
 *
 *   ① 文件入库是**无损的**，识别是**有损的**。
 *      先保证原件一定存住，识别失败也不会丢东西。
 *   ② 识别要花钱（真实模型按 token 计费）。小企业主一次拖几十张票进来，
 *      未必都想立刻识别；让他自己决定什么时候花这笔钱。
 *   ③ 识别结果必须在**校验通过之后**才允许落库。
 *      金额勾稽不成立的票写进发票台账，比不写更危险 ——
 *      它会污染后续的进项抵扣统计。
 *
 * ★ 本服务只做「识别 + 校验 + 落发票」，**不生成凭证**。
 *   生成凭证要走自动记账规则引擎（那是独立的一步，且默认只产出待确认凭证）。
 */
import { Injectable, Logger } from '@nestjs/common';
import { Decimal, assertTaxConsistency, round2 } from '@bookkeeper/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StorageService, inferMimeType } from '../../infrastructure/storage/storage.service';
import { AuditService } from '../../infrastructure/prisma/audit.service';
import { AiService } from '../../infrastructure/ai/ai.service';
import { RecognitionIngestService } from './recognition-ingest.service';
import { DomainError } from '../../domain/accounting/errors';
import { validateExtraction, decideRouting } from '../../domain/extraction/validation';
import { buildInvoiceDedupHash, DEDUP_NS_INVOICE } from '../../common/dedup';
import { toDb, toDbRate } from '../../common/decimal';

export interface RecognizeDocumentResult {
  documentId: string;
  /** 识别结论：能否落库 */
  status: 'SAVED' | 'DUPLICATE' | 'NEEDS_REVIEW' | 'REJECTED';
  invoiceId: string | null;
  /** 抽取到的票面数据（无论是否落库都返回，便于人工核对） */
  extracted: Record<string, unknown>;
  validation: {
    hasFailure: boolean;
    failCount: number;
    warnCount: number;
    findings: Array<{ code: string; level: string; message: string; suggestion?: string }>;
  };
  routing: { status: string; reason: string; lowConfidenceFields: string[] } | null;
  /** 为什么不落库 / 落库后要注意什么 */
  message: string;
  nextSteps: string[];
}

@Injectable()
export class DocumentRecognitionService {
  private readonly logger = new Logger(DocumentRecognitionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
    private readonly ingest: RecognitionIngestService,
  ) {}

  /**
   * 识别一份已入库的单据，并（在校验通过时）落为发票。
   *
   * ★ 校验不通过时**不落库**，但把识别结果原样返回 ——
   *   人工可以看到"模型读成了什么、为什么被拒"，再决定是改原件还是手工录。
   */
  async recognizeDocument(params: {
    entityId: string;
    documentId: string;
    /** 允许人工覆盖识别目标（例如把回单按流水识别） */
    targetType?: 'INVOICE' | 'BANK_SLIP' | 'BANK_STATEMENT';
    /** 仅 Mock 模式有效：强制指定样例，便于演示各条分支 */
    mockCase?: string;
    /** 校验不通过时也强行落库（人工已核对过票面） */
    force?: boolean;
    userId?: string;
  }): Promise<RecognizeDocumentResult> {
    const doc = await this.prisma.document.findFirst({
      where: { id: params.documentId, entityId: params.entityId },
    });
    if (!doc) {
      throw new DomainError(
        'NOT_FOUND',
        '这份单据不存在，或不属于当前账套。',
        404,
        `documentId=${params.documentId}`,
      );
    }

    const buffer = await this.storage.read(doc.storageKey);
    // 用入库时按扩展名推断的 mimeType，而不是重新信任文件名 —— 两者本该一致
    const ingested = await this.ingest.ingest({
      fileName: doc.originalName,
      buffer,
      mimeType: inferMimeType(doc.originalName, doc.mimeType),
    });

    const entity = await this.prisma.entity.findUniqueOrThrow({
      where: { id: params.entityId },
    });
    // 主体身份用于判定进项/销项，比模型的 direction 更可靠
    const entityName = entity.name;
    const entityTaxNo = entity.unifiedSocialCreditCode;

    const targetType = params.targetType ?? 'INVOICE';
    const textForModel = params.mockCase
      ? `__case=${params.mockCase}\n${ingested.text ?? ''}`
      : (ingested.text ?? undefined);

    const preview = await this.ai.extract({
      entityId: params.entityId,
      documentId: doc.id,
      targetType,
      textLayer: textForModel,
      images: ingested.images,
      hints: {
        entityName: entity.name,
        entityTaxNo: entity.unifiedSocialCreditCode,
      },
    });

    // ── 非发票目标：只做识别与校验，不落发票台账 ──
    if (targetType !== 'INVOICE') {
      return {
        documentId: doc.id,
        status: 'NEEDS_REVIEW',
        invoiceId: null,
        extracted: preview.data,
        validation: { hasFailure: false, failCount: 0, warnCount: 0, findings: [] },
        routing: null,
        message:
          `${targetType === 'BANK_SLIP' ? '银行回单' : '银行流水'}识别完成。` +
          '这类单据要用于核销或对账，不落发票台账 —— 请人工核对后走对应的记账流程。',
        nextSteps: ['核对识别结果', '到「录入凭证 → 识别录入」按业务类型生成凭证'],
      };
    }

    // ── 发票：会计交叉校验 ──
    const data = preview.data;
    const knownPartners = await this.prisma.partner.findMany({
      where: { entityId: params.entityId, taxNo: { not: null } },
      select: { taxNo: true },
    });

    // ★ 方向只解析一次，判重与落库**共用同一个结果**。
    //   之前两个函数各自兜底（判重默认 INPUT、落库默认 INPUT），
    //   结果判重放过了、写入却撞上唯一约束 —— 同一条规则两处实现必然出这种事。
    const dir = resolveDirection(data, entityName, entityTaxNo);
    if (!dir.ok) {
      return {
        documentId: doc.id,
        status: 'REJECTED',
        invoiceId: null,
        extracted: data,
        validation: { hasFailure: true, failCount: 1, warnCount: 0, findings: [
          { code: 'D1', level: 'FAIL', message: dir.reason, suggestion: '手工指定进项/销项后重新识别，或直接手工录入。' },
        ] },
        routing: null,
        message: dir.reason,
        nextSteps: ['人工确认这张票是进项还是销项', '在发票台账手工录入，或修正票面信息后重新识别'],
      };
    }

    // 同一张票是否已入账（业务唯一键，使用同一个 direction）
    const dup = await this.findDuplicate(params.entityId, data, dir.direction);

    const outcome = validateExtraction(
      {
        direction: (data.direction as string | null) ?? null,
        category: data.category as string | undefined,
        invoiceCode: (data.invoiceCode as string | null) ?? null,
        invoiceNumber: data.invoiceNumber as string | undefined,
        digitalInvoiceNo: (data.digitalInvoiceNo as string | null) ?? null,
        invoiceDate: (data.invoiceDate as string | null) ?? null,
        sellerName: data.sellerName as string | undefined,
        sellerTaxNo: (data.sellerTaxNo as string | null) ?? null,
        buyerName: data.buyerName as string | undefined,
        buyerTaxNo: (data.buyerTaxNo as string | null) ?? null,
        amountExclTax: data.amountExclTax as string | undefined,
        taxRate: data.taxRate as string | undefined,
        taxAmount: data.taxAmount as string | undefined,
        amountInclTax: data.amountInclTax as string | undefined,
        isRedFlushed: data.isRedFlushed as boolean | undefined,
      },
      {
        name: entity.name,
        unifiedSocialCreditCode: entity.unifiedSocialCreditCode,
        knownSellerTaxNos: new Set(
          knownPartners.map((p) => p.taxNo).filter((t): t is string => !!t),
        ),
        duplicateInvoiceId: dup?.id ?? null,
      },
    );

    const validation = {
      hasFailure: outcome.hasFailure,
      failCount: outcome.failCount,
      warnCount: outcome.warnCount,
      findings: outcome.findings.map((f) => ({
        code: f.code,
        level: f.level,
        message: f.message,
        suggestion: f.suggestion,
      })),
    };

    // 已存在同一张票：把这份文件挂为补充附件，不重复建票
    if (dup) {
      return {
        documentId: doc.id,
        status: 'DUPLICATE',
        invoiceId: dup.id,
        extracted: data,
        validation,
        routing: null,
        message:
          `这张发票已经在台账里了（${dup.invoiceNumber}，` +
          `${dup.direction === 'OUTPUT' ? '销项' : '进项'}）。未重复创建。`,
        nextSteps: [
          '这份文件可以挂为该发票的补充附件',
          '若要替换原附件，请在发票详情里重新关联',
        ],
      };
    }

    // ★ 校验不通过 → 不落库。金额勾稽错的票进台账比不进更危险。
    if (outcome.hasFailure && !params.force) {
      this.logger.warn(
        `单据 ${doc.originalName} 识别未通过校验（${outcome.failCount} 项），已拒绝落库`,
      );
      return {
        documentId: doc.id,
        status: 'REJECTED',
        invoiceId: null,
        extracted: data,
        validation,
        routing: null,
        message:
          `识别结果有 ${outcome.failCount} 项未通过校验，**未写入发票台账**。` +
          '金额勾稽不成立的票如果入库，会污染后续的进项抵扣统计，所以这里选择拒绝而不是记下来。',
        nextSteps: [
          '核对下表列出的一票面字段与原件的差异',
          '原件模糊可重新扫描后重新上传识别',
          '确认票面无误时可勾选「我已核对票面，仍要写入」强制落库',
        ],
      };
    }

    // ── 落库 ──
    const invoiceId = await this.saveInvoice(
      params.entityId,
      doc.id,
      doc.docType,
      data,
      dir.direction,
      dir.doubt,
      params.userId,
    );

    return {
      documentId: doc.id,
      status: 'SAVED',
      invoiceId,
      extracted: data,
      validation,
      routing: null,
      message:
        outcome.warnCount > 0
          ? `已写入发票台账，但有 ${outcome.warnCount} 项提示需要留意。`
          : '已写入发票台账。',
      nextSteps: [
        '到「录入凭证 → 识别录入」或凭证页生成待确认凭证',
        '月末打印凭证册时，这张票的原件会自动附在对应凭证后面',
      ],
    };
  }

  // --------------------------------------------------------------------------
  //  内部
  // --------------------------------------------------------------------------

  /** 按业务唯一键找同主体下是否已有这张票 */
  private async findDuplicate(
    entityId: string,
    data: Record<string, unknown>,
    direction: 'INPUT' | 'OUTPUT',
  ): Promise<{ id: string; invoiceNumber: string; direction: string } | null> {
    const invoiceNumber = str(data.invoiceNumber);
    if (!invoiceNumber) return null;

    const found = await this.prisma.invoice.findFirst({
      where: {
        entityId,
        direction,
        invoiceCode: str(data.invoiceCode),
        invoiceNumber,
        isRedFlushed: data.isRedFlushed === true,
      },
      select: { id: true, invoiceNumber: true, direction: true },
    });
    return found;
  }

  /** 把识别结果写成发票记录，并建立与原件的关联 */
  private async saveInvoice(
    entityId: string,
    documentId: string,
    docType: string,
    data: Record<string, unknown>,
    direction: 'INPUT' | 'OUTPUT',
    directionDoubt: string | null,
    userId?: string,
  ): Promise<string> {
    const excl = round2(new Decimal(str(data.amountExclTax) ?? '0'));
    const tax = round2(new Decimal(str(data.taxAmount) ?? '0'));
    const incl = round2(new Decimal(str(data.amountInclTax) ?? '0'));

    // 再校验一次金额勾稽：这一步走的是发票台账自己的规则，
    // 与前面识别阶段的 V1 是同一套判定，双重保险（force 落库时也不该写出坏数）
    const consistency = assertTaxConsistency(excl, tax, incl, '0.02');
    if (!consistency.ok) {
      throw new DomainError(
        'BAD_REQUEST',
        `金额勾稽不成立：不含税 ${excl.toFixed(2)} + 税额 ${tax.toFixed(2)} = ` +
          `${round2(excl.plus(tax)).toFixed(2)}，但价税合计为 ${incl.toFixed(2)}，` +
          `差异 ${consistency.difference.toFixed(2)}。请核对票面金额。`,
        400,
        '识别结果金额不自洽',
      );
    }

    const rawDate = str(data.invoiceDate) ?? new Date().toISOString().slice(0, 10);
    const invoiceDate = new Date(`${rawDate.slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(invoiceDate.getTime())) {
      throw new DomainError(
        'BAD_REQUEST',
        `开票日期「${rawDate}」无法解析，无法写入发票台账。请手工核对日期。`,
        400,
        'invoiceDate 解析失败',
      );
    }

    const isRedFlushed = data.isRedFlushed === true;
    const invoiceCode = str(data.invoiceCode);
    const invoiceNumber = str(data.invoiceNumber);
    if (!invoiceNumber) {
      throw new DomainError(
        'BAD_REQUEST',
        '没有识别出发票号码，无法写入台账（发票号码是去重的业务唯一键）。',
        400,
        'invoiceNumber 缺失',
      );
    }

    const dedupHash = buildInvoiceDedupHash(DEDUP_NS_INVOICE, {
      direction,
      invoiceCode,
      invoiceNumber,
      invoiceDate,
      counterpartyTaxNo: str(data.sellerTaxNo),
      counterpartyName: str(data.sellerName),
      amountInclTax: incl,
      isRedFlushed,
    });

    const items = Array.isArray(data.items) ? data.items : [];

    const created = await this.prisma.invoice.create({
      data: {
        entityId,
        direction,
        category: normalizeCategory(str(data.category), docType),
        invoiceCode,
        invoiceNumber,
        digitalInvoiceNo: str(data.digitalInvoiceNo),
        invoiceDate,
        sellerName: str(data.sellerName) ?? '（未识别）',
        sellerTaxNo: str(data.sellerTaxNo),
        buyerName: str(data.buyerName) ?? '（未识别）',
        buyerTaxNo: str(data.buyerTaxNo),
        amountExclTax: toDb(excl),
        taxRate: toDbRate(str(data.taxRate) ?? '0'),
        taxAmount: toDb(tax),
        amountInclTax: toDb(incl),
        isRedFlushed,
        isDeductible: true,
        documentId,
        status: 'IMPORTED',
        reviewNote: directionDoubt,
        dedupHash,
        lines: items.length
          ? {
              create: items.slice(0, 200).map((it, i) => {
                const o = (it ?? {}) as Record<string, unknown>;
                return {
                  lineNo: i + 1,
                  itemName: str(o.itemName) ?? '（未识别品名）',
                  spec: str(o.spec),
                  unit: str(o.unit),
                  quantity: num(o.quantity),
                  unitPrice: num(o.unitPrice),
                  amountExclTax: new Decimal(str(o.amountExclTax) ?? '0'),
                  taxRate: toDbRate(str(o.taxRate) ?? '0'),
                  taxAmount: new Decimal(str(o.taxAmount) ?? '0'),
                };
              }),
            }
          : undefined,
      },
      select: { id: true },
    });

    // 单据与原件的显式关联：凭证册打印时据此带出附件
    await this.linkDocument(entityId, created.id, documentId);

    await this.audit.record({
      entityId,
      userId,
      action: 'CREATE',
      subjectType: 'Invoice',
      subjectId: created.id,
      afterData: {
        source: 'DOCUMENT_RECOGNITION',
        documentId,
        invoiceNumber,
        amountInclTax: incl.toFixed(2),
      },
    });

    this.logger.log(`单据识别落库：${invoiceNumber}（${direction}）价税合计 ${incl.toFixed(2)}`);
    return created.id;
  }

  /** 建立 DocumentLink：让凭证册能把原件带出来 */
  private async linkDocument(
    entityId: string,
    invoiceId: string,
    documentId: string,
  ): Promise<void> {
    // 唯一键是 (fromType, fromId, toType, toId, linkType)，
    // 所以用 upsert 的语义：已存在就跳过，避免识别重复执行时报唯一冲突。
    // linkType 用 ATTACHMENT（附件）：语义是"这份文件是这条发票记录的原件"。
    const existing = await this.prisma.documentLink.findFirst({
      where: {
        entityId,
        fromType: 'INVOICE',
        fromId: invoiceId,
        toType: 'DOCUMENT',
        toId: documentId,
        linkType: 'ATTACHMENT',
      },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.documentLink.create({
      data: {
        entityId,
        fromType: 'INVOICE',
        fromId: invoiceId,
        toType: 'DOCUMENT',
        toId: documentId,
        linkType: 'ATTACHMENT',
      },
    });
  }
}

// ============================================================================
//  工具
// ============================================================================

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function num(v: unknown): Decimal | null {
  const s = str(v);
  if (s === null) return null;
  try {
    const d = new Decimal(s.replace(/[¥￥,\s]/g, ''));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * 判定发票方向。
 *
 * ★ 这一条极其重要：方向搞反会让**进项票被记成销项**，虚增收入和销项税。
 *   所以绝不能用「不是销项就是进项」这种静默兜底 ——
 *   模型返回 null 时，正确答案是"不知道"，而不是"大概是进项"。
 *
 * 判定顺序：
 *   ① 模型给出的方向（并校验它与购销方身份不矛盾）
 *   ② 用本主体名称/税号去比对购买方与销售方（这一步是硬事实，比模型可靠）
 *   ③ 都判不出来 → 抛错，让人工指定
 */
type DirectionResolution =
  | { ok: true; direction: 'INPUT' | 'OUTPUT'; source: 'IDENTITY' | 'MODEL'; doubt: string | null }
  | { ok: false; reason: string };

function resolveDirection(
  data: Record<string, unknown>,
  entityName: string,
  entityTaxNo: string | null,
): DirectionResolution {
  const norm = (s: string | null) =>
    (s ?? '').replace(/[\s（）()]/g, '').replace(/（/g, '(').replace(/）/g, ')');

  const sellerName = norm(str(data.sellerName));
  const sellerTaxNo = norm(str(data.sellerTaxNo));
  const buyerName = norm(str(data.buyerName));
  const buyerTaxNo = norm(str(data.buyerTaxNo));
  const meName = norm(entityName);
  const meTaxNo = norm(entityTaxNo);

  const sameTaxNo = (a: string, b: string) => a !== '' && a === b;
  const sameName = (a: string) =>
    a !== '' && meName !== '' && (a === meName || a.includes(meName) || meName.includes(a));

  // ② 身份比对优先于模型（税号相同是最硬的证据）
  const iAmSeller = sameTaxNo(sellerTaxNo, meTaxNo) || sameName(sellerName);
  const iAmBuyer = sameTaxNo(buyerTaxNo, meTaxNo) || sameName(buyerName);

  if (iAmSeller && !iAmBuyer) {
    return { ok: true, direction: 'OUTPUT', source: 'IDENTITY', doubt: null };
  }
  if (iAmBuyer && !iAmSeller) {
    return { ok: true, direction: 'INPUT', source: 'IDENTITY', doubt: null };
  }

  // ① 回落到模型给的方向，但**记下疑点**：票面上双方都不是本主体时，
  //   模型的方向判断没有事实支撑，很可能把购销方看颠倒了。
  const fromModel = str(data.direction);
  if (fromModel === 'INPUT' || fromModel === 'OUTPUT') {
    return {
      ok: true,
      direction: fromModel,
      source: 'MODEL',
      doubt:
        `购销双方都不是本主体「${entityName}」，方向取自模型判断（${fromModel}），` +
        '票面信息不足以交叉验证 —— 请核对是否把购销方看颠倒了。',
    };
  }

  // ③ 两种依据都没有 → 不猜。猜错方向会让进项票被记成销项，虚增收入和销项税。
  return {
    ok: false,
    reason:
      '无法判定这张票是进项还是销项：票面上购销双方都不是本主体（' +
      `${entityName}），模型也没给出方向。` +
      '方向搞反会把进项票记成销项、虚增收入和销项税，所以系统不猜 —— 请手动指定方向后重试。',
  };
}

/** 票种兜底：模型认不出时按单据类型推断 */
function normalizeCategory(
  raw: string | null,
  docType: string,
): 'SPECIAL_VAT' | 'GENERAL_VAT' | 'E_INVOICE' | 'TRAIN' | 'AIR' | 'TOLL' | 'OTHER' {
  const valid = ['SPECIAL_VAT', 'GENERAL_VAT', 'E_INVOICE', 'TRAIN', 'AIR', 'TOLL', 'OTHER'];
  if (raw && valid.includes(raw)) return raw as never;
  if (docType === 'INVOICE_SALES' || docType === 'INVOICE_PURCHASE') return 'SPECIAL_VAT';
  return 'OTHER';
}
