/**
 * AI 接口
 * ============================================================
 * 这些端点让"识图"这条链路在不接真实 API 的情况下也能被验证：
 *   GET  /api/ai/health     AI 服务健康与熔断状态
 *   GET  /api/ai/samples    Mock 样例清单（开发期构造测试数据）
 *   POST /api/ai/extract    对给定样例跑一次识图 + 会计交叉校验
 *
 * 最后一个端点尤其重要：它把「识图结果」与「校验结论」一起返回，
 * 让人能直接看到"这张票为什么被判为需要人工复核"。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes } from '@nestjs/swagger';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiService } from '../infrastructure/ai/ai.service';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { validateExtraction, decideRouting } from '../domain/extraction/validation';
import type { ExtractTargetType } from '../infrastructure/ai/ai-provider.interface';
import { EXTRACT_TARGETS } from '../infrastructure/ai/ai.service';
import {
  validateStatement,
  validateVatReturn,
  buildStatementExtraction,
} from '../domain/history/statement.model';
import type { VatReturnExtraction } from '../domain/history/statement.model';
import { RecognitionIngestService } from '../application/recognition/recognition-ingest.service';
import {
  classifyDocument,
  classificationLabel,
  canAutoRoute,
  type DocClassification,
} from '../domain/recognition/doc-classifier';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';

@ApiTags('AI 识图')
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ingest: RecognitionIngestService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'AI 服务健康与熔断状态' })
  async health() {
    return this.ai.health();
  }

  @Get('samples')
  @ApiOperation({ summary: 'Mock 样例清单（开发期用来构造测试数据）' })
  samples() {
    return {
      provider: this.ai.providerName,
      note:
        this.ai.providerName === 'mock'
          ? '当前为 Mock 模式：识图返回固定样例，覆盖正常票、购销方颠倒票、金额勾稽错误票等场景。'
          : '当前为真实模型模式。样例清单仅用于开发与测试。',
      samples: this.ai.listSamples(),
      usage: '在抽取文本里带 __case=<key> 可强制命中指定样例',
    };
  }

  @Get('targets')
  @ApiOperation({ summary: '可识别的目标类型清单（发票 / 回单 / 流水 / 报表 / 申报表）' })
  targets() {
    return { targets: EXTRACT_TARGETS };
  }

  @Post('recognize')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: '★ 识别录入：上传票/表文件 → 抽取 + 会计交叉校验（不写账）',
    description:
      '支持图片（png/jpg/webp）、PDF、Excel（xlsx）、CSV。\n' +
      '· 图片 → 多模态视觉识别\n' +
      '· PDF → 优先取文本层（更准更省），无文本层才转视觉\n' +
      '· Excel/CSV → 逐单元格精确读取（报表多为 Excel，不做有损的图片识别）\n\n' +
      '★ 识别结果只做校验与预览，绝不自动入账。要落库必须再调用存档/生成凭证接口。',
  })
  async recognize(
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: {
      entityId: string;
      /**
       * ★ 可选。不传时由系统按文件内容自动判定 ——
       *   用户不需要先想清楚"这是发票还是报表"。
       *   传了则以用户的选择为准（自动判定可能不准，必须留人工通道）。
       */
      targetType?: ExtractTargetType;
      filingType?: string;
      /** 仅 Mock 模式有效：强制返回指定样例，用于验证各条分支 */
      mockCase?: string;
    },
  ) {
    if (!file) throw new BadRequestException('未收到文件。请选择要识别的票或表文件。');
    if (!body.entityId) throw new BadRequestException('缺少 entityId');

    const entity = await this.prisma.entity.findUniqueOrThrow({ where: { id: body.entityId } });

    // ── 1. 文件 → 模型输入 ──
    const ingested = await this.ingest.ingest({
      fileName: file.originalname,
      buffer: file.buffer,
      mimeType: file.mimetype,
    });

    // ── 1.5 ★ 自动判定单据类型（用户未指定时） ──
    //
    // 判定发生在文件读入之后、抽取之前 —— 因为判定要看内容。
    // 判不出来时**不猜**：直接返回让用户选，并说明为什么判不出来。
    const classification = classifyDocument({
      fileName: ingested.fileName,
      text: ingested.text,
      mimeType: file.mimetype,
    });

    const userChose = body.targetType !== undefined;
    const type: ExtractTargetType = userChose
      ? body.targetType!
      : (classification.targetType ?? 'INVOICE');

    if (!userChose && !canAutoRoute(classification)) {
      // 判不出来 → 不识别，把选择权交回去
      return {
        ingested: {
          kind: ingested.kind,
          fileName: ingested.fileName,
          sizeBytes: ingested.sizeBytes,
          textChars: ingested.text?.length ?? 0,
          textPreview: ingested.text ? ingested.text.slice(0, 2000) : null,
          notes: ingested.notes,
        },
        // ★ 必须带上 classification —— 否则前端拿到 null，
        //   既看不到判成了什么，也看不到为什么需要人工选。
        classification: {
          label: classificationLabel(classification),
          kind: classification.kind,
          docType: classification.docType,
          statementType: classification.statementType,
          targetType: classification.targetType,
          confidence: classification.confidence,
          needsConfirmation: classification.needsConfirmation,
          evidence: classification.evidence,
          reason: classification.reason,
          hint: classification.hint,
          chosenBy: 'SYSTEM',
          conflictsWithUserChoice: false,
        },
        needsTargetChoice: true,
        preview: null,
        validation: null,
        routing: null,
        explanation:
          `系统无法从内容判断这是什么单据（${classification.reason}）。` +
          '★ 这里刻意不猜：判错会让数据进错识别管道，例如把资产负债表当发票识别，' +
          'AI 会被要求从表里抽「发票号码」。' +
          classification.hint,
      };
    }

    // ── 2. 抽取 ──
    // mockCase 只在 Mock Provider 下有意义（真实模型会把它当成普通文本忽略），
    // 它让我们能在不接真实 API 的情况下验证"不平衡报表""购销方颠倒"这类分支。
    const textForModel = body.mockCase
      ? `__case=${body.mockCase}\n${ingested.text ?? ''}`
      : ingested.text ?? undefined;

    const preview = await this.ai.extract({
      entityId: body.entityId,
      targetType: type,
      textLayer: textForModel,
      images: ingested.images,
      hints: {
        entityName: entity.name,
        entityTaxNo: entity.unifiedSocialCreditCode,
        // 让提示词与 Mock 样例都知道这是增值税还是企业所得税
        taxType: body.filingType,
      },
    });

    // ── 3. 校验：报表类 / 发票类走不同的校验器 ──
    const base = {
      ingested: {
        kind: ingested.kind,
        fileName: ingested.fileName,
        sizeBytes: ingested.sizeBytes,
        // 文本层不回传全文（可能很大），只回传长度与预览，便于排查"模型看到了什么"
        textChars: ingested.text?.length ?? 0,
        textPreview: ingested.text ? ingested.text.slice(0, 2000) : null,
        notes: ingested.notes,
      },
      // ★ 把「系统判成了什么、依据是什么、是系统选的还是你选的」一并返回。
      //   判错时用户能立刻看出是哪一步出的问题，而不是只看到一个错误结果。
      classification: {
        label: classificationLabel(classification),
        kind: classification.kind,
        docType: classification.docType,
        statementType: classification.statementType,
        targetType: classification.targetType,
        confidence: classification.confidence,
        needsConfirmation: classification.needsConfirmation,
        evidence: classification.evidence,
        reason: classification.reason,
        hint: classification.hint,
        chosenBy: userChose ? 'USER' : 'SYSTEM',
        conflictsWithUserChoice:
          userChose && classification.targetType !== null && classification.targetType !== type,
      },
      preview,
    };

    if (type === 'BALANCE_SHEET' || type === 'INCOME_STATEMENT' || type === 'TAX_RETURN') {
      const outcome =
        type === 'TAX_RETURN'
          ? validateVatReturn(preview.data as unknown as VatReturnExtraction)
          : validateStatement(type, buildStatementExtraction(type, preview.data));

      return {
        ...base,
        validation: {
          hasFailure: outcome.hasFailure,
          failCount: outcome.failCount,
          warnCount: outcome.warnCount,
          findings: outcome.findings,
          balanced: outcome.balanced ?? null,
          balanceDifference: outcome.balanceDifference?.toString() ?? null,
          periodLabel: outcome.periodLabel ?? null,
        },
        routing: null,
        explanation: outcome.hasFailure
          ? '报表存在校验未通过项。报表不入账，请核对原表或修正识别结果后重新识别。'
          : '校验通过。请确认期间与行项目后保存为历史报表档案（★ 只建档，不生成凭证）。',
      };
    }

    if (type !== 'INVOICE') {
      return { ...base, validation: null, routing: null, explanation: '识别完成，请人工核对字段。' };
    }

    const data = preview.data;
    const knownPartners = await this.prisma.partner.findMany({
      where: { entityId: body.entityId, taxNo: { not: null } },
      select: { taxNo: true },
    });

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
        knownSellerTaxNos: new Set(knownPartners.map((p) => p.taxNo).filter((t): t is string => !!t)),
      },
    );

    const env = this.config.get<Env>('env') as Env;
    const routing = decideRouting({
      overallConfidence: preview.overallConfidence,
      fieldConfidence: preview.fieldConfidence,
      outcome,
      threshold: env.OCR_MIN_CONFIDENCE,
    });

    return {
      ...base,
      validation: {
        hasFailure: outcome.hasFailure,
        failCount: outcome.failCount,
        warnCount: outcome.warnCount,
        findings: outcome.findings,
      },
      routing,
      explanation: outcome.hasFailure
        ? '存在校验未通过项 → 强制人工复核，且不允许一键确认绕过。'
        : routing.status === 'AUTO_DRAFTED'
          ? '校验全部通过且置信度足够 → 可生成「待确认凭证」（仍需人工确认后才过账）。'
          : '需要人工复核，原因见 routing.reason。',
    };
  }

  @Post('extract')
  @ApiOperation({ summary: '跑一次识图 + 会计交叉校验（开发与验证用）' })
  async extract(
    @Query('entityId') entityId: string,
    @Query('case') caseKey?: string,
    @Query('targetType') targetType?: ExtractTargetType,
  ) {
    // ★ 必须在查库前显式校验。不校验的话 entityId 为 undefined 会被传给
    //   Prisma 的 where，抛出一条包含完整 schema 的 PrismaClientValidationError，
    //   过滤器把它当未知异常兜成 HTTP 500，并把整个 EntityWhereInput 类型定义
    //   写进 userMessage —— 对调用方毫无用处，还泄露了内部结构。
    if (!entityId) {
      throw new BadRequestException('缺少 entityId。请指定要归属的核算主体。');
    }
    if (caseKey && !/^[a-z0-9-]+$/i.test(caseKey)) {
      throw new BadRequestException(
        `样例名「${caseKey}」格式不合法（只允许字母、数字与短横线）。`,
      );
    }

    const entity = await this.prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
    const type: ExtractTargetType = targetType ?? 'INVOICE';

    const preview = await this.ai.extract({
      entityId,
      targetType: type,
      textLayer: caseKey ? `__case=${caseKey}` : '',
      hints: {
        entityName: entity.name,
        entityTaxNo: entity.unifiedSocialCreditCode,
      },
    });

    // ── 报表 / 申报表：走「平衡 + 勾稽」校验，★ 只报不改，也不生成凭证 ──
    if (type === 'BALANCE_SHEET' || type === 'INCOME_STATEMENT' || type === 'TAX_RETURN') {
      const outcome =
        type === 'TAX_RETURN'
          ? validateVatReturn(preview.data as unknown as VatReturnExtraction)
          : validateStatement(
              type,
              buildStatementExtraction(
                type,
                preview.data as Record<string, unknown>,
              ),
            );

      return {
        preview,
        validation: {
          hasFailure: outcome.hasFailure,
          failCount: outcome.failCount,
          warnCount: outcome.warnCount,
          findings: outcome.findings,
          balanced: outcome.balanced ?? null,
          balanceDifference: outcome.balanceDifference?.toString() ?? null,
          periodLabel: outcome.periodLabel ?? null,
        },
        // 报表类不参与记账，没有「自动生成凭证」这条路径
        routing: null,
        explanation: outcome.hasFailure
          ? '报表存在校验未通过项。报表不入账，请先修正识别结果或原表后重新识别。'
          : outcome.balanced === false
            ? '报表本身不平衡（资产 ≠ 负债 + 权益）。★ 系统只报告差额、不做任何平衡调整，' +
              '请先核对原表；若原表确实如此，需人工说明原因后再建账。'
            : '校验通过。可保存为历史报表档案，供期初建账与申报比对使用。',
      };
    }

    if (type !== 'INVOICE') {
      return { preview, validation: null, routing: null };
    }

    // ★ 关键：识图结果必须过会计交叉校验
    const data = preview.data;
    const knownPartners = await this.prisma.partner.findMany({
      where: { entityId, taxNo: { not: null } },
      select: { taxNo: true },
    });

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
        knownSellerTaxNos: new Set(knownPartners.map((p) => p.taxNo).filter((t): t is string => !!t)),
      },
    );

    const env = this.config.get<Env>('env') as Env;
    const routing = decideRouting({
      overallConfidence: preview.overallConfidence,
      fieldConfidence: preview.fieldConfidence,
      outcome,
      threshold: env.OCR_MIN_CONFIDENCE,
    });

    return {
      preview,
      validation: {
        hasFailure: outcome.hasFailure,
        failCount: outcome.failCount,
        warnCount: outcome.warnCount,
        findings: outcome.findings,
      },
      routing,
      explanation: outcome.hasFailure
        ? '存在校验未通过项 → 强制人工复核，且不允许一键确认绕过。'
        : routing.status === 'AUTO_DRAFTED'
          ? '校验全部通过且置信度足够 → 自动生成「待确认凭证」（仍需人工确认后才过账）。'
          : '需要人工复核，原因见 routing.reason。',
    };
  }
}
