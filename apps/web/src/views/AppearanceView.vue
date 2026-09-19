<script setup lang="ts">
/**
 * 外观偏好 + 实控人八字
 * ============================================================
 * 这是「全局喜好」的落地页，两件事放在一起是有道理的：
 * 配色不是凭感觉挑的，而是**由实控人的八字喜用推出来的**。
 * 所以页面顶部先让人把出生信息填对（含真太阳时修正），
 * 再由系统算出四柱与喜用，最后才轮到调色。
 *
 * ★ 为什么把「真太阳时」的明细摊开显示：
 *   同一份出生时间，做不做经度修正、用哪种子时日界，
 *   会得出**不同的日柱**，而喜用结论可能跟着变。
 *   把 +14 分钟是怎么来的（经度差 +26.4、均时差 −12.3）摆出来，
 *   用户才能判断"为什么这里算的和我手机上那个 App 不一样"，
 *   而不是把差异当成 bug。
 *
 * ★ 子时日界两派都给结果，不替用户选。
 *   这是唯一会让四柱整体不同的分歧，隐藏它等于制造争议。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useAppStore } from '@/stores/app';
import { usePreferencesStore } from '@/stores/preferences';
import {
  CHINA_CITIES,
  computeChart,
  type BaziChart,
  type BirthInput,
} from '@bookkeeper/shared';

const app = useAppStore();
const prefs = usePreferencesStore();

// ============================================================================
//  实控人八字
// ============================================================================

/**
 * 默认值：公司实控人的出生信息。
 *
 * ★ 预填的是「1985-01-27 23:15 吉林市船营区」——
 *   这是本系统配色所依据的那一例。保留它是为了让用户一眼看到
 *   "系统默认配色是怎么来的"，而不是面对一个空表单不知道填什么。
 */
const birth = reactive({
  calendar: 'SOLAR' as 'SOLAR' | 'LUNAR',
  isLeapMonth: false,
  year: 1985,
  month: 1,
  day: 27,
  hour: 23,
  minute: 15,
  /** 预设城市 key；'CUSTOM' 表示手工填经纬度 */
  cityKey: 'jilin',
  longitude: 126.56,
  latitude: 43.84,
  placeName: '吉林省吉林市船营区',
  ziHourRule: 'MIDNIGHT' as 'MIDNIGHT' | 'ZI_START',
  useTrueSolarTime: true,
});

/** 是否手工填经纬度 */
const customPlace = computed(() => birth.cityKey === 'CUSTOM');

function onCityChange(key: string): void {
  const city = CHINA_CITIES.find((c) => c.key === key);
  if (!city) return; // CUSTOM：保留当前经纬度让人自己改
  birth.longitude = city.longitude;
  birth.latitude = city.latitude;
  birth.placeName = city.name;
}

const chart = ref<BaziChart | null>(null);
const chartError = ref('');

/** 每次改动都重算 —— 纯计算，没有网络请求，不必防抖 */
function recompute(): void {
  chartError.value = '';
  try {
    const input: BirthInput = {
      calendar: birth.calendar,
      year: Number(birth.year),
      month: Number(birth.month),
      day: Number(birth.day),
      isLeapMonth: birth.isLeapMonth,
      hour: Number(birth.hour),
      minute: Number(birth.minute),
      longitude: birth.useTrueSolarTime ? Number(birth.longitude) : undefined,
      latitude: birth.useTrueSolarTime ? Number(birth.latitude) : undefined,
      placeName: birth.placeName || undefined,
      ziHourRule: birth.ziHourRule,
      useTrueSolarTime: birth.useTrueSolarTime,
    };
    chart.value = computeChart(input);
  } catch (e) {
    chart.value = null;
    chartError.value = e instanceof Error ? e.message : String(e);
  }
}

watch(birth, recompute, { deep: true, immediate: true });

