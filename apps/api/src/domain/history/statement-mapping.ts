/**
 * 财务报表行项目 → 会计科目 的映射
 * ============================================================
 * 为什么需要这一层，以及为什么它必须"宁缺勿错"：
 *
 *   报表行项目名称在不同版本、不同代账软件之间差异很大：
 *     「货币资金」/「货币资金合计」/「一、货币资金」
 *     「存货」/「存货净额」/「存货（净额）」
 *   而合计数更危险：「流动资产合计」不能被映射到任何一个科目 ——
 *   它是一组科目的和，映射过去会让资产被重复确认。
 *
 *   所以本模块只做**点对点**的映射，并且：
 *
 *     ① 只映射"能唯一对应一个科目"的行项目，合计行、小计行一律跳过
 *     ② 匹配用**完整别名等值**（归一化后），不做模糊包含 ——
 *        "应收账款" 绝不能匹配到 "预收账款"，也不该匹配 "应收票据"
 *     ③ 同名多科目时（如"应交税费"可能是未交增值税或应交所得税）不猜，留给人工
 *
 *   映射不上不是失败：报表的原始行项目已经完整存档，
 *   映射只影响"能不能自动填入期初方案"，填不上就退回人工补录 ——
 *   这正是设计里对未知项的标准处理方式。
 */
import type { StatementItem } from './statement.model';

/** 映射结果：科目编码 → 余额（元） */
export interface DeclaredAccountBalances {
  /** 科目编码 → 期末余额（借方为正，贷方为正，靠 direction 区分） */
  balances: Map<string, { amount: string; label: string; direction: 'DEBIT' | 'CREDIT' }>;
  /** 成功映射的行项目数 */
  mappedCount: number;
  /** 跳过的行项目（合计行、未识别行），保留下来给人工看 */
  skipped: Array<{ label: string; reason: string }>;
}

/**
 * 别名表：报表行项目 → 科目。
 *
 * ★ 只收"点对点"的科目余额行。资产/负债/权益的合计行一个都不收。
 *   键是归一化后的行项目名（见 normalizeLabel）。
 */
const ITEM_TO_ACCOUNT: Record<string, { code: string; name: string; direction: 'DEBIT' | 'CREDIT' }> = {
  // ---------------------------------------------------------------- 流动资产
  货币资金: { code: '1002', name: '银行存款', direction: 'DEBIT' },
  库存现金: { code: '1001', name: '库存现金', direction: 'DEBIT' },
  银行存款: { code: '1002', name: '银行存款', direction: 'DEBIT' },
  // 应收票据：小企业会计准则用 1121
  应收票据: { code: '1121', name: '应收票据', direction: 'DEBIT' },
  应收账款: { code: '1122', name: '应收账款', direction: 'DEBIT' },
  预付款项: { code: '1123', name: '预付账款', direction: 'DEBIT' },
  预付账款: { code: '1123', name: '预付账款', direction: 'DEBIT' },
  其他应收款: { code: '1221', name: '其他应收款', direction: 'DEBIT' },
  存货: { code: '1403', name: '原材料', direction: 'DEBIT' },

  // ---------------------------------------------------------------- 非流动资产
  固定资产原价: { code: '1601', name: '固定资产', direction: 'DEBIT' },
  固定资产: { code: '1601', name: '固定资产', direction: 'DEBIT' },
  累计折旧: { code: '1602', name: '累计折旧', direction: 'CREDIT' },
  固定资产减值准备: { code: '1603', name: '固定资产减值准备', direction: 'CREDIT' },
  无形资产: { code: '1701', name: '无形资产', direction: 'DEBIT' },
  长期待摊费用: { code: '1801', name: '长期待摊费用', direction: 'DEBIT' },

  // ---------------------------------------------------------------- 流动负债
  短期借款: { code: '2001', name: '短期借款', direction: 'CREDIT' },
  应付票据: { code: '2201', name: '应付票据', direction: 'CREDIT' },
  应付账款: { code: '2202', name: '应付账款', direction: 'CREDIT' },
  预收款项: { code: '2203', name: '预收账款', direction: 'CREDIT' },
  预收账款: { code: '2203', name: '预收账款', direction: 'CREDIT' },
  应付职工薪酬: { code: '2211', name: '应付职工薪酬', direction: 'CREDIT' },
  应付利息: { code: '2231', name: '应付利息', direction: 'CREDIT' },
  其他应付款: { code: '2241', name: '其他应付款', direction: 'CREDIT' },

  // ---------------------------------------------------------------- 非流动负债
  长期借款: { code: '2501', name: '长期借款', direction: 'CREDIT' },
  长期应付款: { code: '2701', name: '长期应付款', direction: 'CREDIT' },

  // ---------------------------------------------------------------- 所有者权益
  实收资本: { code: '3001', name: '实收资本', direction: 'CREDIT' },
  股本: { code: '3001', name: '实收资本', direction: 'CREDIT' },
  资本公积: { code: '3002', name: '资本公积', direction: 'CREDIT' },
  盈余公积: { code: '3101', name: '盈余公积', direction: 'CREDIT' },
  未分配利润: { code: '3103', name: '本年利润', direction: 'CREDIT' },
};

