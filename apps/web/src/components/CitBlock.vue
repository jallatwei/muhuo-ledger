<script setup lang="ts">
/**
 * 企业所得税底稿块
 * ============================================================
 * ★ 这个块的呈现重点不是数字，而是**哪些格子是空的、为什么空**。
 *
 *   纳税调整、税率选择、优惠适用这些需要专业判断的项目，
 *   系统刻意留空并写明依据要求。界面上必须让它们显眼 ——
 *   否则用户扫一眼看到"表格都填好了"，会以为系统已经算完了。
 */
import { formatMoney } from '@bookkeeper/shared';
import type { CitWorksheetDto } from '@/api';

defineProps<{
  sheet: CitWorksheetDto;
  srcOf: (s: string) => { text: string; type: 'success' | 'info' | 'warning' | 'danger' };
}>();

function amountText(v: string | null): string | null {
  return v === null ? null : formatMoney(v);
}
</script>

<template>
  <div class="cit-block">
    <div class="bk-card__title">
      <span>{{ sheet.title }}</span>
      <span class="bk-hint">{{ sheet.periodLabel }}</span>
    </div>

    <el-alert
      v-if="sheet.warnings.length"
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 10px"
    >
      <div v-for="(w, i) in sheet.warnings" :key="i" class="bk-hint">· {{ w }}</div>
    </el-alert>

    <el-table :data="sheet.cells" size="small" border>
      <el-table-column prop="line" label="行次" width="64" />
      <el-table-column prop="label" label="项目" min-width="180" />
      <el-table-column label="金额" width="140" align="right">
        <template #default="{ row }">
          <span v-if="amountText(row.amount) !== null" class="bk-money">
            {{ amountText(row.amount) }}
          </span>
          <span v-else class="pending-mark">待判断</span>
        </template>
      </el-table-column>
      <el-table-column label="来源" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="srcOf(row.source).type" effect="plain">
            {{ srcOf(row.source).text }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="依据 / 需要你判断什么" min-width="340">
        <template #default="{ row }">
          <span class="bk-hint">{{ row.sourceNote }}</span>
          <div v-if="row.judgement" class="judgement">⚠ {{ row.judgement }}</div>
        </template>
      </el-table-column>
    </el-table>

    <template v-if="sheet.adjustments.length">
      <div class="bk-card__title" style="margin-top: 16px">纳税调整线索（需逐项判断，系统不代填）</div>
      <div v-for="(a, i) in sheet.adjustments" :key="i" class="adj">
        <div class="adj__head">
          <b>{{ a.item }}</b>
          <span v-if="a.amount" class="bk-money">账面 {{ amountText(a.amount) }}</span>
          <el-tag size="small" type="danger" effect="plain">需判断</el-tag>
        </div>
        <div class="bk-hint adj__basis">{{ a.basis }}</div>
      </div>
    </template>

    <template v-if="sheet.preferences.length">
      <div class="bk-card__title" style="margin-top: 16px">优惠适用判断</div>
      <div v-for="(p, i) in sheet.preferences" :key="i" class="adj">
        <div class="adj__head">
          <b>{{ p.name }}</b>
          <el-tag
            size="small"
            :type="p.applicable === 'YES' ? 'success' : p.applicable === 'NO' ? 'info' : 'warning'"
            effect="plain"
          >
            {{ p.applicable === 'YES' ? '适用' : p.applicable === 'NO' ? '不适用' : '待你确认' }}
          </el-tag>
        </div>
        <div class="bk-hint adj__basis">条件：{{ p.condition }}</div>
        <div class="bk-hint adj__basis">{{ p.note }}</div>
      </div>
    </template>

    <el-alert
      v-if="sheet.requiresHumanDecision.length"
      type="error"
      :closable="false"
      show-icon
      style="margin-top: 12px"
    >
      <template #title>申报前必须由你确认的事项</template>
      <div v-for="(d, i) in sheet.requiresHumanDecision" :key="i" class="bk-hint issue">· {{ d }}</div>
    </el-alert>
  </div>
</template>

<style scoped>
.cit-block {
  margin-bottom: 20px;
}

.pending-mark {
  color: var(--bk-danger);
  font-size: 12px;
}

.judgement {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bk-danger);
}

.adj {
  padding: 8px 10px;
  border-left: 3px solid var(--bk-danger);
  background: var(--bk-fire-50);
  border-radius: 4px;
  margin-bottom: 8px;
}

.adj__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 4px;
}

.adj__basis {
  line-height: 1.8;
}

.issue {
  line-height: 1.8;
}
</style>