/** 四柱按展示顺序排好 */
const pillars = computed(() => {
  const c = chart.value;
  if (!c) return [];
  return [
    { key: 'year', label: '年柱', p: c.yearPillar },
    { key: 'month', label: '月柱', p: c.monthPillar },
    { key: 'day', label: '日柱', p: c.dayPillar },
    { key: 'hour', label: '时柱', p: c.hourPillar },
  ];
});

/** 五行统计（只数本气），用于展示分布 */
const fiveElements = computed(() => {
  const c = chart.value;
  if (!c) return [];
  // ★ elementCount 的键是**中文五行**（木火土金水），与命理口径一致；
  //   elementWeighted 同理。这里把两者配上一份英文元素码给喜忌表查角色。
  const rows: Array<{ label: string; code: string }> = [
    { label: '木', code: 'WOOD' },
    { label: '火', code: 'FIRE' },
    { label: '土', code: 'EARTH' },
    { label: '金', code: 'METAL' },
    { label: '水', code: 'WATER' },
  ];
  return rows.map((r) => ({
    ...r,
    count: c.elementCount[r.label as keyof typeof c.elementCount] ?? 0,
    weighted: Math.round(((c.elementWeighted?.[r.label as keyof typeof c.elementWeighted] ?? 0) as number) * 10) / 10,
    role: prefs.roles[r.code] ?? '',
  }));
});

/** 真太阳时修正的四段明细 */
const solarCorrection = computed(() => {
  const t = chart.value?.trueSolar;
  if (!t) return null;
  return {
    clock: fmtClock(t.clockTime),
    effective: fmtClock(t.trueSolarTime),
    longitudeMinutes: round1(t.longitudeCorrectionMinutes),
    eotMinutes: round1(t.equationOfTimeMinutes),
    dstMinutes: round1(t.daylightSavingMinutes),
    totalMinutes: round1(t.totalCorrectionMinutes),
    explanation: t.explanation,
  };
});

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Date → 'YYYY-MM-DD HH:mm'。不走 toLocaleString，避免不同环境格式不一致 */
function fmtClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** 四柱里带十神的展示串 */
function pillarText(p: { stem: string; branch: string }): string {
  return `${p.stem}${p.branch}`;
}

// ============================================================================
//  配色令牌
// ============================================================================

const activeTab = ref('');

/** 按 group 聚合令牌，并把「用神」那一组排在第一个 */
const groups = computed(() => {
  const map = new Map<string, typeof prefs.tokens>();
  for (const t of prefs.tokens) {
    const arr = map.get(t.group) ?? [];
    arr.push(t);
    map.set(t.group, arr);
  }
  const list = [...map.entries()].map(([name, items]) => ({ name, list: items }));
  // 用神在前、忌神在后 —— 顺手把"先调哪个"这件事说清楚
  const rank = (n: string) =>
    n.includes('用神') ? 0 : n.includes('喜神') ? 1 : n.includes('闲神') ? 2 : n.includes('忌神') ? 4 : 3;
  return list.sort((a, b) => rank(a.name) - rank(b.name));
});

const currentGroup = computed(() => groups.value.find((g) => g.name === activeTab.value));

/** 角色徽标颜色 */
function roleType(role: string): 'success' | 'warning' | 'info' | 'danger' {
  switch (role) {
    case '用神':
      return 'danger';
    case '喜神':
      return 'warning';
    case '闲神':
      return 'success';
    case '忌神':
      return 'info';
    default:
      return 'info';
  }
}

