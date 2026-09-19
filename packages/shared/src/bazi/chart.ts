/**
 * 四柱八字推算
 * ============================================================
 * 这个文件里**唯一有流派争议**的地方是「子时日界」，它被显式做成一个选项，
 * 而不是悄悄选一个。其余部分（年柱以立春为界、月柱以节为界、日柱用儒略日、
 * 时柱用五鼠遁）都是确定算法，没有分歧空间。
 *
 * 为什么要把争议点做成选项而不是替用户决定：
 *   同一个出生时刻，两种口径会得出**不同的日柱与时柱**，
 *   而喜用结论可能有差异。用户如果不知道自己用的是哪一派，
 *   就无法判断结果为什么和别处算的不一样。
 *   所以：默认给一个（日在子正，与主流黄历一致），
 *   同时把另一种口径的结果也算出来并展示差异。
 *
 * 两派完整文献出处见 docs/八字推算-口径与依据.md。
 */
import {
  type EarthlyBranch,
  type ElementCount,
  type FiveElement,
  type HeavenlyStem,
  type Pillar,
  type TenGod,
  EARTHLY_BRANCHES,
  HEAVENLY_STEMS,
  branchElement,
  countElements,
  hiddenStems,
  makePillar,
  pillarFromCycleIndex,
  stemElement,
  tenGod,
} from './sexagenary';
import { solarTermMoment } from './solar-longitude';
import { inferDaylightSaving, trueSolarTime, type TrueSolarTimeResult } from './solar-terms';

// ============================================================================
//  输入
// ============================================================================

export interface BirthInput {
  /**
   * 历法。'SOLAR' 公历 / 'LUNAR' 农历。
   * ★ 农历输入必须先转成公历再推算 —— 八字完全建立在**节气**（太阳位置）上，
   *   与农历（月相）无关。把农历日期直接当公历用是最常见的错误。
   */
  calendar: 'SOLAR' | 'LUNAR';
  year: number;
  month: number;
  day: number;
  /** 农历闰月标记（仅 calendar = LUNAR 时有意义） */
  isLeapMonth?: boolean;

  hour: number;
  minute: number;

  /**
   * 出生地经度（东经为正）。真太阳时修正必须用它。
   * 不填则不做经度修正 —— 但会在结果里警示。
   */
  longitude?: number;
  latitude?: number;
  /** 出生地名称（仅作展示） */
  placeName?: string;

  /**
   * 子时日界口径。这是**唯一**会让四柱整体不同的选择，所以做成显式选项。
   *
   * 'MIDNIGHT'（默认）—— 日在**子正**（00:00），子时本身不分早晚定时柱。
   *   依据：《新唐书·历表》「古历分日，起于子半」；
   *        《渊海子平·论十二生肖》「上四刻乃昨夜之阴，下四刻今日之阳」；
   *        《星平大成》「上半时在夜半前属昨日，下半时在夜半后属今日」。
   *   主流黄历即用此口径。
   *
   * 'ZI_START' —— 日在**子初**（23:00），23:00 起即进次日。
   *   依据：韦千里《千里命稿》主张命理取时辰「以气论」，子时固一气不分早晚；
   *        早/晚子时之说最早见于民国袁树珊《命理探原》，是引入 24 小时制后的修正，
   *        经典古书中无用于论命的记载。
   */
  ziHourRule?: 'MIDNIGHT' | 'ZI_START';

  /** 是否使用真太阳时。默认 true */
  useTrueSolarTime?: boolean;
}

export interface PillarWithMeta extends Pillar {
  /** 天干五行 */
  stemElement: FiveElement;
  /** 地支五行 */
  branchElement: FiveElement;
  /** 地支藏干 */
  hidden: HeavenlyStem[];
  /** 天干十神（日柱本身不标） */
  tenGod?: TenGod;
}

export interface BoundaryWarning {
  kind: 'SOLAR_TERM' | 'SHICHEN' | 'DAY';
  message: string;
  /** 距边界的分钟数 */
  minutesToBoundary: number;
}

