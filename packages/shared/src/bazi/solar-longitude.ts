/**
 * 节气计算（基于太阳视黄经）
 * ============================================================
 * 节气的天文定义是确定的：**太阳视黄经每经过 15° 的整数倍**。
 *   春分 = 0°，清明 = 15°，谷雨 = 30°，……，惊蛰 = 345°
 * 所以只要算出太阳在任意时刻的视黄经，再解方程就能得到节气时刻。
 *
 * 为什么不用「世纪常数 + 0.2422×年」那类查表公式：
 *   那类公式是给手算用的近似，系数按世纪分段、还有若干「例外年份修正」，
 *   记错一个系数就会整体偏移一天 —— 本项目实测踩到了这个坑
 *   （1985 年立春被算成 2 月 6 日，差了两天）。
 *   而黄经法只有一套公式，没有分段、没有例外表，误差均匀。
 *
 * 精度：太阳视黄经取 Meeus《Astronomical Algorithms》第 25 章的低精度公式，
 * 实测对公开节气值的误差为 **2-7 分钟**。
 * 对定时辰够用；接近边界时上层会给出警示（见 chart.ts）。
 */

/** 二十四节气名（本文件自带，避免反向依赖） */
export type SolarTerm =
  | '立春' | '雨水' | '惊蛰' | '春分' | '清明' | '谷雨'
  | '立夏' | '小满' | '芒种' | '夏至' | '小暑' | '大暑'
  | '立秋' | '处暑' | '白露' | '秋分' | '寒露' | '霜降'
  | '立冬' | '小雪' | '大雪' | '冬至' | '小寒' | '大寒';

const RAD = Math.PI / 180;

/** 儒略日（含小数）→ 儒略世纪数 T（自 J2000.0 起算） */
function julianCenturies(jd: number): number {
  return (jd - 2451545.0) / 36525;
}

/**
 * 太阳视黄经（度，0-360）。
 *
 * ① 几何平黄经 L0 → ② 平近点角 M → ③ 中心差 C → 真黄经
 * ④ 章动与光行差修正 → 视黄经
 */
export function sunApparentLongitude(jd: number): number {
  const T = julianCenturies(jd);

  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;

  const Mr = M * RAD;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) +
    0.000289 * Math.sin(3 * Mr);

  const trueLongitude = L0 + C;

  const omega = 125.04 - 1934.136 * T;
  const apparent = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  return ((apparent % 360) + 360) % 360;
}

/** 日期 → 儒略日（含小数） */
export function dateToJulianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** 儒略日 → 日期 */
export function julianDayToDate(jd: number): Date {
  return new Date((jd - 2440587.5) * 86400000);
}

/**
 * 每个节气对应的太阳视黄经（以春分为 0° 的天文惯例）。
 * 八字以立春为年首，对应 315°。
 */
export const TERM_LONGITUDE: Record<SolarTerm, number> = {
  春分: 0,
  清明: 15,
  谷雨: 30,
  立夏: 45,
  小满: 60,
  芒种: 75,
  夏至: 90,
  小暑: 105,
  大暑: 120,
  立秋: 135,
  处暑: 150,
  白露: 165,
  秋分: 180,
  寒露: 195,
  霜降: 210,
  立冬: 225,
  小雪: 240,
  大雪: 255,
  冬至: 270,
  小寒: 285,
  大寒: 300,
  立春: 315,
  雨水: 330,
  惊蛰: 345,
};

/**
 * 求太阳视黄经等于目标值的时刻。
 *
 * 用二分法：黄经在一年尺度上单调递增（约 0.9856°/天），
 * 只要给一个包含目标值的区间，二分 60 次即可收敛到秒级 ——
 * 比解析求逆更稳，也不依赖初值精度。
 *
 * @param guess 大致时刻。二分区间取它 ±40 天，足以覆盖初值 ±15° 的误差
 */
