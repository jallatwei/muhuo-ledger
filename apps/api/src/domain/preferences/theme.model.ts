/**
 * 界面主题偏好 —— 领域模型
 * ============================================================
 * 用途：把 UI 配色做成**可持久化的全局偏好**，而不是硬编码在前端 CSS 里。
 *
 * 两条设计原则：
 *
 *   ① **令牌制**：前端只认 CSS 变量（--bk-*），配置里改的是令牌值。
 *      组件里不出现任何硬编码色值，改主题不需要碰组件代码。
 *
 *   ② **五行归位**：每个令牌都标了所属五行（火/木/土/水/金/中性）。
 *      这不是装饰 —— 它让"改配色"这件事有据可依：
 *      命局喜木火、忌水金，所以调整时应当加强木火、削弱水金。
 *      前端设置页按五行分组展示，并直接标出喜忌。
 *
 * 命理依据见 docs/主题配色-八字喜用.md。
 *
 * ★ 2026-09 更正：原先这里按「甲子年 丁丑月 甲子日 甲子时、日主甲木」推算，
 *   把火定为用神。核对儒略日后发现日柱应为**丙寅**、日主是**丙火**：
 *     · 丙火生于丑月（腊月），天寒地冻，非木不生 → **木为用神**
 *     · 木能生火、火能暖局          → **火为喜神**
 *     · 土为火所生，泄火之力，宜少 → **土为闲神**（只做点缀与中性偏暖）
 *     · 水克火、冬水本旺            → **水为忌神**
 *     · 金生水而助寒                → **金为忌神**
 *   所以主色系从「火土」改为「**木火**」：驼峰角色表整体前移一格。
 */
import { z } from 'zod';

// ============================================================================
//  五行
// ============================================================================

export const ELEMENT = {
  FIRE: 'FIRE',
  EARTH: 'EARTH',
  WOOD: 'WOOD',
  WATER: 'WATER',
  METAL: 'METAL',
  NEUTRAL: 'NEUTRAL',
} as const;

export type Element = (typeof ELEMENT)[keyof typeof ELEMENT];

/**
 * 本命局的喜忌：木为用、火为喜、土为闲、水金为忌。
 *
 * ★ 这张表是**唯一**的喜忌声明处。令牌分组名、占比判定、告警文案、
 *   前端的调色方向提示全都由它推导 —— 改命局只改这一处。
 *   曾经这些判断散落在六七个地方各写一遍"火土"，
 *   改一次喜用要找齐所有出现过的字符串，必然漏。
 */
export const ELEMENT_ROLE: Record<Element, '用神' | '喜神' | '闲神' | '忌神' | '中性'> = {
  WOOD: '用神',
  FIRE: '喜神',
  EARTH: '闲神',
  WATER: '忌神',
  METAL: '忌神',
  NEUTRAL: '中性',
};

export const ELEMENT_LABEL: Record<Element, string> = {
  FIRE: '火',
  EARTH: '土',
  WOOD: '木',
  WATER: '水',
  METAL: '金',
  NEUTRAL: '中性',
};

/** 属于喜用（用神 / 喜神）的五行 */
export const FAVORABLE_ELEMENTS: Element[] = (Object.keys(ELEMENT_ROLE) as Element[]).filter(
  (e) => ELEMENT_ROLE[e] === '用神' || ELEMENT_ROLE[e] === '喜神',
);

/** 属于忌神的五行 */
export const UNFAVORABLE_ELEMENTS: Element[] = (Object.keys(ELEMENT_ROLE) as Element[]).filter(
  (e) => ELEMENT_ROLE[e] === '忌神',
);

/** 喜用五行的中文串，如「木火」—— 用于告警与结论文案，避免各处硬写 */
export const FAVORABLE_LABEL = FAVORABLE_ELEMENTS.map((e) => ELEMENT_LABEL[e]).join('');
/** 忌神五行的中文串，如「水金」 */
export const UNFAVORABLE_LABEL = UNFAVORABLE_ELEMENTS.map((e) => ELEMENT_LABEL[e]).join('');

