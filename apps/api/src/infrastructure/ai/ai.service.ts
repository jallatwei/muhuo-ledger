import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from '@bookkeeper/shared';
import type { AiProvider, AiPurpose, ChatRequest, VisionRequest } from './ai-provider.interface';
import { AiProviderError } from './ai-provider.interface';
import type { ExtractTargetType } from './ai-provider.interface';
import { listMockSamples } from './mock.provider';
import type { Env } from '../../config/env';
import { PrismaService } from '../prisma/prisma.service';

export interface ExtractionPreview {
  targetType: ExtractTargetType;
  data: Record<string, unknown>;
  fieldConfidence: Record<string, number>;
  overallConfidence: number;
  model: string;
  latencyMs: number;
  provider: string;
  warnings: string[];
}

/**
 * 识别目标 → 提示词 / AI 用途 的映射表。
 *
 * ★ 集中在一处：新增识别类型只改这张表 + buildPrompt 加一个分支，
 *   不会因为漏写某个 if-else 而静默降级成银行回单模板。
 */
const EXTRACT_ROUTING: Record<
  ExtractTargetType,
  { promptKey: string; promptVersion: string; purpose: AiPurpose; label: string }
> = {
  INVOICE: {
    promptKey: 'invoice-extract',
    promptVersion: 'v1',
    purpose: 'EXTRACT_INVOICE',
    label: '增值税发票',
  },
  BANK_SLIP: {
    promptKey: 'bank-slip-extract',
    promptVersion: 'v1',
    purpose: 'EXTRACT_BANK_SLIP',
    label: '银行回单',
  },
  BANK_STATEMENT: {
    promptKey: 'bank-slip-extract',
    promptVersion: 'v1',
    purpose: 'EXTRACT_BANK_STATEMENT',
    label: '银行流水',
  },
  BALANCE_SHEET: {
    promptKey: 'financial-statement-extract',
    promptVersion: 'v1',
    purpose: 'EXTRACT_BALANCE_SHEET',
    label: '资产负债表',
  },
  INCOME_STATEMENT: {
    promptKey: 'financial-statement-extract',
    promptVersion: 'v1',
    purpose: 'EXTRACT_INCOME_STATEMENT',
    label: '利润表',
  },
  TAX_RETURN: {
    promptKey: 'tax-return-extract',
    promptVersion: 'v1',
    purpose: 'EXTRACT_TAX_RETURN',
    label: '纳税申报表',
  },
};

