/**
 * 定稿色板生成器 —— 低饱和 · 商用质感
 * ============================================================
 * ★ 2026-09 按**更正后的八字**重做：
 *   原先按「甲子日、日主甲木」推出火为用神，主色是低饱和赤陶。
 *   核对儒略日后日柱应为**丙寅**、日主是**丙火** —— 丙火生于丑月（腊月），
 *   天寒地冻非木不生，所以：
 *       木为用神（主色）／火为喜神（辅色）／土为闲神（点缀）／水金为忌神
 *   色板整体前移一格：木从点缀升为主色，火从主色降为辅色。
 *   CSS 变量名（--bk-fire-* / --bk-wood-*）**刻意不改** ——
 *   它们表达的是"这条色阶属于哪个五行"，这一点仍然成立；
 *   变的只是哪个五行当主色。详见 docs/主题配色-八字喜用.md。
 *
 * 设计原则（与高饱和旧板的根本区别）：
 *
 *   ① **骨架中性**：中性色取近真灰（饱和 2–7%），不带暖相。
 *      这是商用软件的关键 —— 界面主体必须是"无色的"，
 *      否则整屏泛棕/泛黄，立刻显得旧。
 *
 *   ② **颜色克制**：主色阶饱和 ≤ 30%、辅色 ≤ 26%、点缀 ≤ 20%。
 *      五行意象靠"色相"承载（木=松绿、火=赤陶、土=赭黄），
 *      而不是靠"饱和度"堆出来。低饱和的松绿依然是木。
 *
 *   ③ **可读性优先**：所有承载文字的色都过 WCAG AA（≥4.5:1）。
 *
 * 用法：node tools/build-palette.mjs
 */
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- 色彩工具
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const hsl = (h, s, l) =>
  '#' + hslToRgb(h, s, l).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

