/**
 * 单据类型自动判定
 * ============================================================
 * 解决的问题：用户上传一个文件时，不该由他先想清楚"这是发票还是报表"。
 * 系统应该自己看出来，实在看不出来**再问人**。
 *
 * ★ 核心原则：宁可判不出来，不可判错。
 *
 *   为什么不能靠"猜一个最可能的"：
 *   判错的后果不是"多一步确认"，而是**数据进错管道** ——
 *   把资产负债表当发票识别，AI 会被要求从表里抽"发票号码"，
 *   抽不出来还硬抽，最后可能生成一张完全错误的发票记录。
 *   而这类错误一旦落库，清理成本远高于让用户多点一下。
 *
 *   所以本模块的返回值里，`needsConfirmation` 与 `confidence` 都是一等公民：
 *   判不出来就说判不出来，并告诉用户"你在这一步选一下"。
 *
 * 判定依据分三层，从强到弱：
 *   ① 文件类型（扩展名）—— 最强信号，不需要看内容
 *      xlsx / csv → 报表；图片 → 票据或报表扫描件；PDF → 都有可能
 *   ② 标题关键词 —— 表单类文档通常第一行就是它的名字
 *   ③ 字段结构 —— 有"发票号码"就是发票，有"期末余额/年初余额"就是报表
 *
 * 三层都不命中 → 返回 UNKNOWN，交给人工。
 */

/** 单据大类：决定走哪条识别管道 */
export type DocKind = 'INVOICE' | 'BANK_SLIP' | 'BANK_STATEMENT' | 'CONTRACT' | 'RECEIPT' | 'STATEMENT' | 'UNKNOWN';

/** 具体类型（与数据库 DocType 枚举一致，STATEMENT 单列） */
export type DocTypeGuess =
  | 'INVOICE_SALES'
  | 'INVOICE_PURCHASE'
  | 'BANK_SLIP'
  | 'BANK_STATEMENT'
  | 'CONTRACT'
  | 'RECEIPT'
  | 'OTHER';

/** 报表子类型（决定用哪个校验器） */
export type StatementGuess = 'BALANCE_SHEET' | 'INCOME_STATEMENT' | 'TAX_RETURN_VAT' | 'TAX_RETURN_CIT';

/** 识别目标（与 AI 服务的 ExtractTargetType 对齐） */
export type TargetGuess =
  | 'INVOICE'
  | 'BANK_SLIP'
  | 'BANK_STATEMENT'
  | 'BALANCE_SHEET'
  | 'INCOME_STATEMENT'
  | 'TAX_RETURN';

export interface ClassificationEvidence {
  /** 命中了什么（人话，给用户看的） */
  signal: string;
  /** 依据强度 */
  strength: 'FILE_TYPE' | 'TITLE' | 'FIELD';
}

export interface DocClassification {
  kind: DocKind;
  /** 与 DocType 枚举对齐；报表类为 OTHER（报表不进 DocType 管道） */
  docType: DocTypeGuess;
  /** 报表子类型，非报表为 null */
  statementType: StatementGuess | null;
  /** ★ 供识别管道直接使用的目标类型；UNKNOWN 时为 null */
  targetType: TargetGuess | null;
  confidence: number;
  /** ★ 是否必须由人确认。判不出来或置信度不足时为 true */
  needsConfirmation: boolean;
  /** 判定依据，逐条列出 */
  evidence: ClassificationEvidence[];
  /** 给用户看的结论说明 */
  reason: string;
  /** 若判不出来，告诉用户该怎么选 */
  hint: string;
}

// ============================================================================
//  关键词表
// ============================================================================

/** 发票类特征 */
const INVOICE_TITLE = [/增值税专用发票/, /增值税普通发票/, /电子发票/, /数电票/, /机动车销售统一发票/, /通行费发票/];
const INVOICE_FIELD = [/发票代码/, /发票号码/, /价税合计/, /销售方名称/, /购买方名称/, /纳税人识别号/];

