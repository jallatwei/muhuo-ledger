<script setup lang="ts">
/**
 * 凭证列表
 * ============================================================
 * 支持按期间/状态/科目/关键字筛选，并显示本期凭证册的封面信息。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAppStore } from '@/stores/app';
import { toastError, voucherApi, type VoucherDto } from '@/api';
import { formatMoney } from '@bookkeeper/shared';

const store = useAppStore();
const router = useRouter();

const list = ref<VoucherDto[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(50);
const statusFilter = ref<string[]>([]);
const keyword = ref('');
const loading = ref(false);
const summary = ref<{ count: number; totalDebit: string; attachments: number; firstNo: number | null; lastNo: number | null } | null>(null);

const statusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'REVIEWING', label: '待审核' },
  { value: 'APPROVED', label: '已审核待过账' },
  { value: 'POSTED', label: '已过账' },
  { value: 'REVERSED', label: '已红冲' },
  { value: 'VOID', label: '已作废' },
];

const statusText = Object.fromEntries(statusOptions.map((s) => [s.value, s.label]));
const statusType: Record<string, string> = {
  DRAFT: 'info',
  REVIEWING: 'warning',
  APPROVED: 'warning',
  POSTED: 'success',
  REVERSED: 'danger',
  VOID: 'info',
};

async function load(): Promise<void> {
  if (!store.currentEntityId) return;
  loading.value = true;
  try {
    const [res, s] = await Promise.all([
      voucherApi.list({
        entityId: store.currentEntityId,
        periodId: store.currentPeriodId || undefined,
        status: statusFilter.value.length ? statusFilter.value.join(',') : undefined,
        keyword: keyword.value || undefined,
        page: page.value,
        pageSize: pageSize.value,
      }),
      store.currentPeriodId
        ? voucherApi.periodSummary(store.currentEntityId, store.currentPeriodId)
        : Promise.resolve(null),
    ]);
    list.value = res.items ?? [];
    total.value = res.total ?? 0;
    summary.value = s;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([() => store.currentPeriodId, statusFilter, () => page.value], load);

async function postVoucher(row: VoucherDto): Promise<void> {
  try {
    const r = await voucherApi.post(row.id);
    ElMessage.success(`已过账，凭证号 ${row.voucherWord}-${r.voucherNo}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <div class="bk-page" v-loading="loading">
    <!-- ── 本期凭证册概览 ─────────────────────────────────── -->
    <div v-if="summary" class="bk-card cover">
      <div class="cover__item">
        <div class="cover__label">会计期间</div>
        <div class="cover__value">{{ store.periodLabel }}</div>
      </div>
      <div class="cover__item">
        <div class="cover__label">凭证张数</div>
        <div class="cover__value">{{ summary.count }} 张</div>
      </div>
      <div class="cover__item">
        <div class="cover__label">凭证号范围</div>
        <div class="cover__value bk-mono">
          {{ summary.firstNo !== null ? `记-${summary.firstNo} ~ 记-${summary.lastNo}` : '—' }}
        </div>
      </div>
      <div class="cover__item">
        <div class="cover__label">借方合计</div>
        <div class="cover__value bk-money" style="text-align: left">
          {{ formatMoney(summary.totalDebit) }}
        </div>
      </div>
      <div class="cover__item">
        <div class="cover__label">附件张数</div>
        <div class="cover__value">{{ summary.attachments }} 张</div>
      </div>
      <div class="cover__item cover__item--actions">
        <el-button type="primary" @click="router.push('/vouchers/new')">录入凭证</el-button>
        <!-- ★ 录入凭证的另一条路：识别发票/申报表后自动生成凭证。
             放在这里而不是录入表单的标题栏 —— 它是与「录入凭证」并列的入口，
             不是表单里的辅助操作。 -->
        <el-button @click="router.push({ name: 'recognition' })">识别录入</el-button>
        <el-button @click="router.push({ name: 'print' })">打印凭证册</el-button>
      </div>
    </div>

    <div class="bk-card">
      <div class="bk-card__title">
        <span>凭证列表</span>
        <span class="bk-hint">共 {{ total }} 张</span>
      </div>

      <div class="filters">
        <el-select
          v-model="statusFilter"
          multiple
          collapse-tags
          clearable
          placeholder="状态（全部）"
          style="width: 260px"
        >
          <el-option v-for="s in statusOptions" :key="s.value" :label="s.label" :value="s.value" />
        </el-select>
        <el-input
          v-model="keyword"
          placeholder="搜索摘要 / 规则依据"
          style="width: 240px"
          clearable
          @keyup.enter="load"
        />
        <el-button type="primary" plain @click="load">查询</el-button>
      </div>

      <el-table :data="list" size="small" style="width: 100%" @row-dblclick="(row: VoucherDto) => router.push(`/vouchers/${row.id}`)">
        <el-table-column label="凭证号" width="110">
          <template #default="{ row }">
            <span class="bk-mono">
              {{ row.voucherNo > 0 ? `${row.voucherWord}-${row.voucherNo}` : `${row.voucherWord}-（草稿）` }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="日期" width="105">
          <template #default="{ row }">{{ row.voucherDate.slice(0, 10) }}</template>
        </el-table-column>
        <el-table-column label="摘要" prop="summary" min-width="220" show-overflow-tooltip />
        <el-table-column label="借方合计" width="130" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{ formatMoney(row.totalDebit) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="贷方合计" width="130" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{ formatMoney(row.totalCredit) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType[row.status] as any">
              {{ statusText[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="80">
          <template #default="{ row }">
            <span class="bk-hint">{{ row.sourceType === 'MANUAL' ? '手工' : '自动' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" align="center">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="router.push(`/vouchers/${row.id}`)">
              查看
            </el-button>
            <el-button
              v-if="row.status === 'APPROVED'"
              size="small"
              type="success"
              plain
              @click="postVoucher(row)"
            >
              过账
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-if="total > pageSize"
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next, total"
        style="margin-top: 12px; justify-content: flex-end"
      />
    </div>
  </div>
</template>

<style scoped>
.cover {
  display: flex;
  align-items: center;
  gap: 40px;
  flex-wrap: wrap;
}

.cover__label {
  font-size: 12px;
  color: var(--bk-ink-3);
  margin-bottom: 4px;
}

.cover__value {
  font-size: 17px;
  font-weight: 600;
}

.cover__item--actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.filters {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
</style>