/** 前端下拉可选的识别目标（含中文名与说明） */
export const EXTRACT_TARGETS: Array<{
  value: ExtractTargetType;
  label: string;
  group: '单据' | '报表';
  hint: string;
}> = [
  {
    value: 'INVOICE',
    label: '增值税发票',
    group: '单据',
    hint: '专票/普票/电子票，自动判定进项或销项',
  },
  {
    value: 'BANK_SLIP',
    label: '银行回单',
    group: '单据',
    hint: '单笔收付款回单，逐笔匹配',
  },
  {
    value: 'BANK_STATEMENT',
    label: '银行流水',
    group: '单据',
    hint: '整月流水明细，用于与发票勾稽',
  },
  {
    value: 'BALANCE_SHEET',
    label: '资产负债表',
    group: '报表',
    hint: '取期末/期初余额，用于历史建账',
  },
  {
    value: 'INCOME_STATEMENT',
    label: '利润表',
    group: '报表',
    hint: '取本期/上期累计发生额，用于历史建账',
  },
  {
    value: 'TAX_RETURN',
    label: '纳税申报表',
    group: '报表',
    hint: '增值税主表、企业所得税年报等，取已申报数',
  },
];
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  /** 连续失败计数，用于熔断 */
  private consecutiveFailures = 0;
  private static readonly CIRCUIT_THRESHOLD = 5;

  constructor(
    @Inject('AI_PROVIDER') private readonly provider: AiProvider,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get env(): Env {
    return this.config.get<Env>('env') as Env;
  }

  get providerName(): string {
    return this.provider.name;
  }

  /**
   * 通用结构化文本抽取（供列名映射等任务复用）。
   *
   * ★ 与 suggestAccount 的区别：这里不做科目白名单校验，
   *   由调用方负责校验返回值。仅用于「非记账关键路径」的任务。
   */
  async extractJson(params: {
    system: string;
    userText: string;
    purpose?: AiPurpose;
    entityId?: string;
    promptKey?: string;
    promptVersion?: string;
  }): Promise<{ json: unknown; text: string; model: string; latencyMs: number }> {
    const started = Date.now();
    const response = await this.provider.chat({
      system: params.system,
      messages: [{ role: 'user', content: params.userText }],
      purpose: params.purpose ?? 'SUGGEST_ACCOUNT',
      entityId: params.entityId,
      promptKey: params.promptKey ?? 'generic-extract',
      promptVersion: params.promptVersion ?? 'v1',
      jsonMode: true,
      temperature: 0,
    });

    await this.logCall({
      entityId: params.entityId,
      purpose: params.purpose ?? 'SUGGEST_ACCOUNT',
      promptKey: params.promptKey ?? 'generic-extract',
      promptVersion: params.promptVersion ?? 'v1',
      requestHash: hash(params.userText),
      model: response.model,
      promptTokens: response.usage?.promptTokens,
      completionTokens: response.usage?.completionTokens,
      latencyMs: Date.now() - started,
      success: true,
      rawResponse: response.json ?? response.text,
    });

    return {
      json: response.json,
      text: response.text,
      model: response.model,
      latencyMs: response.latencyMs,
    };
  }

  /** 列出 Mock 样例（开发期用来构造测试数据） */
  listSamples() {
    return listMockSamples();
  }

  async health() {
    const [ping, stats] = await Promise.all([this.provider.ping(), this.usage24h()]);
    return {
      provider: this.provider.name,
      baseUrl: this.env.AI_BASE_URL || null,
      visionModel: this.env.AI_VISION_MODEL || null,
      textModel: this.env.AI_TEXT_MODEL || null,
      reachable: ping.ok,
      model: ping.model ?? null,
      latencyMs: ping.latencyMs ?? null,
      message: ping.message ?? null,
      circuitBreaker: {
        state: this.consecutiveFailures >= AiService.CIRCUIT_THRESHOLD ? 'OPEN' : 'CLOSED',
        consecutiveFailures: this.consecutiveFailures,
      },
      last24h: stats,
      thresholds: {
        ocrMinConfidence: this.env.OCR_MIN_CONFIDENCE,
        suggestMinConfidence: this.env.AI_SUGGEST_MIN_CONFIDENCE,
        dailyBudget: this.env.AI_DAILY_BUDGET,
      },
    };
  }

  /**
   * 识图抽取（供单据导入流程调用）。
   *
   * 注意：这里只做「抽取 + 记录日志」，不做入账决策。
   * 是否自动入账由 domain/extraction/validation 的校验与路由决定。
   */
  async extract(params: {
    entityId: string;
    documentId?: string;
    targetType: ExtractTargetType;
    /** PDF 文本层（有则优先，省 token 且更准） */
    textLayer?: string;
    images?: Array<{ base64?: string; path?: string; mimeType: string }>;
    hints?: Record<string, unknown>;
  }): Promise<ExtractionPreview> {
    if (this.consecutiveFailures >= AiService.CIRCUIT_THRESHOLD) {
      throw new AiProviderError(
        `AI 识图服务连续失败 ${this.consecutiveFailures} 次，已熔断。请检查 API Key 与额度；` +
          `期间请使用手工录入，后台会自动重试。`,
        this.provider.name,
        true,
      );
    }

    const route = EXTRACT_ROUTING[params.targetType];
    if (!route) {
      throw new AiProviderError(
        `不支持的识别目标类型：${params.targetType}。` +
          `可选值：${Object.keys(EXTRACT_ROUTING).join(' / ')}`,
        this.provider.name,
        false,
      );
    }
    const promptKey = route.promptKey;
    const promptVersion = route.promptVersion;
    const prompt = this.buildPrompt(promptKey, promptVersion, params);

    const req: VisionRequest = {
      system: prompt.system,
      text: prompt.userText,
      images: params.images ?? [],
      purpose: route.purpose,
      entityId: params.entityId,
      documentId: params.documentId,
      promptKey,
      promptVersion,
      jsonMode: true,
      temperature: this.env.AI_TEMPERATURE,
    };

    const started = Date.now();
    let response;
    try {
      response = await this.provider.vision(req);
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      await this.logCall({
        entityId: params.entityId,
        documentId: params.documentId,
        purpose: req.purpose,
        promptKey,
        promptVersion,
        requestHash: hash(JSON.stringify(params.hints ?? {}) + (params.textLayer ?? '')),
        latencyMs: Date.now() - started,
        success: false,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    const json = (response.json ?? {}) as Record<string, unknown>;
    const fieldConfidence = (json._fieldConfidence ?? {}) as Record<string, number>;
    const warnings = (json._warnings ?? []) as string[];

    // 置信度：优先用逐字段平均值，没有则按 0.9 估算（Mock 样例字段少时）
    const confValues = Object.values(fieldConfidence).filter((v) => typeof v === 'number');
    const overallConfidence =
      confValues.length > 0
        ? confValues.reduce((a, b) => a + b, 0) / confValues.length
        : 0.9;

    // 去掉内部字段，只留业务字段
    const { _fieldConfidence: _fc, _warnings: _w, _mockSample: _ms, ...business } = json;

    // 记录调用日志（含成本与原始响应，任何一张凭证都能反查到"当时 AI 说了什么"）
    await this.logCall({
      entityId: params.entityId,
      documentId: params.documentId,
      purpose: req.purpose,
      promptKey,
      promptVersion,
      requestHash: hash(JSON.stringify(params.hints ?? {}) + (params.textLayer ?? '')),
      model: response.model,
      promptTokens: response.usage?.promptTokens,
      completionTokens: response.usage?.completionTokens,
      latencyMs: response.latencyMs,
      success: true,
      rawResponse: business,
    });

    return {
      targetType: params.targetType,
      data: business,
      fieldConfidence,
      overallConfidence: Number(overallConfidence.toFixed(4)),
      model: response.model,
      latencyMs: response.latencyMs,
      provider: this.provider.name,
      warnings,
    };
  }

  /**
   * AI 科目建议（三层决策的 L3 兜底）。
   *
   * ★ 硬约束（在代码里强制，不靠提示词）：
   *   1. 返回的科目编码必须存在于本主体科目表且为末级科目
   *   2. 不允许模型给出金额 —— 只允许返回 amountExpr 变量名
   *   3. 永远不返回 autoPost
   */
  async suggestAccount(params: {
    entityId: string;
    invoiceJson: Record<string, unknown>;
    accountList: Array<{ code: string; name: string }>;
    similarVouchers?: Array<{ summary: string; lines: Array<{ code: string; direction: string }> }>;
  }): Promise<{
    suggestions: Array<{
      lines: Array<{ accountCode: string; direction: 'DEBIT' | 'CREDIT'; amountExpr?: string }>;
      confidence: number;
      reason: string;
    }>;
    warnings: string[];
    discarded: string[];
  }> {
    const promptKey = 'account-suggest';
    const promptVersion = 'v1';

    const chatReq: ChatRequest = {
      system:
        '你是中国小企业会计准则的记账助手。只能使用给定科目表中存在的末级科目编码。' +
        '不要输出金额，只决定科目与借贷方向。不确定时降低 confidence。只输出 JSON。',
      messages: [
        {
          role: 'user',
          content: [
            '# 本主体科目表（仅末级、启用）',
            params.accountList.map((a) => `${a.code}:${a.name}`).join(' '),
            '',
            '# 票据信息',
            JSON.stringify(params.invoiceJson, null, 2),
            '',
            '# 相似历史凭证',
            JSON.stringify(params.similarVouchers ?? [], null, 2),
          ].join('\n'),
        },
      ],
      purpose: 'SUGGEST_ACCOUNT',
      entityId: params.entityId,
      promptKey,
      promptVersion,
      jsonMode: true,
      temperature: 0,
    };

    const started = Date.now();
    const response = await this.provider.chat(chatReq);
    const json = (response.json ?? {}) as {
      suggestions?: Array<{
        lines?: Array<{ accountCode?: string; direction?: string; amountExpr?: string }>;
        confidence?: number;
        reason?: string;
      }>;
      warnings?: string[];
    };

    const validCodes = new Set(params.accountList.map((a) => a.code));
    const discarded: string[] = [];
    const suggestions: Array<{
      lines: Array<{ accountCode: string; direction: 'DEBIT' | 'CREDIT'; amountExpr?: string }>;
      confidence: number;
      reason: string;
    }> = [];

    for (const s of json.suggestions ?? []) {
      const lines: Array<{ accountCode: string; direction: 'DEBIT' | 'CREDIT'; amountExpr?: string }> = [];
      for (const l of s.lines ?? []) {
        const code = l.accountCode;
        // ★ 硬约束 1：科目必须存在
        if (!code || !validCodes.has(code)) {
          discarded.push(`不存在的科目编码：${code}`);
          continue;
        }
        const direction = l.direction === 'DEBIT' || l.direction === 'CREDIT' ? l.direction : null;
        if (!direction) {
          discarded.push(`非法的借贷方向：${l.direction}`);
          continue;
        }
        // ★ 硬约束 2：只接受白名单的金额变量，不接受模型直接给数字
        const allowedExpr = ['amountExclTax', 'amountInclTax', 'taxAmount', 'costAmount'];
        const amountExpr = l.amountExpr && allowedExpr.includes(l.amountExpr) ? l.amountExpr : undefined;
        lines.push({ accountCode: code, direction, amountExpr });
      }

      if (lines.length === 0) {
        discarded.push('该建议没有任何可用分录行，已丢弃');
        continue;
      }

      suggestions.push({
        lines,
        confidence: typeof s.confidence === 'number' ? Math.min(1, Math.max(0, s.confidence)) : 0.5,
        reason: s.reason ?? '（模型未给出理由）',
      });
    }

    await this.logCall({
      entityId: params.entityId,
      purpose: chatReq.purpose,
      promptKey,
      promptVersion,
      requestHash: hash(JSON.stringify(params.invoiceJson)),
      model: response.model,
      promptTokens: response.usage?.promptTokens,
      completionTokens: response.usage?.completionTokens,
      latencyMs: Date.now() - started,
      success: true,
      rawResponse: json,
    });

    this.logger.log(
      `AI 科目建议：${suggestions.length} 条可用，丢弃 ${discarded.length} 条（全部经过科目存在性与金额变量白名单校验）`,
    );

    return { suggestions, warnings: json.warnings ?? [], discarded };
  }

  // --------------------------------------------------------------------------
  //  内部
  // --------------------------------------------------------------------------

  private buildPrompt(
    promptKey: string,
    promptVersion: string,
    params: { textLayer?: string; hints?: Record<string, unknown>; targetType: ExtractTargetType },
  ): { system: string; userText: string } {
    const entityName = (params.hints?.entityName as string) ?? '（未提供）';
    const entityTaxNo = (params.hints?.entityTaxNo as string) ?? '（未提供）';

    if (params.targetType === 'INVOICE') {
      return {
        system:
          '你是中国增值税发票信息抽取引擎。严格按票面文字识别，看不清的字段输出 null，' +
          '不要猜测、不要补全。金额只输出数字，不带千分位与货币符号。只输出 JSON，不要 Markdown 包裹。',
        userText: [
          '# 硬性规则',
          '1. 只输出 JSON，不要代码块包裹，不要解释文字。',
          '2. 金额只输出数字：¥1,234.56 → 1234.56',
          '3. 金额必须自洽：amountExclTax + taxAmount = amountInclTax，对不上就在 _warnings 说明。',
          `4. 购买方名称为「${entityName}」（税号 ${entityTaxNo}）时 direction="INPUT"；`,
          `   销售方为该名称时 direction="OUTPUT"；都不是则 direction=null 并在 _warnings 说明。`,
          '   ⚠️ 方向搞反会导致进项票被记成销项，虚增收入和销项税。',
          '5. 红字发票：票面有「红字」字样或注明对应正数发票时 isRedFlushed=true。',
          '6. 税率输出小数：13% → 0.13；免税 → 0。',
          '',
          '# 输出字段',
          'direction, category, invoiceCode, invoiceNumber, digitalInvoiceNo, invoiceDate,',
          'sellerName, sellerTaxNo, buyerName, buyerTaxNo, amountExclTax, taxRate, taxAmount,',
          'amountInclTax, isRedFlushed, items[], _fieldConfidence{}, _warnings[]',
          '',
          '# 票面文本层（电子发票优先以此为准，图片仅作核对）',
          params.textLayer?.slice(0, 4000) ?? '（无文本层，请从图片识别）',
        ].join('\n'),
      };
    }

    if (params.targetType === 'BALANCE_SHEET' || params.targetType === 'INCOME_STATEMENT') {
      const isBs = params.targetType === 'BALANCE_SHEET';
      const fieldNote = isBs
        ? '每行输出 endBalance（期末余额）与 beginBalance（年初余额）'
        : '每行输出 endBalance（本期累计金额）与 beginBalance（上期累计金额）';
      const totalHint = isBs
        ? [
            'totalAssets（资产总计）、totalLiabilities（负债合计）、totalEquity（所有者权益合计）',
          ]
        : [
            'revenue（营业收入）、cost（营业成本）、profitBeforeTax（利润总额）、netProfit（净利润）',
          ];
      return {
        system:
          '你是中国小企业会计准则财务报表抽取引擎。逐行照抄报表数字，不要重算、不要补齐、' +
          '不要因为「应该平」就改动任何数字。金额只输出数字，不带千分位与货币符号。只输出 JSON。',
        userText: [
          '# 硬性规则',
          `1. 逐行抽取，${fieldNote}；行次 lineNo 与项目名称 label 都照抄表上原文。`,
          '2. 金额可为负数（用 - 号），不要取绝对值。空白/无数据的行不要输出。',
          '3. ⚠️ 不要做任何平衡调整。若合计行与明细行加总不一致，',
          '   在 _warnings 里写明「XX 行合计 X，明细加总 Y，差 Z」，但**输出仍按票面原值**。',
          '   系统只报告差异，由人工判断，绝不允许模型自己把差额抹平。',
          '4. 单位：报表若标注「单位：万元」，请在 unit 填 "万元" 并在 _warnings 说明需换算；',
          '   本系统金额一律按元记账。',
          '5. 日期：periodStart / periodEnd 输出 YYYY-MM-DD。',
          '',
          '# 输出字段',
          'statementType, periodStart, periodEnd, unit, items[],',
          ...totalHint,
          '',
          '_fieldConfidence{}, _warnings[]',
          '',
          '# 报表文本层（电子报表优先以此为准，图片仅作核对）',
          params.textLayer?.slice(0, 6000) ?? '（无文本层，请从图片识别）',
        ].join('\n'),
      };
    }

    if (params.targetType === 'TAX_RETURN') {
      const knownTaxNos = JSON.stringify(params.hints?.knownAccounts ?? []);
      const taxType = String(params.hints?.taxType ?? '');
      const isCit = /CIT|所得税/i.test(taxType);

      // ★ 增值税与企业所得税的行次没有任何对应关系，
      //   用同一份字段清单会让模型把"利润总额"往"销售额"上套。
      const fieldSpec = isCit
        ? [
            '企业所得税年度申报表（主表）行次：',
            'line1Revenue, line2Cost, line3ProfitTotal, line4SpecificAdjust,',
            'line5NonTaxableIncome, line7TaxFreeIncome, line9LossOffset,',
            'line10TaxableIncome, line11TaxRate, line12TaxPayable,',
            'line13TaxRelief, line14PaidThisYear, line16PayableOrRefund, taxType',
          ]
        : [
            '增值税申报表主表行次：',
            'line1SalesTaxable, line5SalesSimple, line8SalesExempt,',
            'line11OutputTax, line12InputTax, line13CreditBroughtForward, line14InputTaxTransferOut,',
            'line17DeductibleTotal, line18ActualDeducted, line19TaxPayable, line20CreditCarriedForward,',
            'line21SimpleTaxPayable, line24TaxPayableTotal, line25OpeningUnpaid,',
            'line27TaxPaidThisPeriod, line32ClosingUnpaid, line34PayableOrRefund,',
            '附加税费：surtaxBase, surtaxCity, surtaxEducation, surtaxLocalEducation, surtaxTotal',
          ];

      return {
        system:
          '你是中国纳税申报表抽取引擎。逐行照抄申报表数字，只抽取表上已有的数字，' +
          '缺失的行输出 null，绝不用其他行的数字反推填补。只输出 JSON。',
        userText: [
          '# 硬性规则',
          '1. 只抽取申报表上实际打印/填写的数字；空白行输出 null，不要推算。',
          '2. 增值税主表按行次输出（line1SalesTaxable、line11OutputTax、line12InputTax…），',
          '   行次编号以表上「一、二、…」与序号为准，认不出行次就跳过并在 _warnings 说明。',
          isCit
            ? '3. 这是企业所得税申报表：只输出企业所得税行次。不要输出增值税的销售额/销项税额。'
            : '3. 这是增值税申报表：只输出增值税行次。不要输出企业所得税的利润总额/应纳税所得额。',
          '4. 日期：periodStart / periodEnd 输出 YYYY-MM-DD（申报所属期）。',
          '5. ⚠️ 申报数是「已申报口径」，与账面数可能不一致。',
          '   若你能看出申报收入与利润表收入明显不符，只在 _warnings 提示，不要修改任何数字。',
          '',
          '# 输出字段',
          'periodStart, periodEnd,',
          ...fieldSpec,
          '_fieldConfidence{}, _warnings[]',
          '',
          '# 本企业已知税号',
          knownTaxNos,
          '',
          '# 申报表文本层',
          params.textLayer?.slice(0, 6000) ?? '（无文本层，请从图片识别）',
        ].join('\n'),
      };
    }

    return {
      system:
        '你是中国银行回单信息抽取引擎。金额只输出正数，方向用 direction 字段表达。' +
        '摘要原样照抄不要概括。只输出 JSON。',
      userText: [
        '# 硬性规则',
        '1. 金额只输出正数：收入 direction="IN"，支出 direction="OUT"。',
        '2. 日期格式 YYYY-MM-DD，看不清输出 null。',
        '3. summary 原样照抄摘要/用途，不要自己概括（摘要关键词是判断业务性质的主要依据）。',
        '4. 若对方账户号属于本企业，请在 _warnings 加入「疑似内部转账」——内部转账绝不能记成费用。',
        '',
        '# 输出字段',
        'direction, txnDate, amount, balanceAfter, counterpartyName, counterpartyAccountNo,',
        'summary, bankSerialNo, bankAccountNo, _fieldConfidence{}, _warnings[]',
        '',
        '# 本企业已知账户号',
        JSON.stringify(params.hints?.knownAccounts ?? []),
        '',
        '# 票面文本层',
        params.textLayer?.slice(0, 4000) ?? '（无文本层，请从图片识别）',
      ].join('\n'),
    };
  }

  private async logCall(entry: {
    entityId?: string;
    documentId?: string;
    purpose: AiPurpose;
    promptKey: string;
    promptVersion: string;
    requestHash: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs: number;
    success: boolean;
    errorMessage?: string;
    rawResponse?: unknown;
  }): Promise<void> {
    try {
      const cost =
        entry.promptTokens !== undefined
          ? new Decimal(entry.promptTokens).div(1_000_000).times(2).plus(
              new Decimal(entry.completionTokens ?? 0).div(1_000_000).times(8),
            )
          : null;

      await this.prisma.aiCallLog.create({
        data: {
          entityId: entry.entityId ?? null,
          purpose: entry.purpose,
          provider: this.provider.name,
          model: entry.model ?? this.provider.name,
          promptKey: entry.promptKey,
          promptVersion: entry.promptVersion,
          requestHash: entry.requestHash,
          rawResponse: (entry.rawResponse ?? null) as never,
          promptTokens: entry.promptTokens ?? null,
          completionTokens: entry.completionTokens ?? null,
          costEstimate: cost ? (cost.toDecimalPlaces(6).toString() as never) : null,
          latencyMs: entry.latencyMs,
          success: entry.success,
          errorMessage: entry.errorMessage ?? null,
          documentId: entry.documentId ?? null,
        },
      });
    } catch (e) {
      // 日志写入失败不能影响业务
      this.logger.warn(`AI 调用日志写入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async usage24h(): Promise<{
    calls: number;
    failures: number;
    costEstimate: string;
    avgLatencyMs: number;
  }> {
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const rows = await this.prisma.aiCallLog.findMany({
        where: { createdAt: { gte: since } },
        select: { success: true, costEstimate: true, latencyMs: true },
      });
      const calls = rows.length;
      const failures = rows.filter((r) => !r.success).length;
      const cost = rows.reduce(
        (s, r) => s.plus(r.costEstimate ? new Decimal(r.costEstimate.toString()) : 0),
        new Decimal(0),
      );
      const avgLatencyMs =
        calls > 0 ? Math.round(rows.reduce((s, r) => s + r.latencyMs, 0) / calls) : 0;
      return { calls, failures, costEstimate: cost.toFixed(4), avgLatencyMs };
    } catch {
      return { calls: 0, failures: 0, costEstimate: '0.0000', avgLatencyMs: 0 };
    }
  }
}

/** 轻量内容哈希，仅用于调用去重与问题复现，不需要密码学强度 */
function hash(input: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0');
}