/** 对比度计算（设置页里即时校验可读性） */
function luminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const ch = [0, 1, 2].map((i) => {
    const c = parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contrastWithWhite(hex: string): number {
  try {
    const l = luminance(hex);
    return Math.round(((1.05 / (l + 0.05)) * 100)) / 100;
  } catch {
    return 0;
  }
}

/** 承载文字的令牌 —— 这些必须达 AA */
const TEXT_TOKENS = new Set([
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
]);

function contrastLevel(hex: string): { level: 'AA' | 'AAA' | '偏低'; ratio: number } {
  const ratio = contrastWithWhite(hex);
  return { level: ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : '偏低', ratio };
}

/** 色相 —— 用来判断"这个色的实际色相是不是跑出了它应有的五行区间" */
function hexToHue(hex: string): number | null {
  const h = hex.replace('#', '');
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null;
  const l = (max + min) / 2;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  if (s < 0.12) return null;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return Math.round(hue < 0 ? hue + 360 : hue);
}

/** 色相 → 五行（与后端 hueToElement 同口径） */
function hueToElementName(hue: number | null): string {
  if (hue === null) return '中性';
  if (hue < 45 || hue >= 330) return 'FIRE';
  if (hue < 70) return 'EARTH';
  if (hue < 170) return 'WOOD';
  return 'WATER';
}

/** 该令牌的实际色相是否偏离了它应有的五行 */
function hueConflict(t: { key: string; element: string }): { hue: number; actual: string } | null {
  if (t.element === 'NEUTRAL') return null;
  const hue = hexToHue(prefs.colors[t.key] ?? '');
  const actual = hueToElementName(hue);
  if (actual === '中性' || actual === t.element) return null;
  // 相邻色相可接受：火↔土、土↔木
  const adjacent =
    (t.element === 'FIRE' && actual === 'EARTH') ||
    (t.element === 'EARTH' && actual === 'FIRE') ||
    (t.element === 'EARTH' && actual === 'WOOD') ||
    (t.element === 'WOOD' && actual === 'EARTH');
  if (adjacent) return null;
  return { hue: hue ?? 0, actual };
}

function onColorChange(token: string, value: string): void {
  prefs.preview(token, value);
}

async function save(): Promise<void> {
  try {
    await prefs.save({ entityId: app.currentEntityId || null });
    ElMessage.success('偏好已保存到服务端，下次打开自动生效');
  } catch {
    ElMessage.error('保存失败，请查看提示');
  }
}

async function reset(): Promise<void> {
  try {
    await prefs.reset({ entityId: app.currentEntityId || null });
    ElMessage.success('已恢复默认配色（依八字喜用）');
  } catch {
    ElMessage.error('恢复失败');
  }
}

async function revert(): Promise<void> {
  await prefs.revert(app.currentEntityId || undefined);
  ElMessage.info('已撤销未保存的改动');
}

/** 一键把某个色系整体加深/减淡（常用调整，省得逐个改） */
function shiftFamily(family: 'wood' | 'fire' | 'earth', delta: number): void {
  const patch: Record<string, string> = {};
  for (const [token, value] of Object.entries(prefs.colors)) {
    if (!token.startsWith(family)) continue;
    const h = value.replace('#', '');
    const rgb = [0, 1, 2].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
    const next = rgb
      .map((c) => Math.max(0, Math.min(255, Math.round(c + delta))))
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('');
    patch[token] = '#' + next;
  }
  prefs.previewMany(patch);
}

// ============================================================================
//  生命周期
// ============================================================================

onMounted(async () => {
  await prefs.loadTokens();
  if (!prefs.colors[prefs.primaryToken]) {
    await prefs.load(app.currentEntityId || undefined);
  }
  activeTab.value = groups.value[0]?.name ?? '';
  recompute();
});
</script>

<template>
  <div class="bk-page" v-loading="prefs.loading">
    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 16px">
      <template #title>配色依实控人八字喜用而定</template>
      <div class="bk-hint">{{ prefs.chart || prefs.note }}</div>
      <div class="bk-hint" style="margin-top: 6px">
        <b>调色方向</b>：
        <span v-for="(g, role) in prefs.guidance" :key="role" style="margin-right: 14px">
          <el-tag size="small" :type="roleType(String(role))" effect="plain">{{ role }}</el-tag>
          {{ g }}
        </span>
      </div>
    </el-alert>

    <el-row :gutter="16">
      <!-- ══════════ 左：配色令牌 ══════════ -->
      <el-col :span="15">
        <div class="bk-card">
          <div class="bk-card__title">
            <span>配色令牌</span>
            <span class="bk-hint">
              当前来源：{{
                prefs.source === 'ENTITY' ? '本主体配置' : prefs.source === 'GLOBAL' ? '全局默认' : '内置默认'
              }}
            </span>
          </div>

          <el-tabs v-model="activeTab" type="border-card">
            <el-tab-pane v-for="g in groups" :key="g.name" :name="g.name" :label="g.name">
              <div class="token-list">
                <div v-for="t in g.list" :key="t.key" class="token-row">
                  <div class="token-row__info">
                    <div class="token-row__label">
                      {{ t.label }}
                      <el-tag size="small" :type="roleType(prefs.roles[t.element] ?? '中性')" effect="plain">
                        {{ t.element === 'NEUTRAL' ? '中性' : (prefs.elements?.[t.element] ?? t.element) }}
                      </el-tag>
                    </div>
                    <div v-if="t.note" class="bk-hint">{{ t.note }}</div>
                  </div>

                  <div class="token-row__value">
                    <span class="bk-mono">{{ prefs.colors[t.key] }}</span>
                  </div>

                  <!-- 色相与对比度：两个都会"看起来没问题但实际错了"的检查 -->
                  <div class="token-row__checks">
                    <template v-if="hueConflict(t)">
                      <el-tooltip
                        :content="`实际色相 ${hueConflict(t)!.hue}°，视觉上属${
                          { FIRE: '火', EARTH: '土', WOOD: '木', WATER: '水' }[hueConflict(t)!.actual] ?? '中性'
                        } —— 与令牌应有的五行不符。承载文字的色请调回本行区间`"
                      >
                        <el-tag size="small" type="danger" effect="plain">
                          {{ hueConflict(t)!.hue }}° 跑色
                        </el-tag>
                      </el-tooltip>
                    </template>
                    <template v-else-if="TEXT_TOKENS.has(t.key)">
                      <el-tag
                        size="small"
                        :type="contrastLevel(prefs.colors[t.key] ?? '#fff').level === '偏低' ? 'danger' : 'success'"
                        effect="plain"
                      >
                        {{ contrastLevel(prefs.colors[t.key] ?? '#fff').ratio }}
                        {{ contrastLevel(prefs.colors[t.key] ?? '#fff').level }}
                      </el-tag>
                    </template>
                    <span v-else class="bk-hint">—</span>
                  </div>

                  <div class="token-row__picker">
                    <el-color-picker
                      :model-value="prefs.colors[t.key]"
                      size="small"
                      @update:model-value="(v: string | null) => v && onColorChange(t.key, v)"
                    />
                  </div>
                </div>
              </div>

              <div class="family-actions">
                <span class="bk-hint">整体调整（减淡 / 加深）：</span>
                <el-button size="small" @click="shiftFamily('wood', 8)">木 +8</el-button>
                <el-button size="small" @click="shiftFamily('wood', -8)">木 -8</el-button>
                <el-button size="small" @click="shiftFamily('fire', 8)">火 +8</el-button>
                <el-button size="small" @click="shiftFamily('fire', -8)">火 -8</el-button>
                <el-button size="small" @click="shiftFamily('earth', 8)">土 +8</el-button>
                <el-button size="small" @click="shiftFamily('earth', -8)">土 -8</el-button>
              </div>
            </el-tab-pane>
          </el-tabs>

          <div class="actions">
            <el-button type="primary" :disabled="!prefs.dirty" @click="save">保存为全局偏好</el-button>
            <el-button :disabled="!prefs.dirty" @click="revert">撤销改动</el-button>
            <el-button @click="reset">恢复默认</el-button>
            <span v-if="prefs.dirty" class="bk-hint" style="align-self: center; margin-left: 10px">
              有未保存的改动（已在界面上实时预览）
            </span>
          </div>
        </div>
      </el-col>

      <!-- ══════════ 右：八字与五行 ══════════ -->
      <el-col :span="9">
        <!-- ── 出生信息 ───────────────────────────────── -->
        <div class="bk-card">
          <div class="bk-card__title">
            <span>公司实控人八字</span>
            <span class="bk-hint">配色依据</span>
          </div>

          <el-form label-position="top" size="small">
            <el-form-item label="历法">
              <el-radio-group v-model="birth.calendar" size="small">
                <el-radio-button value="SOLAR">公历</el-radio-button>
                <el-radio-button value="LUNAR">农历</el-radio-button>
              </el-radio-group>
              <el-checkbox v-if="birth.calendar === 'LUNAR'" v-model="birth.isLeapMonth" style="margin-left: 10px">
                闰月
              </el-checkbox>
            </el-form-item>

            <el-form-item label="出生日期与时刻">
              <div class="datetime">
                <el-input-number v-model="birth.year" :min="1900" :max="2100" :controls="false" placeholder="年" />
                <span class="sep">-</span>
                <el-input-number v-model="birth.month" :min="1" :max="12" :controls="false" />
                <span class="sep">-</span>
                <el-input-number v-model="birth.day" :min="1" :max="31" :controls="false" />
                <span class="sep" style="margin-left: 6px">　</span>
                <el-input-number v-model="birth.hour" :min="0" :max="23" :controls="false" />
                <span class="sep">:</span>
                <el-input-number v-model="birth.minute" :min="0" :max="59" :controls="false" />
              </div>
              <div class="bk-hint">按 24 小时制填<b>钟表时间</b>，不必自己换算真太阳时 —— 下一步会算。</div>
            </el-form-item>

            <el-form-item label="出生地">
              <el-select v-model="birth.cityKey" filterable style="width: 100%" @change="onCityChange">
                <el-option v-for="c in CHINA_CITIES" :key="c.key" :label="c.name" :value="c.key" />
                <el-option label="其它 / 手工填经纬度" value="CUSTOM" />
              </el-select>
            </el-form-item>

            <el-row v-if="customPlace" :gutter="8">
              <el-col :span="12">
                <el-form-item label="东经（度）">
                  <el-input-number v-model="birth.longitude" :min="-180" :max="180" :precision="2" :step="0.1" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="北纬（度）">
                  <el-input-number v-model="birth.latitude" :min="-90" :max="90" :precision="2" :step="0.1" style="width: 100%" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item>
              <el-switch v-model="birth.useTrueSolarTime" active-text="用真太阳时校正" />
              <div class="bk-hint">
                北京时是 120°E 的区时。出生地偏离这条经线时，当地真正的"太阳位置"与钟表并不一致 ——
                关掉它，时柱可能整整差一个时辰。
              </div>
            </el-form-item>

            <el-form-item label="子时日界口径（唯一会让四柱整体不同的分歧）">
              <el-radio-group v-model="birth.ziHourRule" size="small">
                <el-radio-button value="MIDNIGHT">日在子正（00:00）</el-radio-button>
                <el-radio-button value="ZI_START">日在子初（23:00）</el-radio-button>
              </el-radio-group>
              <div class="bk-hint">
                默认「子正」，与主流黄历一致；两种口径的结果下面都列出来了，可自行判断。
              </div>
            </el-form-item>
          </el-form>

          <el-alert v-if="chartError" type="error" :closable="false" show-icon>
            <div class="bk-hint">{{ chartError }}</div>
          </el-alert>
        </div>

        <!-- ── 真太阳时修正明细 ───────────────────────── -->
        <div v-if="solarCorrection" class="bk-card">
          <div class="bk-card__title">真太阳时修正</div>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="钟表时间">{{ solarCorrection.clock }}</el-descriptions-item>
            <el-descriptions-item label="经度时差">
              {{ solarCorrection.longitudeMinutes > 0 ? '+' : '' }}{{ solarCorrection.longitudeMinutes }} 分
              <span class="bk-hint">（经度偏离 120°E 的部分 × 4 分/度）</span>
            </el-descriptions-item>
            <el-descriptions-item label="均时差">
              {{ solarCorrection.eotMinutes > 0 ? '+' : '' }}{{ solarCorrection.eotMinutes }} 分
              <span class="bk-hint">（地球轨道偏心率与黄赤交角造成）</span>
            </el-descriptions-item>
            <el-descriptions-item label="夏令时补偿">
              {{ solarCorrection.dstMinutes > 0 ? '+' : '' }}{{ solarCorrection.dstMinutes }} 分
              <span class="bk-hint">（中国仅 1986–1991 年夏季实行过）</span>
            </el-descriptions-item>
            <el-descriptions-item label="合计">
              <b>{{ solarCorrection.totalMinutes > 0 ? '+' : '' }}{{ solarCorrection.totalMinutes }} 分</b>
            </el-descriptions-item>
            <el-descriptions-item label="真太阳时">
              <b class="bk-mono" style="font-size: 14px">{{ solarCorrection.effective }}</b>
            </el-descriptions-item>
          </el-descriptions>
          <div class="bk-hint" style="margin-top: 8px">{{ solarCorrection.explanation }}</div>
        </div>

        <!-- ── 四柱 ───────────────────────────────────── -->
        <div v-if="chart" class="bk-card">
          <div class="bk-card__title">
            <span>四柱</span>
            <span class="bk-hint">{{ chart.lunarText }}</span>
          </div>

          <div class="pillars">
            <div v-for="row in pillars" :key="row.key" class="pillar">
              <div class="pillar__label">{{ row.label }}</div>
              <div class="pillar__chars bk-mono">{{ pillarText(row.p) }}</div>
              <div class="pillar__meta">
                <el-tag size="small" effect="plain" :type="roleType(prefs.roles[row.p.stemElement] ?? '中性')">
                  {{ prefs.elements?.[row.p.stemElement] ?? row.p.stemElement }}
                </el-tag>
                <el-tag
                  v-if="row.p.tenGod"
                  size="small"
                  effect="plain"
                  type="info"
                  :title="`日主对${row.label}天干的十神关系`"
                >
                  {{ row.p.tenGod }}
                </el-tag>
              </div>
            </div>
          </div>

          <el-divider style="margin: 12px 0" />

          <div class="summary">
            <el-tag effect="dark" type="danger">日主 {{ chart.dayMaster }}</el-tag>
            <span class="bk-hint">
              {{ prefs.chart }}
            </span>
          </div>

          <!-- 五行分布 -->
          <div class="balance">
            <div v-for="e in fiveElements" :key="e.code" class="balance__row">
              <span class="balance__label">
                <el-tag size="small" :type="roleType(e.role)" effect="plain">{{ e.label }}</el-tag>
                <span class="bk-hint">{{ e.role }}</span>
              </span>
              <el-progress
                :percentage="Math.round((e.count / 8) * 100)"
                :stroke-width="10"
                :show-text="false"
                :color="e.role === '用神' || e.role === '喜神' ? '#376754' : '#909098'"
                style="flex: 1"
              />
              <span class="bk-mono balance__count" :title="`含藏干加权 ${e.weighted}`">{{ e.count }}</span>
            </div>
            <div class="bk-hint">
              左侧数字为八字本气个数（共 8 位），悬停可看含藏干的加权值。
              加权值只作参考 —— 命理上怎么算"旺"本身就有分歧。
            </div>
          </div>

          <!-- 节气 -->
          <el-descriptions :column="1" border size="small" style="margin-top: 10px">
            <el-descriptions-item label="生于节气">{{ chart.currentTerm.term }}</el-descriptions-item>
            <el-descriptions-item label="下个节气">{{ chart.nextTerm.term }} · {{ chart.nextTerm.at }}</el-descriptions-item>
          </el-descriptions>

          <!-- 边界警示：离节气/时辰太近，结果可能翻转 -->
          <el-alert
            v-for="(w, i) in chart.boundaryWarnings"
            :key="i"
            :type="w.kind === 'DAY' ? 'error' : 'warning'"
            :closable="false"
            show-icon
            style="margin-top: 10px"
          >
            <div class="bk-hint">
              <b>{{ w.kind === 'SOLAR_TERM' ? '节气边界' : w.kind === 'SHICHEN' ? '时辰边界' : '日界' }}</b>
              ：{{ w.message }}（距边界 {{ w.minutesToBoundary }} 分钟）
            </div>
          </el-alert>

          <!-- 另一种子时口径的结果 -->
          <el-alert type="info" :closable="false" style="margin-top: 10px">
            <template #title>另一种子时日界口径的结果</template>
            <div class="bk-hint">
              {{ chart.alternativeZiHour.ruleLabel }}：日柱
              <b class="bk-mono">{{ chart.alternativeZiHour.dayPillar }}</b>，时柱
              <b class="bk-mono">{{ chart.alternativeZiHour.hourPillar }}</b>
              <div style="margin-top: 4px">{{ chart.alternativeZiHour.note }}</div>
            </div>
          </el-alert>

          <!-- 推算口径：必须随结果一起给出 -->
          <el-collapse style="margin-top: 10px">
            <el-collapse-item title="推算口径与依据（点开看每一步怎么算的）">
              <ol class="method">
                <li v-for="(m, i) in chart.methodology" :key="i">{{ m }}</li>
              </ol>
            </el-collapse-item>
          </el-collapse>
        </div>

        <!-- ── 调整原则 ───────────────────────────────── -->
        <div class="bk-card">
          <div class="bk-card__title">调整原则</div>
          <div class="bk-hint" style="line-height: 2">
            · <b>骨架保持中性</b>：中性色饱和控制在 ≤8%，不带色相。
            界面主体泛棕泛黄会立刻显旧，这也是"商用质感"的来源。<br />
            · <b>只有一处强调色</b>：木（用神）承载品牌感，火（喜神）次之，土（闲神）只做点缀。<br />
            · <b>五行靠色相不靠饱和度</b>：低饱和的松绿依然是木，
            不必靠高饱和去"堆"五行。<br />
            · <b>承载文字的色必须达 AA</b>：右侧实时显示对比度与色相，
            标"偏低"或"跑色"的不要用于正文。
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.token-list {
  max-height: 460px;
  overflow: auto;
}

.token-row {
  display: grid;
  grid-template-columns: 1fr 92px 84px 44px;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--bk-line-2);
}

.token-row:last-child {
  border-bottom: none;
}

.token-row__label {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.token-row__value {
  text-align: right;
  color: var(--bk-ink-2);
}

.token-row__checks {
  text-align: center;
}

.token-row__picker {
  text-align: right;
}

.family-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--bk-line-2);
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 16px;
}

/* ── 出生信息表单 ── */
.datetime {
  display: flex;
  align-items: center;
  gap: 3px;
  width: 100%;
}

.datetime :deep(.el-input-number) {
  width: 62px;
}

.datetime .sep {
  color: var(--bk-ink-3);
}

/* ── 四柱 ── */
.pillars {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.pillar {
  border: 1px solid var(--bk-line);
  border-radius: 6px;
  padding: 9px 6px;
  text-align: center;
  background: var(--bk-page-bg);
}

.pillar__label {
  font-size: 12px;
  color: var(--bk-ink-3);
  margin-bottom: 4px;
}

.pillar__chars {
  font-size: 22px;
  letter-spacing: 3px;
  color: var(--bk-wood-600);
  line-height: 1.3;
}

.pillar__meta {
  display: flex;
  justify-content: center;
  gap: 4px;
  margin-top: 5px;
  flex-wrap: wrap;
}

.summary {
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 1.9;
}

.balance {
  margin-top: 12px;
}

.balance__row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.balance__label {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 92px;
  flex-shrink: 0;
}

.balance__count {
  width: 20px;
  text-align: right;
  color: var(--bk-ink-2);
}

.method {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--bk-ink-2);
}

.method li {
  margin-bottom: 4px;
}
</style>
