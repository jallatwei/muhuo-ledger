<script setup lang="ts">
/**
 * 税务填报
 * ============================================================
 * 这个页面的设计原则只有一条：**说清每个数字从哪来、哪些要人判断**。
 *
 * 三块内容，边界各不相同：
 *   ① 申报底稿  系统算得出来的都算好，每格标来源；判断项留空并写明依据要求
 *   ② 政策检索  只呈现官方原文与关键日期，不做适用性判断
 *   ③ 报销自检  机械核查出来的疑点，形态可疑 ≠ 违规
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  taxApi,
  toastError,
  type CitWorksheetDto,
  type ExpenseAuditDto,
  type PolicyRecordDto,
  type PolicySearchResultDto,
  type ReportSheetDto,
  type TaxWorksheetPackage,
  type WorksheetCell,
} from '@/api';
import { useAppStore } from '@/stores/app';
import ReportSheetBlock from '@/components/ReportSheetBlock.vue';
import CitBlock from '@/components/CitBlock.vue';
import { formatMoney } from '@bookkeeper/shared';

const store = useAppStore();

// ── 期间选择 ────────────────────────────────────────────────────────────────
const periods = ref<Array<{ id: string; fiscalYear: number; month: number; status: string }>>([]);
const year = ref<number>(new Date().getFullYear());
const month = ref<number>(1);
const cityRate = ref('0.07');

// ── 底稿 ────────────────────────────────────────────────────────────────────
const pkg = ref<TaxWorksheetPackage | null>(null);
const loading = ref(false);
const activeTab = ref('vat');

// ── 政策 ────────────────────────────────────────────────────────────────────
const policies = ref<PolicyRecordDto[]>([]);
const searchResult = ref<PolicySearchResultDto | null>(null);
const searching = ref(false);
const jurisdictions = [
  { value: 'CN-GENERAL', label: '国家层面（增值税、企业所得税）' },
  { value: 'CN-JL', label: '吉林省' },
];
const jurisdiction = ref('CN-GENERAL');

// ── 自检 ────────────────────────────────────────────────────────────────────
const audit = ref<ExpenseAuditDto | null>(null);
const auditing = ref(false);

// ============================================================================

async function loadPeriods(): Promise<void> {
  if (!store.currentEntityId) return;
  try {
    periods.value = await taxApi.periods(store.currentEntityId);
    if (periods.value.length > 0) {
      year.value = periods.value[0]!.fiscalYear;
      month.value = periods.value[0]!.month;
    }
  } catch (e) {
    toastError(e);
  }
}

async function generate(): Promise<void> {
  if (!store.currentEntityId) return;
  loading.value = true;
  try {
    pkg.value = await taxApi.worksheets({
      entityId: store.currentEntityId,
      fiscalYear: year.value,
      month: month.value,
      surtaxRates: { city: cityRate.value },
    });
    // 自动切到有内容的页签，避免用户以为没生成
    activeTab.value = pkg.value.vat.mainForm.some((c) => c.amount && c.amount !== '0.00')
      ? 'vat'
      : 'bs';
    ElMessage.success(`已生成 ${pkg.value.periodLabel} 申报底稿`);
  } catch (e) {
    toastError(e);
    pkg.value = null;
  } finally {
    loading.value = false;
  }
}

async function runSearch(): Promise<void> {
  searching.value = true;
  try {
    searchResult.value = await taxApi.searchPolicies(jurisdiction.value);
    await loadPolicies();
    ElMessage.success(
      `检索完成：新增 ${searchResult.value.policiesNew} 条、变更 ${searchResult.value.policiesChanged} 条`,
    );
  } catch (e) {
    toastError(e);
  } finally {
    searching.value = false;
  }
}

async function loadPolicies(): Promise<void> {
  try {
    policies.value = await taxApi.policies({ jurisdiction: jurisdiction.value });
  } catch (e) {
    toastError(e);
  }
}

async function runAudit(): Promise<void> {
  if (!store.currentEntityId) return;
  auditing.value = true;
  try {
    audit.value = await taxApi.expenseAudit({
      entityId: store.currentEntityId,
      fiscalYear: year.value,
      month: month.value,
    });
  } catch (e) {
    toastError(e);
  } finally {
    auditing.value = false;
  }
}

async function reviewPolicy(row: PolicyRecordDto): Promise<void> {
  try {
    await taxApi.reviewPolicy(row.id, '已在界面上确认阅读');
    await loadPolicies();
    ElMessage.success('已标记为已阅');
  } catch (e) {
    toastError(e);
  }
}

/**
 * 企业所得税底稿块。
 *
 * ★ 这个块的重点不是数字，而是**哪些格子是空的、为什么空**：
 *   纳税调整、税率选择这些需要专业判断的项目系统留空并写明依据要求，
 *   界面上必须让它们显眼，而不是让用户以为"系统算完了"。
 */