/** 各五行色相的合理区间（与 hueToElement 保持一致），用于给出"该往哪调" */
export const ELEMENT_HUE_RANGE: Record<Element, string> = {
  WOOD: '70–170°（绿）',
  FIRE: '0–45° 或 330–360°（橙红）',
  EARTH: '45–70°（赭黄）',
  WATER: '170–330°（青蓝 / 蓝紫）',
  METAL: '（金在色彩语言里没有独立色相，表现为高饱和冷灰）',
  NEUTRAL: '（近真灰，饱和 2–8%）',
};

/**
 * 内置默认色板的依据说明，随喜忌表一起改，文档与外观偏好页共用。
 *
 * ★ 这是**色板的依据**，不是"本系统实控人的命盘"。
 *   内置默认色板按一例寒月丙火（用神木、喜神火）定下来，
 *   用户可以在「外观偏好」页填**自己的**出生信息，系统重算四柱与喜用，
 *   界面文案随之改变。
 *
 * ★ 这段文字**只出现在外观偏好页**（/appearance），不进入登录首页。
 *   登录页可能被别人看到，把命盘摆在首屏是不必要的暴露；
 *   而且在那一屏要回答的是"这软件靠不靠得住"，不是"它按谁的八字配色"。
 */
export const CHART_SUMMARY =
  '默认色板取一例寒月丙火（日主丙火生于丑月，天寒地冻非木不生）—— ' +
  '木为用神、火为喜神、土为闲神、忌水金。可在本页填入你自己的出生信息重算。';

// ============================================================================
//  令牌定义
// ============================================================================

/** 颜色令牌（对应前端 --bk-* 变量） */
export const COLOR_TOKEN_KEYS = [
  // 木 —— 用神：主色系（腊月丙火，非木不生）。主色必须是完整色阶
  'wood50',
  'wood100',
  'wood200',
  'wood300',
  'wood400',
  'wood500',
  'wood600',
  'wood700',
  // 火 —— 喜神：辅色系
  'fire50',
  'fire100',
  'fire200',
  'fire300',
  'fire400',
  'fire500',
  'fire600',
  'fire700',
  // 土 —— 闲神：点缀色（火生土而泄火，克制使用）
  'earth50',
  'earth100',
  'earth200',
  'earth300',
  'earth400',
  'earth500',
  'earth600',
  'earth700',
  // 中性 —— 近真灰（不带暖相，这是商用质感的来源）
  'ink',
  'ink2',
  'ink3',
  'line',
  'line2',
  'surface',
  'pageBg',
  // 侧边栏（近真灰深色，不着五行）
  'asideBg',
  'asideBg2',
  'asideText',
  'asideTextDim',
  // 记账语义色
  'debit',
  'credit',
  'warn',
  'danger',
  'ok',
] as const;

export type ColorTokenKey = (typeof COLOR_TOKEN_KEYS)[number];

/** 令牌元数据：五行归属 + 中文名 + 说明。用于设置页分组展示 */
export interface TokenMeta {
  key: ColorTokenKey;
  label: string;
  element: Element;
  group: string;
  note?: string;
}