export interface BaziChart {
  /** 规范化后的公历出生时刻（钟表时间） */
  solarDateTime: string;
  /** 农历表示（供展示） */
  lunarText: string;
  /** 真太阳时修正详情 */
  trueSolar: TrueSolarTimeResult | null;
  /** 实际用于定时辰的时刻 */
  effectiveDateTime: string;

  yearPillar: PillarWithMeta;
  monthPillar: PillarWithMeta;
  dayPillar: PillarWithMeta;
  hourPillar: PillarWithMeta;

  /** 日主（日干） */
  dayMaster: HeavenlyStem;
  dayMasterElement: FiveElement;

  /** 八字五行统计（只数本气） */
  elementCount: ElementCount;
  /** 含藏干的加权统计（参考值，不是命理定论） */
  elementWeighted: Record<FiveElement, number>;

  /** 出生时所属的节气区间 */
  currentTerm: { term: string; since: string };
  /** 下一个节气 */
  nextTerm: { term: string; at: string };

  /** 边界警示：出生时间离节气或时辰边界很近，结果可能翻转 */
  boundaryWarnings: BoundaryWarning[];

  /** 另一种子时日界口径的结果（用于对比展示） */
  alternativeZiHour: {
    rule: 'MIDNIGHT' | 'ZI_START';
    ruleLabel: string;
    dayPillar: string;
    hourPillar: string;
    note: string;
  };

  /** 推算口径说明，必须随结果一起展示 */
  methodology: string[];
}

// ============================================================================
//  十二节 → 月支
// ============================================================================

/** 寅月起于立春，卯月起于惊蛰，依此类推；丑月起于小寒 */
const TERM_TO_MONTH: Array<{ term: string; branch: EarthlyBranch; monthNo: number }> = [
  { term: '立春', branch: '寅', monthNo: 1 },
  { term: '惊蛰', branch: '卯', monthNo: 2 },
  { term: '清明', branch: '辰', monthNo: 3 },
  { term: '立夏', branch: '巳', monthNo: 4 },
  { term: '芒种', branch: '午', monthNo: 5 },
  { term: '小暑', branch: '未', monthNo: 6 },
  { term: '立秋', branch: '申', monthNo: 7 },
  { term: '白露', branch: '酉', monthNo: 8 },
  { term: '寒露', branch: '戌', monthNo: 9 },
  { term: '立冬', branch: '亥', monthNo: 10 },
  { term: '大雪', branch: '子', monthNo: 11 },
  { term: '小寒', branch: '丑', monthNo: 12 },
];

// ============================================================================
//  主函数
// ============================================================================

/**
 * 由公历时刻推算四柱。
 *
 * ① 真太阳时修正（可选）
 * ② 年柱：以**立春时刻**为界（不是日期）
 * ③ 月柱：以**十二节**为界（不是农历初一）
 * ④ 日柱：儒略日公式，子时日界规则在此生效
 * ⑤ 时柱：五鼠遁，按真太阳时的时辰定位
 */