/** 银行回单特征（单笔） */
const SLIP_TITLE = [/回单/, /付款凭证/, /收款凭证/, /转账凭证/, /电子回单/];
const SLIP_FIELD = [/付款人/, /收款人/, /交易流水号/, /凭证号/, /业务参考号/];

/** 银行流水特征（多笔） */
const STATEMENT_BANK_TITLE = [/交易明细/, /对账单/, /流水/, /账户明细/];
const STATEMENT_BANK_FIELD = [/借方发生额/, /贷方发生额/, /账户余额/, /交易日期/, /对方户名/];

/** 合同特征 */
const CONTRACT_TITLE = [/合同/, /协议/, /订单/];
const CONTRACT_FIELD = [/甲方/, /乙方/, /签订地点/, /第一条/, /本合同/];

/** 收据特征 */
const RECEIPT_TITLE = [/收据/, /收款收据/];

/** 财务报表特征 */
const BALANCE_SHEET_TITLE = [/资产负债表/];
const BALANCE_SHEET_FIELD = [/期末余额/, /年初余额/, /流动资产/, /资产总计/, /负债和所有者权益/];
const INCOME_STATEMENT_TITLE = [/利润表/, /损益表/];
const INCOME_STATEMENT_FIELD = [/营业收入/, /营业成本/, /利润总额/, /净利润/, /本期金额/];

/** 申报表特征 */
const TAX_RETURN_TITLE = [/纳税申报表/, /增值税申报表/, /企业所得税.*申报表/, /申报表/];
const VAT_RETURN_FIELD = [/销项税额/, /进项税额/, /应纳税额/, /留抵税额/, /按适用税率计税销售额/];
const CIT_RETURN_FIELD = [/应纳税所得额/, /纳税调整/, /应纳所得税额/, /利润总额/, /弥补以前年度亏损/];

/** 表格类扩展名 —— 这类几乎一定是报表，不可能是发票扫描件 */
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xls', 'csv', 'txt']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff']);

// ============================================================================
//  主函数
// ============================================================================

export interface ClassifyInput {
  fileName: string;
  /** 已抽取的文本（Excel/CSV/PDF 文本层）。没有则为 null（纯图片） */
  text: string | null;
  /** 文件 MIME（可选，扩展名优先） */
  mimeType?: string;
}

/**
 * 按内容判定单据类型。
 *
 * 不看用户声明 —— 声明的用途是"用户以为这是什么"，
 * 与本函数要回答的"这实际上是什么"是两件事。
 * 两者不一致时应当提示（见 documents 服务的 declaredType 对比）。
 */
