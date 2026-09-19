/**
 * 干支基础（天干地支 / 六十甲子 / 五行）
 * ============================================================
 * 纯查表与取模，没有任何"经验判断"的空间 —— 干支推算出错只可能是算法错，
 * 不可能是流派差异，所以这一层必须是可单元测试的确定性代码。
 *
 * 唯一有流派差异的部分（子时是否换日）不在这里，在 chart.ts 里显式标注。
 */

/** 十天干 */
export const HEAVENLY_STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'] as const;
export type HeavenlyStem = (typeof HEAVENLY_STEMS)[number];

/** 十二地支 */
export const EARTHLY_BRANCHES = [
  '子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥',
] as const;
export type EarthlyBranch = (typeof EARTHLY_BRANCHES)[number];

/** 五行 */
export const ELEMENTS = ['木', '火', '土', '金', '水'] as const;
export type FiveElement = (typeof ELEMENTS)[number];

/** 天干配五行：甲乙木、丙丁火、戊己土、庚辛金、壬癸水 */
const STEM_ELEMENT: Record<HeavenlyStem, FiveElement> = {
  甲: '木', 乙: '木',
  丙: '火', 丁: '火',
  戊: '土', 己: '土',
  庚: '金', 辛: '金',
  壬: '水', 癸: '水',
};

/** 天干阴阳：甲丙戊庚壬为阳，乙丁己辛癸为阴 */
const STEM_YANG: Record<HeavenlyStem, boolean> = {
  甲: true, 乙: false, 丙: true, 丁: false, 戊: true,
  己: false, 庚: true, 辛: false, 壬: true, 癸: false,
};

/** 地支配五行与阴阳 */
const BRANCH_ELEMENT: Record<EarthlyBranch, FiveElement> = {
  子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火',
  午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水',
};

/** 地支藏干（本气 / 中气 / 余气）。用于五行强弱统计 —— 只看天干会严重低估地支的力量 */
const BRANCH_HIDDEN_STEMS: Record<EarthlyBranch, HeavenlyStem[]> = {
  子: ['癸'],
  丑: ['己', '癸', '辛'],
  寅: ['甲', '丙', '戊'],
  卯: ['乙'],
  辰: ['戊', '乙', '癸'],
  巳: ['丙', '庚', '戊'],
  午: ['丁', '己'],
  未: ['己', '丁', '乙'],
  申: ['庚', '壬', '戊'],
  酉: ['辛'],
  戌: ['戊', '辛', '丁'],
  亥: ['壬', '甲'],
};

export function stemElement(stem: HeavenlyStem): FiveElement {
  return STEM_ELEMENT[stem];
}

export function branchElement(branch: EarthlyBranch): FiveElement {
  return BRANCH_ELEMENT[branch];
}

export function isYangStem(stem: HeavenlyStem): boolean {
  return STEM_YANG[stem];
}

export function hiddenStems(branch: EarthlyBranch): HeavenlyStem[] {
  return BRANCH_HIDDEN_STEMS[branch];
}

/** 一个柱（干支各一） */
export interface Pillar {
  stem: HeavenlyStem;
  branch: EarthlyBranch;
  /** 组合名，如「甲子」 */
  name: string;
}

export function makePillar(stemIndex: number, branchIndex: number): Pillar {
  const stem = HEAVENLY_STEMS[((stemIndex % 10) + 10) % 10]!;
  const branch = EARTHLY_BRANCHES[((branchIndex % 12) + 12) % 12]!;
  return { stem, branch, name: `${stem}${branch}` };
}

/**
 * 六十甲子序号 → 柱。
 *
 * 序号 0 = 甲子，1 = 乙丑，…，59 = 癸亥。
 * 由于 10 与 12 的最小公倍数是 60，序号本身就同时编码了天干与地支：
 *   天干 = 序号 mod 10，地支 = 序号 mod 12
 * 这是六十甲子的基本性质，其他所有推算（年、日、时）都归结到这一个函数。
 */