export const TOKEN_META: TokenMeta[] = [
  // ---- 木 · 用神（主色系，完整色阶）----
  { key: 'wood500', label: '主色', element: ELEMENT.WOOD, group: '木 · 用神', note: '主按钮、选中态、贷方金额 —— 全站唯一的强调色' },
  { key: 'wood400', label: '主色浅（hover）', element: ELEMENT.WOOD, group: '木 · 用神' },
  { key: 'wood300', label: '主色淡（边框）', element: ELEMENT.WOOD, group: '木 · 用神' },
  { key: 'wood200', label: '主色更淡', element: ELEMENT.WOOD, group: '木 · 用神' },
  { key: 'wood100', label: '主色极淡（底色）', element: ELEMENT.WOOD, group: '木 · 用神' },
  { key: 'wood50', label: '主色最淡（底色）', element: ELEMENT.WOOD, group: '木 · 用神' },
  { key: 'wood600', label: '主色深（active / 文字用）', element: ELEMENT.WOOD, group: '木 · 用神', note: '承载文字，对白 8.63 达 AAA' },
  { key: 'wood700', label: '主色更深', element: ELEMENT.WOOD, group: '木 · 用神' },
  // ---- 火 · 喜神 ----
  { key: 'fire500', label: '辅色', element: ELEMENT.FIRE, group: '火 · 喜神', note: '次强调、危险态；火为喜神，用量次于木' },
  { key: 'fire400', label: '辅色浅（hover）', element: ELEMENT.FIRE, group: '火 · 喜神' },
  { key: 'fire300', label: '辅色淡（边框）', element: ELEMENT.FIRE, group: '火 · 喜神' },
  { key: 'fire200', label: '辅色更淡', element: ELEMENT.FIRE, group: '火 · 喜神' },
  { key: 'fire100', label: '辅色极淡', element: ELEMENT.FIRE, group: '火 · 喜神' },
  { key: 'fire50', label: '辅色最淡（底色）', element: ELEMENT.FIRE, group: '火 · 喜神' },
  { key: 'fire600', label: '辅色深（active / 文字用）', element: ELEMENT.FIRE, group: '火 · 喜神', note: '承载文字，对白 5.88 达 AA' },
  { key: 'fire700', label: '辅色更深', element: ELEMENT.FIRE, group: '火 · 喜神' },
  // ---- 土 · 闲神 ----
  { key: 'earth500', label: '点缀色', element: ELEMENT.EARTH, group: '土 · 闲神', note: '警告态、次级强调；土泄火，克制使用' },
  { key: 'earth400', label: '点缀色浅', element: ELEMENT.EARTH, group: '土 · 闲神' },
  { key: 'earth300', label: '点缀色淡', element: ELEMENT.EARTH, group: '土 · 闲神' },
  { key: 'earth200', label: '点缀色更淡', element: ELEMENT.EARTH, group: '土 · 闲神' },
  { key: 'earth100', label: '点缀色极淡', element: ELEMENT.EARTH, group: '土 · 闲神' },
  { key: 'earth50', label: '点缀色最淡（底色）', element: ELEMENT.EARTH, group: '土 · 闲神' },
  { key: 'earth600', label: '点缀色深（文字用）', element: ELEMENT.EARTH, group: '土 · 闲神', note: '承载文字，对白 6.12 达 AA' },
  { key: 'earth700', label: '点缀色更深', element: ELEMENT.EARTH, group: '土 · 闲神' },
  // ---- 中性骨架 ----
  { key: 'ink', label: '正文色', element: ELEMENT.NEUTRAL, group: '中性骨架', note: '近真灰，不带暖相 —— 商用质感的关键' },
  { key: 'ink2', label: '次要文字', element: ELEMENT.NEUTRAL, group: '中性骨架' },
  { key: 'ink3', label: '弱化文字', element: ELEMENT.NEUTRAL, group: '中性骨架' },
  { key: 'line', label: '边框线', element: ELEMENT.NEUTRAL, group: '中性骨架' },
  { key: 'line2', label: '浅边框线', element: ELEMENT.NEUTRAL, group: '中性骨架' },
  { key: 'surface', label: '卡片底色', element: ELEMENT.NEUTRAL, group: '中性骨架' },
  { key: 'pageBg', label: '页面底色', element: ELEMENT.NEUTRAL, group: '中性骨架', note: '保持近中性，避免整屏泛黄' },
  // ---- 侧边栏 ----
  { key: 'asideBg', label: '侧边栏底色', element: ELEMENT.NEUTRAL, group: '侧边栏', note: '近真灰，不带色相；原为深蓝黑，属忌神水色' },
  { key: 'asideBg2', label: '侧边栏描边', element: ELEMENT.NEUTRAL, group: '侧边栏' },
  { key: 'asideText', label: '侧边栏文字', element: ELEMENT.NEUTRAL, group: '侧边栏' },
  { key: 'asideTextDim', label: '侧边栏弱化文字', element: ELEMENT.NEUTRAL, group: '侧边栏' },
  // ---- 记账语义 ----
  { key: 'debit', label: '借方金额', element: ELEMENT.FIRE, group: '记账语义色', note: '低饱和火红（喜神）；原为蓝色，属忌神水色' },
  { key: 'credit', label: '贷方金额', element: ELEMENT.WOOD, group: '记账语义色', note: '木绿，与借方成阴阳对照' },
  { key: 'warn', label: '警告文字', element: ELEMENT.EARTH, group: '记账语义色' },
  { key: 'danger', label: '危险', element: ELEMENT.FIRE, group: '记账语义色' },
  { key: 'ok', label: '正常', element: ELEMENT.WOOD, group: '记账语义色' },
];