export function classifyDocument(input: ClassifyInput): DocClassification {
  const ext = extOf(input.fileName);
  const text = (input.text ?? '').replace(/\r/g, '');
  // 只看前 3000 字：标题与关键字段都在开头，全文扫描既慢又容易被正文里的词干扰
  const head = text.slice(0, 3000);

  const evidence: ClassificationEvidence[] = [];
  const hit = (patterns: RegExp[], source: string): RegExp | null => {
    for (const p of patterns) {
      if (p.test(source)) return p;
    }
    return null;
  };

  // ── ⓪ 银行类前置判定 ──
  //
  // ★ 必须在文件类型分支之前判：银行流水与回单**经常以 Excel 导出**，
  //   如果先按"表格 → 报表"走，流水会被判成 UNKNOWN（实测踩过这个坑）。
  //   银行类单据的特征词足够独特（借方/贷方发生额、交易流水号），
  //   前置判定不会误伤财务报表 —— 报表里不会有"借方发生额"这种列名。
  const slipTitlePre = hit(SLIP_TITLE, head);
  const bankStatementTitlePre = hit(STATEMENT_BANK_TITLE, head);
  const slipFieldPre = hit(SLIP_FIELD, head);
  const bankStatementFieldPre = hit(STATEMENT_BANK_FIELD, head);

  if (bankStatementTitlePre && bankStatementFieldPre) {
    return {
      kind: 'BANK_STATEMENT',
      docType: 'BANK_STATEMENT',
      statementType: null,
      targetType: 'BANK_STATEMENT',
      confidence: 0.9,
      needsConfirmation: false,
      evidence: [
        { signal: `标题命中「${bankStatementTitlePre.source.replace(/[\\/^$*+?.()|[\]{}]/g, '')}」`, strength: 'TITLE' },
        { signal: '含流水字段（借方/贷方发生额、账户余额）', strength: 'FIELD' },
      ],
      reason: '判定为银行流水（整月多笔），将走流水识别。',
      hint: '流水用于与发票勾稽，不直接生成凭证。',
    };
  }

  if (slipTitlePre && !bankStatementFieldPre) {
    return {
      kind: 'BANK_SLIP',
      docType: 'BANK_SLIP',
      statementType: null,
      targetType: 'BANK_SLIP',
      confidence: slipFieldPre ? 0.9 : 0.75,
      needsConfirmation: !slipFieldPre,
      evidence: [
        { signal: `标题命中「${slipTitlePre.source.replace(/[\\/^$*+?.()|[\]{}]/g, '')}」`, strength: 'TITLE' },
        ...(slipFieldPre
          ? [{ signal: '含回单字段（付款人/收款人/交易流水号）', strength: 'FIELD' as const }]
          : []),
      ],
      reason: '判定为银行回单（单笔收付款）。',
      hint: '回单用于核销与对账，不落发票台账。',
    };
  }

  // ── ⓪b 合同与收据同样可能以表格/文本形式出现 ──
  //
  // ★ 与银行流水同理：合同的台账、收据的 CSV 都很常见，
  //   若先进"表格 → 报表"分支就会被漏成 UNKNOWN（实测踩过）。
  //   合同与收据都不参与记账，判错的代价比发票小，但仍要给对结论 ——
  //   用户看到"未知类型"会以为文件有问题。
  const contractTitlePre = hit(CONTRACT_TITLE, head);
  const contractFieldPre = hit(CONTRACT_FIELD, head);
  if (contractTitlePre && contractFieldPre) {
    return {
      kind: 'CONTRACT',
      docType: 'CONTRACT',
      statementType: null,
      targetType: null,
      confidence: 0.85,
      needsConfirmation: false,
      evidence: [
        { signal: `标题命中「${contractTitlePre.source.replace(/[\\/^$*+?.()|[\]{}]/g, '')}」`, strength: 'TITLE' },
        { signal: '含合同条款特征（甲方/乙方/第一条）', strength: 'FIELD' },
      ],
      reason: '判定为合同。★ 合同只作辅助备查，不参与记账 —— 记账依据是发票与银行流水。',
      hint: '合同会存入单据仓库并可与凭证挂接，但不会生成凭证。',
    };
  }

  const receiptTitlePre = hit(RECEIPT_TITLE, head);
  if (receiptTitlePre) {
    return {
      kind: 'RECEIPT',
      docType: 'RECEIPT',
      statementType: null,
      targetType: null,
      confidence: 0.8,
      needsConfirmation: false,
      evidence: [
        { signal: `标题命中「${receiptTitlePre.source.replace(/[\\/^$*+?.()|[\]{}]/g, '')}」`, strength: 'TITLE' },
      ],
      reason: '判定为收据。收据不是合规扣除凭证，入账后需在汇算时关注税前扣除风险。',
      hint: '收据可存入仓库作为辅助凭证，但企业所得税前扣除需合规发票。',
    };
  }

  // ── ① 文件类型：最强信号 ──
  //
  // 表格文件（xlsx/csv）几乎不可能是发票 —— 发票是版式文件或扫描件，
  // 没人会把发票做成 Excel。反过来，财务报表几乎都是 Excel。
  if (SHEET_EXT.has(ext)) {
    evidence.push({
      signal: `文件是表格格式（.${ext}），这类文件通常是财务报表或明细台账`,
      strength: 'FILE_TYPE',
    });
    // 仍要看内容区分是"报表"还是"发票明细台账"
    const asStatementInSheet = classifyStatement(head);
    if (asStatementInSheet) {
      return {
        kind: 'STATEMENT',
        docType: 'OTHER',
        statementType: asStatementInSheet.statementType,
        targetType: asStatementInSheet.targetType,
        confidence: Math.max(asStatementInSheet.confidence, 0.9),
        needsConfirmation: false,
        evidence: [...evidence, ...asStatementInSheet.evidence],
        reason: `按文件格式与内容判定为${asStatementInSheet.label}，将走报表识别（★ 只建档，不生成凭证）。`,
        hint: '报表识别结果需要你确认期间与行项目后再建档。',
      };
    }

    // 表格里出现发票字段 → 多半是发票明细台账，但**要看数据行数**
    //
    // ★ 为什么不能一律判成台账：
    //   有些开票软件导出的是「字段 值」逐行文本（.txt），那是**一张票**；
    //   而 .csv/.xlsx 里的台账是「一行一张票」。两者都含"发票号码"这类字段，
    //   只看字段名会把单张票误判成台账，让用户白白多点一次。
    //
    //   数据行数是可靠的区分依据：台账必然有多行数据（一行一张票）。
    if (hit(INVOICE_FIELD, head)) {
      const rowCount = countInvoiceDataRows(head);
      const isLedger = rowCount > 1;

      const isSales = /销项|销方|销售方/.test(head) && !/进项|购方|购买方/.test(head);
      const docType = isSales ? 'INVOICE_SALES' : 'INVOICE_PURCHASE';

      if (isLedger) {
        return {
          kind: 'INVOICE',
          docType,
          statementType: null,
          // ★ 台账不是单张票，不能直接走发票识别 → 应当走「历史数据导入」
          targetType: null,
          confidence: 0.75,
          needsConfirmation: true,
          evidence: [
            ...evidence,
            {
              signal: `表格中含发票字段，且有约 ${rowCount} 行数据 —— 一行一张票，判断为发票明细台账`,
              strength: 'FIELD',
            },
          ],
          reason:
            `这看起来是**发票明细台账**（约 ${rowCount} 张票），不是单张发票。` +
            '单张票识别一次只能处理一张，用它处理台账会只认出第一张。',
          hint:
            '批量导入历史开票/进项明细请用「历史数据导入」（可一次导入成百上千条）。' +
            '若确实只想识别其中一张，请把该行单独导出后再上传。',
        };
      }

      // 只有一行数据 → 单张票。可以走发票识别。
      return {
        kind: 'INVOICE',
        docType,
        statementType: null,
        targetType: 'INVOICE',
        confidence: 0.7,
        needsConfirmation: false,
        evidence: [
          ...evidence,
          { signal: '内容含发票字段，且只有一条数据（一张票）', strength: 'FIELD' },
        ],
        reason: '判定为单张增值税发票，将走发票识别（进项/销项由票面购销方与本主体比对后确定）。',
        hint: '识别后请核对方向与金额 —— 方向搞反会把进项票记成销项。',
      };
    }

    return unknownResult(
      [...evidence, { signal: '但内容里没有识别出报表标题，也没有发票字段', strength: 'FIELD' }],
      '文件是表格格式，但内容既不像财务报表也不像发票台账。',
    );
  }

  // ── ② 报表类（标题 + 字段结构） ──
  const asStatement = classifyStatement(head);
  if (asStatement) {
    const allEvidence = [...evidence, ...asStatement.evidence];

    // PDF 报表 vs 图片报表：都不影响走报表管道，但图片要提示核对
    if (IMAGE_EXT.has(ext)) {
      allEvidence.push({
        signal: '文件是图片，报表数字需逐项核对（图片识别比文本层更易出错）',
        strength: 'FILE_TYPE',
      });
    }

    return {
      kind: 'STATEMENT',
      docType: 'OTHER',
      statementType: asStatement.statementType,
      targetType: asStatement.targetType,
      confidence: asStatement.confidence,
      needsConfirmation: false,
      evidence: allEvidence,
      reason: `判定为${asStatement.label}，将走报表识别（★ 只建档，不生成凭证）。`,
      hint: '报表识别结果需要你确认期间与行项目后再建档。',
    };
  }

  // ── ③ 发票 ──
  const invoiceTitle = hit(INVOICE_TITLE, head);
  const invoiceField = hit(INVOICE_FIELD, head);
  if (invoiceTitle || invoiceField) {
    // 购销方向：由本主体在票面上的位置决定，这里先给个初判，
    // 真正的方向判定在识别阶段用主体名称/税号做（那才可靠）
    const salesSignal = /销方|销售方|开票方/.test(head);
    const purchaseSignal = /购方|购买方|受票方/.test(head);

    const hasTitle = !!invoiceTitle;
    const hasField = !!invoiceField;
    const confidence = hasTitle && hasField ? 0.95 : hasTitle || hasField ? 0.75 : 0.5;

    if (hasTitle) {
      evidence.push({ signal: `标题命中「${invoiceTitle!.source.replace(/[\\/^$*+?.()|[\]{}]/g, '')}」`, strength: 'TITLE' });
    }
    if (hasField) {
      evidence.push({ signal: '含发票专用字段（发票号码 / 价税合计 / 购销方名称）', strength: 'FIELD' });
    }

    return {
      kind: 'INVOICE',
      // 方向在识别阶段以主体身份判定，这里只是初判
      docType: salesSignal && !purchaseSignal ? 'INVOICE_SALES' : 'INVOICE_PURCHASE',
      statementType: null,
      targetType: 'INVOICE',
      confidence,
      needsConfirmation: confidence < 0.7,
      evidence,
      reason: '判定为增值税发票，将走发票识别（进项/销项由票面购销方与本主体比对后确定）。',
      hint: '识别后请核对方向与金额 —— 方向搞反会把进项票记成销项。',
    };
  }

  // ── ④ 银行回单 / 流水 ──
  const slipTitle = slipTitlePre;
  const bankStatementTitle = bankStatementTitlePre;
  const slipField = slipFieldPre;
  const bankStatementField = bankStatementFieldPre;

  if (bankStatementTitle && bankStatementField) {
    evidence.push({ signal: `标题命中「${bankStatementTitle.source.replace(/[\\/^$*+?.()|[\]{}]/g, '')}」`, strength: 'TITLE' });
    evidence.push({ signal: '含流水字段（借方/贷方发生额、账户余额）', strength: 'FIELD' });
    return {
      kind: 'BANK_STATEMENT',
      docType: 'BANK_STATEMENT',
      statementType: null,
      targetType: 'BANK_STATEMENT',
      confidence: 0.9,
      needsConfirmation: false,
      evidence,
      reason: '判定为银行流水（整月多笔），将走流水识别。',
      hint: '流水用于与发票勾稽，不直接生成凭证。',
    };
  }

  if (slipTitle || (slipField && !bankStatementField)) {
    if (slipTitle) {
      evidence.push({ signal: `标题命中「${slipTitle.source.replace(/[\\/^$*+?.()|[\]{}]/g, '')}」`, strength: 'TITLE' });
    }
    if (slipField) {
      evidence.push({ signal: '含回单字段（付款人/收款人/交易流水号）', strength: 'FIELD' });
    }
    return {
      kind: 'BANK_SLIP',
      docType: 'BANK_SLIP',
      statementType: null,
      targetType: 'BANK_SLIP',
      confidence: slipTitle && slipField ? 0.9 : 0.7,
      needsConfirmation: !(slipTitle && slipField),
      evidence,
      reason: '判定为银行回单（单笔收付款）。',
      hint: '回单用于核销与对账，不落发票台账。',
    };
  }

  // ── ⑤ 合同 ──
  const contractTitle = hit(CONTRACT_TITLE, head);
  const contractField = hit(CONTRACT_FIELD, head);
  if (contractTitle && contractField) {
    evidence.push({ signal: `标题命中「${contractTitle.source.replace(/[\\/^$*+?.()|[\]{}]/g, '')}」`, strength: 'TITLE' });
    evidence.push({ signal: '含合同条款特征（甲方/乙方/第一条）', strength: 'FIELD' });
    return {
      kind: 'CONTRACT',
      docType: 'CONTRACT',
      statementType: null,
      // ★ 合同不参与记账（只作辅助备查），所以没有识别目标
      targetType: null,
      confidence: 0.85,
      needsConfirmation: false,
      evidence,
      reason: '判定为合同。★ 合同只作辅助备查，不参与记账 —— 记账依据是发票与银行流水。',
      hint: '合同会存入单据仓库并可与凭证挂接，但不会生成凭证。',
    };
  }

  // ── ⑥ 收据 ──
  const receiptTitle = hit(RECEIPT_TITLE, head);
  if (receiptTitle) {
    evidence.push({ signal: `标题命中「${receiptTitle.source.replace(/[\\/^$*+?.()|[\]{}]/g, '')}」`, strength: 'TITLE' });
    return {
      kind: 'RECEIPT',
      docType: 'RECEIPT',
      statementType: null,
      targetType: null,
      confidence: 0.8,
      needsConfirmation: false,
      evidence,
      reason: '判定为收据。收据不是合规扣除凭证，入账后需在汇算时关注税前扣除风险。',
      hint: '收据可存入仓库作为辅助凭证，但企业所得税前扣除需合规发票。',
    };
  }

  // ── ⑦ 纯图片：内容看不出来 ──
  if (IMAGE_EXT.has(ext) && !text) {
    return {
      kind: 'UNKNOWN',
      docType: 'OTHER',
      statementType: null,
      targetType: null,
      confidence: 0,
      needsConfirmation: true,
      evidence: [{ signal: '文件是图片，没有文本层可供判定', strength: 'FILE_TYPE' }],
      reason: '这是一张图片，系统无法在识别之前判断它是发票、回单还是报表扫描件。',
      hint:
        '请选择识别目标：发票 / 银行回单 / 银行流水 / 资产负债表 / 利润表 / 纳税申报表。' +
        '★ 选错会让数据进错管道 —— 例如把资产负债表当发票识别。',
    };
  }

  return unknownResult(
    [{ signal: '未命中任何已知单据的特征词', strength: 'FIELD' }],
    '系统无法从内容判断这是什么单据。',
  );
}

