<script setup lang="ts">
/**
 * 识别录入
 * ============================================================
 * 这是「录入凭证」下的第二个入口（另一个是手工录入）。
 * 它承担两类识别，二者的下游完全不同：
 *
 *   【单据类】发票 / 银行回单 / 银行流水
 *     识别 → 会计交叉校验 → 生成待确认凭证 → 影响账簿。
 *
 *   【报表类】资产负债表 / 利润表 / 纳税申报表
 *     识别 → 平衡与勾稽校验 → **只建档** → 供期初建账取数。
 *     报表是"结果"、凭证是"原因"。拿资产负债表期末数去生成凭证，
 *     会把明细账里已有的资产再确认一遍 —— 所以报表这条路径绝不入账。
 *
 * 两种模式都遵循同一个原则：模型只负责"抄"，校验与金额计算由系统做。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  aiApi,
  statementApi,
  toastError,
  type ExtractResult,
  type ExtractTargetMeta,
  type ExtractTargetType,
  type DeclaredStatementSummary,
  type DocClassification,
  type ValidationFinding,
  type RecognizeResult,
  type SavedStatement,
  type StatementItemRow,
} from '@/api';
import { useAppStore } from '@/stores/app';
import { formatMoney, toChineseUppercase } from '@bookkeeper/shared';

const store = useAppStore();

// ── 状态 ────────────────────────────────────────────────────────────────────
const targets = ref<ExtractTargetMeta[]>([]);
const targetType = ref<ExtractTargetType>('INVOICE');

/**
 * ★ 识别目标默认由**系统按文件内容自动判定**，用户不必先想清楚"这是发票还是报表"。
 *
 * 只有两种情况才需要人工介入：
 *   ① 系统判不出来（例如纯图片没有文本层）→ 强制要求选
 *   ② 用户不同意系统的判断 → 手工覆盖
 *
 * 为什么不默认为手动选：多数人并不知道"纳税申报表"和"利润表"要分两条管道，
 * 让他先选只会增加出错面。自动判定 + 可覆盖才是对的默认值。
 */
const manualTarget = ref(false);
/** 系统判定结果 */
const classification = ref<DocClassification | null>(null);

/** 系统判不出来、必须人工选 */
const mustChooseTarget = computed(
  () => classification.value !== null && classification.value.targetType === null,
);

/**
 * 识别结果的预览。
 * ★ 系统判不出来时为 null（没有识别，也就没有结果可看）——
 *   模板里必须走这个 computed，不能直接摸 result.preview。
 */
const preview = computed<ExtractResult["preview"] | null>(() => result.value?.preview ?? null);
const previewData = computed<Record<string, unknown>>(() => preview.value?.data ?? {});
const findings = computed<ValidationFinding[]>(() => result.value?.validation?.findings ?? []);
const samples = ref<Array<{ key: string; label: string; covers: string }>>([]);
const providerNote = ref('');

const sourceMode = ref<'FILE' | 'SAMPLE'>('FILE');
/** el-upload 实例，用于换文件前清空其内部 selected 列表 */
const uploadRef = ref<{ clearFiles: () => void } | null>(null);
const selectedCase = ref<string>('purchase-office-supplies');
const fileList = ref<File[]>([]);

const result = ref<RecognizeResult | ExtractResult | null>(null);
const ingested = computed(() =>
  result.value && 'ingested' in result.value ? result.value.ingested : null,
);
const loading = ref(false);
const saving = ref(false);

/** 人工确认的报表期间（识别不出来时必须补） */
const periodOverride = ref<string>('');
/**
 * 申报表类型。
 *
 * 增值税与企业所得税的申报表行次完全不同，落库后也进不同的字段组
 * （history_filing_record 里 vat* 与 cit* 是两套字段）。
 * 识别阶段虽由模型读表，但归档口径必须由人指定 ——
 * 让模型猜"这是增值税还是所得税"，猜错了数据就进错字段。
 */
const filingType = ref<'VAT_MONTHLY' | 'VAT_QUARTERLY' | 'CIT_QUARTERLY' | 'CIT_ANNUAL'>(
  'VAT_MONTHLY',
);
const reconNote = ref('');

const archived = ref<SavedStatement[]>([]);
const filings = ref<Array<Record<string, unknown>>>([]);
/** 已建档报表被期初建账取用的明细 —— 回答"我上传的表到底用上了没有" */
const declared = ref<DeclaredStatementSummary | null>(null);
const isStatement = computed(() =>
  ['BALANCE_SHEET', 'INCOME_STATEMENT', 'TAX_RETURN'].includes(targetType.value),
);
const currentTarget = computed(() => targets.value.find((t) => t.value === targetType.value));

// ── 目标类型 ────────────────────────────────────────────────────────────────
async function loadTargets(): Promise<void> {
  try {
    targets.value = await aiApi.targets();
  } catch (e) {
    toastError(e);
  }
}

/**
 * 用户手工改了识别目标 → 之后不再自动判定。
 *
 * ★ 这个"黏性"是必要的：一旦用户表达过意见，系统就不该在下次上传时
 *   把他的选择悄悄改回去。
 */
function onTargetChange(): void {
  manualTarget.value = true;
  result.value = null;
  periodOverride.value = '';
  reconNote.value = '';
  const first = samplesForTarget.value[0];
  if (first) selectedCase.value = first.key;
}

/** 交回系统判定 */
function backToAuto(): void {
  manualTarget.value = false;
  classification.value = null;
  result.value = null;
  fileList.value = [];
}