export function computeChart(input: BirthInput): BaziChart {
  const methodology: string[] = [];
  const boundaryWarnings: BoundaryWarning[] = [];

  // ── ① 公历出生时刻（钟表时间） ──
  const clockTime = new Date(
    Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute),
  );
  if (Number.isNaN(clockTime.getTime())) {
    throw new Error(
      `出生日期时间无法解析：${input.year}-${input.month}-${input.day} ${input.hour}:${input.minute}`,
    );
  }

  // ── ② 真太阳时 ──
  const useTst = input.useTrueSolarTime !== false;
  let trueSolar: TrueSolarTimeResult | null = null;
  let effective = clockTime;

  if (useTst && typeof input.longitude === 'number') {
    const dst = inferDaylightSaving(clockTime, 'CN');
    trueSolar = trueSolarTime(clockTime, {
      longitude: input.longitude,
      latitude: input.latitude,
      daylightSavingMinutes: dst,
    });
    effective = trueSolar.trueSolarTime;
    methodology.push(`真太阳时：${trueSolar.explanation}`);

    if (dst !== 0) {
      methodology.push(
        '★ 出生时间落在中国夏令时区间（1986-1991），钟表时间已按 -60 分钟还原为标准时。' +
          '这段历史容易被忽略，若出生证明上的时间未标注夏令时，可能整体偏早 1 小时。',
      );
    }
  } else if (useTst) {
    methodology.push(
      '⚠ 未提供出生地经度，**未做真太阳时修正**，直接用钟表时间定时辰。' +
        '经度每偏离东经 120° 一度就差 4 分钟，中国西部可达 1 小时以上，足以跨过一个时辰。' +
        '建议补上出生地。',
    );
  }

  // ── ③ 年柱：以立春时刻为界 ──
  const lichunThisYear = solarTermMoment(input.year, '立春');
  const beforeLichun = effective.getTime() < lichunThisYear.getTime();
  const yearForPillar = beforeLichun ? input.year - 1 : input.year;
  const lichunOfPillarYear =
    yearForPillar === input.year ? lichunThisYear : solarTermMoment(yearForPillar, '立春');

  // 年干支：1984 年为甲子年（序号 0）
  const yearCycleIndex = (((yearForPillar - 1984) % 60) + 60) % 60;
  const yearPillarBase = pillarFromCycleIndex(yearCycleIndex);

  methodology.push(
    `年柱以**立春**为界：${yearForPillar} 年立春在 ${fmt(lichunOfPillarYear)}（北京时间），` +
      `出生时刻在其${beforeLichun ? '前，年柱仍属上一年' : '后'}，故年柱取 ${yearPillarBase.name}。` +
      '★ 年柱不以正月初一为界 —— 春节前后出生的人最容易在这里错。',
  );

  const toLichun = Math.abs(effective.getTime() - lichunThisYear.getTime()) / 60000;
  if (toLichun <= 720) {
    boundaryWarnings.push({
      kind: 'SOLAR_TERM',
      minutesToBoundary: Math.round(toLichun),
      message:
        `出生时刻距 ${input.year} 年立春仅 ${Math.round(toLichun)} 分钟。` +
        '节气时刻的计算误差在分钟级，且真太阳时修正也会影响判定 —— ' +
        '**年柱与月柱都可能在边界上翻转**，建议核对出生证明的准确时间。',
    });
  }

  // ── ④ 月柱 ──
  const monthInfo = resolveMonthPillar(effective, yearPillarBase.stem);
  methodology.push(
    `月柱以**十二节**为界（不是农历初一）：当前处于「${monthInfo.termName}」之后，` +
      `故为 ${monthInfo.branch} 月；月干用五虎遁由年干 ${yearPillarBase.stem} 推出 → ` +
      `${monthInfo.pillar.name}。`,
  );

  if (monthInfo.minutesToNextTerm <= 720) {
    boundaryWarnings.push({
      kind: 'SOLAR_TERM',
      minutesToBoundary: Math.round(monthInfo.minutesToNextTerm),
      message:
        `出生时刻距下一个节气「${monthInfo.nextTermName}」仅 ` +
        `${Math.round(monthInfo.minutesToNextTerm)} 分钟，**月柱可能在边界上翻转**。`,
    });
  }

  // ── ⑤ 日柱 ──
  const ziRule: 'MIDNIGHT' | 'ZI_START' = input.ziHourRule ?? 'MIDNIGHT';
  const dayInfo = resolveDayPillar(effective, ziRule);

  const ziRuleText =
    ziRule === 'MIDNIGHT'
      ? '日在子正（00:00 换日，23:00-23:59 的晚子时仍属当日）'
      : '日在子初（23:00 起即进次日）';

  methodology.push(
    `日柱用儒略日推算（${fmtDate(effective)} 的 JDN = ${dayInfo.jdn}），得 ${dayInfo.pillar.name}。` +
      `子时日界口径：${ziRuleText}。`,
  );

  if (dayInfo.minutesToZiHour <= 60) {
    boundaryWarnings.push({
      kind: 'SHICHEN',
      minutesToBoundary: Math.round(dayInfo.minutesToZiHour),
      message:
        '出生时刻接近子时边界。子时是**唯一跨日的时辰**，' +
        '两种日界口径会给出不同的日柱与时柱，本结果已同时列出两种供对比。',
    });
  }

  // ── ⑥ 时柱 ──
  const hourInfo = resolveHourPillar(effective, dayInfo.pillar.stem);
  methodology.push(
    `时柱：真太阳时 ${fmtTime(effective)} 属${hourInfo.branchLabel}；` +
      `时干用五鼠遁由日干 ${dayInfo.pillar.stem} 推出 → ${hourInfo.pillar.name}。`,
  );

  if (hourInfo.minutesToShichenBoundary <= 30) {
    boundaryWarnings.push({
      kind: 'SHICHEN',
      minutesToBoundary: Math.round(hourInfo.minutesToShichenBoundary),
      message:
        `出生时刻距时辰边界仅 ${Math.round(hourInfo.minutesToShichenBoundary)} 分钟，` +
        '**时柱可能在边界上翻转**。真太阳时修正（可达 ±1 小时）在这里足以改变结果。',
    });
  }

  // ── ⑦ 另一种口径 ──
  const altRule: 'MIDNIGHT' | 'ZI_START' = ziRule === 'MIDNIGHT' ? 'ZI_START' : 'MIDNIGHT';
  const altDay = resolveDayPillar(effective, altRule);
  const altHour = resolveHourPillar(effective, altDay.pillar.stem);
  const altLabel =
    altRule === 'MIDNIGHT'
      ? '日在子正（00:00 换日，子时不分早晚）'
      : '日在子初（23:00 起即进次日）';

  // ── ⑧ 五行统计 ──
  const pillars = [yearPillarBase, monthInfo.pillar, dayInfo.pillar, hourInfo.pillar];
  const elementCount = countElements(pillars);
  const elementWeighted = weightedElements(pillars);

  return {
    solarDateTime: fmt(clockTime),
    lunarText: toLunarText(clockTime),
    trueSolar,
    effectiveDateTime: fmt(effective),
    yearPillar: withMeta(yearPillarBase, undefined),
    monthPillar: withMeta(monthInfo.pillar, tenGod(dayInfo.pillar.stem, monthInfo.pillar.stem)),
    dayPillar: withMeta(dayInfo.pillar, undefined),
    hourPillar: withMeta(hourInfo.pillar, tenGod(dayInfo.pillar.stem, hourInfo.pillar.stem)),
    dayMaster: dayInfo.pillar.stem,
    dayMasterElement: stemElement(dayInfo.pillar.stem),
    elementCount,
    elementWeighted,
    currentTerm: { term: monthInfo.termName, since: fmt(monthInfo.termAt) },
    nextTerm: { term: monthInfo.nextTermName, at: fmt(monthInfo.nextTermAt) },
    boundaryWarnings,
    alternativeZiHour: {
      rule: altRule,
      ruleLabel: altLabel,
      dayPillar: altDay.pillar.name,
      hourPillar: altHour.pillar.name,
      note:
        `若按「${altLabel}」的口径，日柱为 ${altDay.pillar.name}、时柱为 ${altHour.pillar.name}。` +
        '两种口径都能在古籍中找到出处（见 docs/八字推算-口径与依据.md）—— ' +
        '这是唯一会让四柱整体不同的选择，请确认你或你的命理师习惯用哪一种。',
    },
    methodology,
  };
}