// ============================================================================
//  报表子分类
// ============================================================================

interface StatementHit {
  kind: 'STATEMENT';
  docType: 'OTHER';
  statementType: StatementGuess;
  targetType: TargetGuess;
  confidence: number;
  needsConfirmation: boolean;
  evidence: ClassificationEvidence[];
  label: string;
}

/**
 * 判定报表子类型。
 *
 * 顺序有讲究：**先判申报表再判财务报表**。
 * 因为企业所得税年度申报表里也有"利润总额""营业收入"这些词，
 * 先判财务报表会把它误判成利润表。
 */
function classifyStatement(head: string): StatementHit | null {
  if (!head) return null;

  const has = (patterns: RegExp[]) => patterns.some((p) => p.test(head));

  // ① 申报表（先判，因为它的字段与财务报表重叠最多）
  const isTaxReturnTitle = has(TAX_RETURN_TITLE);
  const isVat = has(VAT_RETURN_FIELD);
  const isCit = has(CIT_RETURN_FIELD);

  if (isTaxReturnTitle && isVat) {
    return {
      kind: 'STATEMENT',
      docType: 'OTHER',
      statementType: 'TAX_RETURN_VAT',
      targetType: 'TAX_RETURN',
      confidence: 0.92,
      needsConfirmation: false,
      label: '增值税纳税申报表',
      evidence: [
        { signal: '标题含「申报表」', strength: 'TITLE' },
        { signal: '含增值税申报表行次（销项税额 / 进项税额 / 应纳税额 / 留抵税额）', strength: 'FIELD' },
      ],
    };
  }

  if (isTaxReturnTitle && isCit) {
    return {
      kind: 'STATEMENT',
      docType: 'OTHER',
      statementType: 'TAX_RETURN_CIT',
      targetType: 'TAX_RETURN',
      confidence: 0.9,
      needsConfirmation: false,
      label: '企业所得税纳税申报表',
      evidence: [
        { signal: '标题含「申报表」', strength: 'TITLE' },
        { signal: '含企业所得税申报表行次（应纳税所得额 / 纳税调整 / 弥补以前年度亏损）', strength: 'FIELD' },
      ],
    };
  }

  // 只看"应纳税所得额""纳税调整"这类**申报表独有**的词，也可以判定
  if (!isTaxReturnTitle && /应纳税所得额|纳税调整|实际利润额/.test(head)) {
    return {
      kind: 'STATEMENT',
      docType: 'OTHER',
      statementType: 'TAX_RETURN_CIT',
      targetType: 'TAX_RETURN',
      confidence: 0.75,
      needsConfirmation: true,
      label: '企业所得税纳税申报表',
      evidence: [
        { signal: '含「应纳税所得额 / 纳税调整」等申报表独有行次', strength: 'FIELD' },
        { signal: '但未见「申报表」标题，判定把握一般', strength: 'TITLE' },
      ],
    };
  }

  // ② 资产负债表
  if (has(BALANCE_SHEET_TITLE) || (has(BALANCE_SHEET_FIELD) && /资产总计|负债合计/.test(head))) {
    const strong = has(BALANCE_SHEET_TITLE) && has(BALANCE_SHEET_FIELD);
    return {
      kind: 'STATEMENT',
      docType: 'OTHER',
      statementType: 'BALANCE_SHEET',
      targetType: 'BALANCE_SHEET',
      confidence: strong ? 0.95 : 0.7,
      needsConfirmation: !strong,
      label: '资产负债表',
      evidence: [
        ...(has(BALANCE_SHEET_TITLE) ? [{ signal: '标题含「资产负债表」', strength: 'TITLE' as const }] : []),
        ...(has(BALANCE_SHEET_FIELD)
          ? [{ signal: '含「期末余额 / 年初余额 / 资产总计」等报表列', strength: 'FIELD' as const }]
          : []),
      ],
    };
  }

  // ③ 利润表
  if (has(INCOME_STATEMENT_TITLE) || (has(INCOME_STATEMENT_FIELD) && /营业收入|利润总额/.test(head))) {
    const strong = has(INCOME_STATEMENT_TITLE) && has(INCOME_STATEMENT_FIELD);
    return {
      kind: 'STATEMENT',
      docType: 'OTHER',
      statementType: 'INCOME_STATEMENT',
      targetType: 'INCOME_STATEMENT',
      confidence: strong ? 0.93 : 0.68,
      needsConfirmation: !strong,
      label: '利润表',
      evidence: [
        ...(has(INCOME_STATEMENT_TITLE) ? [{ signal: '标题含「利润表」', strength: 'TITLE' as const }] : []),
        ...(has(INCOME_STATEMENT_FIELD)
          ? [{ signal: '含「营业收入 / 营业成本 / 利润总额 / 净利润」等行次', strength: 'FIELD' as const }]
          : []),
      ],
    };
  }

  return null;
}