// ============================================================================
//  默认主题 —— 低饱和 · 商用质感
// ============================================================================
//
//  策略：**近真灰中性骨架 + 单点低饱和绿意点缀**
//    · 中性色饱和 ≤8%，不带色相（否则整屏泛棕泛黄，立刻显旧）
//    · 主色（木）饱和 30%、辅色（火）24%、点缀（土）20%，全板 ≤ 31%
//    · 五行意象由「色相」承载，不由「饱和度」堆：
//        木 = 156° 松绿   火 = 14° 赤陶   土 = 48° 赭黄
//    · 所有承载文字的色均过 WCAG AA（≥4.5:1）
//
//  ★ 色相区间与 hueToElement 的判定区间刻意对齐（木 70–170°、火 0–45°、
//    土 45–70°）。不对齐的话，设置页一边显示"这个色属于木"、
//    一边在算占比时把它算成火，用户看到的结论就自相矛盾。
//
//  由 tools/build-palette.mjs 生成与校验（含 WCAG AA 与色相归位两项检查），
//  改色后请重跑该脚本并同步这里。

export const DEFAULT_THEME = {
  // 木 · 主色（用神）：丙火生腊月，非木不生
  wood50: '#f5faf8',
  wood100: '#ebf4f1',
  wood200: '#d2e5dd',
  wood300: '#a3c8b9',
  wood400: '#5ea186',
  wood500: '#376754',
  wood600: '#2d5344',
  wood700: '#223f33',

  // 火 · 辅色（喜神）：木生火，火暖局，用量次于木
  fire50: '#f9f6f5',
  fire100: '#f4eeec',
  fire200: '#e5dad6',
  fire300: '#cfbbb4',
  fire400: '#b49288',
  fire500: '#966a5c',
  fire600: '#835b4e',
  fire700: '#67463c',

  // 土 · 点缀（闲神）：火生土而泄火，克制使用
  earth50: '#f7f6f3',
  earth100: '#f3f2ed',
  earth200: '#e4e2d8',
  earth300: '#c9c4b1',
  earth400: '#a49c79',
  earth500: '#847b58',
  earth600: '#696244',
  earth700: '#4d4832',

  // 中性 · 近真灰骨架
  ink: '#2a2a2d',
  ink2: '#636369',
  ink3: '#909098',
  line: '#e7e7e9',
  line2: '#f1f1f3',
  surface: '#ffffff',
  pageBg: '#fafafa',

  // 侧边栏（近真灰深色，不着五行）
  asideBg: '#252528',
  asideBg2: '#1b1b1d',
  asideText: '#c7c7cc',
  asideTextDim: '#909098',

  // 记账语义色
  debit: '#946157', // 借方：火（喜神）
  credit: '#34604e', // 贷方：木（用神），与借方成阴阳对照
  warn: '#696244',
  danger: '#8c534f',
  ok: '#34604e',
} as const satisfies Record<ColorTokenKey, string>;
export type ThemeColors = Record<ColorTokenKey, string>;

