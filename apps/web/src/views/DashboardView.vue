<script setup lang="ts">
/**
 * 总览
 * ============================================================
 * 一屏回答四个问题：
 *   ① 这个月记了多少账、平不平
 *   ② 有哪些票还没入账 / 需要人工确认
 *   ③ 账务自检过没过
 *   ④ AI 和数据库防线是否就位
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAppStore } from '@/stores/app';
import { aiApi, api, auditApi, toastError, voucherApi } from '@/api';
import { formatMoney } from '@bookkeeper/shared';

const store = useAppStore();
const router = useRouter();

const health = ref<Record<string, any> | null>(null);
const aiHealth = ref<Record<string, any> | null>(null);
const periodStats = ref<{ count: number; totalDebit: string; attachments: number } | null>(null);
const selfCheck = ref<Record<string, any> | null>(null);
const pendingVouchers = ref<Array<Record<string, any>>>([]);
const loading = ref(false);

const integrity = ref<Record<string, any> | null>(null);

async function load(): Promise<void> {
  if (!store.currentEntityId || !store.currentPeriodId) return;
  loading.value = true;
  try {
    const [h, ah, ps, sc, pv, integ] = await Promise.all([
      api.health(),
      aiApi.health().catch(() => null),
      voucherApi.periodSummary(store.currentEntityId, store.currentPeriodId),
      auditApi.selfCheck(store.currentEntityId, store.currentPeriodId).catch((e) => ({
        ok: false,
        results: [],
        error: e?.userMessage ?? String(e),
      })),
      voucherApi.list({
        entityId: store.currentEntityId,
        periodId: store.currentPeriodId,
        status: 'DRAFT,REVIEWING,APPROVED',
        pageSize: 20,
      }),
      api.accountIntegrity(store.currentEntityId).catch(() => null),
    ]);
    health.value = h;
    aiHealth.value = ah;
    periodStats.value = ps;
    selfCheck.value = sc;
    pendingVouchers.value = pv.items ?? [];
    integrity.value = integ;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const selfCheckOk = computed(() => selfCheck.value?.ok === true);
const blockers = computed(
  () => (selfCheck.value?.results ?? []).filter((r: Record<string, any>) => !r.passed),
);

const statusText: Record<string, string> = {
  DRAFT: '草稿',
  REVIEWING: '待审核',
  APPROVED: '已审核待过账',
  POSTED: '已过账',
  REVERSED: '已红冲',
  VOID: '已作废',
};

const statusType: Record<string, string> = {
  DRAFT: 'info',
  REVIEWING: 'warning',
  APPROVED: 'warning',
  POSTED: 'success',
  REVERSED: 'danger',
  VOID: 'info',
};

async function rebuild(): Promise<void> {
  try {
    const r = await auditApi.rebuildBalances(store.currentEntityId, store.currentPeriodId);
    ElMessage.success(`已重算 ${r.rebuiltRows} 行余额，自检${r.ok ? '通过' : '仍有问题'}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function postVoucher(id: string): Promise<void> {
  try {
    const r = await voucherApi.post(id);
    ElMessage.success(`已过账，凭证号 ${r.voucherNo}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <div class="bk-page" v-loading="loading">
    <!-- ── 关键指标 ───────────────────────────────────────────── -->
    <el-row :gutter="16">
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">本期凭证</div>
          <div class="stat__value">{{ periodStats?.count ?? 0 }} <span class="stat__unit">张</span></div>
          <div class="stat__foot">附件 {{ periodStats?.attachments ?? 0 }} 张</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">本期借方合计</div>
          <div class="stat__value bk-money" style="text-align: left">
            {{ formatMoney(periodStats?.totalDebit ?? '0') }}
          </div>
          <div class="stat__foot">{{ store.periodLabel }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">待处理凭证</div>
          <div class="stat__value" :class="{ 'stat__value--warn': pendingVouchers.length > 0 }">
            {{ pendingVouchers.length }} <span class="stat__unit">张</span>
          </div>
          <div class="stat__foot">草稿 / 待审核 / 待过账</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">账务自检</div>
          <div class="stat__value" :class="selfCheckOk ? 'stat__value--ok' : 'stat__value--bad'">
            {{ selfCheckOk ? '通过' : '未通过' }}
          </div>
          <div class="stat__foot">{{ selfCheckOk ? '不变式 I2 / I4 / I5 全部成立' : `${blockers.length} 项不成立` }}</div>
        </div>
      </el-col>
    </el-row>

    <!-- ── 自检不通过时的醒目提示 ─────────────────────────────── -->
    <el-alert
      v-if="selfCheck && !selfCheckOk"
      type="error"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    >
      <template #title>账务自检未通过，结账将被阻止</template>
      <div v-for="b in blockers" :key="b.code" class="bk-hint">
        · [{{ b.code }}] {{ b.name }}：{{ b.detail }}
      </div>
      <el-button size="small" type="danger" plain style="margin-top: 8px" @click="rebuild">
        按凭证重算余额（幂等操作）
      </el-button>
    </el-alert>

    <el-row :gutter="16">
      <!-- ── 待处理凭证 ─────────────────────────────────────── -->
      <el-col :span="15">
        <div class="bk-card">
          <div class="bk-card__title">
            <span>待处理凭证</span>
            <el-button size="small" text type="primary" @click="router.push('/vouchers')">
              查看全部
            </el-button>
          </div>
          <el-table
            v-if="pendingVouchers.length"
            :data="pendingVouchers"
            size="small"
            style="width: 100%"
          >
            <el-table-column label="摘要" prop="summary" min-width="200" show-overflow-tooltip />
            <el-table-column label="金额" width="130" align="right">
              <template #default="{ row }">
                <span class="bk-money">{{ formatMoney(row.totalDebit) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="statusType[row.status] as any">
                  {{ statusText[row.status] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="90">
              <template #default="{ row }">
                <span class="bk-hint">{{ row.sourceType === 'MANUAL' ? '手工' : '自动' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130" align="center">
              <template #default="{ row }">
                <el-button
                  size="small"
                  type="primary"
                  plain
                  @click="router.push(`/vouchers/${row.id}`)"
                >
                  打开
                </el-button>
                <el-button
                  v-if="row.status === 'APPROVED'"
                  size="small"
                  type="success"
                  @click="postVoucher(row.id)"
                >
                  过账
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="本期没有待处理的凭证" :image-size="70" />
        </div>
      </el-col>

      <!-- ── 系统状态 ───────────────────────────────────────── -->
      <el-col :span="9">
        <div class="bk-card">
          <div class="bk-card__title">系统状态</div>

          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="数据库">
              <el-tag size="small" :type="health?.database?.ok ? 'success' : 'danger'">
                {{ health?.database?.ok ? `正常 ${health.database.latencyMs}ms` : '不可用' }}
              </el-tag>
            </el-descriptions-item>

            <el-descriptions-item label="AI 识图">
              <el-tag size="small" :type="aiHealth?.reachable ? 'success' : 'danger'">
                {{ aiHealth?.provider ?? '未知' }}
              </el-tag>
              <span class="bk-hint" style="margin-left: 8px">
                {{ aiHealth?.visionModel ?? '离线样例模式' }}
              </span>
            </el-descriptions-item>

            <el-descriptions-item label="AI 成本(24h)">
              <span class="bk-money">
                ¥{{ aiHealth?.last24h?.costEstimate ?? '0.0000' }}
              </span>
              <span class="bk-hint" style="margin-left: 8px">
                {{ aiHealth?.last24h?.calls ?? 0 }} 次调用
              </span>
            </el-descriptions-item>

            <el-descriptions-item label="借贷平衡触发器">
              <el-tag size="small" :type="health?.bookkeeping?.dbConstraints ? 'success' : 'danger'">
                {{ health?.bookkeeping?.dbConstraints ? '已启用' : '已关闭' }}
              </el-tag>
            </el-descriptions-item>

            <el-descriptions-item label="自动过账">
              <el-tag size="small" :type="health?.bookkeeping?.autoPost ? 'danger' : 'success'">
                {{ health?.bookkeeping?.autoPost ? '开启（不建议）' : '关闭（推荐）' }}
              </el-tag>
            </el-descriptions-item>

            <el-descriptions-item label="科目表完整性">
              <el-tag size="small" :type="integrity?.ok ? 'success' : 'warning'">
                {{ integrity?.ok ? '全部已映射' : `${integrity?.unmappedCount ?? 0} 个未映射` }}
              </el-tag>
            </el-descriptions-item>
          </el-descriptions>

          <div class="bk-hint" style="margin-top: 12px">
            {{ health?.bookkeeping?.notes?.join('；') }}
          </div>
        </div>

        <div class="bk-card">
          <div class="bk-card__title">记账红线</div>
          <ul class="rules">
            <li><b>借贷不平</b>的凭证无法保存 —— 应用层与数据库触发器双重校验</li>
            <li>同一张单据<b>绝不重复入账</b> —— 内容哈希 + 业务唯一键 + 幂等键</li>
            <li>已结账期间<b>改不动</b> —— 要改只能反结账后红冲</li>
            <li>已过账凭证<b>不可修改</b> —— 只能红冲，保留完整痕迹</li>
            <li>自动记账只生成<b>待确认</b>凭证，人工确认后才入账</li>
          </ul>
        </div>
      </el-col>
    </el-row>
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

.stat__value--bad {
  color: var(--bk-danger);
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

.rules {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 2;
  color: var(--bk-ink-2);
}

.rules b {
  color: var(--bk-ink);
}
</style>
