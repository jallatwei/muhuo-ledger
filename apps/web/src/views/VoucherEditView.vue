<script setup lang="ts">
/**
 * 凭证录入 / 详情
 * ============================================================
 * 这是全系统最重要的界面。设计要点：
 *   ① 借贷平衡**实时**校验 —— 差额直接显示在合计行，不平不允许保存
 *   ② 只允许选末级科目（记账红线，非末级科目记上去报表就取不到数）
 *   ③ 已过账凭证只读，要改只能红冲
 *   ④ 命中理由（ruleReason）显眼展示，回答"为什么这么记"
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAppStore } from '@/stores/app';
import { toastError, voucherApi, type VoucherDto, type VoucherLineInput } from '@/api';
import { Decimal, formatMoney, toChineseUppercase } from '@bookkeeper/shared';

const route = useRoute();
const router = useRouter();
const store = useAppStore();

const voucherId = computed(() => (route.params.id as string | undefined) ?? '');
/** 凭证加载失败的原因。非空时页面显示失败态而不是空白 */
const loadError = ref<string>('');
const isNew = computed(() => !voucherId.value);

const voucher = ref<VoucherDto | null>(null);
const saving = ref(false);
const loading = ref(false);

// ---- 表单 ----
const form = ref({
  voucherDate: '',
  summary: '',
  voucherWord: '记',
  lines: [] as Array<VoucherLineInput & { key: number }>,
});

let keySeq = 0;
function nextKey(): number {
  keySeq += 1;
  return keySeq;
}

function emptyLine(direction: 'DEBIT' | 'CREDIT'): VoucherLineInput & { key: number } {
  return { key: nextKey(), accountCode: '', direction, amount: '' };
}

function resetForm(): void {
  const p = store.currentPeriod;
  const d = p ? `${p.fiscalYear}-${String(p.month).padStart(2, '0')}-01` : new Date().toISOString().slice(0, 10);
  form.value = {
    voucherDate: d,
    summary: '',
    voucherWord: '记',
    lines: [emptyLine('DEBIT'), emptyLine('CREDIT')],
  };
}

// ---- 实时借贷平衡 ----
interface LineComputed {
  debit: Decimal;
  credit: Decimal;
  invalid: boolean;
  invalidReason: string;
}

const computedLines = computed<LineComputed[]>(() =>
  form.value.lines.map((l) => {
    let amount = new Decimal(0);
    let invalid = false;
    let invalidReason = '';

    const raw = (l.amount ?? '').trim();
    if (raw !== '') {
      try {
        amount = new Decimal(raw.replace(/,/g, ''));
        if (amount.isNegative() || amount.isZero()) {
          invalid = true;
          invalidReason = '金额必须大于 0';
        } else if (amount.decimalPlaces() > 2) {
          invalid = true;
          invalidReason = '最多 2 位小数（分）';
        }
      } catch {
        invalid = true;
        invalidReason = '不是合法数字';
      }
    } else {
      amount = new Decimal(0);
    }

    const acc = store.accountByCode.get(l.accountCode);
    if (l.accountCode && !acc) {
      invalid = true;
      invalidReason = '科目不存在';
    } else if (acc && !acc.isLeaf) {
      invalid = true;
      invalidReason = '不是末级科目，不允许记账';
    } else if (acc && !acc.isActive) {
      invalid = true;
      invalidReason = '科目已停用';
    } else if (acc && acc.auxRequired.length > 0 && !l.partnerId) {
      // 辅助核算是可选项的告警，不阻止保存（服务端会拦）
      invalidReason = `需填辅助核算：${acc.auxRequired.join('/')}`;
      invalid = true;
    }

    return {
      debit: l.direction === 'DEBIT' ? amount : new Decimal(0),
      credit: l.direction === 'CREDIT' ? amount : new Decimal(0),
      invalid,
      invalidReason,
    };
  }),
);

