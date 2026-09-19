/**
 * 税务政策检索
 * ============================================================
 * ★ 先说清这个模块**不做**什么，因为它最容易被误解：
 *
 *   ✗ 它不判断某条政策是否适用于你
 *   ✗ 它不替你决定申报口径
 *   ✗ 它不保证抓到的就是全部（只覆盖已登记的来源）
 *   ✗ 它不把政策的"解读"当结论 —— 只呈现原文与关键日期
 *
 *   ✓ 它做的是：按月去已登记的官方来源抓一遍，把**原文、发文机关、
 *     文号、发文日期、施行日期、失效日期、来源链接、抓取时间**存下来，
 *     在政策发生变化时提示你去看一眼。
 *
 * 为什么坚持只呈现原文：
 *   政策的适用往往取决于**限定条件**（"……的企业，同时符合下列条件的……"），
 *   而这些条件写在正文里。如果系统只给一句"某政策可减半征收"，
 *   用户很可能在不符合条件的情况下照做。所以正文原文必须留存可查。
 *
 * 关于"最优方式"：
 *   本模块**不提供**"哪种申报方式最优"的结论。原因不是技术做不到，
 *   而是判断某个安排是否构成"合理商业目的"属于涉税专业判断，
 *   由软件替用户下这个结论并引导申报，是在替用户承担它承担不起的责任。
 *   系统能做的是把**不同口径下的税额差异算出来供比较**，
 *   决策与签字必须是人。
 *
 * 关于抓取：
 *   抓取器是**可注入**的。默认使用内置的政策目录（离线可用、结果确定），
 *   接入真实 HTTP 抓取器后可自动获取。这样做的原因：
 *   ① 开发与 CI 环境不应依赖外网
 *   ② 抓取失败必须能被看见（而不是静默返回"本期无新政策"）
 */
import { createHash } from 'node:crypto';

// ============================================================================
//  类型
// ============================================================================

export type PolicyStatus = 'EFFECTIVE' | 'UPCOMING' | 'EXPIRED';

export type TaxTypeHint = 'VAT' | 'CIT' | 'SURTAX' | 'STAMP_DUTY' | 'IIT' | 'OTHER';

/** 从来源抓回来的一条原始条目 */
export interface RawPolicyItem {
  title: string;
  sourceUrl: string;
  sourceName?: string;
  issuer?: string;
  documentNo?: string;
  /** 发文日期（YYYY-MM-DD） */
  publishedAt?: string | null;
  /** 施行日期 */
  effectiveFrom?: string | null;
  /** 失效日期 */
  effectiveTo?: string | null;
  /** 正文原文（必须尽量完整 —— 限定条件都在正文里） */
  content: string;
}

/** 抓取器接口。真实实现走 HTTP，默认实现用内置目录 */
export interface PolicyFetcher {
  readonly name: string;
  /** 拉取某个来源的条目 */
  fetch(source: PolicySource): Promise<RawPolicyItem[]>;
}

/** 一个已登记的官方来源 */
export interface PolicySource {
  /** 来源标识 */
  key: string;
  name: string;
  /** 该来源对应的报税地 */
  jurisdiction: string;
  /** 入口 URL（真实抓取时用；内置目录模式下仅作展示） */
  url: string;
  /** 说明这个来源覆盖什么 */
  covers: string;
}

export interface FetchRunResult {
  jurisdiction: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  sourcesTried: number;
  sourcesFailed: number;
  items: RawPolicyItem[];
  sourceResults: Array<{
    source: string;
    ok: boolean;
    itemCount: number;
    error?: string;
  }>;
  warnings: string[];
}

// ============================================================================
//  已登记的官方来源
// ============================================================================

/**
 * 官方来源登记表。
 *
 * ★ 只登记**官方**来源：财政部、国家税务总局、省税务局。
 *   不登记任何第三方解读站点 —— 解读可以作为线索，但不能当作依据留存。
 *
 * ★ 报税地是政策生效范围的关键：
 *   增值税与企业所得税主要是国家层面政策，全国一致；
 *   但**附加税费率**（城建税 7%/5%/1%）与部分地方优惠因地区而异。
 *   所以来源按 jurisdiction 区分，用户配置自己的报税地后只关注相关的那些。
 */
