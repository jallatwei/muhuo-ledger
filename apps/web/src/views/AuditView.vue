<script setup lang="ts">
/**
 * 账务自检
 * ============================================================
 * 把四条账务不变式摊开给人看：
 *   I2  借方余额合计 == 贷方余额合计
 *   I3  上期期末 == 本期期初
 *   I4  本期发生额 == 该期凭证分录聚合
 *   I5  凭证号连续无空洞
 *
 * 任何时候怀疑「账不对」，先跑这个。
 */
import { onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useAppStore } from '@/stores/app';
import { auditApi, toastError } from '@/api';

const store = useAppStore();
const result = ref<Record<string, any> | null>(null);
const loading = ref(false);

async function run(): Promise<void> {
  if (!store.currentEntityId || !store.currentPeriodId) return;
  loading.value = true;
  try {
    result.value = await auditApi.selfCheck(store.currentEntityId, store.currentPeriodId);
  } catch (e) {
    toastError(e);
    result.value = null;
  } finally {
    loading.value = false;
  }
}

async function rebuild(): Promise<void> {
  loading.value = true;
  try {
    const r = await auditApi.rebuildBalances(store.currentEntityId, store.currentPeriodId);
    ElMessage.success(`已按凭证重算 ${r.rebuiltRows} 行余额，自检${r.ok ? '已通过' : '仍有问题'}`);
    await run();
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(run);
watch(() => store.currentPeriodId, run);
</script>

<template>
  <div class="bk-page" v-loading="loading">
    <div class="bk-card">
      <div class="bk-card__title">
        <span>账务自检 · {{ store.periodLabel }}</span>
        <div style="display: flex; gap: 8px">
          <el-button size="small" @click="run">重新检查</el-button>
          <el-button size="small" type="danger" plain @click="rebuild">按凭证重算余额</el-button>
        </div>
      </div>

      <el-result
        v-if="result"
        :icon="result.ok ? 'success' : 'error'"
        :title="result.ok ? '全部不变式成立' : '存在不成立的项'"
        :sub-title="result.ok ? '账务数据自洽，可以进行结账' : '请先处理下方问题，否则结账会被阻止'"
      />

      <el-table v-if="result?.results?.length" :data="result.results" size="small" border>
        <el-table-column label="不变式" width="90" align="center">
          <template #default="{ row }">
            <span class="bk-mono">{{ row.code }}</span>
          </template>
        </el-table-column>
        <el-table-column label="含义" prop="name" min-width="260" />
        <el-table-column label="结果" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.passed ? 'success' : 'danger'" effect="dark">
              {{ row.passed ? '成立' : '不成立' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="详情" prop="detail" min-width="380" show-overflow-tooltip />
      </el-table>

      <el-empty v-else description="暂无自检结果" :image-size="80" />
    </div>

    <div class="bk-card">
      <div class="bk-card__title">这些不变式为什么重要</div>
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="I2 借贷余额相等">
          每张凭证借贷相等 ⇒ 全部凭证借方发生额合计 == 贷方发生额合计；
          期初又来自上期期末，归纳基础为 0，故期末借贷余额合计必相等。
          <b>不通过说明余额表被污染</b>（手工改数、程序 bug、部分写入）。
        </el-descriptions-item>
        <el-descriptions-item label="I4 余额与分录一致">
          余额表必须能从凭证完整重算出来。不通过说明两者脱节 ——
          报表就会与明细账对不上。
        </el-descriptions-item>
        <el-descriptions-item label="I5 凭证号连续">
          凭证号在期间内必须从 1 连续无空洞。有空洞说明号段被破坏，
          凭证册装订与审计时会对不上号。
        </el-descriptions-item>
        <el-descriptions-item label="为什么可以放心重算">
          「按凭证重算余额」是<b>幂等</b>操作：先删该期间余额，再由凭证重新计算并滚动下期期初。
          任何时候怀疑余额不对，重算一次即可，不会造成数据损坏。
        </el-descriptions-item>
      </el-descriptions>
    </div>
  </div>
</template>