const totalDebit = computed(() =>
  computedLines.value.reduce((s, l) => s.plus(l.debit), new Decimal(0)),
);
const totalCredit = computed(() =>
  computedLines.value.reduce((s, l) => s.plus(l.credit), new Decimal(0)),
);
const difference = computed(() => totalDebit.value.minus(totalCredit.value));
const balanced = computed(() => difference.value.isZero() && totalDebit.value.gt(0));

const hasInvalidLine = computed(() => computedLines.value.some((l) => l.invalid));
const filledLines = computed(() =>
  form.value.lines.filter((l) => l.accountCode && (l.amount ?? '').trim() !== ''),
);

const canSave = computed(
  () =>
    !hasInvalidLine.value &&
    balanced.value &&
    filledLines.value.length >= 2 &&
    form.value.summary.trim().length > 0 &&
    Boolean(store.currentEntityId),
);

const isReadOnly = computed(() => {
  if (!voucher.value) return !store.periodWritable;
  return (
    voucher.value.status === 'POSTED' ||
    voucher.value.status === 'REVERSED' ||
    voucher.value.status === 'VOID' ||
    !store.periodWritable
  );
});

// ---- 科目选项（只列末级且启用）----
const accountOptions = computed(() =>
  store.leafAccounts.map((a) => ({
    value: a.code,
    label: `${a.code} ${a.fullName}`,
    code: a.code,
    name: a.name,
    fullName: a.fullName,
  })),
);