/** 全局偏好（含非颜色项） */
export interface ThemeSettings {
  colors: ThemeColors;
  /** 金额等宽字体 */
  moneyFont: string;
  /** Logo 主色（默认跟随木色 —— 木是本命用神，也是全站主色） */
  logoFireColor: string | null;
  /** Logo 木色 */
  logoWoodColor: string | null;
  /** 是否启用紧凑表格（分录一屏多看几行） */
  compactTable: boolean;
  /** 偏好说明，记录依据来源 */
  note: string;
}

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  colors: { ...DEFAULT_THEME } as ThemeColors,
  moneyFont: "'Consolas', 'Menlo', 'DejaVu Sans Mono', 'Courier New', monospace",
  logoFireColor: null,
  logoWoodColor: null,
  compactTable: false,
  note:
    '依八字喜用而定（甲子年 丁丑月 丙寅日 戊子时，日主丙火生于丑月天寒地冻，' +
    '非木不生 —— 木为用神、火为喜神、土为闲神、忌水金）。' +
    '配色策略：近真灰中性骨架 + 单点低饱和松绿主色，全板饱和不超过 31%，' +
    '承载文字的色均达 WCAG AA，且逐令牌校验过色相与五行归属一致。',
};

// ============================================================================
//  校验
// ============================================================================

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const themeColorsSchema = z
  .object(
    Object.fromEntries(
      COLOR_TOKEN_KEYS.map((k) => [k, z.string().regex(HEX_COLOR, `${k} 必须是 #RGB 或 #RRGGBB 格式的色值`)]),
    ) as Record<ColorTokenKey, z.ZodString>,
  )
  .partial();

