/**
 * 进项凭证类型（受控枚举）与它的税务处理
 * ============================================================
 * ★ 为什么必须有这个模块，而不是继续用模型给的 category 文本
 *
 *   改造前，进项税怎么算这件事散在两处按关键词匹配：
 *     · statutoryRateFor()          判断是不是旅客运输、套哪个税率
 *     · isNonDeductibleTaxiVoucher() 判断是不是出租车卷式票
 *   两处各自维护关键词，很容易出现"一处认得出、另一处认不出"的分叉 ——
 *   而分叉的后果是税额算错或多抵进项税，不是显示问题。
 *
 *   另一头，落库时 `category ?? 'SPECIAL_VAT'`、`isDeductible ?? true`
 *   两个默认值更危险：一张出租车卷式票若没带类别，会被存成
 *   「可抵扣的增值税专用发票」。
 *
 *   所以把「凭证类型 → 税务处理」收敛成**一张表**，取值与数据库
 *   InvoiceCategory 枚举一一对应（另加 TAXI，见 migration），
 *   模型只负责提供线索，判定与算法由这里唯一决定。
 *
 * ★ 判定顺序有讲究，不能随手排：
 *   「电子发票（铁路电子客票）」既含"电子发票"也含"铁路"，
 *   先判铁路才不会被当成普通电子发票；
 *   「航空运输电子客票行程单」也含"电子客票"，所以航空要排在铁路前面。
 */
import { dec } from '@bookkeeper/shared';

/** 进项凭证类型（取值与数据库 InvoiceCategory 一致） */
export type VoucherType =
  | 'SPECIAL_VAT' // 增值税专用发票
  | 'GENERAL_VAT' // 增值税普通发票 / 电子普通发票
  | 'E_INVOICE' // 全电发票（数电票）
  | 'TRAIN' // 电子发票（铁路电子客票）/ 铁路车票
  | 'AIR' // 电子发票（航空运输电子客票行程单）
  | 'TOLL' // 通行费发票
  | 'TAXI' // 出租车卷式 / 通用机打发票 —— 不是扣税凭证
  | 'ROAD_WATER' // 列明旅客身份信息的公路、水路等其他客票
  | 'OTHER';

/**
 * 进项税怎么确定。
 *
 *   STATED   按票面列明的税额（凭票直抵）
 *   COMPUTE  按法定公式从含税金额倒算
 *   NONE     不可抵扣（票面全额计入费用）
 */
export type DeductionMode = 'STATED' | 'COMPUTE' | 'NONE';

export interface VoucherRule {
  label: string;
  deduction: DeductionMode;
  /** COMPUTE 时使用的法定税率（小数） */
  statutoryRate?: string;
  /** 税法依据。会写进校验说明 —— 用户有权知道凭什么这么算 */
  basis: string;
}

export const VOUCHER_RULES: Record<VoucherType, VoucherRule> = {
  SPECIAL_VAT: {
    label: '增值税专用发票',
    deduction: 'STATED',
    basis: '增值税专用发票按票面列明的税额抵扣。',
  },
  GENERAL_VAT: {
    label: '增值税普通发票',
    deduction: 'STATED',
    basis: '增值税普通发票（含电子普通发票）按票面列明的税额抵扣；未列明税额则无从抵扣。',
  },
  E_INVOICE: {
    label: '全电发票（数电票）',
    deduction: 'STATED',
    basis: '全电发票（数电票）按票面列明的税额抵扣。',
  },
  TRAIN: {
    label: '铁路电子客票',
    deduction: 'COMPUTE',
    statutoryRate: '0.09',
    basis:
      '财政部 税务总局公告2026年第13号 第一条第（二）项1：取得电子发票（铁路电子客票）的，' +
      '为发票上列明**或包含**的增值税税额。票面只印票价、未列明税额，即税额包含在票价里，' +
      '按交通运输服务 9% 倒算。',
  },
  AIR: {
    label: '航空运输电子客票行程单',
    deduction: 'COMPUTE',
    statutoryRate: '0.09',
    basis:
      '财政部 税务总局公告2026年第13号 第一条第（二）项1：取得电子发票（航空运输电子客票行程单）的，' +
      '为发票上列明**或包含**的增值税税额；未列明时按 9% 倒算。',
  },
  TOLL: {
    label: '通行费发票',
    deduction: 'STATED',
    basis:
      '财政部 税务总局公告2026年第13号 第一条第（三）项1：取得收费公路通行费增值税电子普通发票、' +
      '带有"通行费"字样的电子发票（普通发票）的，为发票上列明的增值税税额。',
  },
  TAXI: {
    label: '出租车卷式/通用机打发票',
    deduction: 'NONE',
    basis:
      '该凭证未注明旅客身份信息，不属于13号公告第一条第（二）项2 允许计算抵扣的' +
      '"列明旅客身份信息的公路、水路等其他客票"，也不是增值税扣税凭证，进项税额为 0，' +
      '票面全额计入费用。★ 不要按公路运输 3% 倒算 —— 那会凭空多抵。',
  },
  ROAD_WATER: {
    label: '公路/水路等其他客票',
    deduction: 'COMPUTE',
    statutoryRate: '0.03',
    basis:
      '财政部 税务总局公告2026年第13号 第一条第（二）项2：取得**列明旅客身份信息**的' +
      '公路、水路等其他客票的，进项税额 = 票面金额 ÷ (1 + 3%) × 3%。' +
      '★ 前提是票面列明了旅客身份信息；未列明的（如出租车卷式票）不得抵扣。',
  },
  OTHER: {
    label: '其他凭证',
    deduction: 'NONE',
    basis:
      '未能确定凭证类型，按不可抵扣处理（宁可不抵，不可错抵）。' +
      '若该凭证确实可抵扣，请人工指定凭证类型后再入账。',
  },
};