// ---- 载入 ----
async function load(): Promise<void> {
  if (isNew.value) {
    resetForm();
    return;
  }
  loading.value = true;
  loadError.value = '';
  try {
    const v = await voucherApi.get(voucherId.value);
    voucher.value = v;
    form.value = {
      voucherDate: v.voucherDate.slice(0, 10),
      summary: v.summary,
      voucherWord: v.voucherWord,
      lines: (v.lines ?? []).map((l) => ({
        key: nextKey(),
        accountCode: l.account.code,
        direction: l.direction,
        amount: new Decimal(l.amount).toFixed(2),
        summary: l.summary ?? '',
        partnerId: l.partnerId ?? undefined,
        taxRate: l.taxRate ?? undefined,
        taxAmount: l.taxAmount ?? undefined,
      })),
    };
  } catch (e) {
    // ★ 失败的凭证不能被静默吞掉：
    //   只弹一个 toast 的话，转瞬即逝之后页面就只剩空白（voucher 为 null、
    //   isNew 又是 false，条件渲染全部不成立），看起来像"功能没做"。
    //   所以把失败状态留下来，给一个明确的、可操作的页面。
    loadError.value = e instanceof Error ? e.message : String(e);
    toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(voucherId, load);
watch(() => store.currentPeriodId, () => {
  if (isNew.value) resetForm();
});

// ---- 行操作 ----
function addLine(direction: 'DEBIT' | 'CREDIT'): void {
  form.value.lines.push(emptyLine(direction));
}

function removeLine(index: number): void {
  if (form.value.lines.length <= 2) {
    ElMessage.warning('至少保留一借一贷两行');
    return;
  }
  form.value.lines.splice(index, 1);
}

/** 一键补平：把差额填到最后一行 */
function fillDifference(): void {
  const diff = difference.value;
  if (diff.isZero()) return;
  const target = diff.gt(0) ? 'CREDIT' : 'DEBIT';
  const amount = diff.abs();
  // 找最后一行空白的，否则新增一行
  const idx = form.value.lines.findIndex(
    (l, i) => l.direction === target && (l.amount ?? '').trim() === '' && computedLines.value[i]?.invalid !== true,
  );
  if (idx >= 0) {
    form.value.lines[idx]!.amount = amount.toFixed(2);
  } else {
    form.value.lines.push({
      key: nextKey(),
      accountCode: '',
      direction: target,
      amount: amount.toFixed(2),
    });
  }
}

// ---- 保存与流转 ----
async function save(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const res = await voucherApi.create({
      entityId: store.currentEntityId,
      periodId: store.currentPeriodId || undefined,
      voucherDate: form.value.voucherDate,
      summary: form.value.summary.trim(),
      voucherWord: form.value.voucherWord,
      sourceType: 'MANUAL',
      lines: filledLines.value.map((l) => ({
        accountCode: l.accountCode,
        direction: l.direction,
        amount: new Decimal((l.amount ?? '0').replace(/,/g, '')).toFixed(2),
        summary: l.summary || undefined,
        partnerId: l.partnerId || undefined,
      })),
    });
    if (res.alreadyExists) {
      ElMessage.info('该凭证已存在（幂等命中），未重复创建');
    } else {
      ElMessage.success('凭证已保存为草稿');
    }
    router.push(`/vouchers/${res.id}`);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function doAction(action: 'submit' | 'approve' | 'post'): Promise<void> {
  if (!voucher.value) return;
  try {
    if (action === 'post') {
      const r = await voucherApi.post(voucher.value.id);
      ElMessage.success(`已过账，凭证号 ${voucher.value.voucherWord}-${r.voucherNo}。此后不可修改。`);
    } else if (action === 'submit') {
      await voucherApi.submit(voucher.value.id);
      ElMessage.success('已提交审核');
    } else {
      await voucherApi.approve(voucher.value.id);
      ElMessage.success('已审核通过');
    }
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function doReverse(): Promise<void> {
  if (!voucher.value) return;
  try {
    const { value } = await ElMessageBox.prompt(
      '红冲会生成一张方向相反的新凭证来冲销本凭证。原凭证会保留并标记为「已红冲」。\n请填写红冲理由（会永久保留在凭证摘要中）：',
      '确认红冲',
      {
        confirmButtonText: '确认红冲',
        cancelButtonText: '取消',
        inputPlaceholder: '例如：发票作废 / 金额录错',
        inputValidator: (v) => (v && v.trim().length > 0 ? true : '必须填写理由'),
      },
    );
    await voucherApi.reverse(voucher.value.id, value.trim());
    ElMessage.success('已红冲，新凭证已生成并过账');
    await load();
  } catch (e) {
    if (e !== 'cancel') toastError(e);
  }
}

async function doVoid(): Promise<void> {
  if (!voucher.value) return;
  try {
    const { value } = await ElMessageBox.prompt('作废后该凭证不再参与任何计算。请填写理由：', '确认作废', {
      confirmButtonText: '确认作废',
      cancelButtonText: '取消',
      inputValidator: (v) => (v && v.trim().length > 0 ? true : '必须填写理由'),
    });
    await voucherApi.void(voucher.value.id, value.trim());
    ElMessage.success('已作废');
    await load();
  } catch (e) {
    if (e !== 'cancel') toastError(e);
  }
}

/**
 * 带理由的退回。
 *
 * ★ 理由必填（后端也会拒绝空理由）：退回是"有后果的动作" ——
 *   凭证被打回、别人要返工。留空的退回等于把人卡住却不说原因。
 *   所以这里的校验不是"防呆"，是保证流程能继续走下去。
 */
async function doReject(
  kind: 'reject' | 'rejectAfterReview' | 'unapprove',
): Promise<void> {
  if (!voucher.value) return;

  const cfg = {
    reject: {
      title: '审核不通过',
      tip: '这张凭证将退回为**草稿**，由制单人修改后重新提交。',
      placeholder: '例如：第 2 行科目选错，应为「管理费用—办公费」；附件金额与分录不符',
    },
    rejectAfterReview: {
      title: '过账前退回审核',
      tip: '这张凭证将退回为**待审核**，由审核人重新复核（不退到草稿，因为问题多半出在审核环节）。',
      placeholder: '例如：进项税额不应抵扣，该笔属于集体福利',
    },
    unapprove: {
      title: '反审核退回制单人',
      tip: '这张凭证将直接退回为**草稿** —— 意味着单据本身需要改，而不只是审核重新看一遍。',
      placeholder: '例如：金额录错，需按发票原件重新录入',
    },
  }[kind];

  let reason: string;
  try {
    const { value } = await ElMessageBox.prompt(
      `${cfg.tip}\n\n退回理由会写入凭证备注，制单人打开就能看到要改什么。`,
      cfg.title,
      {
        confirmButtonText: '确认退回',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: cfg.placeholder,
        inputValidator: (v) =>
          v && v.trim().length >= 4 ? true : '请填写具体理由（至少 4 个字），否则对方不知道要改什么',
      },
    );
    reason = value.trim();
  } catch {
    return; // 用户取消
  }

  try {
    if (kind === 'reject') await voucherApi.reject(voucher.value.id, reason);
    else if (kind === 'rejectAfterReview')
      await voucherApi.rejectAfterReview(voucher.value.id, reason);
    else await voucherApi.unapprove(voucher.value.id, reason);

    ElMessage.success(
      kind === 'rejectAfterReview' ? '已退回审核' : '已退回制单人',
    );
    await load();
  } catch (e) {
    toastError(e);
  }
}

const statusText: Record<string, string> = {
  DRAFT: '草稿',
  REVIEWING: '待审核',
  APPROVED: '已审核',
  POSTED: '已过账',
  REVERSED: '已红冲',
  VOID: '已作废',
};
</script>

<template>
  <div class="bk-page" v-loading="loading">
    <!-- ── 状态条 ─────────────────────────────────────────── -->
    <div v-if="voucher" class="bk-card status-bar">
      <div class="status-bar__left">
        <el-tag size="large" :type="voucher.status === 'POSTED' ? 'success' : voucher.status === 'REVERSED' ? 'danger' : 'warning'">
          {{ statusText[voucher.status] }}
        </el-tag>
        <span class="status-bar__label">
          {{ voucher.voucherNo > 0 ? `${voucher.voucherWord}-${voucher.voucherNo}` : `${voucher.voucherWord}-（未编号）` }}
        </span>
        <el-tag v-if="voucher.sourceType !== 'MANUAL'" size="small" type="info" effect="plain">
          自动生成
        </el-tag>
        <el-tag v-if="voucher.confidence" size="small" effect="plain">
          置信度 {{ (Number(voucher.confidence) * 100).toFixed(0) }}%
        </el-tag>
      </div>

      <div class="status-bar__actions">
        <el-button v-if="voucher.status === 'DRAFT'" type="primary" @click="doAction('submit')">
          提交审核
        </el-button>
        <el-button v-if="voucher.status === 'REVIEWING'" type="success" @click="doAction('approve')">
          审核通过
        </el-button>
        <el-button
          v-if="voucher.status === 'REVIEWING'"
          type="danger"
          plain
          @click="doReject('reject')"
        >
          审核不通过
        </el-button>

        <el-button
          v-if="voucher.status === 'APPROVED'"
          type="success"
          @click="doAction('post')"
        >
          过账（分配凭证号）
        </el-button>
        <el-button
          v-if="voucher.status === 'APPROVED'"
          type="warning"
          plain
          @click="doReject('rejectAfterReview')"
        >
          退回审核
        </el-button>
        <el-button
          v-if="voucher.status === 'APPROVED'"
          type="danger"
          plain
          @click="doReject('unapprove')"
        >
          退回制单人
        </el-button>
        <el-button v-if="voucher.status === 'POSTED'" type="warning" plain @click="doReverse">
          红冲
        </el-button>
        <el-button
          v-if="['DRAFT', 'REVIEWING'].includes(voucher.status)"
          type="danger"
          plain
          @click="doVoid"
        >
          作废
        </el-button>
      </div>
    </div>

    <!-- ── 退回理由：制单人最需要看到的东西 ────────────────── -->
    <el-alert
      v-if="voucher?.reviewNote && ['DRAFT', 'REVIEWING'].includes(voucher.status)"
      type="error"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    >
      <template #title>
        {{ voucher.status === 'DRAFT' ? '这张凭证被退回，需要修改' : '这张凭证被退回审核，需要复核' }}
      </template>
      <div class="bk-hint" style="line-height: 1.9">
        <b>退回理由：</b>{{ voucher.reviewNote }}
        <div style="margin-top: 4px">
          修改后重新提交审核即可。理由也会留在操作日志里，便于事后追溯是谁、因为什么退回的。
        </div>
      </div>
    </el-alert>

    <!-- ── 自动记账的命中理由 ─────────────────────────────── -->
    <el-alert
      v-if="voucher?.ruleReason"
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    >
      <template #title>自动记账依据</template>
      <div class="bk-hint">
        {{ voucher.ruleReason }}
        <span v-if="voucher.ruleId">（规则 {{ voucher.ruleId }} v{{ voucher.ruleVersion }}）</span>
      </div>
    </el-alert>

    <!-- ── 加载失败：不许留白页 ──────────────────────────── -->
    <div v-if="loadError" class="bk-card">
      <el-result icon="error" title="这张凭证打不开" :sub-title="loadError">
        <template #extra>
          <div class="bk-hint" style="max-width: 560px; text-align: left; line-height: 2">
            常见原因：<br />
            · 地址里的凭证 id 不对（例如把某个页面的路径误当成凭证 id）<br />
            · 这张凭证已被删除<br />
            · 后端服务没启动
          </div>
          <div style="margin-top: 16px">
            <el-button type="primary" @click="router.push('/vouchers')">回到凭证列表</el-button>
            <el-button @click="load">重试</el-button>
          </div>
        </template>
      </el-result>
    </div>

    <!-- ── 凭证主体 ───────────────────────────────────────── -->
    <div v-if="!loadError" class="bk-card">
      <div class="bk-card__title">
        <span>{{ isNew ? '录入凭证' : '凭证内容' }}</span>
        <div class="title-actions">
          <span class="bk-hint">{{ store.periodLabel }}</span>
        </div>
      </div>

      <el-form :disabled="isReadOnly" label-width="80px" style="margin-bottom: 12px">
        <el-row :gutter="16">
          <el-col :span="6">
            <el-form-item label="凭证日期">
              <el-date-picker
                v-model="form.voucherDate"
                type="date"
                value-format="YYYY-MM-DD"
                style="width: 100%"
                :clearable="false"
              />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="凭证字">
              <el-select v-model="form.voucherWord" style="width: 100%">
                <el-option label="记" value="记" />
                <el-option label="收" value="收" />
                <el-option label="付" value="付" />
                <el-option label="转" value="转" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="摘要">
              <el-input
                v-model="form.summary"
                placeholder="例如：采购办公用品（某某办公用品有限公司）"
                maxlength="200"
                show-word-limit
              />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <!-- ── 分录表 ──────────────────────────────────────── -->
      <el-table :data="form.lines" size="small" class="bk-entry-table" border>
        <el-table-column type="index" label="#" width="46" align="center" />

        <el-table-column label="科目" min-width="280">
          <template #default="{ row }">
            <el-select
              v-model="row.accountCode"
              filterable
              clearable
              placeholder="输入编码或名称搜索（仅末级科目）"
              style="width: 100%"
              :disabled="isReadOnly"
            >
              <el-option
                v-for="opt in accountOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              >
                <span style="float: left">{{ opt.code }}</span>
                <span style="float: right; color: var(--bk-ink-3); font-size: 12px">
                  {{ opt.fullName }}
                </span>
              </el-option>
            </el-select>
            <div
              v-if="computedLines[row.$index]?.invalidReason"
              class="line-hint line-hint--bad"
            >
              {{ computedLines[row.$index]?.invalidReason }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="方向" width="92">
          <template #default="{ row }">
            <el-select v-model="row.direction" :disabled="isReadOnly" size="small">
              <el-option label="借" value="DEBIT" />
              <el-option label="贷" value="CREDIT" />
            </el-select>
          </template>
        </el-table-column>

        <el-table-column label="借方金额" width="150" align="right">
          <template #default="{ row, $index }">
            <el-input
              v-if="row.direction === 'DEBIT'"
              v-model="row.amount"
              placeholder="0.00"
              class="bk-money"
              :disabled="isReadOnly"
            />
            <span v-else class="bk-money bk-money--zero">—</span>
          </template>
        </el-table-column>

        <el-table-column label="贷方金额" width="150" align="right">
          <template #default="{ row }">
            <el-input
              v-if="row.direction === 'CREDIT'"
              v-model="row.amount"
              placeholder="0.00"
              class="bk-money"
              :disabled="isReadOnly"
            />
            <span v-else class="bk-money bk-money--zero">—</span>
          </template>
        </el-table-column>

        <el-table-column label="行摘要" min-width="160">
          <template #default="{ row }">
            <el-input v-model="row.summary" placeholder="可选" :disabled="isReadOnly" />
          </template>
        </el-table-column>

        <el-table-column v-if="!isReadOnly" label="" width="60" align="center">
          <template #default="{ $index }">
            <el-button size="small" text type="danger" @click="removeLine($index)">删</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="!isReadOnly" style="margin-top: 10px; display: flex; gap: 8px">
        <el-button size="small" @click="addLine('DEBIT')">+ 借方行</el-button>
        <el-button size="small" @click="addLine('CREDIT')">+ 贷方行</el-button>
        <el-button v-if="!difference.isZero()" size="small" type="warning" plain @click="fillDifference">
          补平差额 {{ formatMoney(difference.abs()) }}
        </el-button>
      </div>

      <!-- ── 合计与平衡状态 ──────────────────────────────── -->
      <div class="bk-total-row">
        <span>
          <span class="bk-total-row__label">借方合计</span>
          <span class="bk-money bk-money--debit" style="margin-left: 8px; font-size: 15px">
            {{ formatMoney(totalDebit) }}
          </span>
        </span>
        <span>
          <span class="bk-total-row__label">贷方合计</span>
          <span class="bk-money bk-money--credit" style="margin-left: 8px; font-size: 15px">
            {{ formatMoney(totalCredit) }}
          </span>
        </span>
        <span v-if="balanced" class="bk-total-row__balanced">✓ 借贷平衡</span>
        <span v-else class="bk-total-row__unbalanced">
          ✗ 差额 {{ formatMoney(difference) }}
        </span>
      </div>

      <!-- ── 大写金额（凭证册与发票核对用）────────────────── -->
      <div v-if="totalDebit.gt(0)" class="capital-amount">
        价税合计大写：<b>{{ toChineseUppercase(totalDebit) }}</b>
      </div>

      <!-- ── 保存 ────────────────────────────────────────── -->
      <div v-if="isNew" style="margin-top: 16px; display: flex; gap: 10px">
        <el-button
          type="primary"
          size="large"
          :loading="saving"
          :disabled="!canSave"
          @click="save"
        >
          保存为草稿
        </el-button>
        <el-button size="large" @click="resetForm">清空重填</el-button>
        <span v-if="!canSave" class="bk-hint" style="align-self: center">
          {{
            !form.summary.trim()
              ? '请填写摘要'
              : hasInvalidLine
                ? '存在非法分录行，请先修正'
                : !balanced
                  ? '借贷不平，无法保存'
                  : '至少需要一借一贷两行'
          }}
        </span>
      </div>

      <div v-else-if="isReadOnly" class="bk-hint" style="margin-top: 12px">
        <template v-if="voucher?.status === 'POSTED'">
          本凭证已过账，不可修改。如需更正，请点击上方「红冲」生成反向凭证。
        </template>
        <template v-else-if="voucher?.status === 'REVERSED'">
          本凭证已被红冲，仅作历史留痕，不参与后续计算。
        </template>
        <template v-else-if="!store.periodWritable">
          当前会计期间已{{ store.currentPeriod?.status === 'CLOSING' ? '进入结账流程' : '结账' }}，不可修改凭证。如需调整请先执行反结账。
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.title-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
}

.status-bar__left,
.status-bar__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-bar__label {
  font-size: 16px;
  font-weight: 600;
  font-family: var(--bk-money-font);
}

.line-hint {
  font-size: 11px;
  line-height: 1.4;
  margin-top: 2px;
}

.line-hint--bad {
  color: var(--bk-danger);
}

.capital-amount {
  margin-top: 10px;
  padding: 8px 12px;
  background: var(--bk-earth-50);
  border-radius: 4px;
  font-size: 13px;
  color: var(--bk-earth-700);
}
</style>