// ============================================================================
//  月柱
// ============================================================================

interface MonthResolution {
  pillar: Pillar;
  branch: EarthlyBranch;
  termName: string;
  termAt: Date;
  nextTermName: string;
  nextTermAt: Date;
  minutesToNextTerm: number;
}

/**
 * 定位月柱。
 *
 * 做法：把出生年前后各一年的「十二节」全部排出来，找出生时刻落在哪两个节之间，
 * 起始那个节决定月支。这样跨年（12 月大雪之后到次年立春）自然覆盖，不需要特判。
 */
function resolveMonthPillar(when: Date, yearStem: HeavenlyStem): MonthResolution {
  const candidates: Array<{ term: string; branch: EarthlyBranch; monthNo: number; at: Date }> = [];

  for (const y of [when.getUTCFullYear() - 1, when.getUTCFullYear(), when.getUTCFullYear() + 1]) {
    for (const t of TERM_TO_MONTH) {
      candidates.push({
        term: t.term,
        branch: t.branch,
        monthNo: t.monthNo,
        // ★ 小寒落在次年 1 月，所以要查 y+1 年才能拿到「y 这一轮的」小寒。
        //   传错年份会让丑月整体偏一年 —— 实测踩过这个坑。
        at:
          t.term === '小寒'
            ? solarTermMoment(y + 1, '小寒')
            : solarTermMoment(y, t.term as never),
      });
    }
  }
  candidates.sort((a, b) => a.at.getTime() - b.at.getTime());

  const t = when.getTime();
  let current = candidates[0]!;
  let next = candidates[candidates.length - 1]!;
  for (let i = 0; i < candidates.length; i += 1) {
    if (candidates[i]!.at.getTime() <= t) {
      current = candidates[i]!;
      next = candidates[i + 1] ?? candidates[i]!;
    }
  }

  // 月干用五虎遁：甲己之年丙作首（寅月为丙寅）
  const yearStemIdx = HEAVENLY_STEMS.indexOf(yearStem);
  const yinMonthStemIdx = ((yearStemIdx % 5) * 2 + 2) % 10;
  // monthNo：寅=1 … 丑=12
  const stemIdx = (yinMonthStemIdx + current.monthNo - 1) % 10;
  const branchIdx = EARTHLY_BRANCHES.indexOf(current.branch);

  return {
    pillar: makePillar(stemIdx, branchIdx),
    branch: current.branch,
    termName: current.term,
    termAt: current.at,
    nextTermName: next.term,
    nextTermAt: next.at,
    minutesToNextTerm: (next.at.getTime() - t) / 60000,
  };
}