onMounted(async () => {
  await Promise.all([loadPeriods(), loadPolicies()]);
});

// ── 展示辅助 ────────────────────────────────────────────────────────────────

/** 取数来源的中文说明。★ 让用户一眼看出哪些是算的、哪些是账上的 */
const sourceMeta: Record<string, { text: string; type: 'success' | 'info' | 'warning' | 'danger' }> = {
  LEDGER: { text: '账上取数', type: 'success' },
  INVOICE: { text: '发票聚合', type: 'success' },
  PRIOR_FILING: { text: '上期申报表', type: 'info' },
  CALCULATED: { text: '计算得出', type: 'info' },
  MANUAL: { text: '人工提供', type: 'warning' },
  JUDGEMENT: { text: '需人工判断', type: 'danger' },
  UNKNOWN: { text: '待补录', type: 'warning' },
};

function srcOf(s: string) {
  return sourceMeta[s] ?? { text: s, type: 'info' as const };
}

const severityMeta: Record<string, { text: string; type: 'danger' | 'warning' | 'info'; hint: string }> = {
  VIOLATION: { text: '数据矛盾', type: 'danger', hint: '数据本身互相矛盾，必然有一处是错的' },
  SUSPICIOUS: { text: '形态可疑', type: 'warning', hint: '形态可疑但可能是正常业务，需人工确认' },
  NOTICE: { text: '仅作提示', type: 'info', hint: '供参考，通常无需处理' },
};

const reviewCount = computed(() => policies.value.filter((p) => p.needsReview).length);

/** 企业所得税底稿块的 props（子组件在同文件内定义） */
const citProps = { sheet: { type: Object, required: true }, srcOf: { type: Function, required: true } };

