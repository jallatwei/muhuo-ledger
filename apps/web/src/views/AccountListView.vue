<script setup lang="ts">
/**
 * 科目表
 * ============================================================
 * 展示小企业会计准则科目表，并明确标出：
 *   · 哪些是末级科目（只有这些允许记账）
 *   · 每个科目的余额方向与报表行项目映射
 *   · 增值税归集标记（决定申报表能不能自动出）
 */
import { computed, onMounted, ref } from 'vue';
import { useAppStore } from '@/stores/app';
import { api, toastError } from '@/api';

const store = useAppStore();
const keyword = ref('');
const onlyLeaf = ref(false);
const categoryFilter = ref<string[]>([]);
const integrity = ref<Record<string, any> | null>(null);
const loading = ref(false);

const categoryOptions = [
  { value: 'ASSET', label: '资产类' },
  { value: 'LIABILITY', label: '负债类' },
  { value: 'EQUITY', label: '所有者权益类' },
  { value: 'COST', label: '成本类' },
  { value: 'PROFIT_LOSS', label: '损益类' },
];

const categoryText = Object.fromEntries(categoryOptions.map((c) => [c.value, c.label]));

const filtered = computed(() =>
  store.accounts.filter((a) => {
    if (onlyLeaf.value && !a.isLeaf) return false;
    if (categoryFilter.value.length && !categoryFilter.value.includes(a.category)) return false;
    if (keyword.value) {
      const q = keyword.value.toLowerCase();
      return (
        a.code.includes(q) ||
        a.name.includes(q) ||
        a.fullName.toLowerCase().includes(q)
      );
    }
    return true;
  }),
);

const stats = computed(() => ({
  total: store.accounts.length,
  leaf: store.accounts.filter((a) => a.isLeaf).length,
  withTaxTag: store.accounts.filter((a) => a.taxTag).length,
  withAux: store.accounts.filter((a) => a.auxRequired.length > 0).length,
}));

onMounted(async () => {
  loading.value = true;
  try {
    integrity.value = await api.accountIntegrity(store.currentEntityId);
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="bk-page" v-loading="loading">
    <el-row :gutter="16" style="margin-bottom: 0">
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">科目总数</div>
          <div class="stat__value">{{ stats.total }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">末级科目（可记账）</div>
          <div class="stat__value">{{ stats.leaf }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">增值税归集科目</div>
          <div class="stat__value">{{ stats.withTaxTag }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">报表映射</div>
          <div class="stat__value" :class="integrity?.ok ? 'ok' : 'warn'">
            {{ integrity?.ok ? '完整' : `${integrity?.unmappedCount ?? 0} 个缺失` }}
          </div>
        </div>
      </el-col>
    </el-row>

    <el-alert v-if="integrity && !integrity.ok" type="warning" :closable="false" show-icon style="margin-bottom: 16px">
      <template #title>以下末级科目未设置报表行项目，报表取数会漏掉它们</template>
      <div class="bk-hint">
        {{ integrity.unmapped.map((a: any) => `${a.code} ${a.name}`).join('、') }}
      </div>
    </el-alert>

    <div class="bk-card">
      <div class="bk-card__title">
        <span>小企业会计准则科目表</span>
        <span class="bk-hint">末级科目才能记账；非末级科目在报表中自动汇总下级</span>
      </div>

      <div class="filters">
        <el-select v-model="categoryFilter" multiple collapse-tags clearable placeholder="类别（全部）" style="width: 240px">
          <el-option v-for="c in categoryOptions" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
        <el-input v-model="keyword" placeholder="搜索编码 / 名称" style="width: 220px" clearable />
        <el-checkbox v-model="onlyLeaf">只看末级科目</el-checkbox>
      </div>

      <el-table :data="filtered" size="small" height="560" style="width: 100%">
        <el-table-column label="编码" width="110">
          <template #default="{ row }">
            <span class="bk-mono" :style="{ paddingLeft: `${(row.level - 1) * 12}px` }">{{ row.code }}</span>
          </template>
        </el-table-column>
        <el-table-column label="科目名称" min-width="230">
          <template #default="{ row }">
            <span :style="{ fontWeight: row.isLeaf ? 400 : 600 }">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类别" width="100">
          <template #default="{ row }">
            <span class="bk-hint">{{ categoryText[row.category] }}</span>
          </template>
        </el-table-column>
        <el-table-column label="余额方向" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.direction === 'DEBIT' ? 'primary' : 'warning'" effect="plain">
              {{ row.direction === 'DEBIT' ? '借' : '贷' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="末级" width="70" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.isLeaf" size="small" type="success" effect="plain">可记账</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">汇总</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="辅助核算" width="140">
          <template #default="{ row }">
            <el-tag v-for="a in row.auxRequired" :key="a" size="small" effect="plain" style="margin-right: 4px">
              {{ { CUSTOMER: '客户', SUPPLIER: '供应商', EMPLOYEE: '员工', PROJECT: '项目', DEPARTMENT: '部门', CONTRACT: '合同' }[a as string] ?? a }}
            </el-tag>
            <span v-if="!row.auxRequired.length" class="bk-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="税标记" width="170">
          <template #default="{ row }">
            <span v-if="row.taxTag" class="bk-mono" style="font-size: 11px">{{ row.taxTag }}</span>
            <span v-else class="bk-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="报表行" width="170">
          <template #default="{ row }">
            <span v-if="row.reportItem" class="bk-mono" style="font-size: 11px">{{ row.reportItem }}</span>
            <span v-else class="bk-hint">—</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.stat__label {
  font-size: 12px;
  color: var(--bk-ink-3);
}

.stat__value {
  font-size: 24px;
  font-weight: 600;
  margin-top: 6px;
}

.ok {
  color: var(--bk-wood-500);
}

.warn {
  color: var(--bk-earth-500);
}

.filters {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
</style>