export interface VoucherEvidence {
  /** 模型给的类别文本（自由文本，只当线索用） */
  category?: string | null;
  /** 原始文件名 */
  fileName?: string | null;
  /** 票面文本层（PDF 有文本层时字符是精确的） */
  text?: string | null;
}

export interface VoucherClassification {
  type: VoucherType;
  /** 判定依据，适合直接展示给用户 */
  reason: string;
}

/**
 * 由证据判定凭证类型。
 *
 * 证据按"离票面越近越可信"排序：模型读到的类别 → 文件名 → 正文文本层。
 * 任一条能定性就返回，都不行则 OTHER（conservative：不抵扣）。
 */
export function classifyVoucher(evidence: VoucherEvidence): VoucherClassification {
  const sources: Array<{ name: string; value: string }> = [
    { name: '识别到的类别', value: (evidence.category ?? '').trim() },
    { name: '文件名', value: (evidence.fileName ?? '').trim() },
    // 文本层可能很长（流水几十页），定性只需要开头
    { name: '票面文本', value: (evidence.text ?? '').slice(0, 500).trim() },
  ];

  for (const source of sources) {
    const type = matchVoucherType(source.value);
    if (type) {
      return { type, reason: `按${source.name}判定为「${VOUCHER_RULES[type].label}」` };
    }
  }

  return {
    type: 'OTHER',
    reason: '类别、文件名与票面文本都没能识别出凭证类型',
  };
}

/** 关键词 → 凭证类型。顺序即优先级，见文件头注释。 */
function matchVoucherType(s: string): VoucherType | null {
  if (!s) return null;

  /*
   * ⓪ 先认**枚举值本身**。
   *
   *   category 这个字段有两个来源：模型读出来的中文类别（"出租车发票"），
   *   以及已经规范化过的枚举值（"TAXI"）。两者都会流到这里 ——
   *   例如 mock 样例、以及前端回传已确认过的凭证。
   *   改造初期只匹配中文，结果传 "SPECIAL_VAT" 时认不出、落到 OTHER，
   *   于是"不可抵扣"把税额清成 0，V1/V2/V3 等金额规则全部失效 ——
   *   校验静默失灵比判错类型更危险，所以这一步必须放在最前。
   */
  const upper = s.toUpperCase();
  if ((Object.keys(VOUCHER_RULES) as string[]).includes(upper)) {
    return upper as VoucherType;
  }

  // ① 航空要排在铁路前面：「航空运输电子客票行程单」也含"电子客票"
  if (/航空|机票|行程单/.test(s)) return 'AIR';
  // ② 铁路：「电子发票（铁路电子客票）」也含"电子发票"，必须先判
  if (/铁路|火车|高铁|动车|城际|12306/.test(s)) return 'TRAIN';

  // ③ 出租车：★ 但要放过网约车/出租车公司开的增值税发票
  //    （类别里带"增值税"或"普通发票"的是合规扣税凭证，凭票面税额抵扣）
  if (/出租|的士|卷式|通用机打/.test(s) && !/增值税|普通发票/.test(s)) return 'TAXI';

  // ④ 通行费要排在公路/水路前面：
  //    「收费公路通行费增值税电子普通发票」含"公路"，若先判公路水路
  //    会被认成 3% 计算抵扣的客运客票，而它其实是凭票面税额直抵。
  if (/通行费|过路费|过桥费|桥闸|ETC/.test(s)) return 'TOLL';

  // ⑤ 公路 / 水路等其他客票（3%）。能走到这里的才是可能可抵扣的客运客票
  //    （出租车卷式票已在③被拦下）
  if (/公路|水路|客运|长途汽车|汽车票|船票|轮渡/.test(s)) return 'ROAD_WATER';

  // ⑥ 增值税发票
  if (/专用发票|专票/.test(s)) return 'SPECIAL_VAT';
  if (/普通发票|普票/.test(s)) return 'GENERAL_VAT';
  if (/全电|数电|电子发票/.test(s)) return 'E_INVOICE';

  return null;
}

/** 该凭证类型的默认可抵扣性（凭证类型这一维；用途维由费用审计另行判断） */
export function deductibleByVoucherType(type: VoucherType): boolean {
  return VOUCHER_RULES[type].deduction !== 'NONE';
}

/** 该凭证类型需要按法定税率倒算时的税率 */
export function statutoryRateOf(type: VoucherType): string | null {
  const rule = VOUCHER_RULES[type];
  return rule.deduction === 'COMPUTE' ? (rule.statutoryRate ?? null) : null;
}

/** 供展示的税率文本：0.09 → "9%" */
export function formatRate(rate: string): string {
  return `${dec(rate).times(100).toString()}%`;
}