function lum(hex) {
  const h = hex.replace('#', '');
  const ch = [0, 1, 2].map((i) => {
    const c = parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const contrast = (a, b) =>
  Math.round(((Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)) * 100) / 100;

function sat(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 1, 2].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return 0;
  const s = l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  return Math.round(s * 1000) / 10;
}

/** 色相回读，用于校验"令牌名与真实色相是否一致" */
function hueOf(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 1, 2].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return null;
  const l = (max + min) / 2;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  if (s < 0.12) return null;
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return Math.round(hue < 0 ? hue + 360 : hue);
}

// ---------------------------------------------------------------- 定稿色板
// 色相（依五行）：木 156°（松绿）· 火 14°（赤陶）· 土 48°（赭黄）· 中性 240°（近真灰）
// 饱和度：主色（木）30% · 辅色（火）24% · 点缀（土）20% · 中性 3–6%
const HUE = { wood: 156, fire: 14, earth: 48, neutral: 240 };
const PALETTE = {
  // ── 木 · 主色（用神）：色相 156°，饱和 26–30% ──
  wood50: hsl(HUE.wood, 30, 97),
  wood100: hsl(HUE.wood, 28, 94),
  wood200: hsl(HUE.wood, 26, 86),
  wood300: hsl(HUE.wood, 25, 71),
  wood400: hsl(HUE.wood, 26, 50),
  wood500: hsl(HUE.wood, 30, 31), // 主色
  wood600: hsl(HUE.wood, 30, 25),
  wood700: hsl(HUE.wood, 29, 19),

  // ── 火 · 辅色（喜神）：色相 14°，饱和 20–24% ──
  fire50: hsl(HUE.fire, 26, 97),
  fire100: hsl(HUE.fire, 25, 94),
  fire200: hsl(HUE.fire, 23, 87),
  fire300: hsl(HUE.fire, 22, 76),
  fire400: hsl(HUE.fire, 23, 62),
  fire500: hsl(HUE.fire, 24, 47.5), // 辅色（对白 4.6，达 AA）
  fire600: hsl(HUE.fire, 25, 41),
  fire700: hsl(HUE.fire, 26, 32),

  // ── 土 · 点缀（闲神）：色相 48°，饱和 18–20% ──
  earth50: hsl(HUE.earth, 20, 96),
  earth100: hsl(HUE.earth, 20, 94),
  earth200: hsl(HUE.earth, 19, 87),
  earth300: hsl(HUE.earth, 18, 74),
  earth400: hsl(HUE.earth, 19, 56),
  earth500: hsl(HUE.earth, 20, 43),
  earth600: hsl(HUE.earth, 21, 34),
  earth700: hsl(HUE.earth, 21, 25),

  // ── 中性 · 近真灰骨架（饱和 2–7%，这是"商用质感"的来源）──
  ink: hsl(HUE.neutral, 3, 17),
  ink2: hsl(HUE.neutral, 3, 40),
  ink3: hsl(HUE.neutral, 4, 58),
  line: hsl(HUE.neutral, 5, 91),
  line2: hsl(HUE.neutral, 6, 95),
  surface: '#ffffff',
  pageBg: hsl(HUE.neutral, 6, 98),

  // ── 侧边栏 · 近真灰深色 ──
  asideBg: hsl(HUE.neutral, 4, 15),
  asideBg2: hsl(HUE.neutral, 4, 11),
  asideText: hsl(HUE.neutral, 4, 79),
  asideTextDim: hsl(HUE.neutral, 4, 58),

  // ── 记账语义色 · 全部低饱和 ──
  debit: hsl(10, 26, 46), // 借方：火（喜神）
  credit: hsl(HUE.wood, 30, 29), // 贷方：木（用神），与借方成阴阳对照
  warn: hsl(HUE.earth, 21, 34),
  danger: hsl(4, 28, 43),
  ok: hsl(HUE.wood, 30, 29),
};

// ---------------------------------------------------------------- 校验输出
const W = '#ffffff';
const TEXT_TOKENS = [
  'ink',
  'ink2',
  'wood500',
  'wood600',
  'fire500',
  'fire600',
  'earth600',
  'debit',
  'credit',
  'warn',
  'danger',
  'ok',
];

console.log('\n════════ 定稿色板校验（木为用神 · 火为喜神）════════\n');
console.log(['令牌', '色值', '饱和', '色相', '对白对比', '判定'].map((s, i) => s.padEnd([13, 10, 8, 7, 10, 9][i])).join(''));
console.log('─'.repeat(60));

let fail = 0;
for (const [k, v] of Object.entries(PALETTE)) {
  const c = contrast(v, W);
  const s = sat(v);
  const hu = hueOf(v);
  const verdict = c >= 7 ? 'AAA' : c >= 4.5 ? 'AA' : c >= 3 ? 'large' : '装饰';
  const isText = TEXT_TOKENS.includes(k);
  const bad = isText && c < 4.5;
  if (bad) fail++;
  console.log(
    [k, v, s + '%', hu === null ? '—' : hu + '°', String(c), verdict + (bad ? '  ← 不达 AA!' : '')]
      .map((x, i) => String(x).padEnd([13, 10, 8, 7, 10, 9][i]))
      .join(''),
  );
}

// ── 五行归位校验：令牌名说的五行，必须与真实色相一致 ──────────────
//
// 这不是形式检查。曾经出现过「令牌叫 fire500 但填了蓝色」的情况，
// 那时整个"按喜用调色"的说法就是假的 —— 界面上看不出，只有逐条验色相才能发现。
const RANGES = {
  wood: [70, 170],
  fire: [0, 45],
  earth: [45, 70],
};
const HUE_ALIAS_VIA_360 = [330, 360]; // 红可以落在 330–360

console.log('\n════════ 五行归位校验（令牌名 vs 真实色相）════════\n');
let hueFail = 0;
for (const [family, [lo, hi]] of Object.entries(RANGES)) {
  for (const [k, v] of Object.entries(PALETTE)) {
    if (!k.startsWith(family)) continue;
    const hu = hueOf(v);
    if (hu === null) continue; // 极淡色近灰，无色相可言，跳过
    const ok = (hu >= lo && hu <= hi) || (family === 'fire' && hu >= HUE_ALIAS_VIA_360[0]);
    if (!ok) {
      console.log(`  ✗ ${k} = ${v}，色相 ${hu}° 不在 ${family} 的 ${lo}–${hi}° 区间`);
      hueFail++;
    }
  }
}
// 中性色必须"无色相"或色相饱和度极低 —— 泛暖相会让整屏显旧
const neutralWarm = Object.entries(PALETTE).filter(
  ([k, v]) => ['ink', 'ink2', 'ink3', 'line', 'line2', 'pageBg', 'surface'].includes(k) && sat(v) > 8,
);
if (neutralWarm.length > 0) {
  console.log(`  ✗ 中性色饱和过高（会泛色相）：${neutralWarm.map(([k, v]) => `${k}=${v}(${sat(v)}%)`).join('、')}`);
  hueFail += neutralWarm.length;
}
const neutralMax = Math.max(
  ...['ink', 'ink2', 'ink3', 'line', 'line2', 'pageBg', 'asideBg'].map((k) => sat(PALETTE[k])),
);
console.log(
  hueFail === 0
    ? `  ✓ 全部令牌的色相与所属五行一致；中性色最大饱和 ${neutralMax}%（≤8%，不带色相）`
    : `  ✗ ${hueFail} 处色相与令牌归属不符`,
);

const accent = ['wood500', 'wood600', 'wood700', 'fire500', 'fire600', 'earth500', 'earth600', 'debit', 'credit', 'warn', 'danger', 'ok'];
const maxAccent = Math.max(...accent.map((k) => sat(PALETTE[k])));

console.log(`\n强调色最大饱和度 ${maxAccent}%   中性色最大饱和度 ${neutralMax}%`);
console.log(fail === 0 ? '✓ 所有承载文字的色均达 WCAG AA' : `✗ ${fail} 个色未达 AA`);

// ---------------------------------------------------------------- 与旧板对比
const OLD = {
  主色: ['#d95a2b', PALETTE.wood500],
  辅色: ['#b8802a', PALETTE.fire500],
  点缀: ['#4a7c3f', PALETTE.earth500],
  借方: ['#bc4620', PALETTE.debit],
  危险: ['#b3261e', PALETTE.danger],
  正文: ['#33261f', PALETTE.ink],
  侧边栏底: ['#33251e', PALETTE.asideBg],
  页面底: ['#faf7f2', PALETTE.pageBg],
};
console.log('\n════════ 与高饱和旧板对比 ════════\n');
console.log(['用途', '旧', '旧饱和', '新', '新饱和', '降幅'].map((s, i) => s.padEnd([10, 10, 9, 10, 9, 8][i])).join(''));
console.log('─'.repeat(58));
for (const [k, [o, n]] of Object.entries(OLD)) {
  const so = sat(o), sn = sat(n);
  const drop = so > 0 ? `-${Math.round((1 - sn / so) * 100)}%` : '—';
  console.log([k, o, so + '%', n, sn + '%', drop].map((x, i) => String(x).padEnd([10, 10, 9, 10, 9, 8][i])).join(''));
}

// ---------------------------------------------------------------- 写出文件
const jsonPath = 'tools/palette.json';
writeFileSync(jsonPath, JSON.stringify(PALETTE, null, 2) + '\n', 'utf8');
console.log(`\n✓ 色板已写入 ${jsonPath}`);
console.log('\n可直接粘进 theme.model.ts 的 DEFAULT_THEME：\n');
const order = [
  ['木 · 主色（用神）', ['wood50', 'wood100', 'wood200', 'wood300', 'wood400', 'wood500', 'wood600', 'wood700']],
  ['火 · 辅色（喜神）', ['fire50', 'fire100', 'fire200', 'fire300', 'fire400', 'fire500', 'fire600', 'fire700']],
  ['土 · 点缀（闲神）', ['earth50', 'earth100', 'earth200', 'earth300', 'earth400', 'earth500', 'earth600', 'earth700']],
  ['中性', ['ink', 'ink2', 'ink3', 'line', 'line2', 'surface', 'pageBg']],
  ['侧边栏', ['asideBg', 'asideBg2', 'asideText', 'asideTextDim']],
  ['语义', ['debit', 'credit', 'warn', 'danger', 'ok']],
];
for (const [title, keys] of order) {
  console.log(`  // ${title}`);
  for (const k of keys) console.log(`  ${k}: '${PALETTE[k]}',`);
  console.log('');
}