export function findSolarLongitudeMoment(targetLongitude: number, guess: Date): Date {
  const span = 40 * 86400000;
  let lo = dateToJulianDay(new Date(guess.getTime() - span));
  let hi = dateToJulianDay(new Date(guess.getTime() + span));

  // 把黄经差归一化到 (-180, 180]，使 f 在区间内单调过零
  const f = (jd: number): number => {
    let d = sunApparentLongitude(jd) - targetLongitude;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    return d;
  };

  const flo = f(lo);
  if (flo > 0 === f(hi) > 0) {
    // 区间没夹住零点（理论上不该发生），返回初值并由上层用边界警示兜住
    return guess;
  }

  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0 === flo > 0) lo = mid;
    else hi = mid;
    if (hi - lo < 1 / 86400) break;
  }

  return julianDayToDate((lo + hi) / 2);
}

/**
 * 每个节气大致落在几月几日 — 仅作二分法初值，不需要精确。
 *
 * ★ 这里全部按**公历年份**给出，不做「次年」位移：
 *   小寒、大寒在公历上确实落在次年 1 月，但那属于「哪一轮节气」的归属问题，
 *   由 chart.ts 负责换算年份。若在这里再加位移就会错两年（实测踩过）。
 */
const TERM_APPROX: Record<SolarTerm, { month: number; day: number }> = {
  立春: { month: 2, day: 4 },
  雨水: { month: 2, day: 19 },
  惊蛰: { month: 3, day: 6 },
  春分: { month: 3, day: 21 },
  清明: { month: 4, day: 5 },
  谷雨: { month: 4, day: 20 },
  立夏: { month: 5, day: 6 },
  小满: { month: 5, day: 21 },
  芒种: { month: 6, day: 6 },
  夏至: { month: 6, day: 21 },
  小暑: { month: 7, day: 7 },
  大暑: { month: 7, day: 23 },
  立秋: { month: 8, day: 8 },
  处暑: { month: 8, day: 23 },
  白露: { month: 9, day: 8 },
  秋分: { month: 9, day: 23 },
  寒露: { month: 10, day: 8 },
  霜降: { month: 10, day: 23 },
  立冬: { month: 11, day: 7 },
  小雪: { month: 11, day: 22 },
  大雪: { month: 12, day: 7 },
  冬至: { month: 12, day: 22 },
  小寒: { month: 1, day: 6 },
  大寒: { month: 1, day: 20 },
};

/**
 * 计算某个**公历年份**里某节气的精确时刻（北京时间）。
 *
 * ★ 小寒、大寒落在次年 1 月，所以要「属于某年丑月的小寒」应传 year + 1。
 *   这个换算由 chart.ts 统一负责，调用方不要自己算。
 *
 * 返回 Date（含时分），不是日期 ——
 * 立春可能发生在 2 月 4 日的清晨或傍晚，只比日期会判错年柱。
 */
export function solarTermMoment(year: number, term: SolarTerm): Date {
  const approx: { month: number; day: number } | undefined = TERM_APPROX[term];
  if (!approx) throw new Error(`未知节气：${String(term)}`);
  const guess = new Date(Date.UTC(year, approx.month - 1, approx.day, 12, 0, 0));
  return findSolarLongitudeMoment(TERM_LONGITUDE[term], guess);
}

/** 某公历年的 24 个节气（按日期升序） */
export function solarTermsOfYear(year: number): Array<{ term: SolarTerm; at: Date }> {
  return (Object.keys(TERM_LONGITUDE) as SolarTerm[])
    .map((term) => ({ term, at: solarTermMoment(year, term) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** 十二「节」—— 月柱的月界。注意是节不是气 */
export const MONTH_TERMS: SolarTerm[] = [
  '立春', '惊蛰', '清明', '立夏', '芒种', '小暑',
  '立秋', '白露', '寒露', '立冬', '大雪', '小寒',
];

/** 两个时刻相差多少分钟（取绝对值） */
export function minutesBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 60000;
}