export const themeSettingsSchema = z.object({
  colors: themeColorsSchema.optional(),
  moneyFont: z.string().max(200).optional(),
  logoFireColor: z.string().regex(HEX_COLOR).nullable().optional(),
  logoWoodColor: z.string().regex(HEX_COLOR).nullable().optional(),
  compactTable: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

export type ThemeSettingsPatch = z.infer<typeof themeSettingsSchema>;

/**
 * 合并补丁到当前偏好。
 * 只覆盖显式传入的字段，未传的保持原值 —— 这样前端可以只提交改动的那几个色。
 */
export function mergeThemeSettings(
  current: ThemeSettings,
  patch: ThemeSettingsPatch,
): ThemeSettings {
  return {
    colors: { ...current.colors, ...(patch.colors ?? {}) } as ThemeColors,
    moneyFont: patch.moneyFont ?? current.moneyFont,
    logoFireColor:
      patch.logoFireColor === undefined ? current.logoFireColor : patch.logoFireColor,
    logoWoodColor:
      patch.logoWoodColor === undefined ? current.logoWoodColor : patch.logoWoodColor,
    compactTable: patch.compactTable ?? current.compactTable,
    note: patch.note ?? current.note,
  };
}

/** 配置完整性检查：缺的令牌补默认值，保证前端总能完整渲染 */
export function normalizeThemeSettings(raw: unknown): ThemeSettings {
  const base = DEFAULT_THEME_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...base, colors: { ...base.colors } };

  const obj = raw as Partial<ThemeSettings>;
  const colors = { ...base.colors };

  if (obj.colors && typeof obj.colors === 'object') {
    for (const key of COLOR_TOKEN_KEYS) {
      const v = (obj.colors as Record<string, unknown>)[key];
      if (typeof v === 'string' && HEX_COLOR.test(v)) {
        colors[key] = v;
      }
    }
  }

  return {
    colors,
    moneyFont: typeof obj.moneyFont === 'string' && obj.moneyFont ? obj.moneyFont : base.moneyFont,
    logoFireColor:
      typeof obj.logoFireColor === 'string' && HEX_COLOR.test(obj.logoFireColor)
        ? obj.logoFireColor
        : null,
    logoWoodColor:
      typeof obj.logoWoodColor === 'string' && HEX_COLOR.test(obj.logoWoodColor)
        ? obj.logoWoodColor
        : null,
    compactTable: obj.compactTable === true,
    note: typeof obj.note === 'string' ? obj.note : base.note,
  };
}

// ============================================================================
//  五行统计 —— 让"是否合于喜用"可量化
// ============================================================================

/** 色值 → HSL 色相（0–360）；灰阶（饱和过低）返回 null */
export function hexToHue(hex: string): number | null {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;

  if (d === 0) return null; // 纯灰，无色相

  // 饱和度过低的一律视为中性 —— 它们不承载五行倾向
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  if (s < 0.12) return null;

  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;

  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/**
 * 色相 → 五行。
 *
 * 判定区间（与 theme.css 里的色相选择一致）：
 *   0–45°    火（橙红）      45–70°   土（黄）
 *   70–170°  木（绿）        170–260° 水（青蓝）★ 忌神
 *   260–330° 水（蓝紫）★    330–360° 火（红）
 *
 * 注意：这是"颜色语言"的五行，不是命理排盘的五行 ——
 * 用途是判断"用户挑的这个色，视觉上偏向哪个方位色"。
 */
export function hueToElement(hue: number | null): Element {
  if (hue === null) return ELEMENT.NEUTRAL;
  if (hue < 45 || hue >= 330) return ELEMENT.FIRE;
  if (hue < 70) return ELEMENT.EARTH;
  if (hue < 170) return ELEMENT.WOOD;
  return ELEMENT.WATER; // 170–330：青蓝/蓝/蓝紫，皆属水
}

export interface ElementBalance {
  element: Element;
  label: string;
  role: string;
  /** 该五行在配色中占了多少个令牌 */
  tokenCount: number;
  /** 是否属于喜用（用神/喜神） */
  favorable: boolean;
}

/**
 * 统计当前配色的五行分布。
 *
 * 这不是玄学装饰 —— 它给"改配色"一个可检查的量化口径：
 * 若喜用（木火）令牌占比过低、忌神（水金）出现，说明配色偏离了喜用方向。
 *
 * ★ 全篇的**角色与文案都由 ELEMENT_ROLE 推导**，不再硬写"火土"。
 *   原因很实际：改一次喜用要找齐所有出现过"火土"的字符串，必然漏，
 *   而漏掉的那处会继续给用户错误的调色建议 —— 比不提示更糟。
 */
export function analyzeElementBalance(settings: ThemeSettings): {
  balance: ElementBalance[];
  favorableRatio: number;
  verdict: string;
  warnings: string[];
} {
  const counts = new Map<Element, number>();
  for (const meta of TOKEN_META) {
    counts.set(meta.element, (counts.get(meta.element) ?? 0) + 1);
  }

  const total = TOKEN_META.length;
  const balance: ElementBalance[] = (Object.keys(ELEMENT) as Element[]).map((el) => {
    const role = ELEMENT_ROLE[el];
    return {
      element: el,
      label: ELEMENT_LABEL[el],
      role,
      tokenCount: counts.get(el) ?? 0,
      favorable: role === '用神' || role === '喜神',
    };
  });

  const favorable = balance.filter((b) => b.favorable).reduce((s, b) => s + b.tokenCount, 0);
  const favorableRatio = total > 0 ? favorable / total : 0;

  /** 喜用五行的色相区间提示，如「木（70–170°）或火（0–45° / 330–360°）」 */
  const advisableHueHint = FAVORABLE_ELEMENTS.map(
    (e) => `${ELEMENT_LABEL[e]}（${ELEMENT_HUE_RANGE[e]}）`,
  ).join('或');

  const warnings: string[] = [];

  // 忌神五行是否真的出现在配色里（中性色不算）
  const unfavorableTokens: string[] = [];
  for (const meta of TOKEN_META) {
    if (UNFAVORABLE_ELEMENTS.includes(meta.element)) {
      unfavorableTokens.push(meta.label);
    }
  }
  if (unfavorableTokens.length > 0) {
    warnings.push(
      `配色中出现 ${unfavorableTokens.length} 个属${UNFAVORABLE_LABEL}的令牌：` +
        `${unfavorableTokens.join('、')}。本命忌${UNFAVORABLE_LABEL}，建议改为${FAVORABLE_LABEL}系色值。`,
    );
  }

  // ★ 关键检查：**实际色值的色相**是否偏离了令牌应有的五行。
  //
  //   只看令牌归属是不够的 —— 令牌名为 wood500 但填了蓝色，一样是水色入局，
  //   而界面一眼看去就是冷的。这里逐令牌比对色相，把"名不副实"的挑出来。
  const hueConflicts: Array<{ label: string; color: string; hue: number; actual: Element }> = [];

  for (const meta of TOKEN_META) {
    // 中性令牌允许任意色相（灰阶），不参与判定
    if (meta.element === ELEMENT.NEUTRAL) continue;

    const color = settings.colors[meta.key];
    if (!color) continue;

    const hue = hexToHue(color);
    const actual = hueToElement(hue);

    // 灰阶（无色相）不算冲突
    if (actual === ELEMENT.NEUTRAL) continue;
    if (actual === meta.element) continue;

    // 相邻色相视觉上可接受，不算冲突：
    //   火 ↔ 土（橙红 ↔ 赭黄）、土 ↔ 木（赭黄 ↔ 黄绿）
    const adjacent =
      (meta.element === ELEMENT.FIRE && actual === ELEMENT.EARTH) ||
      (meta.element === ELEMENT.EARTH && actual === ELEMENT.FIRE) ||
      (meta.element === ELEMENT.EARTH && actual === ELEMENT.WOOD) ||
      (meta.element === ELEMENT.WOOD && actual === ELEMENT.EARTH);
    if (adjacent) continue;

    hueConflicts.push({
      label: meta.label,
      color,
      hue: Math.round(hue ?? 0),
      actual,
    });
  }

  if (hueConflicts.length > 0) {
    const desc = hueConflicts
      .slice(0, 6)
      .map((c) => `${c.label}（${c.color}，色相 ${c.hue}° 属${ELEMENT_LABEL[c.actual]}）`)
      .join('；');
    const conflictedUnfavorable = [
      ...new Set(
        hueConflicts
          .filter((c) => UNFAVORABLE_ELEMENTS.includes(c.actual))
          .map((c) => ELEMENT_LABEL[c.actual]),
      ),
    ];
    warnings.push(
      `★ 有 ${hueConflicts.length} 个令牌的**实际色相**偏离了应有五行：${desc}。` +
        (conflictedUnfavorable.length > 0
          ? `其中含属${conflictedUnfavorable.join('、')}的色值 —— 那是本命忌神，` +
            `界面会偏冷，建议换成${advisableHueHint}。`
          : `建议把色相调回${advisableHueHint}。`),
    );
  }

  const favorableCount = balance
    .filter((b) => b.favorable)
    .reduce((s, b) => s + b.tokenCount, 0);

  if (favorableCount < total * 0.5) {
    warnings.push(
      `${FAVORABLE_LABEL}令牌共 ${favorableCount} 个，占比不足一半。` +
        `${FAVORABLE_ELEMENTS.map((e) => `${ELEMENT_LABEL[e]}为${ELEMENT_ROLE[e]}`).join('、')}，` +
        `主色系应占多数。`,
    );
  }

  const pct = (favorableRatio * 100).toFixed(0);
  let verdict: string;
  if (hueConflicts.some((c) => UNFAVORABLE_ELEMENTS.includes(c.actual))) {
    verdict =
      `配色中有属${UNFAVORABLE_LABEL}的色值（本命忌神），界面会偏冷。` +
      `建议把色相调回${advisableHueHint}区间。`;
  } else if (favorableRatio >= 0.6) {
    verdict = `${FAVORABLE_LABEL}占比 ${pct}%，合于喜用。`;
  } else if (favorableRatio >= 0.45) {
    verdict = `${FAVORABLE_LABEL}占比 ${pct}%，尚可，可再加强${FAVORABLE_LABEL}。`;
  } else {
    verdict =
      `${FAVORABLE_LABEL}占比仅 ${pct}%，偏离喜用方向，` +
      `建议加强${FAVORABLE_LABEL}、削弱${UNFAVORABLE_LABEL}。`;
  }

  return { balance, favorableRatio, verdict, warnings };
}
