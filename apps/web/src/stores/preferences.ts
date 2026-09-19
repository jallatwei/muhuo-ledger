/**
 * 界面偏好 —— 全局 store
 * ============================================================
 * 把后端存的主题偏好落到 `:root` 的 CSS 变量上，实现"改一次、全局生效、下次打开还在"。
 *
 * 两条机制：
 *   ① **本地缓存**：颜色在 localStorage 存一份，页面启动时**先于网络请求**应用，
 *      避免刷新时闪一下默认色。
 *   ② **后端为准**：拉取成功则以服务端为准覆盖本地，保证多设备一致。
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { http, toastError } from '@/api';

/** 令牌名 → CSS 变量名（camelCase → kebab-case） */
function cssVarName(token: string): string {
  return '--bk-' + token.replace(/([A-Z0-9])/g, '-$1').toLowerCase();
}

export interface ThemeColors {
  [token: string]: string;
}

export interface ThemeSettings {
  colors: ThemeColors;
  moneyFont: string;
  logoFireColor: string | null;
  logoWoodColor: string | null;
  compactTable: boolean;
  note: string;
}

export interface ElementBalance {
  element: string;
  label: string;
  role: string;
  tokenCount: number;
  favorable: boolean;
}

export interface ThemeAnalysis {
  balance: ElementBalance[];
  favorableRatio: number;
  verdict: string;
  warnings: string[];
}

export interface TokenMeta {
  key: string;
  label: string;
  element: string;
  group: string;
  note?: string;
}

/** 令牌元数据接口返回的调色指引（由后端按喜忌表推导，前端不硬写五行） */
export interface ThemeGuidance {
  [role: string]: string;
}

/** 各五行色相的合理区间，用于在设置页提示"该往哪调" */
export interface ElementHueRange {
  [element: string]: string;
}

const LOCAL_KEY = 'bk.theme.colors';
const LOCAL_FONT = 'bk.theme.moneyFont';

