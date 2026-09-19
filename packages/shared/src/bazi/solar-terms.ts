/**
 * 真太阳时（天文计算）
 * ============================================================
 * 真太阳时是**天文**问题，有确定的物理定义，所以能算到分钟级、
 * 不需要查表，也没有流派争议。节气计算另见 solar-longitude.ts。
 *
 *   真太阳时 = 钟表时间 + 经度时差 + 均时差 − 夏令时补偿
 *
 * 八字里用它把出生地的钟表时间换算成当地真太阳时，再定时辰。
 */

// ============================================================================
//  均时差
// ============================================================================

/**
 * 均时差（Equation of Time），单位：分钟。
 *
 * 真太阳时 = 平太阳时 + 均时差。
 * 一年之内这个差值在 −14 分到 +16 分之间摆动，最大能跨过半个时辰。
 *
 * 用 NOAA 的简化式，精度约 ±0.5 分钟 —— 对定时辰远远够用。
 */
export function equationOfTime(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86400000);

  // 分数年（简化按 365.25 天）
  const gamma = ((2 * Math.PI) / 365.25) * (dayOfYear - 1 + (date.getUTCHours() - 12) / 24);

  return (
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma))
  );
}

// ============================================================================
//  真太阳时
// ============================================================================

export interface TrueSolarTimeInput {
  /** 出生地经度（东经为正） */
  longitude: number;
  /** 出生地纬度（北纬为正）。均时差与纬度无关，保留以便后续扩展 */
  latitude?: number;
  /** 记录时间所属时区的标准经线。中国一律 120（北京时间） */
  standardMeridian?: number;
  /** 夏令时补偿（分钟）。中国 1986-1991 年实行过，需减回 60 分钟 */
  daylightSavingMinutes?: number;
}

export interface TrueSolarTimeResult {
  /** 钟表时间 */
  clockTime: Date;
  /** 真太阳时 */
  trueSolarTime: Date;
  /** 经度时差（分钟） */
  longitudeCorrectionMinutes: number;
  /** 均时差（分钟） */
  equationOfTimeMinutes: number;
  /** 夏令时补偿（分钟） */
  daylightSavingMinutes: number;
  /** 合计修正（分钟） */
  totalCorrectionMinutes: number;
  /** 供界面展示的说明 —— 必须把三步修正分别列出来，不能只给结果 */
  explanation: string;
}

/**
 * 计算真太阳时。
 *
 * 三步修正（每一步都单独返回，便于界面展示与人工核对）：
 *
 *   ① **经度时差**：北京时间以东经 120° 为准。出生地每偏东 1 度，
 *      当地真太阳时就比钟表时间早 4 分钟。吉林（约 126.6°E）偏东 6.6 度，
 *      真太阳时比钟表时间**早约 26 分钟**。
 *   ② **均时差**：地球轨道是椭圆且存在黄赤交角，真太阳日长短不均，
 *      一年内 ±15 分钟摆动。1 月下旬约 −13 分钟。
 *   ③ **夏令时**：中国 1986-1991 年夏季实行过夏令时，
 *      那段时间的钟表时间要减 1 小时才是标准时。
 */
export function trueSolarTime(
  clockTime: Date,
  input: TrueSolarTimeInput,
): TrueSolarTimeResult {
  const standardMeridian = input.standardMeridian ?? 120;
  const dst = input.daylightSavingMinutes ?? 0;

  // ① 经度修正：4 分钟 / 度
  const longitudeCorrection = (input.longitude - standardMeridian) * 4;

  // ② 均时差：用「还原掉夏令时之后」的标准时去算，避免差一天
  const standardTime = new Date(clockTime.getTime() - dst * 60000);
  const eot = equationOfTime(standardTime);

  const total = longitudeCorrection + eot - dst;
  const trueTime = new Date(clockTime.getTime() + total * 60000);

  const fmt = (min: number) => `${min >= 0 ? '+' : ''}${min.toFixed(1)} 分`;
  const explanation =
    `钟表时间 ${formatDateTime(clockTime)} → 真太阳时 ${formatDateTime(trueTime)}。` +
    `合计修正 ${fmt(total)}：` +
    `经度时差 ${fmt(longitudeCorrection)}` +
    `（出生地 ${input.longitude.toFixed(2)}°E 相对标准经线 ${standardMeridian}°E，每度 4 分钟）` +
    `、均时差 ${fmt(eot)}` +
    (dst !== 0 ? `、夏令时补偿 ${fmt(-dst)}` : '') +
    '。';

  return {
    clockTime,
    trueSolarTime: trueTime,
    longitudeCorrectionMinutes: round1(longitudeCorrection),
    equationOfTimeMinutes: round1(eot),
    daylightSavingMinutes: dst,
    totalCorrectionMinutes: round1(total),
    explanation,
  };
}

// ============================================================================
//  中国夏令时
// ============================================================================

/**
 * 中国大陆夏令时区间（1986-1991）。
 *
 * ★ 很多人不知道这段历史，用它记录出生时间的人会把时间记早 1 小时 ——
 *   而那正好可能跨过一个时辰。这是一段真实存在且容易被忽略的坑，
 *   所以宁可多花几十行把它列全。
 *
 * 起止日期来自国务院公告。1986 年起始较晚（5 月 4 日），其余年份为 4 月中旬。
 */
const CHINA_DST_PERIODS: Array<{ from: string; to: string }> = [
  { from: '1986-05-04', to: '1986-09-14' },
  { from: '1987-04-12', to: '1987-09-13' },
  { from: '1988-04-10', to: '1988-09-11' },
  { from: '1989-04-16', to: '1989-09-17' },
  { from: '1990-04-15', to: '1990-09-16' },
  { from: '1991-04-14', to: '1991-09-15' },
];

/** 判断某个时刻是否落在中国夏令时区间内 */
export function isChinaDaylightSaving(date: Date): boolean {
  const day = date.toISOString().slice(0, 10);
  return CHINA_DST_PERIODS.some((p) => day >= p.from && day <= p.to);
}

/** 自动推断夏令时补偿（分钟）。非中国时区一律返回 0 */
export function inferDaylightSaving(date: Date, timezone: 'CN' | 'NONE' = 'CN'): number {
  if (timezone !== 'CN') return 0;
  return isChinaDaylightSaving(date) ? 60 : 0;
}

/** 全部夏令时区间（供界面提示用） */
export function chinaDaylightSavingPeriods(): Array<{ from: string; to: string }> {
  return [...CHINA_DST_PERIODS];
}

// ============================================================================

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}
