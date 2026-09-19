<script setup lang="ts">
/**
 * 凭证册打印
 * ============================================================
 * 按业务约定：日常不打印，**月末结账后一次性打一本**。
 *
 * 页面设计围绕"打印前先看清能打什么"：
 *   ① 本期有几张凭证、几张原始单据、几张缺附件
 *   ② 期间是否已结账（未结账会提示可能变动）
 *   ③ 打印范围与附件策略可选
 *   ④ 生成后在浏览器新标签打开 → Ctrl+P 直接打印
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useAppStore } from '@/stores/app';
import { http, toastError } from '@/api';
import { formatMoney } from '@bookkeeper/shared';

const store = useAppStore();

const stats = ref<{
  voucherCount: number;
  withAttachment: number;
  missingAttachment: number;
  attachmentCount: number;
  periodLabel: string | null;
  periodStatus: string | null;
  printable: boolean;
  hints: string[];
} | null>(null);

const loading = ref(false);
const generating = ref(false);

// 打印选项
const attachmentMode = ref<'NONE' | 'IMAGE' | 'ALL'>('IMAGE');
const includeAccountSummary = ref(true);
const copies = ref(1);

/** 未结账时要求勾选确认，避免打出会变的凭证册 */
const unclosedConfirmed = ref(false);

const periodStatusText = computed(() => {
  const s = stats.value?.periodStatus;
  return s === 'CLOSED' ? '已结账' : s === 'CLOSING' ? '结账中' : '未结账';
});

const needsConfirm = computed(
  () => stats.value !== null && stats.value.voucherCount > 0 && stats.value.periodStatus !== 'CLOSED',
);

const canGenerate = computed(
  () => (stats.value?.printable ?? false) && (!needsConfirm.value || unclosedConfirmed.value),
);