/** 样例按目标类型过滤 —— 否则选了"资产负债表"却只能跑发票样例 */
const samplesForTarget = computed(() => {
  const kw: Record<string, string[]> = {
    INVOICE: ['发票', '购销', '红字', '金额'],
    BANK_SLIP: ['回单', '银行'],
    BANK_STATEMENT: ['流水', '银行'],
    BALANCE_SHEET: ['资产负债表'],
    INCOME_STATEMENT: ['利润表'],
    TAX_RETURN: ['申报', '增值税'],
  };
  const keys = kw[targetType.value] ?? [];
  const hit = samples.value.filter(
    (s) => keys.some((k) => s.label.includes(k) || s.covers.includes(k)),
  );
  return hit.length > 0 ? hit : samples.value;
});

async function loadSamples(): Promise<void> {
  try {
    const r = await aiApi.samples();
    samples.value = r.samples;
    providerNote.value = r.note;
    const first = samplesForTarget.value[0];
    if (first) selectedCase.value = first.key;
  } catch (e) {
    toastError(e);
  }
}

// ── 识别 ────────────────────────────────────────────────────────────────────

/**
 * el-upload 的回调。
 * auto-upload=false + show-file-list=false：我们只要拿到原始 File，
 * 上传时机由「识别」动作决定 —— 用户没选对目标类型之前不该发起请求。
 *
 * ★ uploadRef.clearFiles() 是必须的：el-upload 内部有 selected 列表，
 *   不清掉的话用户第二次选文件会被 limit 拦住（而文件列表是隐藏的，
 *   用户只会看到"选了但没反应"这种没有反馈的失败）。所以干脆不设 limit，
 *   每次替换前先清空内部状态，把"换文件"变成永远可用的操作。
 */
function onUploadChange(uploadFile: { raw?: File }): void {
  const raw = uploadFile?.raw;
  if (!raw) return;
  uploadRef.value?.clearFiles();
  fileList.value = [raw];
  void runRecognize();
}

/** 清空已选文件，回到"等待选择"状态 */
function clearFile(): void {
  uploadRef.value?.clearFiles();
  fileList.value = [];
  result.value = null;
}