/**
 * 「应交税费」是唯一需要拆分的行项目。
 *
 * 报表上只有一行「应交税费」，但它指向哪个明细科目完全取决于它是借方还是贷方：
 *   贷方余额 → 欠税务局的税（未交增值税 / 应交企业所得税）
 *   借方余额 → 多交或待抵扣
 * 这个判断不是"识别问题"而是"会计判断"，且没有唯一答案，
 * 所以这里**不猜**：拆不出来就让期初方案的税额直接取申报表（那里本来就准）。
 */
const AMBIGUOUS_ITEMS = new Set(['应交税费', '应交税金']);

/**
 * 明确不能映射的行项目特征：合计、小计、总计行。
 *
 * ★ 「减：」「加：」「其中：」**不是合计行**，只是报表的列示前缀：
 *     「减：累计折旧」指向的是"累计折旧"这个**独立的科目**（1602）；
 *     「加：营业外收入」指向的是"营业外收入"（6301）。
 *   把带这些前缀的行当合计行丢掉，会让累计折旧凭空消失 ——
 *   固定资产净值就虚高了整整一个折旧额。这是个会直接记错账的坑。
 *
 *   前缀在 normalizeLabel 里剥掉，这里只判断真正的合计。
 */
const TOTAL_PATTERNS = [/合计$/, /小计$/, /总计$/, /^其中[:：]/];

/**
 * 行项目名归一化。
 *
 * 报表里的名称常带序号前缀与括号注释：
 *   「一、货币资金」「（一）货币资金」「货币资金合计」「存货（净额）」
 * 全部剥掉后再做等值匹配 —— 注意是**剥掉**而不是模糊包含，
 * 因为包含匹配会让「应收账款」命中「预收账款」这类反向科目。
 */
export function normalizeLabel(label: string): string {
  let s = (label ?? '').trim();
  // 全角括号统一
  s = s.replace(/（/g, '(').replace(/）/g, ')');
  // 去掉序号前缀：一、 二、 (一) 1. 1、 等
  s = s.replace(/^[\(（]?[一二三四五六七八九十百]+[\)）]?[、.．,，]?\s*/, '');
  s = s.replace(/^[\(（]?\d+[\)）]?[、.．,，]?\s*/, '');
  // 去掉序号后缀（有些表把序号放后面）
  s = s.replace(/\s*[\(（]?[一二三四五六七八九十]+[\)）]$/, '');
  // ★ 去掉列示前缀「减：」「加：」「其中：」——它们是报表排版，不是科目名的一部分。
  //   「减：累计折旧」的科目就是「累计折旧」，方向由别名表决定（贷方）。
  s = s.replace(/^(减|加|其中|其中)[:：]/, '');
  // 括号注释：保留"固定资产原价"这类必要词，但去掉"（净额）""(元)"这类修饰
  s = s.replace(/[\(（](净额|净值为|元|万元|已抵减|损失准备)[\)）]/g, '');
  // 去掉尾部"合计/小计/总计"，让"货币资金合计"能命中"货币资金"
  s = s.replace(/(合计|小计|总计)$/, '');
  return s.replace(/\s/g, '');
}