async function load(): Promise<void> {
  if (!store.currentEntityId || !store.currentPeriodId) return;
  loading.value = true;
  try {
    stats.value = await http
      .get('/printing/voucher-book/stats', {
        params: { entityId: store.currentEntityId, periodId: store.currentPeriodId },
      })
      .then((r) => r.data);
    unclosedConfirmed.value = false;
  } catch (e) {
    toastError(e);
    stats.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => store.currentPeriodId, load);

/** 组装打印 URL */
function bookUrl(autoPrint: boolean): string {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');
  const params = new URLSearchParams({
    entityId: store.currentEntityId,
    periodId: store.currentPeriodId,
    attachmentMode: attachmentMode.value,
    includeAccountSummary: String(includeAccountSummary.value),
    copies: String(copies.value),
  });
  if (autoPrint) params.set('autoPrint', 'true');
  return `${base}/printing/voucher-book?${params.toString()}`;
}

/** 预览：新标签打开，可直接 Ctrl+P */
function preview(): void {
  window.open(bookUrl(false), '_blank');
}

/** 直接打印：打开后自动唤起打印对话框 */
function printNow(): void {
  if (needsConfirm.value && !unclosedConfirmed.value) {
    ElMessage.warning('请先确认「本期尚未结账」的提示');
    return;
  }
  generating.value = true;
  const w = window.open(bookUrl(true), '_blank');
  if (!w) {
    ElMessage.warning('浏览器拦截了新窗口。请允许弹出窗口后重试，或改用「预览」。');
  }
  generating.value = false;
}

/** 单张补打：跳转到凭证页打印 */
function printSingle(): void {
  ElMessage.info('在凭证列表中打开某张凭证，点击「打印本张」即可补打。');
}
</script>

<template>
  <div class="bk-page" v-loading="loading">
    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 16px">
      <template #title>按月打印是常规做法</template>
      <div class="bk-hint">
        日常记账不需要打印；<b>月末结账后一次性打一本</b>即可。
        凭证册会自动把每张凭证与它关联的发票原件一起打出来，按 A4 纵向装订（左侧 25mm 装订边）。
      </div>
    </el-alert>

    <!-- ── 本期可打印内容 ─────────────────────────────────── -->
    <el-row :gutter="16">
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">本期凭证</div>
          <div class="stat__value">{{ stats?.voucherCount ?? 0 }} <span class="stat__unit">张</span></div>
          <div class="stat__foot">仅收录已过账凭证</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">原始单据（发票）</div>
          <div class="stat__value">{{ stats?.attachmentCount ?? 0 }} <span class="stat__unit">张</span></div>
          <div class="stat__foot">{{ stats?.withAttachment ?? 0 }} 张凭证已关联单据</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">缺附件的凭证</div>
          <div
            class="stat__value"
            :class="{ 'stat__value--warn': (stats?.missingAttachment ?? 0) > 0 }"
          >
            {{ stats?.missingAttachment ?? 0 }} <span class="stat__unit">张</span>
          </div>
          <div class="stat__foot">自动生成的凭证应有附件</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">期间状态</div>
          <div
            class="stat__value"
            :class="stats?.periodStatus === 'CLOSED' ? 'stat__value--ok' : 'stat__value--warn'"
            style="font-size: 20px"
          >
            {{ periodStatusText }}
          </div>
          <div class="stat__foot">{{ stats?.periodLabel }}</div>
        </div>
      </el-col>
    </el-row>

    <!-- ── 打印前提示 ─────────────────────────────────────── -->
    <el-alert
      v-for="(hint, i) in stats?.hints ?? []"
      :key="i"
      :type="hint.includes('尚未结账') ? 'warning' : hint.includes('未关联原始单据') ? 'warning' : 'info'"
      :closable="false"
      show-icon
      style="margin-bottom: 8px"
    >
      <div class="bk-hint">{{ hint }}</div>
    </el-alert>

    <!-- ── 打印选项 ──────────────────────────────────────── -->
    <div class="bk-card">
      <div class="bk-card__title">打印选项</div>

      <el-form label-width="130px" label-position="left">
        <el-form-item label="附件打印范围">
          <el-radio-group v-model="attachmentMode">
            <el-radio value="NONE">仅凭证（不带单据）</el-radio>
            <el-radio value="IMAGE">凭证 + 发票图片（推荐）</el-radio>
            <el-radio value="ALL">凭证 + 全部附件</el-radio>
          </el-radio-group>
          <div class="bk-hint" style="margin-top: 4px">
            图片类附件（发票扫描件、电子发票截图）会内联进册子，打印时不会丢图。
            PDF 类附件无法可靠嵌入打印流，选「全部附件」时会在册中留一页提示单独打印。
          </div>
        </el-form-item>

        <el-form-item label="册末汇总表">
          <el-switch v-model="includeAccountSummary" />
          <span class="bk-hint" style="margin-left: 10px">
            附加科目发生额汇总表，便于装订后快速核对
          </span>
        </el-form-item>

        <el-form-item label="每张凭证份数">
          <el-input-number v-model="copies" :min="1" :max="3" />
          <span class="bk-hint" style="margin-left: 10px">
            一般 1 份；如需「记账联 + 存档联」可打 2 份
          </span>
        </el-form-item>

        <el-form-item v-if="needsConfirm" label="确认">
          <el-checkbox v-model="unclosedConfirmed">
            我确认本期尚未结账，现在打印的是<b>可能变动的</b>凭证册
          </el-checkbox>
        </el-form-item>
      </el-form>

      <div class="actions">
        <el-button type="primary" size="large" :disabled="!canGenerate" @click="printNow">
          生成并打印凭证册
        </el-button>
        <el-button size="large" :disabled="!canGenerate" @click="preview">先预览</el-button>
        <el-button size="large" @click="printSingle">补打单张凭证</el-button>
        <span v-if="!stats?.printable" class="bk-hint" style="align-self: center; margin-left: 10px">
          本期还没有已过账凭证，先完成审核与过账再打印
        </span>
      </div>

      <el-divider />

      <div class="bk-hint">
        <b>册子结构：</b>封面（含凭证号范围、张数、签字位）→ 逐张「记账凭证」页 →
        每张凭证对应的发票原件页 → 册末科目发生额汇总表。<br />
        <b>版式：</b>A4 纵向，左侧 25mm 装订边；金额等宽字体右对齐、千分位两位小数；
        凭证按「记-x」连续编号，每张凭证独立成页不跨页断开。
      </div>
    </div>

    <!-- ── 打印说明 ──────────────────────────────────────── -->
    <div class="bk-card">
      <div class="bk-card__title">打印操作说明</div>
      <el-steps :active="4" align-center>
        <el-step title="核对本期数据" description="确认凭证数与附件数，处理缺附件提示" />
        <el-step title="点击生成并打印" description="新标签页打开凭证册" />
        <el-step title="Ctrl+P" description="纸张选 A4、纵向、边距默认，不要勾选页眉页脚" />
        <el-step title="装订" description="沿左侧 25mm 装订边装订成册" />
      </el-steps>
      <div class="bk-hint" style="margin-top: 12px">
        提示：打印对话框里请关闭「页眉和页脚」，否则页边会多出网址与页码，
        影响与左侧装订边的对齐。
      </div>
    </div>
  </div>
</template>

<style scoped>
.stat__label {
  font-size: 12px;
  color: var(--bk-ink-3);
}

.stat__value {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.5;
  margin: 6px 0 2px;
}

.stat__value--ok {
  color: var(--bk-wood-500);
}

.stat__value--warn {
  color: var(--bk-earth-500);
}

.stat__unit {
  font-size: 13px;
  font-weight: 400;
  color: var(--bk-ink-3);
}

.stat__foot {
  font-size: 12px;
  color: var(--bk-ink-3);
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}
</style>