async function runRecognize(): Promise<void> {
  if (!store.currentEntityId) {
    ElMessage.warning('请先在右上角选择账套主体');
    return;
  }
  const file = fileList.value[0];
  if (!file) {
    ElMessage.warning('请先选择要识别的文件（图片 / PDF / Excel / CSV）');
    return;
  }

  loading.value = true;
  result.value = null;
  try {
      // ★ 人工没指定时不传 targetType —— 让服务端按内容判定。
      //   传空串会让后端以为"用户选了"从而跳过自动判定。
      const res = await aiApi.recognize(
        store.currentEntityId,
        file,
        manualTarget.value ? targetType.value : undefined,
      );
      result.value = res;
      classification.value = res.classification;

      // 系统判出来了 → 把选择器同步到判定结果，用户要改时从这里改起
      if (res.classification?.targetType) {
        targetType.value = res.classification.targetType;
      }
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

async function runSample(): Promise<void> {
  if (!store.currentEntityId) return;
  loading.value = true;
  result.value = null;
  try {
    result.value = await aiApi.extract(
      store.currentEntityId,
      selectedCase.value,
      targetType.value,
    );
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

// ── 保存（仅报表类） ─────────────────────────────────────────────────────────
const previewItems = computed<StatementItemRow[]>(() => {
  const raw = result.value?.preview?.data?.items;
  if (!Array.isArray(raw)) return [];

  const out: StatementItemRow[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const label = String(o.label ?? o.name ?? '').trim();
    if (label === '') continue; // 没有项目名的行没有意义，直接丢掉
    out.push({
      lineNo: o.lineNo === null || o.lineNo === undefined ? null : String(o.lineNo),
      label,
      endBalance: moneyOrNull(o.endBalance),
      beginBalance: moneyOrNull(o.beginBalance),
    });
  }
  return out;
});

/** 识别出来的期间，作为人工确认的默认值 */
const detectedPeriod = computed<string>(() => {
  const d = (result.value?.preview?.data ?? {}) as Record<string, unknown>;
  const raw = d.periodEnd ?? d.periodStart ?? d.date;
  return raw ? String(raw) : '';
});

async function saveStatement(): Promise<void> {
  if (!result.value || !store.currentEntityId) return;

  const periodEnd = (periodOverride.value || detectedPeriod.value || '').trim();
  if (!periodEnd) {
    ElMessage.warning('请先填写报表所属期间（如 2024-12-31），否则数据归不到年份上');
    return;
  }

  const v = result.value.validation;
  // ★ 不平衡的报表要人工显式确认，不允许悄悄存进去
  if (v?.balanced === false) {
    try {
      await ElMessageBox.confirm(
        '该报表资产与负债+权益相差 ' +
          (v.balanceDifference ?? '（未给出）') +
          '。\n\n系统不会做平衡修正 —— 存档后差额会原样保留并写入备注。\n' +
          '请在下方"存档备注"中说明原因（例如：原表确实如此 / 某行识别有误）。',
        '报表不平衡，确认仍要存档？',
        { type: 'warning', confirmButtonText: '仍然存档', cancelButtonText: '先核对' },
      );
    } catch {
      return;
    }
  }

  saving.value = true;
  try {
    const data = previewData.value;
    const res = await statementApi.save({
      entityId: store.currentEntityId,
      statementType: targetType.value,
      periodStart: strOrNull(data.periodStart),
      periodEnd,
      items: previewItems.value,
      totals: {
        totalAssets: moneyOrNull(data.totalAssets),
        totalLiabilities: moneyOrNull(data.totalLiabilities),
        totalEquity: moneyOrNull(data.totalEquity),
        revenue: moneyOrNull(data.revenue),
        cost: moneyOrNull(data.cost),
        profitBeforeTax: moneyOrNull(data.profitBeforeTax),
        netProfit: moneyOrNull(data.netProfit),
      },
      isBalanced: v?.balanced ?? null,
      balanceDifference: v?.balanceDifference ?? null,
      reconNote: reconNote.value || null,
      filingType: targetType.value === 'TAX_RETURN' ? filingType.value : undefined,
      rawRow: data,
    });

    ElMessage.success(
      (res.created ? '已建档：' : '已覆盖原有档案：') + res.periodLabel,
    );
    for (const w of res.warnings) ElMessage.warning({ message: w, duration: 6000 });
    await loadArchived();
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

// ── 档案清单 ────────────────────────────────────────────────────────────────
async function loadArchived(): Promise<void> {
  if (!store.currentEntityId) return;
  try {
    const [st, fl] = await Promise.all([
      statementApi.list(store.currentEntityId),
      statementApi.listFilings(store.currentEntityId),
    ]);
    archived.value = st;
    filings.value = fl as Array<Record<string, unknown>>;
    // 取用明细：用当前年做目标年（期初建账通常启用在本年或下一年）
    declared.value = await statementApi.declared(
      store.currentEntityId,
      new Date().getFullYear(),
    );
  } catch (e) {
    toastError(e);
  }
}

async function removeStatement(row: SavedStatement): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '确认删除 ' +
        statementLabel(row.statementType) +
        '（' +
        String(row.statementDate).slice(0, 10) +
        '）这份档案？\n\n删除后它将不再参与期初建账。',
      '删除报表档案',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await statementApi.remove(row.id, store.currentEntityId);
    ElMessage.success('已删除');
    await loadArchived();
  } catch (e) {
    toastError(e);
  }
}

// ── 展示辅助 ────────────────────────────────────────────────────────────────
function levelType(level: string): string {
  return level === 'FAIL'
    ? 'danger'
    : level === 'WARN'
      ? 'warning'
      : level === 'PASS'
        ? 'success'
        : 'info';
}

function levelText(level: string): string {
  return level === 'FAIL' ? '不通过' : level === 'WARN' ? '告警' : level === 'PASS' ? '通过' : '提示';
}

function statementLabel(t: string): string {
  const map: Record<string, string> = {
    BALANCE_SHEET: '资产负债表',
    INCOME_STATEMENT: '利润表',
    CASH_FLOW: '现金流量表',
    VAT_MONTHLY: '增值税月报',
    VAT_QUARTERLY: '增值税季报',
    CIT_QUARTERLY: '企业所得税季度预缴',
    CIT_ANNUAL: '企业所得税汇算清缴',
    SURTAX: '附加税费',
    STAMP_DUTY: '印花税',
  };
  return map[t] ?? t;
}

const invoiceFields = [
  {
    key: 'direction',
    label: '方向',
    format: (v: unknown) =>
      v === 'INPUT' ? '进项' : v === 'OUTPUT' ? '销项' : String(v ?? '—'),
  },
  { key: 'category', label: '票种' },
  { key: 'invoiceCode', label: '发票代码' },
  { key: 'invoiceNumber', label: '发票号码' },
  { key: 'invoiceDate', label: '开票日期' },
  { key: 'sellerName', label: '销售方' },
  { key: 'sellerTaxNo', label: '销售方税号' },
  { key: 'buyerName', label: '购买方' },
  { key: 'buyerTaxNo', label: '购买方税号' },
  { key: 'amountExclTax', label: '不含税金额', money: true },
  { key: 'taxRate', label: '税率' },
  { key: 'taxAmount', label: '税额', money: true },
  { key: 'amountInclTax', label: '价税合计', money: true },
  { key: 'isRedFlushed', label: '红字发票', format: (v: unknown) => (v ? '是' : '否') },
];

/** 报表类的表头字段（与发票完全不同） */
const statementFields = [
  { key: 'periodStart', label: '期间起' },
  { key: 'periodEnd', label: '期间止' },
  {
    key: 'unit',
    label: '表内单位',
    format: (v: unknown) => (v ? String(v) + '（系统按元记账）' : '元'),
  },
  { key: 'totalAssets', label: '资产总计', money: true, bs: true },
  { key: 'totalLiabilities', label: '负债合计', money: true, bs: true },
  { key: 'totalEquity', label: '所有者权益合计', money: true, bs: true },
  { key: 'revenue', label: '营业收入', money: true, is: true },
  { key: 'cost', label: '营业成本', money: true, is: true },
  { key: 'profitBeforeTax', label: '利润总额', money: true, is: true },
  { key: 'netProfit', label: '净利润', money: true, is: true },
];

/** 增值税申报表主表关键行次（识别到才显示） */
const vatLines = [
  { key: 'line1SalesTaxable', label: '第1行 按适用税率计税销售额' },
  { key: 'line5SalesSimple', label: '第5行 按简易办法计税销售额' },
  { key: 'line8SalesExempt', label: '第8行 免税销售额' },
  { key: 'line11OutputTax', label: '第11行 销项税额' },
  { key: 'line12InputTax', label: '第12行 进项税额' },
  { key: 'line13CreditBroughtForward', label: '第13行 上期留抵税额' },
  { key: 'line14InputTaxTransferOut', label: '第14行 进项税额转出' },
  { key: 'line17DeductibleTotal', label: '第17行 应抵扣税额合计' },
  { key: 'line18ActualDeducted', label: '第18行 实际抵扣税额' },
  { key: 'line19TaxPayable', label: '第19行 应纳税额' },
  { key: 'line20CreditCarriedForward', label: '第20行 期末留抵税额' },
  { key: 'line24TaxPayableTotal', label: '第24行 应纳税额合计' },
  { key: 'line25OpeningUnpaid', label: '第25行 期初未缴税额' },
  { key: 'line27TaxPaidThisPeriod', label: '第27行 本期已缴税额' },
  { key: 'line32ClosingUnpaid', label: '第32行 期末未缴税额' },
  { key: 'line34PayableOrRefund', label: '第34行 本期应补(退)税额' },
  { key: 'surtaxBase', label: '附加税费 计税(费)依据' },
  { key: 'surtaxCity', label: '附加税费 城建税' },
  { key: 'surtaxEducation', label: '附加税费 教育费附加' },
  { key: 'surtaxLocalEducation', label: '附加税费 地方教育附加' },
  { key: 'surtaxTotal', label: '附加税费 合计' },
];

const visibleVatLines = computed(() =>
  vatLines.filter((l) => {
    const v = fieldValue(l.key);
    return v !== null && v !== undefined && String(v).trim() !== '';
  }),
);

const visibleFields = computed(() => {
  if (!isStatement.value) return invoiceFields;
  if (targetType.value === 'TAX_RETURN') {
    return statementFields.filter((f) => f.key === 'periodStart' || f.key === 'periodEnd');
  }
  const isBs = targetType.value === 'BALANCE_SHEET';
  return statementFields.filter((f) => (isBs ? !('is' in f) : !('bs' in f)));
});

function fieldValue(key: string): unknown {
  return previewData.value[key];
}

function fieldConf(key: string): number | undefined {
  return preview.value?.fieldConfidence?.[key];
}

function moneyOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === '-' || s === '—' ? null : s;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

onMounted(async () => {
  await Promise.all([loadTargets(), loadSamples(), loadArchived()]);
});
</script>
<template>
  <div class="bk-page" v-loading="loading">
    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 16px">
      <template #title>识别录入：上传票 / 表 → 抽取 → 校验</template>
      <div class="bk-hint">
        {{ providerNote }}
        <br />
        <b>模型会看错，但会计恒等式不会骗人。</b>
        单据类识别结果必须通过金额勾稽、税率合法性、购销方一致性校验才允许记账；
        报表类则通过平衡与勾稽校验，<b>只建档不入账</b>。
      </div>
    </el-alert>

    <!-- ── ① 识别目标：默认由系统判定 ─────────────────────────── -->
    <div class="bk-card">
      <div class="bk-card__title">
        <span>① 识别目标</span>
        <el-tag v-if="!manualTarget" type="success" effect="plain" size="small">系统自动判定</el-tag>
        <el-tag v-else type="warning" effect="plain" size="small">你已手工指定</el-tag>
      </div>

      <!-- 系统判定结果 -->
      <template v-if="classification">
        <div class="cls">
          <div class="cls__head">
            <b>{{ classification.label || '未识别出类型' }}</b>
            <el-tag
              v-if="classification.targetType"
              size="small"
              :type="classification.confidence >= 0.9 ? 'success' : 'warning'"
              effect="plain"
            >
              置信度 {{ (classification.confidence * 100).toFixed(0) }}%
            </el-tag>
          </div>
          <div class="bk-hint cls__reason">{{ classification.reason }}</div>

          <!-- 判定依据：判错时用户能立刻看出是哪一步的问题 -->
          <el-collapse v-if="classification.evidence.length" class="cls__evidence">
            <el-collapse-item :title="`判定依据（${classification.evidence.length} 条）`">
              <div v-for="(ev, i) in classification.evidence" :key="i" class="cls__ev">
                <el-tag size="small" effect="plain" :type="ev.strength === 'FILE_TYPE' ? 'info' : ev.strength === 'TITLE' ? 'success' : 'warning'">
                  {{ ev.strength === 'FILE_TYPE' ? '文件类型' : ev.strength === 'TITLE' ? '标题' : '字段' }}
                </el-tag>
                <span>{{ ev.signal }}</span>
              </div>
            </el-collapse-item>
          </el-collapse>

          <!-- 与人工选择冲突时提醒 -->
          <el-alert
            v-if="classification.conflictsWithUserChoice"
            type="warning"
            :closable="false"
            show-icon
            style="margin-top: 8px"
          >
            <template #title>你的选择与系统判定不一致</template>
            <div class="bk-hint">
              系统判定为「{{ classification.label }}」，你选了别的。以你的选择为准 ——
              但若不确定，建议改用系统判定。
            </div>
          </el-alert>

          <!-- 判不出来：必须人工选 -->
          <el-alert
            v-if="mustChooseTarget"
            type="error"
            :closable="false"
            show-icon
            style="margin-top: 8px"
          >
            <template #title>系统判不出来，请你选一下</template>
            <div class="bk-hint">{{ classification.hint }}</div>
          </el-alert>
        </div>
      </template>

      <div v-else class="bk-hint" style="margin-bottom: 10px">
        上传文件后，系统会按**文件格式与内容**自动判定这是发票、回单还是报表 ——
        你不需要先想清楚。判不出来时会让你选。
      </div>

      <!-- 识别目标选择器：判不出来、或用户要覆盖时才展开 -->
      <div v-if="mustChooseTarget || manualTarget || !classification" class="picker">
        <el-select v-model="targetType" style="width: 280px" @change="onTargetChange">
          <el-option-group label="单据（识别后可生成凭证）">
            <el-option
              v-for="t in targets.filter((x) => x.group === '单据')"
              :key="t.value"
              :label="t.label"
              :value="t.value"
            />
          </el-option-group>
          <el-option-group label="报表（只建档，不生成凭证）">
            <el-option
              v-for="t in targets.filter((x) => x.group === '报表')"
              :key="t.value"
              :label="t.label"
              :value="t.value"
            />
          </el-option-group>
        </el-select>

        <el-tag v-if="isStatement" type="warning" effect="plain" size="small">
          报表只建档，不生成凭证
        </el-tag>
        <span class="bk-hint">{{ currentTarget?.hint }}</span>
      </div>

      <div v-else class="picker">
        <el-button size="small" text @click="manualTarget = true">改成手工指定</el-button>
      </div>

      <div v-if="manualTarget && classification" class="picker" style="margin-top: 6px">
        <el-button size="small" text type="primary" @click="backToAuto">交回系统自动判定</el-button>
      </div>
    </div>

    <!-- ── ② 提供票 / 表 ──────────────────────────────────────── -->
    <div class="bk-card">
      <div class="bk-card__title">
        <span>② 提供票 / 表</span>
        <el-radio-group v-model="sourceMode" size="small" @change="result = null">
          <el-radio-button value="FILE">上传文件</el-radio-button>
          <el-radio-button value="SAMPLE">内置样例</el-radio-button>
        </el-radio-group>
      </div>

      <!-- 上传真实文件 -->
      <div v-if="sourceMode === 'FILE'" class="picker picker--col">
        <el-upload
          ref="uploadRef"
          drag
          :auto-upload="false"
          :show-file-list="false"
          accept=".png,.jpg,.jpeg,.webp,.bmp,.pdf,.xlsx,.xlsm,.csv,.txt"
          :on-change="onUploadChange"
        >
          <div class="upload">
            <div class="upload__icon">＋</div>
            <div class="upload__text">把文件拖到这里，或<b>点击选择</b></div>
            <div class="bk-hint">支持 图片（png / jpg / webp）、PDF、Excel（xlsx）、CSV</div>
          </div>
        </el-upload>

        <div v-if="fileList.length" class="picker">
          <el-tag type="success" effect="plain">{{ fileList[0]!.name }}</el-tag>
          <span class="bk-hint">{{ (fileList[0]!.size / 1024).toFixed(0) }} KB</span>
          <el-button type="primary" :loading="loading" @click="runRecognize">重新识别</el-button>
          <el-button text @click="clearFile">换一个文件</el-button>
        </div>

        <el-alert type="info" :closable="false" class="tip">
          <div class="bk-hint">
            <b>文件是怎么被读进来的，直接决定识别准不准：</b>
            <br />· 图片 → 多模态视觉识别
            <br />· PDF → 优先读文本层（更准、更省 token），扫描件无文本层时才转视觉识别
            <br />· Excel / CSV → 逐单元格精确读取，<b>零识别误差</b>
            <br />&nbsp;&nbsp;（财务报表多来自代账公司的 Excel，<b>强烈建议直接传 Excel，不要打印或扫描</b>）
          </div>
        </el-alert>
      </div>

      <!-- 内置样例 -->
      <div v-else class="picker">
        <el-select v-model="selectedCase" style="width: 460px" @change="runSample">
          <el-option v-for="s in samplesForTarget" :key="s.key" :label="s.label" :value="s.key" />
        </el-select>
        <el-button type="primary" @click="runSample">重新识别</el-button>
        <span class="bk-hint">{{ samples.find((s) => s.key === selectedCase)?.covers }}</span>
      </div>
    </div>

    <!-- ── 文件读取说明 ───────────────────────────────────────── -->
    <div v-if="ingested" class="bk-card">
      <div class="bk-card__title">文件读取方式</div>
      <div class="picker">
        <el-tag effect="plain" size="small">
          {{
            ingested.kind === 'IMAGE'
              ? '图片 → 视觉识别'
              : ingested.kind === 'PDF'
                ? 'PDF'
                : '表格 → 精确读取'
          }}
        </el-tag>
        <span class="bk-hint">
          {{ ingested.fileName }} · {{ (ingested.sizeBytes / 1024).toFixed(0) }} KB · 文本层
          {{ ingested.textChars }} 字
        </span>
      </div>
      <div v-for="(n, i) in ingested.notes" :key="i" class="bk-hint bk-hint--warn note">· {{ n }}</div>
      <el-collapse v-if="ingested.textPreview" style="margin-top: 8px">
        <el-collapse-item title="查看模型实际读到的内容（排查识别错误时看这里）">
          <pre class="preview">{{ ingested.textPreview }}</pre>
        </el-collapse-item>
      </el-collapse>
    </div>

    <el-row v-if="result && preview" :gutter="16">
      <!-- ── 抽取结果 ─────────────────────────────────────────── -->
      <el-col :span="12">
        <div class="bk-card">
          <div class="bk-card__title">
            <span>{{ isStatement ? '识别到的表头与合计' : '抽取字段' }}</span>
            <span class="bk-hint">
              整体置信度
              <b :class="(preview?.overallConfidence ?? 0) >= 0.85 ? 'ok' : 'warn'">
                {{ ((preview?.overallConfidence ?? 0) * 100).toFixed(0) }}%
              </b>
            </span>
          </div>

          <el-table :data="visibleFields" size="small" :show-header="false">
            <el-table-column width="130">
              <template #default="{ row }">
                <span class="bk-hint">{{ row.label }}</span>
              </template>
            </el-table-column>
            <el-table-column>
              <template #default="{ row }">
                <span :class="row.money ? 'bk-money' : ''">
                  {{
                    row.format
                      ? row.format(fieldValue(row.key))
                      : row.money &&
                          fieldValue(row.key) !== null &&
                          fieldValue(row.key) !== undefined
                        ? formatMoney(String(fieldValue(row.key)))
                        : fieldValue(row.key) ?? '—'
                  }}
                </span>
              </template>
            </el-table-column>
            <el-table-column width="80" align="right">
              <template #default="{ row }">
                <el-tag
                  v-if="fieldConf(row.key) !== undefined"
                  size="small"
                  :type="
                    (fieldConf(row.key) ?? 0) >= 0.85
                      ? 'success'
                      : (fieldConf(row.key) ?? 0) >= 0.7
                        ? 'warning'
                        : 'danger'
                  "
                  effect="plain"
                >
                  {{ ((fieldConf(row.key) ?? 0) * 100).toFixed(0) }}%
                </el-tag>
              </template>
            </el-table-column>
          </el-table>

          <div v-if="!isStatement && Number(fieldValue('amountInclTax')) > 0" class="capital">
            大写：<b>{{ toChineseUppercase(String(fieldValue('amountInclTax'))) }}</b>
          </div>

          <!-- 增值税申报表行次 -->
          <template v-if="targetType === 'TAX_RETURN' && visibleVatLines.length">
            <div class="bk-hint" style="margin: 12px 0 6px">
              识别到 <b>{{ visibleVatLines.length }}</b> 个申报行次（空白行不显示 ——
              <b>表上没写的绝不推算填补</b>）
            </div>
            <el-table :data="visibleVatLines" size="small" max-height="320" border>
              <el-table-column prop="label" label="行次" width="240" />
              <el-table-column label="金额" align="right">
                <template #default="{ row }">
                  <span class="bk-money">{{
                    fieldValue(row.key) === null ? '—' : formatMoney(String(fieldValue(row.key)))
                  }}</span>
                </template>
              </el-table-column>
            </el-table>
          </template>

          <!-- 报表行项目：原样保留，不映射科目 -->
          <template v-if="isStatement && previewItems.length">
            <div class="bk-hint" style="margin: 12px 0 6px">
              识别到 <b>{{ previewItems.length }}</b> 个行项目（<b>原样保留表上行次与名称，不强行映射科目</b>）
            </div>
            <el-table :data="previewItems" size="small" max-height="320" border>
              <el-table-column prop="lineNo" label="行次" width="60" />
              <el-table-column prop="label" label="项目" show-overflow-tooltip />
              <el-table-column label="期末 / 本期" width="120" align="right">
                <template #default="{ row }">
                  <span class="bk-money">{{
                    row.endBalance === null ? '—' : formatMoney(row.endBalance)
                  }}</span>
                </template>
              </el-table-column>
              <el-table-column label="年初 / 上期" width="120" align="right">
                <template #default="{ row }">
                  <span class="bk-money">{{
                    row.beginBalance === null ? '—' : formatMoney(row.beginBalance)
                  }}</span>
                </template>
              </el-table-column>
            </el-table>
          </template>

          <div class="meta">
            模型：{{ preview?.model }} · 耗时 {{ preview?.latencyMs }}ms · Provider
            {{ preview?.provider }}
          </div>
        </div>
      </el-col>

      <!-- ── 校验与后续动作 ───────────────────────────────────── -->
      <el-col :span="12">
        <div class="bk-card">
          <div class="bk-card__title">
            <span>校验结论</span>
            <span>
              <el-tag v-if="result.validation?.hasFailure" type="danger" size="small">
                {{ result.validation.failCount }} 项不通过
              </el-tag>
              <el-tag v-else-if="result.validation" type="success" size="small">全部通过</el-tag>
              <el-tag
                v-if="result.validation?.warnCount"
                type="warning"
                size="small"
                style="margin-left: 6px"
              >
                {{ result.validation.warnCount }} 项告警
              </el-tag>
            </span>
          </div>

          <!-- 报表平衡自检：报表类最重要的一条 -->
          <el-alert
            v-if="
              isStatement &&
              result.validation &&
              result.validation.balanced !== undefined &&
              result.validation.balanced !== null
            "
            :type="result.validation.balanced ? 'success' : 'error'"
            :closable="false"
            show-icon
            style="margin-bottom: 10px"
          >
            <template #title>
              {{ result.validation.balanced ? '资产负债表平衡' : '★ 资产负债表不平衡' }}
            </template>
            <div class="bk-hint">
              {{
                result.validation.balanced
                  ? '资产总计 = 负债合计 + 所有者权益合计。'
                  : '差额 ' +
                    (result.validation.balanceDifference ?? '（未给出）') +
                    '。系统不做任何平衡修正 —— 请核对原件后人工说明原因。'
              }}
            </div>
          </el-alert>

          <div
            v-for="f in findings"
            :key="f.code"
            class="finding"
            :class="'finding--' + f.level.toLowerCase()"
          >
            <div class="finding__head">
              <el-tag size="small" :type="levelType(f.level) as any" effect="dark">{{ f.code }}</el-tag>
              <span class="finding__level">{{ levelText(f.level) }}</span>
              <span class="finding__msg">{{ f.message }}</span>
            </div>
            <div v-if="f.suggestion" class="finding__suggestion">→ {{ f.suggestion }}</div>
          </div>

          <el-empty
            v-if="!result.validation"
            description="该识别目标暂不做会计交叉校验，请人工核对字段后使用。"
            :image-size="60"
          />
        </div>

        <!-- 下一步 -->
        <div class="bk-card">
          <div class="bk-card__title">下一步</div>

          <!-- 报表 → 建档 -->
          <template v-if="isStatement">
            <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 12px">
              <template #title>报表只建档，不生成凭证</template>
              <div class="bk-hint">
                报表是"结果"，凭证是"原因"。拿资产负债表的期末数去生成凭证，会把明细账里已有的资产再确认一遍。
                报表的唯一用途是<b>为期初建账提供真实数据</b>。
              </div>
            </el-alert>

            <div v-if="targetType === 'TAX_RETURN'" class="form-row">
              <span class="form-row__label">申报表类型 <b class="req">*</b></span>
              <el-select v-model="filingType" style="width: 220px">
                <el-option label="增值税月报" value="VAT_MONTHLY" />
                <el-option label="增值税季报" value="VAT_QUARTERLY" />
                <el-option label="企业所得税季度预缴" value="CIT_QUARTERLY" />
                <el-option label="企业所得税汇算清缴" value="CIT_ANNUAL" />
              </el-select>
              <span class="bk-hint">
                增值税与企业所得税的行次完全不同，归档口径必须由人指定 ——
                让模型猜会让数据进错字段。
              </span>
            </div>

            <div class="form-row">
              <span class="form-row__label">报表期间 <b class="req">*</b></span>
              <el-input
                v-model="periodOverride"
                :placeholder="detectedPeriod || '如 2024-12-31；申报表可用 2024-12 或 2024Q4'"
                style="max-width: 280px"
              />
              <span class="bk-hint">{{
                detectedPeriod ? '识别到：' + detectedPeriod : '未识别到，必须手动填'
              }}</span>
            </div>

            <div class="form-row">
              <span class="form-row__label">存档备注</span>
              <el-input
                v-model="reconNote"
                type="textarea"
                :rows="2"
                placeholder="报表不平的原因、数据来源说明等（会写进档案，供以后回看）"
                style="max-width: 420px"
              />
            </div>

            <el-button
              type="primary"
              :loading="saving"
              :disabled="!previewItems.length && targetType !== 'TAX_RETURN'"
              @click="saveStatement"
            >
              确认并建档
            </el-button>
            <span class="bk-hint" style="margin-left: 10px">
              同一主体 + 同类型 + 同报表日期视为同一份档案，重复保存会覆盖而不是新增。
            </span>
          </template>

          <!-- 单据 → 路由决策 -->
          <template v-else>
            <el-result
              :icon="result.routing?.status === 'AUTO_DRAFTED' ? 'success' : 'warning'"
              :title="result.routing?.status === 'AUTO_DRAFTED' ? '可生成待确认凭证' : '必须人工复核'"
              :sub-title="result.routing?.reason ?? '（该目标类型不产出凭证，请人工核对）'"
            />
            <div class="bk-hint" style="text-align: center">{{ result.explanation }}</div>
            <div
              v-if="result.routing?.lowConfidenceFields?.length"
              class="bk-hint bk-hint--warn note"
              style="text-align: center"
            >
              需重点核对的字段：{{ result.routing.lowConfidenceFields.join('、') }}
            </div>
          </template>
        </div>
      </el-col>
    </el-row>

    <!-- ── 已建档的报表与申报记录 ─────────────────────────────── -->
    <div class="bk-card">
      <div class="bk-card__title">
        <span>已建档的报表</span>
        <el-button size="small" text @click="loadArchived">刷新</el-button>
      </div>
      <el-table
        :data="archived"
        size="small"
        empty-text="还没有报表档案。识别资产负债表 / 利润表后在这里建档。"
      >
        <el-table-column label="类型" width="110">
          <template #default="{ row }">{{ statementLabel(row.statementType) }}</template>
        </el-table-column>
        <el-table-column label="报表日期" width="110">
          <template #default="{ row }">{{ String(row.statementDate).slice(0, 10) }}</template>
        </el-table-column>
        <el-table-column label="资产总计" width="130" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{ row.totalAssets ? formatMoney(row.totalAssets) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="负债合计" width="130" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{
              row.totalLiabilities ? formatMoney(row.totalLiabilities) : '—'
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平衡" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.isBalanced" type="success" size="small" effect="plain">平衡</el-tag>
            <el-tag v-else type="danger" size="small">差 {{ row.balanceDifference ?? '—' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="备注" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="bk-hint">{{ row.reconNote ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column width="70" align="right">
          <template #default="{ row }">
            <el-button size="small" text type="danger" @click="removeStatement(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- ★ 取用明细：回答"我上传的表到底用上了没有" -->
      <template v-if="declared">
        <div class="bk-card__title" style="margin-top: 18px">
          <span>这些报表会被期初建账取用哪些数</span>
          <el-tag size="small" effect="plain" type="success">优先级高于人工输入</el-tag>
        </div>
        <div class="bk-hint" style="margin-bottom: 8px">{{ declared.explanation }}</div>

        <template v-if="declared.balanceSheet">
          <div class="bk-hint" style="margin-bottom: 6px">
            取自 <b>{{ declared.balanceSheet.statementDate }}</b> 资产负债表 ·
            共 {{ declared.balanceSheet.itemCount }} 行 ·
            映射成功 <b>{{ declared.balanceSheet.mapped.length }}</b> 个科目 ·
            跳过 {{ declared.balanceSheet.skipped.length }} 行
          </div>
          <el-row :gutter="16">
            <el-col :span="12">
              <el-table :data="declared.balanceSheet.mapped" size="small" max-height="240" border>
                <el-table-column prop="accountCode" label="科目" width="80" />
                <el-table-column prop="label" label="报表行项目" show-overflow-tooltip />
                <el-table-column label="方向" width="70">
                  <template #default="{ row }">
                    <span :class="row.direction === 'DEBIT' ? 'bk-debit' : 'bk-credit'">
                      {{ row.direction === 'DEBIT' ? '借' : '贷' }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="金额" width="120" align="right">
                  <template #default="{ row }">
                    <span class="bk-money">{{ formatMoney(row.amount) }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </el-col>
            <el-col :span="12">
              <el-table :data="declared.balanceSheet.skipped" size="small" max-height="240" border>
                <el-table-column prop="label" label="跳过的行" width="150" show-overflow-tooltip />
                <el-table-column prop="reason" label="原因" show-overflow-tooltip />
              </el-table>
            </el-col>
          </el-row>
          <div class="bk-hint bk-hint--warn note">
            ★ 合计行不会被映射到任何科目 —— 映射过去会让资产被重复确认（明细账里已经有一遍）。
            「应交税费」也不映射：报表上只有一行，无法确定是未交增值税还是应交所得税，期初税额以申报表为准。
          </div>
        </template>
        <el-empty
          v-else
          description="还没有已建档的资产负债表。上传后，货币资金、存货、固定资产、实收资本这些“算不出来只能问人”的科目就能自动取数，不必再倒轧。"
          :image-size="60"
        />
      </template>

      <div class="bk-card__title" style="margin-top: 16px">
        <span>已建档的申报记录</span>
      </div>
      <el-table
        :data="filings"
        size="small"
        max-height="260"
        empty-text="还没有申报记录。识别增值税主表 / 企业所得税年报后在这里建档。"
      >
        <el-table-column label="税种" width="150">
          <template #default="{ row }">{{ statementLabel(String(row.filingType)) }}</template>
        </el-table-column>
        <el-table-column prop="periodLabel" label="所属期" width="100" />
        <el-table-column label="销售额" width="130" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{
              row.salesExclTax ? formatMoney(String(row.salesExclTax)) : '—'
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="销项税" width="120" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{
              row.outputTax ? formatMoney(String(row.outputTax)) : '—'
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="进项税" width="120" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{
              row.inputTax ? formatMoney(String(row.inputTax)) : '—'
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="应纳税额" width="120" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{
              row.taxPayable ? formatMoney(String(row.taxPayable)) : '—'
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="附加税费" width="110" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{ row.surtax ? formatMoney(String(row.surtax)) : '—' }}</span>
          </template>
        </el-table-column>
      </el-table>
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

.picker--col {
  flex-direction: column;
  align-items: stretch;
}

.upload {
  padding: 18px 24px;
  text-align: center;
}

.upload__icon {
  font-size: 26px;
  color: var(--bk-ink-3);
  line-height: 1;
  margin-bottom: 6px;
}

.upload__text {
  font-size: 14px;
  color: var(--bk-ink-2);
  margin-bottom: 4px;
}

.tip {
  margin-top: 4px;
}

.note {
  margin-top: 6px;
  line-height: 1.7;
}

.preview {
  margin: 0;
  padding: 10px;
  max-height: 320px;
  overflow: auto;
  background: var(--bk-earth-50);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.ok {
  color: var(--bk-wood-500);
}

.warn {
  color: var(--bk-earth-500);
}

.req {
  color: var(--bk-danger);
}

.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.form-row__label {
  width: 84px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--bk-ink-2);
}

.capital {
  margin-top: 10px;
  padding: 8px 12px;
  background: var(--bk-earth-50);
  border-radius: 4px;
  font-size: 13px;
  color: var(--bk-earth-700);
}

.meta {
  margin-top: 10px;
  font-size: 12px;
  color: var(--bk-ink-3);
}

.finding {
  padding: 8px 10px;
  border-radius: 4px;
  margin-bottom: 8px;
  border-left: 3px solid var(--bk-line);
  background: var(--bk-fire-50);
}

.finding--fail {
  border-left-color: var(--bk-danger);
  background: var(--bk-fire-50);
}

.finding--warn {
  border-left-color: var(--bk-earth-500);
  background: var(--bk-earth-50);
}

.finding--pass {
  border-left-color: var(--bk-wood-500);
  background: var(--bk-wood-100);
}

.finding--info {
  border-left-color: var(--bk-ink-3);
}

.finding__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.6;
}

.finding__level {
  color: var(--bk-ink-3);
  font-size: 12px;
  flex-shrink: 0;
}

.finding__msg {
  flex: 1;
}

.finding__suggestion {
  margin-top: 4px;
  padding-left: 8px;
  font-size: 12px;
  color: var(--bk-ink-2);
  line-height: 1.6;
}
.cls {
  margin-bottom: 10px;
}

.cls__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  margin-bottom: 4px;
}

.cls__reason {
  line-height: 1.8;
}

.cls__evidence {
  margin-top: 4px;
}

.cls__ev {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.9;
}</style>