/** 有值的申报行（空行不展示，避免一屏都是 0） */
function nonZero(cells: WorksheetCell[]): WorksheetCell[] {
  return cells.filter((c) => (c.amount !== null && c.amount !== '0.00') || c.blocked);
}
</script>
<template>
  <div class="bk-page">
    <!-- ── 顶部：期间与免责声明 ───────────────────────────────── -->
    <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 16px">
      <template #title>这里出的是「底稿」，不是申报</template>
      <div class="bk-hint" style="line-height: 1.9">
        底稿按税局表格行次排好、每一格标明数据来源，照着填即可。
        <b>系统不做任何申报动作</b>，也不会替你决定申报口径 ——
        标注「需人工判断」的项目必须看懂之后自己填。
      </div>
    </el-alert>

    <div class="bk-card">
      <div class="bk-card__title">
        <span>选择期间</span>
        <el-button size="small" text @click="loadPeriods">刷新期间</el-button>
      </div>
      <div class="picker">
        <el-select v-model="year" style="width: 120px">
          <el-option
            v-for="y in [...new Set(periods.map((p) => p.fiscalYear))]"
            :key="y"
            :label="`${y} 年`"
            :value="y"
          />
        </el-select>
        <el-select v-model="month" style="width: 110px">
          <el-option v-for="m in 12" :key="m" :label="`${m} 月`" :value="m" />
        </el-select>
        <el-select v-model="cityRate" style="width: 210px">
          <el-option label="城建税 7%（市区）" value="0.07" />
          <el-option label="城建税 5%（县城、镇）" value="0.05" />
          <el-option label="城建税 1%（其他）" value="0.01" />
        </el-select>
        <el-button type="primary" :loading="loading" @click="generate">生成申报底稿</el-button>
        <el-button :loading="auditing" @click="runAudit">报销自检</el-button>
      </div>
      <div class="bk-hint" style="margin-top: 6px">
        附加税费的城建税税率按<b>纳税人所在地</b>分档，请按实际经营地选择。
      </div>
    </div>

    <!-- ── 数据问题 ─────────────────────────────────────────── -->
    <el-alert
      v-if="pkg && pkg.dataIssues.length"
      type="error"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    >
      <template #title>底稿生成时发现 {{ pkg.dataIssues.length }} 个数据问题</template>
      <div v-for="(w, i) in pkg.dataIssues" :key="i" class="bk-hint issue">· {{ w }}</div>
    </el-alert>

    <!-- ── 底稿页签 ─────────────────────────────────────────── -->
    <div v-if="pkg" class="bk-card">
      <div class="bk-card__title">
        <span>{{ pkg.periodLabel }} 申报底稿</span>
        <span class="bk-hint">
          生成于 {{ pkg.generatedAt.slice(0, 19).replace('T', ' ') }} ·
          期间状态 {{ pkg.periodStatus }}
          <b v-if="!pkg.currentPeriodClosed" class="warn">（未结账，数字还会变）</b>
        </span>
      </div>

      <el-tabs v-model="activeTab">
        <!-- ══ 增值税及附加 ══ -->
        <el-tab-pane label="增值税及附加" name="vat">
          <div class="bk-hint" style="margin-bottom: 8px">
            {{ pkg.vat.taxpayerKind }} ·
            「需人工判断」「待补录」的格子是<b>系统取不到数</b>的地方，原因已写在格子里。
          </div>
          <el-table :data="nonZero(pkg.vat.mainForm)" size="small" border>
            <el-table-column prop="line" label="行次" width="64" />
            <el-table-column prop="label" label="项目" min-width="200" />
            <el-table-column label="金额" width="140" align="right">
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
            <el-table-column label="依据 / 待补录原因" min-width="300">
              <template #default="{ row }">
                <span class="bk-hint">{{ row.sourceNote }}</span>
                <div v-if="row.blocked" class="blocked">⚠ {{ row.blocked }}</div>
              </template>
            </el-table-column>
          </el-table>

          <!-- 附加税费 -->
          <div class="bk-card__title" style="margin-top: 18px">附加税费</div>
          <el-row :gutter="16">
            <el-col :span="12">
              <el-table
                :data="[
                  { k: '计税依据', v: pkg.vat.surtax.base, note: pkg.vat.surtax.baseNote },
                  { k: `城建税（${pkg.vat.surtax.rates.city}）`, v: pkg.vat.surtax.city, note: '按纳税人所在地分档' },
                  { k: `教育费附加（${pkg.vat.surtax.rates.education}）`, v: pkg.vat.surtax.education, note: '' },
                  { k: `地方教育附加（${pkg.vat.surtax.rates.localEducation}）`, v: pkg.vat.surtax.localEducation, note: '' },
                  { k: '合计', v: pkg.vat.surtax.total, note: '' },
                ]"
                size="small"
                :show-header="false"
              >
                <el-table-column prop="k" width="200" />
                <el-table-column align="right" width="140">
                  <template #default="{ row }">
                    <span class="bk-money">{{ formatMoney(row.v) }}</span>
                  </template>
                </el-table-column>
                <el-table-column>
                  <template #default="{ row }"><span class="bk-hint">{{ row.note }}</span></template>
                </el-table-column>
              </el-table>
            </el-col>
            <el-col :span="12">
              <el-alert
                v-if="pkg.vat.surtax.reductionHint"
                type="info"
                :closable="false"
                show-icon
                style="margin-bottom: 10px"
              >
                <template #title>可能的减免（需你自行判断是否适用）</template>
                <div class="bk-hint">{{ pkg.vat.surtax.reductionHint }}</div>
              </el-alert>
              <div v-for="(n, i) in pkg.vat.policyNote" :key="i" class="bk-hint note">· {{ n }}</div>
            </el-col>
          </el-row>

          <!-- 附列资料一 / 二 -->
          <div class="bk-card__title" style="margin-top: 18px">附列资料一（按税率分档）</div>
          <el-table :data="pkg.vat.annex1" size="small" border>
            <el-table-column prop="taxRate" label="税率" width="100" />
            <el-table-column prop="invoiceCount" label="张数" width="80" align="right" />
            <el-table-column label="销售额" width="150" align="right">
              <template #default="{ row }">
                <span class="bk-money">{{ formatMoney(row.salesExclTax) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="销项税额" width="150" align="right">
              <template #default="{ row }">
                <span class="bk-money">{{ formatMoney(row.outputTax) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="说明" />
          </el-table>

          <div class="bk-card__title" style="margin-top: 18px">附列资料二（进项税额）</div>
          <el-table :data="pkg.vat.annex2" size="small" border>
            <el-table-column prop="item" label="项目" min-width="220" />
            <el-table-column label="金额" width="140" align="right">
              <template #default="{ row }">
                <span class="bk-money">{{ formatMoney(row.amount) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="sourceNote" label="来源" min-width="280" />
          </el-table>

          <div class="bk-card__title" style="margin-top: 18px">勾稽自检</div>
          <div v-for="(c, i) in pkg.vat.checks" :key="i" class="checkline" :class="{ 'checkline--bad': !c.ok }">
            <el-tag size="small" :type="c.ok ? 'success' : 'danger'" effect="plain">
              {{ c.ok ? '通过' : '差异' }}
            </el-tag>
            <span class="checkline__name">{{ c.name }}</span>
            <div class="bk-hint">{{ c.detail }}</div>
          </div>
        </el-tab-pane>

        <!-- ══ 资产负债表 ══ -->
        <el-tab-pane label="资产负债表" name="bs">
          <ReportSheetBlock :sheet="pkg.financial.balanceSheet" :src-of="srcOf" />
        </el-tab-pane>

        <el-tab-pane label="利润表" name="is">
          <ReportSheetBlock :sheet="pkg.financial.incomeStatement" :src-of="srcOf" />
        </el-tab-pane>

        <!-- ══ 企业所得税 ══ -->
        <el-tab-pane label="企业所得税" name="cit">
          <el-empty
            v-if="!pkg.citQuarterly && !pkg.citAnnual"
            description="本月不是季度末月（3/6/9/12），不生成企业所得税底稿。"
            :image-size="70"
          />
          <template v-else>
            <CitBlock v-if="pkg.citQuarterly" :sheet="pkg.citQuarterly" :src-of="srcOf" />
            <CitBlock v-if="pkg.citAnnual" :sheet="pkg.citAnnual" :src-of="srcOf" />
          </template>
        </el-tab-pane>
      </el-tabs>

      <div class="bk-hint" style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--bk-line)">
        {{ pkg.disclaimer }}
      </div>
    </div>

    <!-- ── 政策检索 ─────────────────────────────────────────── -->
    <div class="bk-card">
      <div class="bk-card__title">
        <span>税务政策检索</span>
        <span class="bk-hint" v-if="reviewCount > 0">
          <el-tag size="small" type="warning" effect="plain">{{ reviewCount }} 条待阅读</el-tag>
        </span>
      </div>

      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
        <template #title>只呈现原文与关键日期，不判断是否适用于你</template>
        <div class="bk-hint" style="line-height: 1.9">
          政策能不能适用，通常取决于正文里的<b>限定条件</b>（"同时符合下列条件……"）。
          系统把条件单独摘出来放在显眼位置，但<b>不替你做适用性判断</b>。
        </div>
      </el-alert>

      <div class="picker">
        <el-select v-model="jurisdiction" style="width: 280px" @change="loadPolicies">
          <el-option v-for="j in jurisdictions" :key="j.value" :label="j.label" :value="j.value" />
        </el-select>
        <el-button type="primary" :loading="searching" @click="runSearch">立即检索</el-button>
        <span class="bk-hint">每月自动检索一次；这里是手动触发</span>
      </div>

      <el-alert
        v-if="searchResult"
        :type="searchResult.status === 'SUCCESS' ? 'success' : searchResult.status === 'PARTIAL' ? 'warning' : 'error'"
        :closable="false"
        show-icon
        style="margin-top: 12px"
      >
        <template #title>
          检索{{ searchResult.status === 'SUCCESS' ? '成功' : searchResult.status === 'PARTIAL' ? '部分成功' : '失败' }}：
          新增 {{ searchResult.policiesNew }} 条 · 变更 {{ searchResult.policiesChanged }} 条 ·
          未变 {{ searchResult.unchanged }} 条
        </template>
        <div class="bk-hint">
          来源 {{ searchResult.sourcesTried }} 个（失败 {{ searchResult.sourcesFailed }} 个）·
          抓取时间 {{ searchResult.fetchedAt.slice(0, 19).replace('T', ' ') }} ·
          抓取器 {{ searchResult.fetcher }}
        </div>
        <div v-for="(w, i) in searchResult.warnings" :key="i" class="bk-hint issue">· {{ w }}</div>
        <div v-if="searchResult.changed.length" style="margin-top: 6px">
          <div v-for="(c, i) in searchResult.changed" :key="i" class="bk-hint issue">
            ⚠ 内容已变更：{{ c.title }}
          </div>
        </div>
      </el-alert>

      <el-table :data="policies" size="small" style="margin-top: 12px" border>
        <el-table-column label="政策" min-width="300">
          <template #default="{ row }">
            <div class="pol-title">
              <el-tag v-if="row.needsReview" size="small" type="warning" effect="dark">待阅</el-tag>
              <span>{{ row.title }}</span>
            </div>
            <div class="bk-hint">
              {{ row.issuer ?? row.sourceName }} · {{ row.documentNo ?? '文号未识别' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="170">
          <template #default="{ row }">
            <el-tag
              size="small"
              effect="plain"
              :type="row.status === 'EFFECTIVE' ? 'success' : row.status === 'UPCOMING' ? 'info' : 'danger'"
            >
              {{ row.displayStatus }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="施行 / 失效" width="200">
          <template #default="{ row }">
            <div class="bk-hint">
              {{ row.effectiveFrom ? row.effectiveFrom.slice(0, 10) : '未识别' }} ~
              {{ row.effectiveTo ? row.effectiveTo.slice(0, 10) : '未见失效' }}
            </div>
            <div class="bk-hint">抓取 {{ row.fetchedAt.slice(0, 10) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="税种 / 关键词" width="200">
          <template #default="{ row }">
            <el-tag v-for="t in row.taxTypes" :key="t" size="small" effect="plain" style="margin-right: 4px">
              {{ t }}
            </el-tag>
            <div class="bk-hint">{{ row.keywords.join('、') || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="限定条件（★ 最容易被忽略）" min-width="280">
          <template #default="{ row }">
            <div v-if="row.conditions.length" class="cond">
              <div v-for="(c, i) in row.conditions.slice(0, 3)" :key="i">· {{ c }}</div>
            </div>
            <span v-else class="bk-hint">正文未识别到条件句</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" align="center">
          <template #default="{ row }">
            <el-link type="primary" :href="row.sourceUrl" target="_blank">看原文</el-link>
            <el-button v-if="row.needsReview" size="small" text @click="reviewPolicy(row)">已阅</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- ── 报销自检 ─────────────────────────────────────────── -->
    <div v-if="audit" class="bk-card">
      <div class="bk-card__title">
        <span>{{ audit.periodLabel }} 报销自检</span>
        <span class="bk-hint">
          扫描 {{ audit.scope.voucherCount }} 张凭证 / {{ audit.scope.invoiceCount }} 张发票 ·
          费用合计 {{ formatMoney(audit.scope.totalExpenseAmount) }}
        </span>
      </div>

      <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 12px">
        <template #title>{{ audit.disclaimer }}</template>
      </el-alert>

      <div class="picker" style="margin-bottom: 12px">
        <el-tag type="danger" effect="dark">数据矛盾 {{ audit.summary.violationCount }}</el-tag>
        <el-tag type="warning" effect="dark">形态可疑 {{ audit.summary.suspiciousCount }}</el-tag>
        <el-tag type="info" effect="dark">仅作提示 {{ audit.summary.noticeCount }}</el-tag>
      </div>

      <el-empty v-if="!audit.findings.length" description="本期没有发现需要核实的疑点。" :image-size="70" />

      <div v-for="f in audit.findings" :key="f.ruleId + f.subjects[0]?.id" class="finding" :class="`finding--${f.severity.toLowerCase()}`">
        <div class="finding__head">
          <el-tag size="small" :type="severityMeta[f.severity].type" effect="dark">
            {{ severityMeta[f.severity].text }}
          </el-tag>
          <span class="bk-mono">{{ f.ruleId }}</span>
          <b>{{ f.title }}</b>
          <span v-if="f.amount" class="bk-money">{{ formatMoney(f.amount) }}</span>
        </div>
        <div class="finding__detail">{{ f.detail }}</div>
        <div class="finding__how">
          <b>怎么核实：</b>{{ f.howToVerify }}
        </div>
        <div class="bk-hint">依据：{{ f.basis }}</div>
      </div>
    </div>
  </div>
</template>
<style scoped>
.picker {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.issue {
  margin-top: 4px;
  line-height: 1.8;
  color: var(--bk-danger);
}

.note {
  margin-top: 6px;
  line-height: 1.8;
}

.blocked {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bk-danger);
}

.warn {
  color: var(--bk-earth-600);
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

.pol-title {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  line-height: 1.6;
}

.cond {
  font-size: 12px;
  line-height: 1.8;
  color: var(--bk-earth-700);
}

.finding {
  padding: 10px 12px;
  border-left: 3px solid var(--bk-line);
  border-radius: 4px;
  margin-bottom: 10px;
  background: var(--bk-page-bg);
}

.finding--violation {
  border-left-color: var(--bk-danger);
  background: var(--bk-fire-50);
}

.finding--suspicious {
  border-left-color: var(--bk-earth-500);
  background: var(--bk-earth-50);
}

.finding--notice {
  border-left-color: var(--bk-ink-3);
}

.finding__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex-wrap: wrap;
}

.finding__detail {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.8;
}

.finding__how {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--bk-wood-100);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.8;
}
</style>