export function pillarFromCycleIndex(index: number): Pillar {
  const i = ((index % 60) + 60) % 60;
  return makePillar(i % 10, i % 12);
}

/** 两个柱之间的距离（用于大运顺逆等推算） */
export function cycleIndex(pillar: Pillar): number {
  const s = HEAVENLY_STEMS.indexOf(pillar.stem);
  const b = EARTHLY_BRANCHES.indexOf(pillar.branch);
  // 解同余方程组：x ≡ s (mod 10)，x ≡ b (mod 12)，0 ≤ x < 60
  for (let x = 0; x < 60; x += 1) {
    if (x % 10 === s && x % 12 === b) return x;
  }
  /* istanbul ignore next —— 干支组合必然有解 */
  throw new Error(`不是合法的干支组合：${pillar.name}`);
}

export interface ElementCount {
  木: number;
  火: number;
  土: number;
  金: number;
  水: number;
}

/**
 * 统计八个字（四柱干支）的五行分布。
 *
 * ★ 只数天干地支的"本气"，不数藏干 —— 这是最常见的命理统计口径，
 *   也让结果可解释（用户能自己数出来对得上）。
 *   藏干力量另算（见 hiddenStems），不用来替代基本统计。
 */
export function countElements(pillars: Pillar[]): ElementCount {
  const count: ElementCount = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  for (const p of pillars) {
    count[stemElement(p.stem)] += 1;
    count[branchElement(p.branch)] += 1;
  }
  return count;
}

/** 十神：以日干为我，判断其他天干与我的关系 */
export const TEN_GODS = [
  '比肩', '劫财', '食神', '伤官', '偏财', '正财', '七杀', '正官', '偏印', '正印',
] as const;
export type TenGod = (typeof TEN_GODS)[number];

/**
 * 求某天干相对日干的十神。
 *
 * 规则：同五行同性为比肩、异性为劫财；我生者同性食神、异性伤官；
 * 我克者同性偏财、异性正财；克我者同性七杀、异性正官；生我者同性偏印、异性正印。
 *
 * 五行相生：木→火→土→金→水→木
 * 五行相克：木克土、土克水、水克火、火克金、金克木
 */
const GENERATES: Record<FiveElement, FiveElement> = {
  木: '火', 火: '土', 土: '金', 金: '水', 水: '木',
};
const OVERCOMES: Record<FiveElement, FiveElement> = {
  木: '土', 土: '水', 水: '火', 火: '金', 金: '木',
};

export function tenGod(dayStem: HeavenlyStem, other: HeavenlyStem): TenGod {
  const me = stemElement(dayStem);
  const it = stemElement(other);
  const samePolarity = isYangStem(dayStem) === isYangStem(other);

  if (me === it) return samePolarity ? '比肩' : '劫财';
  if (GENERATES[me] === it) return samePolarity ? '食神' : '伤官';
  if (OVERCOMES[me] === it) return samePolarity ? '偏财' : '正财';
  if (OVERCOMES[it] === me) return samePolarity ? '七杀' : '正官';
  if (GENERATES[it] === me) return samePolarity ? '偏印' : '正印';

  /* istanbul ignore next —— 五行两两之间必属上述五种关系之一 */
  throw new Error(`无法判定十神：日干 ${dayStem} 对 ${other}`);
}

/** 十二时辰名与对应的地支（子时跨日，见 chart.ts 的说明） */
export const SHICHEN_NAMES: Record<EarthlyBranch, string> = {
  子: '子时（23:00-00:59）',
  丑: '丑时（01:00-02:59）',
  寅: '寅时（03:00-04:59）',
  卯: '卯时（05:00-06:59）',
  辰: '辰时（07:00-08:59）',
  巳: '巳时（09:00-10:59）',
  午: '午时（11:00-12:59）',
  未: '未时（13:00-14:59）',
  申: '申时（15:00-16:59）',
  酉: '酉时（17:00-18:59）',
  戌: '戌时（19:00-20:59）',
  亥: '亥时（21:00-22:59）',
};