/** 是否是明确的合计/小计行（必须在去后缀之前判断） */
function isTotalRow(rawLabel: string): boolean {
  const s = (rawLabel ?? '').trim().replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/\s/g, '');
  return TOTAL_PATTERNS.some((p) => p.test(s));
}

/**
 * 把资产负债表的行项目映射成科目余额。
 *
 * 只用**期末余额**（endBalance）：期初余额属于更早的期间，
 * 而期初建账要的是"启用前一日的余额"，也就是最后一期报表的期末数。
 */
export function mapBalanceSheetItems(items: StatementItem[]): DeclaredAccountBalances {
  const balances = new Map<
    string,
    { amount: string; label: string; direction: 'DEBIT' | 'CREDIT' }
  >();
  const skipped: Array<{ label: string; reason: string }> = [];

  for (const item of items) {
    const raw = (item.label ?? '').trim();
    if (raw === '') continue;

    const value = item.endBalance;
    if (value === null || value === undefined || String(value).trim() === '') {
      // 期末无数据的行直接忽略（报表里大量空行）
      continue;
    }

    if (isTotalRow(raw)) {
      skipped.push({ label: raw, reason: '合计/小计行 —— 映射过去会让资产被重复确认' });
      continue;
    }

    const key = normalizeLabel(raw);
    if (key === '') continue;

    if (AMBIGUOUS_ITEMS.has(key)) {
      skipped.push({
        label: raw,
        reason: '「应交税费」在报表上只有一行，无法确定是未交增值税还是应交所得税；期初税额以申报表为准',
      });
      continue;
    }

    const hit = ITEM_TO_ACCOUNT[key];
    if (!hit) {
      skipped.push({ label: raw, reason: '不在可映射别名表内（保留原始行项目，请人工补录）' });
      continue;
    }

    // ★ 同一科目被两行命中时**不能默默取一个**：
    //   「固定资产」与「固定资产原价」都指向 1601，若两行的金额不同，
    //   说明报表口径和我们理解的不一致，这时猜错会让固定资产凭空多一份。
    //   所以取先出现的那个（报表里更具体的明细行总在前），并把冲突显式列出。
    const existing = balances.get(hit.code);
    if (existing) {
      if (existing.amount !== String(value).trim()) {
        skipped.push({
          label: raw,
          reason:
            `与已采用的「${existing.label}」同为科目 ${hit.code}，但金额不同` +
            `（${String(value).trim()} vs ${existing.amount}）。` +
            `已保留先出现的「${existing.label}」，请人工核对该科目应有余额。`,
        });
      }
      continue;
    }

    balances.set(hit.code, {
      amount: String(value).trim(),
      label: raw,
      direction: hit.direction,
    });
  }

  return { balances, mappedCount: balances.size, skipped };
}

// ============================================================================
//  利润表 → 年度损益
// ============================================================================

export interface DeclaredIncomeStatement {
  /** 营业收入（利润表口径，含其他业务收入） */
  revenue: string | null;
  cost: string | null;
  profitBeforeTax: string | null;
  netProfit: string | null;
}

/** 从利润表抽取四个关键数（优先用合计行字段，缺失再按行项目兜底） */
export function readIncomeStatement(items: StatementItem[]): DeclaredIncomeStatement {
  const find = (patterns: RegExp[]): string | null => {
    for (const p of patterns) {
      const hit = items.find((it) => p.test(normalizeLabel(it.label ?? '')));
      if (hit && hit.endBalance !== null && String(hit.endBalance).trim() !== '') {
        return String(hit.endBalance).trim();
      }
    }
    return null;
  };

  return {
    revenue: find([/^营业收入$/, /^营业总收入$/, /^主营业务收入$/]),
    cost: find([/^营业成本$/, /^营业总成本$/, /^主营业务成本$/]),
    profitBeforeTax: find([/^利润总额$/, /^三利润总额$/]),
    netProfit: find([/^净利润$/, /^四净利润$/]),
  };
}