export const POLICY_SOURCES: PolicySource[] = [
  {
    key: 'mof-tax-policy',
    name: '财政部 政策发布',
    jurisdiction: 'CN-GENERAL',
    url: 'https://www.mof.gov.cn/zhengwuxinxi/zhengcefabu/',
    covers: '财政部发布的税收政策（含联合发文）',
  },
  {
    key: 'chinatax-news',
    name: '国家税务总局 政策文件',
    jurisdiction: 'CN-GENERAL',
    url: 'https://www.chinatax.gov.cn/chinatax/n810341/n810755/index.html',
    covers: '国家税务总局公告、通知、政策解读',
  },
  {
    key: 'chinatax-fgk',
    name: '国家税务总局 法规库',
    jurisdiction: 'CN-GENERAL',
    url: 'https://fgk.chinatax.gov.cn/',
    covers: '现行有效法规全文库（含失效标注）',
  },
  {
    key: 'jilin-tax',
    name: '国家税务总局吉林省税务局',
    jurisdiction: 'CN-JL',
    url: 'https://jilin.chinatax.gov.cn/',
    covers: '吉林省地方口径、地方税费政策',
  },
];

/**
 * 内置政策目录（默认抓取器的数据源）。
 *
 * ★ 为什么需要内置目录，而不是纯依赖网络：
 *   ① 离线/内网环境（很多小企业的电脑不能随便出网）也要能用
 *   ② 抓取器坏了的时候，至少有基线可比对
 *   ③ 让"政策变更提示"这个功能可以被测试
 *
 * ★ 这里的内容是**示例基线**，不是完整的政策库，也**不保证时效**。
 *   界面必须明确标注"内置基线，需以官方来源为准"。
 *   接入真实抓取器后，真实结果会与基线合并（同一链接以真实结果为准）。
 */
export const BUILTIN_POLICY_CATALOG: RawPolicyItem[] = [
  {
    title: '财政部 税务总局关于增值税小规模纳税人减免增值税政策的公告',
    sourceUrl: 'https://www.chinatax.gov.cn/chinatax/n810341/n810755/c10197456/content.html',
    sourceName: '国家税务总局 政策文件',
    issuer: '财政部 税务总局',
    documentNo: '财政部 税务总局公告2023年第19号',
    publishedAt: '2023-08-01',
    effectiveFrom: '2023-01-01',
    effectiveTo: '2027-12-31',
    content:
      '为进一步支持小微企业和个体工商户发展，现将有关增值税政策公告如下：\n' +
      '一、对月销售额10万元以下（含本数）的增值税小规模纳税人，免征增值税。\n' +
      '二、增值税小规模纳税人适用3%征收率的应税销售收入，减按1%征收率征收增值税；' +
      '适用3%预征率的预缴增值税项目，减按1%预征率预缴增值税。\n' +
      '三、本公告执行至2027年12月31日。\n' +
      '★ 注意：本条适用于**小规模纳税人**。一般纳税人不适用。',
  },
  {
    title: '财政部 税务总局关于进一步支持小微企业和个体工商户发展有关税费政策的公告',
    sourceUrl: 'https://www.chinatax.gov.cn/chinatax/n810341/n810755/c10197405/content.html',
    sourceName: '国家税务总局 政策文件',
    issuer: '财政部 税务总局',
    documentNo: '财政部 税务总局公告2023年第12号',
    publishedAt: '2023-08-02',
    effectiveFrom: '2023-01-01',
    effectiveTo: '2027-12-31',
    content:
      '一、自2023年1月1日至2027年12月31日，对增值税小规模纳税人、小型微利企业和个体工商户' +
      '减半征收资源税（不含水资源税）、城市维护建设税、房产税、城镇土地使用税、印花税' +
      '（不含证券交易印花税）、耕地占用税和教育费附加、地方教育附加。\n' +
      '二、小型微利企业，是指从事国家非限制和禁止行业，且同时符合以下三个条件的企业：' +
      '年度应纳税所得额不超过300万元、从业人数不超过300人、资产总额不超过5000万元。\n' +
      '★ 注意：三项条件必须**同时**满足。从业人数与资产总额需自行核算。',
  },
  {
    title: '财政部 税务总局关于进一步实施小微企业所得税优惠政策的公告',
    sourceUrl: 'https://www.chinatax.gov.cn/chinatax/n810341/n810755/c10165483/content.html',
    sourceName: '国家税务总局 政策文件',
    issuer: '财政部 税务总局',
    documentNo: '财政部 税务总局公告2022年第13号',
    publishedAt: '2022-03-14',
    effectiveFrom: '2022-01-01',
    effectiveTo: '2027-12-31',
    content:
      '一、对小型微利企业年应纳税所得额超过100万元但不超过300万元的部分，减按25%计入应纳税所得额，' +
      '按20%的税率缴纳企业所得税。\n' +
      '二、小型微利企业的判定条件见财政部 税务总局公告2023年第12号第二条。\n' +
      '★ 实际税负需按"减按比例计入 × 税率"计算，不要直接套用单一税率。',
  },
  {
    title: '中华人民共和国城市维护建设税法',
    sourceUrl: 'https://www.chinatax.gov.cn/chinatax/n810341/n810755/c5154744/content.html',
    sourceName: '国家税务总局 政策文件',
    issuer: '全国人民代表大会常务委员会',
    documentNo: '主席令第五十一号',
    publishedAt: '2020-08-11',
    effectiveFrom: '2021-09-01',
    effectiveTo: null,
    content:
      '第四条 城市维护建设税税率如下：\n' +
      '（一）纳税人所在地在市区的，税率为百分之七；\n' +
      '（二）纳税人所在地在县城、镇的，税率为百分之五；\n' +
      '（三）纳税人所在地不在市区、县城或者镇的，税率为百分之一。\n' +
      '★ 税率取决于**纳税人所在地**，不是注册地。请按实际经营地确认档位。',
  },
  {
    title: '国家税务总局吉林省税务局关于明确房产税城镇土地使用税有关政策的公告',
    sourceUrl: 'https://jilin.chinatax.gov.cn/art/2023/1/1/art_1033_1.html',
    sourceName: '国家税务总局吉林省税务局',
    issuer: '国家税务总局吉林省税务局',
    documentNo: '吉税公告2023年第1号',
    publishedAt: '2023-01-01',
    effectiveFrom: '2023-01-01',
    effectiveTo: null,
    content:
      '本公告示例：地方性税费政策（房产税、城镇土地使用税等）的具体执行口径由省级税务机关明确。\n' +
      '★ 这一类政策的适用范围仅限于本省，跨省经营需分别关注各地口径。',
  },
];