// ============================================================================

function unknownResult(evidence: ClassificationEvidence[], reason: string): DocClassification {
  return {
    kind: 'UNKNOWN',
    docType: 'OTHER',
    statementType: null,
    targetType: null,
    confidence: 0,
    needsConfirmation: true,
    evidence,
    reason,
    hint:
      '请手工选择识别目标（发票 / 银行回单 / 银行流水 / 资产负债表 / 利润表 / 纳税申报表）。' +
      '★ 选错会让数据进错管道，所以这里不替你猜。',
  };
}

/**
 * 数一数内容里有几条「发票」数据。
 *
 * 判据：
 *   · 含逗号的行 → 表格网格，数其中"像数据行"的（≥3 列且含数字）
 *   · 不含逗号的行 → 逐行文本，数出现了几次"发票号码"（一张票只有一个号码）
 *
 * ★ 这个数字只用于区分"台账（多张票）"与"单张票"，不参与任何金额计算，
 *   所以用宽松的启发式可以接受 —— 判错只影响要不要多问用户一句。
 */
function countInvoiceDataRows(head: string): number {
  const lines = head.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return 0;

  // 单元格分隔符有两种可能：
  //   · 原始 CSV → 逗号
  //   · 经报告读取器转换后的网格 → 「 | 」
  //   两条路径都会走到这里，所以两种都要认。
  //   实测踩过两次：先只认逗号、后把表头也当成数据行。
  const isGrid = lines.some((l) => l.includes('|') || (l.match(/,/g)?.length ?? 0) >= 2);
  if (isGrid) {
    // ★ 判据是「是否含 4 位以上连续数字」，而不是「是否含数字」：
    //   表头行（开票日期/发票代码/发票号码…）没有任何数字，
    //   而数据行必然含日期、发票号码或金额中的至少一个。
    //   用"含数字"会把表头也算进来，于是 4 行台账会被数成 4 张票。
    const DATA_NUMBER = /[0-9]{4,}/;
    return lines.filter((l) => {
      const cols = l
        .split(/[|,]/)
        .map((c) => c.trim())
        .filter((c) => c !== '');
      return cols.length >= 2 && cols.some((c) => DATA_NUMBER.test(c));
    }).length;
  }

  // 逐行文本：一张票只出现一次「发票号码」，出现几次就是几张票
  const matches = head.match(/发票号码/g);
  return matches ? matches.length : 0;
}

function extOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec((fileName ?? '').trim());
  return m ? m[1]!.toLowerCase() : '';
}

/** 判定结果是否可直接用于自动路由（不需要人工确认） */
export function canAutoRoute(c: DocClassification): boolean {
  return !c.needsConfirmation && c.targetType !== null;
}

/** 供界面展示的结论标签 */
export function classificationLabel(c: DocClassification): string {
  switch (c.statementType) {
    case 'BALANCE_SHEET':
      return '资产负债表';
    case 'INCOME_STATEMENT':
      return '利润表';
    case 'TAX_RETURN_VAT':
      return '增值税纳税申报表';
    case 'TAX_RETURN_CIT':
      return '企业所得税纳税申报表';
    default:
      break;
  }
  switch (c.kind) {
    case 'INVOICE':
      // ★ 台账（多张票）与单张票要分开说：
      //   两者都 kind=INVOICE，但处理方式完全不同 ——
      //   拿单张票识别去跑台账只会认出第一张，用户必须知道这一点。
      if (c.targetType === null) {
        return c.docType === 'INVOICE_SALES' ? '销项发票明细台账' : '进项发票明细台账';
      }
      return c.docType === 'INVOICE_SALES' ? '销项发票' : '进项发票';
    case 'BANK_SLIP':
      return '银行回单';
    case 'BANK_STATEMENT':
      return '银行流水';
    case 'CONTRACT':
      return '合同';
    case 'RECEIPT':
      return '收据';
    default:
      return '未识别出类型';
  }
}
