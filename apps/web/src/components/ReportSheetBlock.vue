<script setup lang="ts">
/**
 * 报表展示块（资产负债表 / 利润表共用）
 * ============================================================
 * 这个组件的核心职责不是"把表格画出来"，而是**让每个数字都能追溯**：
 *   · 标出来源（账上取数 / 计算得出）
 *   · 账上取数的行可以展开看它由哪些科目的余额加总而成
 *   · 表内勾稽不通过时显式报出来，而不是悄悄显示一个平的数字
 */
import { ref } from 'vue';
import { formatMoney } from '@bookkeeper/shared';
import type { ReportSheetDto } from '@/api';

const props = defineProps<{
  sheet: ReportSheetDto;
  srcOf: (s: string) => { text: string; type: 'success' | 'info' | 'warning' | 'danger' };
}>();

/** 只看有金额的行：全 0 的行列出来只会淹没重点 */
const showAll = ref(false);
const rows = () => (showAll.value ? props.sheet.rows : props.sheet.rows.filter((r) => r.amount && r.amount !== '0.00'));
</script>

<template>
  <div>
    <div class="bk-hint" style="margin-bottom: 8px">
      {{ sheet.formNo }} · {{ sheet.periodLabel }} · 单位：{{ sheet.unit }} ——
      金额为空的科目行不显示（零余额科目不入表）
      <el-checkbox v-model="showAll" size="small" style="margin-left: 10px">显示全部行</el-checkbox>
    </div>

    <el-table :data="rows()" size="small" border>
      <el-table-column prop="lineNo" label="行次" width="64" />
      <el-table-column label="项目" min-width="200">
        <template #default="{ row }">
          <span :class="{ 'row-strong': row.highlight }">{{ row.label }}</span>
          <div v-if="row.note" class="bk-hint">{{ row.note }}</div>
        </template>
      </el-table-column>
      <el-table-column label="金额" width="150" align="right">
        <template #default="{ row }">
          <span v-if="row.amount !== null" class="bk-money">{{ formatMoney(row.amount) }}</span>
          <span v-else class="bk-hint">—</span>
        </template>
      </el-table-column>
      <el-table-column label="来源" width="106">
        <template #default="{ row }">
          <el-tag size="small" :type="srcOf(row.source).type" effect="plain">
            {{ srcOf(row.source).text }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="科目构成（点开看这个数由哪些科目加总）" min-width="300">
        <template #default="{ row }">
          <el-popover v-if="row.accounts && row.accounts.length" trigger="click" width="440">
            <template #reference>
              <el-link type="primary">{{ row.accounts.length }} 个科目</el-link>
            </template>
            <el-table :data="row.accounts" size="small" :show-header="false">
              <el-table-column prop="code" width="90" />
              <el-table-column prop="name" />
              <el-table-column align="right" width="130">
                <template #default="{ row: a }">
                  <span class="bk-money">{{ formatMoney(a.amount) }}</span>
                </template>
              </el-table-column>
            </el-table>
          </el-popover>
          <span v-else class="bk-hint">
            {{ row.source === 'CALCULATED' ? '由其他行计算得出' : '—' }}
          </span>
        </template>
      </el-table-column>
    </el-table>

    <div class="bk-card__title" style="margin-top: 16px">表内勾稽自检</div>
    <div v-for="(c, i) in sheet.checks" :key="i" class="checkline" :class="{ 'checkline--bad': !c.ok }">
      <el-tag size="small" :type="c.ok ? 'success' : 'danger'" effect="plain">
        {{ c.ok ? '通过' : '不通过' }}
      </el-tag>
      <span class="checkline__name">{{ c.name }}</span>
      <div class="bk-hint">
        {{ c.detail }}
        <span v-if="c.expected !== undefined && !c.ok">（期望 {{ c.expected }}，实际 {{ c.actual }}）</span>
      </div>
    </div>

    <div v-for="(w, i) in sheet.warnings" :key="`w${i}`" class="bk-hint issue">⚠ {{ w }}</div>
  </div>
</template>

<style scoped>
.row-strong {
  font-weight: 600;
}

.checkline {
  padding: 6px 10px;
  border-left: 3px solid var(--bk-wood-500);
  background: var(--bk-wood-100);
  border-radius: 4px;
  margin-bottom: 6px;
}

.checkline--bad {
  border-left-color: var(--bk-danger);
  background: var(--bk-fire-50);
}

.checkline__name {
  margin-left: 8px;
  font-size: 13px;
}

.issue {
  margin-top: 6px;
  line-height: 1.8;
  color: var(--bk-danger);
}
</style>