// ============================================================================
//  日柱
// ============================================================================

interface DayResolution {
  pillar: Pillar;
  jdn: number;
  minutesToZiHour: number;
}

/**
 * 定位日柱。
 *
 * 儒略日公式：JDN 每 +1 对应一天。
 * 锚点：1949-10-01 为甲子日（JDN 2433191），便于人工核对。
 * 已用三个日期交叉验证：1949-10-01 甲子、1985-01-27 丙寅、1985-01-28 丁卯。
 *
 * ★ 子时日界（唯一有争议之处，两派出处见 docs/八字推算-口径与依据.md）：
 *   'MIDNIGHT'：日在子正。23:00-23:59 是「晚子时」仍属当日，00:00 换日。
 *   'ZI_START'：日在子初。23:00 起即进次日。
 */
function resolveDayPillar(when: Date, rule: 'MIDNIGHT' | 'ZI_START'): DayResolution {
  const hour = when.getUTCHours();
  const minute = when.getUTCMinutes();

  // 距「日的分界」还有多少分钟，用于边界警示
  const minutesToZiHour =
    rule === 'MIDNIGHT'
      ? hour === 23
        ? 60 - minute
        : minute
      : hour === 23
        ? 60 - minute
        : 23 * 60 - (hour * 60 + minute);

  // 日柱是否推进一天：
  //   ZI_START：23:00 起即进次日
  //   MIDNIGHT：晚子时仍属当日；00:00 起已自然进入公历次日，无需推进
  const advance = rule === 'ZI_START' && hour === 23;

  const dayStart = new Date(
    Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()),
  );
  if (advance) dayStart.setUTCDate(dayStart.getUTCDate() + 1);

  const jdn = Math.floor(dayStart.getTime() / 86400000) + 2440588;
  const ANCHOR_JDN = 2433191; // JDN(1949-10-01) = 甲子日
  const cycleIndex = (((jdn - ANCHOR_JDN) % 60) + 60) % 60;

  return { pillar: pillarFromCycleIndex(cycleIndex), jdn, minutesToZiHour };
}