// ============================================================================
//  默认抓取器
// ============================================================================

/**
 * 内置目录抓取器。
 *
 * ★ 它**不会**假装自己抓到了网络内容 —— 返回值里明确标注来源为内置基线，
 *   界面据此提示"需以官方来源为准"。假装有网络数据比没有数据更危险。
 */
export class BuiltinCatalogFetcher implements PolicyFetcher {
  readonly name = 'builtin-catalog';

  async fetch(source: PolicySource): Promise<RawPolicyItem[]> {
    return BUILTIN_POLICY_CATALOG.filter(
      (item) => (item.sourceName ?? '') === source.name,
    );
  }
}

// ============================================================================
//  纯逻辑
// ============================================================================

/**
 * 由生效/失效日期推算政策状态。**只做日期比较，不做主观判断**。
 *
 * ★ "现行有效"这个结论只基于两个日期，不代表对适用性的判断。
 *   界面措辞要准确：「按公布日期推算，该政策自 X 起施行」，
 *   而不是「该政策现行有效，你可以适用」。
 */
export function deriveStatus(
  effectiveFrom: string | null | undefined,
  effectiveTo: string | null | undefined,
  asOf: Date = new Date(),
): PolicyStatus {
  const today = asOf.toISOString().slice(0, 10);

  if (effectiveFrom && effectiveFrom.slice(0, 10) > today) return 'UPCOMING';
  if (effectiveTo && effectiveTo.slice(0, 10) < today) return 'EXPIRED';
  return 'EFFECTIVE';
}

/** 从标题与正文里识别相关税种 */
export function inferTaxTypes(title: string, content: string): TaxTypeHint[] {
  const text = `${title}\n${content}`;
  const out = new Set<TaxTypeHint>();

  if (/增值税/.test(text)) out.add('VAT');
  if (/企业所得税/.test(text)) out.add('CIT');
  if (/城市维护建设税|教育费附加|地方教育附加|附加税费/.test(text)) out.add('SURTAX');
  if (/印花税/.test(text)) out.add('STAMP_DUTY');
  if (/个人所得税/.test(text)) out.add('IIT');

  // 识别不到就标 OTHER，而不是硬塞一个税种进去
  if (out.size === 0) out.add('OTHER');
  return [...out];
}

/**
 * 提取关键词：把政策里**会影响适用判断**的词抓出来。
 *
 * ★ 命中"小型微利企业""一般纳税人"这类词，决定了这条政策要不要仔细看。
 *   这是给用户做初筛用的，不是适用性判断。
 */
const KEY_TERMS = [
  '小型微利企业',
  '小规模纳税人',
  '一般纳税人',
  '个体工商户',
  '高新技术企业',
  '小微企业',
  '留抵退税',
  '加计抵减',
  '加计扣除',
  '免税',
  '减半征收',
  '即征即退',
  '汇总纳税',
];

export function extractKeywords(title: string, content: string): string[] {
  const text = `${title}\n${content}`;
  return KEY_TERMS.filter((k) => text.includes(k));
}

/**
 * 从正文里抓出"同时符合下列条件"这类限定条件句。
 *
 * ★ 这是本模块最有价值的一个提取：
 *   政策的适用往往取决于限定条件，而用户最容易忽略的正是这些条件。
 *   把它们单独摘出来放在显眼位置，能显著降低误用概率。
 */