export const usePreferencesStore = defineStore('preferences', () => {
  const colors = ref<ThemeColors>({});
  const moneyFont = ref<string>('');
  const logoFireColor = ref<string | null>(null);
  const logoWoodColor = ref<string | null>(null);
  const compactTable = ref(false);
  const note = ref('');
  /** 命局一句话说明（后端给，随喜忌表变化） */
  const chart = ref('');
  const source = ref<'ENTITY' | 'GLOBAL' | 'DEFAULT'>('DEFAULT');
  const analysis = ref<ThemeAnalysis | null>(null);
  const tokens = ref<TokenMeta[]>([]);
  const roles = ref<Record<string, string>>({});
  /** 五行英文码 → 中文名（后端给，避免前端硬写映射） */
  const elements = ref<Record<string, string>>({});
  const guidance = ref<ThemeGuidance>({});
  const hueRanges = ref<ElementHueRange>({});
  const loading = ref(false);
  const dirty = ref(false);

  /**
   * Logo 用色：未单独指定则跟随主色。
   *
   * ★ 木是本命用神，也是全站主色，所以两个回退值都以木为准 ——
   *   曾经这里火色在前，改了喜用之后 Logo 会继续拿旧的赤陶当主色。
   */
  const effectiveLogoWood = computed(() => logoWoodColor.value ?? colors.value.wood500 ?? '#376754');
  const effectiveLogoFire = computed(() => logoFireColor.value ?? colors.value.fire500 ?? '#966a5c');

  /**
   * 主色令牌名。木为用神 —— 想换主色只改这一处。
   * 设置页与文档都从这里取，避免各处再硬写 'wood500'。
   */
  const primaryToken = 'wood500';
  const accentToken = 'fire500';

  /**
   * 把颜色朝白色混，得到"深底上可读"的浅色版本。
   *
   * ★ 为什么需要它：主色阶的 500 是给**白底**用的（对白 6.5 才够 AA），
   *   放到侧边栏、登录页品牌区那种近真灰深底上，对比度只有约 2:1 —— 几乎看不清。
   *   品牌名、四柱这些字都压在深底上，必须用浅一档的色。
   *
   * 与 theme.css 里的 wood400 / fire400 是同一个思路，
   * 但这里从用户当前的主色**实时算**，所以在外面观偏好里改了主色，深底上的字也跟着变。
   */
  function lightenForDark(hex: string, amount = 0.42): string {
    const h = (hex ?? '').replace('#', '');
    if (h.length !== 6) return hex;
    const mix = (i: number): string => {
      const c = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      const v = Math.round(c + (255 - c) * amount);
      return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
    };
    return `#${mix(0)}${mix(2)}${mix(4)}`;
  }

  /** 把颜色写进 :root 的 CSS 变量 */
  function apply(next?: ThemeColors): void {
    const palette = next ?? colors.value;
    const root = document.documentElement;
    for (const [token, value] of Object.entries(palette)) {
      if (!value) continue;
      root.style.setProperty(cssVarName(token), value);
    }
    if (moneyFont.value) {
      root.style.setProperty('--bk-money-font', moneyFont.value);
    }
    root.style.setProperty('--bk-logo-fire', effectiveLogoFire.value);
    root.style.setProperty('--bk-logo-wood', effectiveLogoWood.value);
    // 深底（侧边栏、登录页品牌区）上的品牌用色，由当前主/辅色实时推导
    root.style.setProperty('--bk-on-dark-wood', lightenForDark(effectiveLogoWood.value));
    root.style.setProperty('--bk-on-dark-fire', lightenForDark(effectiveLogoFire.value));
  }

  /** 页面启动：先用本地缓存，避免闪默认色 */
  function applyLocalCache(): void {
    try {
      const cached = localStorage.getItem(LOCAL_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as ThemeColors;
        colors.value = { ...parsed };
        apply(parsed);
      }
      const font = localStorage.getItem(LOCAL_FONT);
      if (font) moneyFont.value = font;
    } catch {
      // 缓存坏了就忽略，走后端
    }
  }

  function persistLocal(): void {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(colors.value));
      localStorage.setItem(LOCAL_FONT, moneyFont.value);
    } catch {
      // 隐私模式等场景写不了，忽略
    }
  }

  /** 从后端拉取（成功则以服务端为准） */
  async function load(entityId?: string): Promise<void> {
    loading.value = true;
    try {
      const res = await http
        .get('/preferences/theme', { params: entityId ? { entityId } : {} })
        .then((r) => r.data);

      colors.value = { ...res.settings.colors };
      moneyFont.value = res.settings.moneyFont;
      logoFireColor.value = res.settings.logoFireColor;
      logoWoodColor.value = res.settings.logoWoodColor;
      compactTable.value = res.settings.compactTable;
      note.value = res.settings.note;
      chart.value = res.chart ?? '';
      source.value = res.source;
      analysis.value = res.analysis;

      apply();
      persistLocal();
      dirty.value = false;
    } catch (e) {
      // 拉不到就继续用本地缓存/内置默认，不打断使用
      console.warn('[preferences] 读取主题偏好失败，继续使用本地缓存', e);
    } finally {
      loading.value = false;
    }
  }

  /** 加载令牌元数据（设置页用） */
  async function loadTokens(): Promise<void> {
    if (tokens.value.length > 0) return;
    try {
      const res = await http.get('/preferences/theme/tokens').then((r) => r.data);
      tokens.value = res.tokens;
      roles.value = res.roles;
      elements.value = res.elements ?? {};
      guidance.value = res.guidance;
      hueRanges.value = res.hueRanges ?? {};
      if (res.chart) chart.value = res.chart;
    } catch (e) {
      toastError(e);
    }
  }

  /** 本地试改（不落库），用于设置页实时预览 */
  function preview(token: string, value: string): void {
    colors.value = { ...colors.value, [token]: value };
    apply();
    dirty.value = true;
  }

  /** 批量预览 */
  function previewMany(patch: ThemeColors): void {
    colors.value = { ...colors.value, ...patch };
    apply();
    dirty.value = true;
  }

  /** 保存到后端（全局默认） */
  async function save(params: { entityId?: string | null; userId?: string } = {}): Promise<void> {
    loading.value = true;
    try {
      const res = await http
        .patch('/preferences/theme', {
          colors: colors.value,
          moneyFont: moneyFont.value,
          logoFireColor: logoFireColor.value,
          logoWoodColor: logoWoodColor.value,
          compactTable: compactTable.value,
          entityId: params.entityId ?? null,
          userId: params.userId,
        })
        .then((r) => r.data);

      colors.value = { ...res.settings.colors };
      analysis.value = res.analysis;
      source.value = res.source;
      apply();
      persistLocal();
      dirty.value = false;
    } catch (e) {
      toastError(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** 恢复默认 */
  async function reset(params: { entityId?: string | null } = {}): Promise<void> {
    loading.value = true;
    try {
      const res = await http
        .post('/preferences/theme/reset', { entityId: params.entityId ?? null })
        .then((r) => r.data);

      colors.value = { ...res.settings.colors };
      moneyFont.value = res.settings.moneyFont;
      logoFireColor.value = null;
      logoWoodColor.value = null;
      analysis.value = res.analysis;
      apply();
      persistLocal();
      dirty.value = false;
    } catch (e) {
      toastError(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** 撤销未保存的本地试改 */
  async function revert(entityId?: string): Promise<void> {
    await load(entityId);
  }

  return {
    colors,
    moneyFont,
    logoFireColor,
    logoWoodColor,
    compactTable,
    note,
    chart,
    source,
    analysis,
    tokens,
    roles,
    elements,
    guidance,
    hueRanges,
    primaryToken,
    accentToken,
    loading,
    dirty,
    effectiveLogoFire,
    effectiveLogoWood,
    applyLocalCache,
    apply,
    load,
    loadTokens,
    preview,
    previewMany,
    save,
    reset,
    revert,
  };
});