// ============================================================================
//  时柱
// ============================================================================

interface HourResolution {
  pillar: Pillar;
  branch: EarthlyBranch;
  branchLabel: string;
  minutesToShichenBoundary: number;
}

/**
 * 定位时柱。
 *
 * 时辰分界：子时 23:00-00:59、丑时 01:00-02:59、…（每两小时一个）。
 * ★ 子时**不再分早晚** —— 时干一律用日柱的日干，这就是韦千里所说的「以气论」。
 *   在这套口径下，23:15 与 00:30 的时柱相同（都属子时、同一时干），
 *   只有跨过日界时日柱才变，进而时干随之变。
 *
 * 时干用五鼠遁：甲己还加甲、乙庚丙作初、丙辛从戊起、丁壬庚子居、戊癸壬子是真途。
 */
function resolveHourPillar(when: Date, dayStem: HeavenlyStem): HourResolution {
  const hour = when.getUTCHours();
  const minute = when.getUTCMinutes();

  // 23:00-00:59 → 子(0)；01:00-02:59 → 丑(1)；…
  const branchIdx = Math.floor(((hour + 1) % 24) / 2);

  // 五鼠遁：子时天干索引 = (日干索引 % 5) * 2
  const zhiStemIdx = ((HEAVENLY_STEMS.indexOf(dayStem) % 5) * 2) % 10;
  const stemIdx = (zhiStemIdx + branchIdx) % 10;

  const minutesIntoShichen = ((hour + 1) % 2) * 60 + minute;
  const minutesToBoundary = Math.min(minutesIntoShichen, 120 - minutesIntoShichen);

  return {
    pillar: makePillar(stemIdx, branchIdx),
    branch: EARTHLY_BRANCHES[branchIdx]!,
    branchLabel: `${EARTHLY_BRANCHES[branchIdx]}时`,
    minutesToShichenBoundary: minutesToBoundary,
  };
}

// ============================================================================
//  辅助
// ============================================================================

function withMeta(pillar: Pillar, god: TenGod | undefined): PillarWithMeta {
  return {
    ...pillar,
    stemElement: stemElement(pillar.stem),
    branchElement: branchElement(pillar.branch),
    hidden: hiddenStems(pillar.branch),
    tenGod: god,
  };
}

/**
 * 含藏干的加权五行统计。
 *
 * 权重：天干 1、地支本气 1、中气 0.5、余气 0.3。
 * ★ 这只是**参考值**，不是命理定论 —— 月令、生克、合化都会改变实际力量。
 *   界面必须标明它是参考值，避免被当成结论。
 */
function weightedElements(pillars: Pillar[]): Record<FiveElement, number> {
  const out: Record<FiveElement, number> = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  const hiddenWeight = [1, 0.5, 0.3];

  for (const p of pillars) {
    out[stemElement(p.stem)] += 1;
    const hidden = hiddenStems(p.branch);
    hidden.forEach((s, i) => {
      out[stemElement(s)] += hiddenWeight[i] ?? 0.3;
    });
  }

  for (const k of Object.keys(out) as FiveElement[]) {
    out[k] = Math.round(out[k] * 100) / 100;
  }
  return out;
}

/**
 * 公历 → 农历文本。
 *
 * 用运行环境内置的中国农历（`Intl` 的 `zh-CN-u-ca-chinese`）——
 * Node 与浏览器都原生支持，含闰月标注。
 * 这比自己维护一张农历表可靠得多：没有数据表就没有「表过期」的问题。
 */
export function toLunarText(solar: Date): string {
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return fmt.format(solar);
  } catch {
    return '（当前环境不支持农历换算）';
  }
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

function fmtDate(d: Date): string {
  return fmt(d).slice(0, 10);
}

function fmtTime(d: Date): string {
  return fmt(d).slice(11);
}

export { branchElement, stemElement };