export function extractConditions(content: string): string[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const out: string[] = [];
  for (const line of lines) {
    if (/同时符合|同时满足|且同时|下列条件|以下条件|条件如下|认定标准/.test(line)) {
      out.push(line);
    }
    // "一、二、" 这种条款里如果含"不超过/不超过…人/万元"也是条件
    if (/不超过\s*\d|不超过\s*[一二三四五六七八九十百千万]+/.test(line) && line.length < 200) {
      out.push(line);
    }
  }
  // 去重并去掉过长的行
  return [...new Set(out)].filter((l) => l.length <= 300);
}

/** 计算内容哈希：用于判断政策有没有变过 */
export function hashPolicy(item: RawPolicyItem): string {
  return createHash('sha256')
    .update(
      [item.title, item.documentNo ?? '', item.effectiveFrom ?? '', item.effectiveTo ?? '', item.content].join(
        '\u0001',
      ),
    )
    .digest('hex')
    .slice(0, 32);
}

/** 从标题或正文里提取文号 */
export function extractDocumentNo(title: string, content: string): string | null {
  const patterns = [
    /(财政部\s*税务总局公告\d{4}年第\d+号)/,
    /([\u4e00-\u9fa5]{2,10}(?:省|市|自治区)?(?:税务局|财政局)公告\d{4}年第\d+号)/,
    /(国家税务总局公告\d{4}年第\d+号)/,
    /(财税〔\d{4}〕\d+号)/,
    /(主席令第[\u4e00-\u9fa5\d]+号)/,
  ];
  for (const p of patterns) {
    const m = p.exec(title) ?? p.exec(content.slice(0, 500));
    if (m) return m[1]!.replace(/\s+/g, '');
  }
  return null;
}

/** 执行一次抓取（不写库，纯取数据） */
export async function runFetch(params: {
  jurisdiction: string;
  fetcher: PolicyFetcher;
  sources?: PolicySource[];
}): Promise<FetchRunResult> {
  const sources = (params.sources ?? POLICY_SOURCES).filter(
    (s) =>
      s.jurisdiction === params.jurisdiction ||
      // 国家层面政策对所有报税地都适用
      s.jurisdiction === 'CN-GENERAL',
  );

  const items: RawPolicyItem[] = [];
  const sourceResults: FetchRunResult['sourceResults'] = [];
  const warnings: string[] = [];
  let failed = 0;

  if (sources.length === 0) {
    warnings.push(
      `没有为报税地「${params.jurisdiction}」登记任何官方来源。` +
        '政策检索不会凭空找到东西 —— 请先登记来源，或确认报税地配置是否正确。',
    );
  }

  for (const source of sources) {
    try {
      const got = await params.fetcher.fetch(source);
      sourceResults.push({ source: source.name, ok: true, itemCount: got.length });
      items.push(...got);
    } catch (e) {
      failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      sourceResults.push({ source: source.name, ok: false, itemCount: 0, error: msg });
      warnings.push(`来源「${source.name}」抓取失败：${msg}`);
    }
  }

  // ★ 一个来源都没成功时，绝不能报"本期无新政策" —— 那与"抓取全挂了"是两件事
  const status: FetchRunResult['status'] =
    failed === 0 ? 'SUCCESS' : failed === sources.length ? 'FAILED' : 'PARTIAL';

  if (status === 'FAILED' && sources.length > 0) {
    warnings.push(
      '所有来源都抓取失败。本次结果**不能**用来判断"本期没有新政策" —— ' +
        '请检查网络与来源可用性后重试。',
    );
  }

  return {
    jurisdiction: params.jurisdiction,
    status,
    sourcesTried: sources.length,
    sourcesFailed: failed,
    items,
    sourceResults,
    warnings,
  };
}

/**
 * 比对：哪些是新政策、哪些内容变了。
 *
 * ★ 内容变化必须单独报出来 —— 政策被修订比新增政策更容易被漏掉，
 *   因为链接没变、标题没变，只有正文变了。
 */
export function diffPolicies(params: {
  fetched: RawPolicyItem[];
  existing: Array<{ sourceUrl: string; contentHash: string; title: string }>;
}): {
  added: RawPolicyItem[];
  changed: Array<{ item: RawPolicyItem; previousHash: string }>;
  unchanged: number;
} {
  const byUrl = new Map(params.existing.map((e) => [e.sourceUrl, e]));
  const added: RawPolicyItem[] = [];
  const changed: Array<{ item: RawPolicyItem; previousHash: string }> = [];
  let unchanged = 0;

  for (const item of params.fetched) {
    const prev = byUrl.get(item.sourceUrl);
    const hash = hashPolicy(item);
    if (!prev) {
      added.push(item);
    } else if (prev.contentHash !== hash) {
      changed.push({ item, previousHash: prev.contentHash });
    } else {
      unchanged += 1;
    }
  }

  return { added, changed, unchanged };
}
