<script setup lang="ts">
/**
 * 电子发票仓库
 * ============================================================
 * 仓库由三张已有表构成，不额外建表：
 *   Document（原始文件）→ Invoice（结构化发票）→ JournalLine（凭证分录）
 *   + DocumentLink（显式挂接的附件）
 *
 * 页面的核心价值是回答两个问题：
 *   ① 这张发票在哪张凭证上？（勾稽）
 *   ② 还能不能打出来？（原件是否在库）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { documentsApi, http, toastError, type RecognizeDocumentResult } from '@/api';
import { formatMoney } from '@bookkeeper/shared';

const store = useAppStore();
const router = useRouter();

interface InvoiceRow {
  id: string;
  direction: string;
  number: string;
  invoiceDate: string;
  sellerName: string;
  buyerName: string;
  amountInclTax: string;
  status: string;
}

interface DocumentRow {
  id: string;
  originalName: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  createdAt: string;
  invoices: InvoiceRow[];
  invoiceAmount: string;
  linkedVouchers: Array<{ id: string; label: string; status: string }>;
  isLinked: boolean;
}

const rows = ref<DocumentRow[]>([]);
const total = ref(0);
const linkedFilter = ref<'all' | 'true' | 'false'>('all');
const keyword = ref('');
const page = ref(1);
const pageSize = ref(50);
const loading = ref(false);
const summary = ref<{ totalDocuments: number; linkedCount: number; unlinkedCount: number } | null>(null);

// ── 导入单据 ──────────────────────────────────────────────────────────────
const importDialog = ref(false);
const importing = ref(false);
const recognizeAfterUpload = ref(true);
const uploadDocType = ref('INVOICE_PURCHASE');
/** 每个文件的处理结果（逐条展示，避免"传了 20 张只报一句成功"） */
interface ImportOutcome {
  fileName: string;
  state: 'OK' | 'SKIP' | 'REJECT' | 'FAIL';
  text: string;
  detail?: RecognizeDocumentResult | null;
}
const outcomes = ref<ImportOutcome[]>([]);
const warehouse = ref<{
  totalInvoices: number;
  invoicesWithDocument: number;
  totalDocuments: number;
  byYear: Array<{ year: number; outputCount: number; outputAmount: string; inputCount: number; inputAmount: string }>;
} | null>(null);

async function load(): Promise<void> {
  if (!store.currentEntityId) return;
  loading.value = true;
  try {
    const params: Record<string, unknown> = {
      entityId: store.currentEntityId,
      page: page.value,
      pageSize: pageSize.value,
    };
    if (linkedFilter.value !== 'all') params.linked = linkedFilter.value;
    if (keyword.value) params.keyword = keyword.value;

    const [res, wh] = await Promise.all([
      http.get('/documents', { params }).then((r) => r.data),
      http.get('/documents/warehouse/stats', { params: { entityId: store.currentEntityId } }).then((r) => r.data),
    ]);
    rows.value = res.items ?? [];
    total.value = res.total ?? 0;
    summary.value = res.summary ?? null;
    warehouse.value = wh;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([linkedFilter, () => page.value], load);

function search(): void {
  page.value = 1;
  void load();
}

// ── 导入单据 ──────────────────────────────────────────────────────────────

function openImport(): void {
  outcomes.value = [];
  importDialog.value = true;
}

/**
 * 逐份上传 →（可选）识别 → 展示逐条结果。
 *
 * ★ 为什么必须逐份串行、逐条报结果：
 *   一次拖 20 张票进来，如果只报"成功 18 失败 2"，用户不知道是哪 2 张、
 *   也不知道为什么。而且识别要花钱，串行能避免一次打满模型并发。
 */
async function handleImportFiles(files: FileList | null): Promise<void> {
  if (!files || files.length === 0 || !store.currentEntityId) return;

  importing.value = true;
  outcomes.value = [];

  for (const file of Array.from(files)) {
    try {
      // 第一步：入库（无损、必成）
      const up = await documentsApi.upload(store.currentEntityId, file, uploadDocType.value);

      if (up.duplicated) {
        outcomes.value.push({
          fileName: file.name,
          state: 'SKIP',
          text: up.message ?? '该文件已在库中（内容完全相同），未重复入库。',
        });
        continue;
      }

      // 第二步：识别（可选、有损、要花钱）
      if (!recognizeAfterUpload.value) {
        outcomes.value.push({
          fileName: file.name,
          state: 'OK',
          text: '已入库（未识别）。可稍后在这一行点「识别」按需处理。',
        });
        continue;
      }

      const res = await documentsApi.recognize(up.documentId, store.currentEntityId);
      outcomes.value.push({
        fileName: file.name,
        state:
          res.status === 'SAVED'
            ? 'OK'
            : res.status === 'DUPLICATE'
              ? 'SKIP'
              : res.status === 'REJECTED'
                ? 'REJECT'
                : 'OK',
        text: res.message,
        detail: res,
      });
    } catch (e) {
      outcomes.value.push({
        fileName: file.name,
        state: 'FAIL',
        text: e instanceof Error ? e.message : String(e),
      });
    }
  }

  importing.value = false;
  await load();
  ElMessage.success(`处理完成：${outcomes.value.length} 份文件`);
}

/** 对列表中某一行补做识别 */
async function recognizeRow(row: DocumentRow): Promise<void> {
  if (!store.currentEntityId) return;
  try {
    const res = await documentsApi.recognize(row.id, store.currentEntityId);
    if (res.status === 'REJECTED') {
      ElMessageBox.alert(
        res.message +
          '\n\n未通过的校验项：\n' +
          res.validation.findings
            .filter((f) => f.level === 'FAIL')
            .map((f) => `· [${f.code}] ${f.message}`)
            .join('\n'),
        '识别结果未通过校验',
        { type: 'warning', confirmButtonText: '知道了' },
      );
    } else {
      ElMessage.success(res.message);
    }
    await load();
  } catch (e) {
    toastError(e);
  }
}

function stateTag(s: ImportOutcome['state']): 'success' | 'info' | 'warning' | 'danger' {
  return s === 'OK' ? 'success' : s === 'SKIP' ? 'info' : s === 'REJECT' ? 'warning' : 'danger';
}

function stateText(s: ImportOutcome['state']): string {
  return s === 'OK' ? '已处理' : s === 'SKIP' ? '已跳过' : s === 'REJECT' ? '未通过校验' : '失败';
}

const apiBase = computed(() => (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, ''));

function openFile(doc: DocumentRow, download = false): void {
  const url = `${apiBase.value}/documents/${doc.id}/file${download ? '?download=true' : ''}`;
  window.open(url, '_blank');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const docTypeText: Record<string, string> = {
  INVOICE_SALES: '销项发票',
  INVOICE_PURCHASE: '进项发票',
  BANK_SLIP: '银行回单',
  BANK_STATEMENT: '银行流水',
  CONTRACT: '合同',
  RECEIPT: '收据',
  OTHER: '其他',
};
</script>

<template>
  <div class="bk-page" v-loading="loading">
    <!-- ── 仓库总览 ──────────────────────────────────────── -->
    <el-row :gutter="16">
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">原始单据</div>
          <div class="stat__value">{{ warehouse?.totalDocuments ?? 0 }} <span class="stat__unit">份</span></div>
          <div class="stat__foot">发票、回单、合同等原件</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">结构化发票</div>
          <div class="stat__value">{{ warehouse?.totalInvoices ?? 0 }} <span class="stat__unit">张</span></div>
          <div class="stat__foot">已识别的票面数据</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">已勾稽到凭证</div>
          <div class="stat__value stat__value--ok">{{ summary?.linkedCount ?? 0 }} <span class="stat__unit">份</span></div>
          <div class="stat__foot">打印凭证册时会带出</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="bk-card stat">
          <div class="stat__label">未勾稽</div>
          <div class="stat__value" :class="{ 'stat__value--warn': (summary?.unlinkedCount ?? 0) > 0 }">
            {{ summary?.unlinkedCount ?? 0 }} <span class="stat__unit">份</span>
          </div>
          <div class="stat__foot">尚未关联任何凭证</div>
        </div>
      </el-col>
    </el-row>

    <!-- ── 按年度统计 ────────────────────────────────────── -->
    <div v-if="warehouse?.byYear?.length" class="bk-card">
      <div class="bk-card__title">
        <span>历年开票情况</span>
        <span class="bk-hint">销项 / 进项分列，便于与申报记录核对</span>
      </div>
      <el-table :data="warehouse.byYear" size="small">
        <el-table-column label="年度" prop="year" width="100" />
        <el-table-column label="销项张数" prop="outputCount" width="110" align="right" />
        <el-table-column label="销项价税合计" width="160" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{ formatMoney(row.outputAmount) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="进项张数" prop="inputCount" width="110" align="right" />
        <el-table-column label="进项价税合计" width="160" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{ formatMoney(row.inputAmount) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- ── 单据列表 ──────────────────────────────────────── -->
    <div class="bk-card">
      <div class="bk-card__title">
        <span>单据与发票仓库</span>
        <div class="title-actions">
          <el-button size="small" type="primary" @click="openImport">导入单据</el-button>
          <el-button size="small" plain @click="router.push({ name: 'recognition' })">
            去识别录入
          </el-button>
        </div>
      </div>

      <div class="filters">
        <el-radio-group v-model="linkedFilter">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="true">已勾稽</el-radio-button>
          <el-radio-button value="false">未勾稽</el-radio-button>
        </el-radio-group>
        <el-input
          v-model="keyword"
          placeholder="搜索文件名 / 对方单位 / 发票号码"
          style="width: 280px"
          clearable
          @keyup.enter="search"
        />
        <el-button type="primary" plain @click="search">查询</el-button>
      </div>

      <el-table :data="rows" size="small" style="width: 100%">
        <el-table-column label="单据" min-width="200">
          <template #default="{ row }">
            <div class="doc-name">
              <el-tag size="small" :type="row.isImage ? 'success' : 'info'" effect="plain">
                {{ row.isImage ? '图片' : 'PDF' }}
              </el-tag>
              <span class="doc-name__text">{{ row.originalName }}</span>
            </div>
            <div class="bk-hint">
              {{ docTypeText[row.docType] ?? row.docType }} · {{ formatBytes(row.sizeBytes) }} ·
              {{ row.createdAt.slice(0, 10) }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="发票信息" min-width="260">
          <template #default="{ row }">
            <div v-for="inv in row.invoices" :key="inv.id" class="inv-line">
              <el-tag size="small" :type="inv.direction === 'OUTPUT' ? 'warning' : 'primary'" effect="plain">
                {{ inv.direction === 'OUTPUT' ? '销项' : '进项' }}
              </el-tag>
              <span class="bk-mono">{{ inv.number }}</span>
              <span class="bk-hint">{{ inv.invoiceDate.slice(0, 10) }}</span>
              <span class="inv-line__party">{{ inv.sellerName }}</span>
            </div>
            <span v-if="!row.invoices.length" class="bk-hint">未识别为发票（作为通用附件保留）</span>
          </template>
        </el-table-column>

        <el-table-column label="价税合计" width="130" align="right">
          <template #default="{ row }">
            <span class="bk-money">{{ row.invoiceAmount !== '0.00' ? formatMoney(row.invoiceAmount) : '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="关联凭证" width="150">
          <template #default="{ row }">
            <template v-if="row.linkedVouchers.length">
              <el-tag
                v-for="v in row.linkedVouchers"
                :key="v.id"
                size="small"
                type="success"
                effect="plain"
                style="margin-right: 4px; cursor: pointer"
                @click="router.push(`/vouchers/${v.id}`)"
              >
                {{ v.label }}
              </el-tag>
            </template>
            <el-tag v-else size="small" type="warning" effect="plain">未勾稽</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="210" align="center">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openFile(row)">查看</el-button>
            <el-button size="small" text @click="openFile(row, true)">下载</el-button>
            <el-button
              v-if="!row.invoices.length"
              size="small"
              text
              type="warning"
              @click="recognizeRow(row)"
            >
              识别
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

      <el-empty v-if="!rows.length && !loading" :image-size="80">
        <template #description>
          <div>仓库还是空的。导入发票后，这里会显示原始单据与凭证的勾稽关系。</div>
        </template>
        <el-button type="primary" @click="openImport">导入单据</el-button>
      </el-empty>
    </div>

    <!-- ── 导入对话框 ──────────────────────────────────────── -->
    <el-dialog v-model="importDialog" title="导入单据" width="720px" :close-on-click-modal="!importing">
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px">
        <template #title>两步走：先入库，再识别</template>
        <div class="bk-hint">
          <b>入库是无损的</b>（原件按内容哈希去重，传同一份文件不会重复）；<br />
          <b>识别是有损的、也花钱</b>，所以分开：先把原件存住，识别可以随时补做。
          <br />金额勾稽不通过的票<b>不会写入发票台账</b> ——
          坏数据进台账比不进更危险，它会污染进项抵扣统计。
        </div>
      </el-alert>

      <div class="imp-row">
        <span class="imp-row__label">单据类型</span>
        <el-select v-model="uploadDocType" style="width: 180px" :disabled="importing">
          <el-option label="进项发票" value="INVOICE_PURCHASE" />
          <el-option label="销项发票" value="INVOICE_SALES" />
          <el-option label="银行回单" value="BANK_SLIP" />
          <el-option label="银行流水" value="BANK_STATEMENT" />
          <el-option label="合同" value="CONTRACT" />
          <el-option label="收据" value="RECEIPT" />
          <el-option label="其他" value="OTHER" />
        </el-select>
        <el-checkbox v-model="recognizeAfterUpload" :disabled="importing">
          入库后立即识别
        </el-checkbox>
      </div>

      <el-upload
        drag
        multiple
        :auto-upload="false"
        :show-file-list="false"
        :disabled="importing"
        accept=".png,.jpg,.jpeg,.webp,.bmp,.pdf"
        :on-change="(f: any) => f.raw && handleImportFiles([f.raw] as any)"
      >
        <div class="imp-drop">
          <div class="imp-drop__icon">＋</div>
          <div>把发票 / 回单拖到这里，或<b>点击选择</b>（可多选）</div>
          <div class="bk-hint">支持 图片（png / jpg / webp）、PDF</div>
        </div>
      </el-upload>

      <div v-if="importing" class="bk-hint" style="margin-top: 10px">
        正在逐份处理，请勿关闭窗口……
      </div>

      <div v-if="outcomes.length" class="imp-results">
        <div class="bk-card__title" style="margin-bottom: 6px">处理结果</div>
        <div v-for="(o, i) in outcomes" :key="i" class="imp-item">
          <el-tag size="small" :type="stateTag(o.state)" effect="plain">
            {{ stateText(o.state) }}
          </el-tag>
          <span class="imp-item__name">{{ o.fileName }}</span>
          <div class="bk-hint">{{ o.text }}</div>
          <div v-if="o.detail?.validation?.findings?.length" class="imp-item__findings">
            <div
              v-for="f in o.detail.validation.findings.filter((x) => x.level === 'FAIL')"
              :key="f.code"
              class="bk-hint imp-item__fail"
            >
              · [{{ f.code }}] {{ f.message }}
              <span v-if="f.suggestion"> → {{ f.suggestion }}</span>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button :disabled="importing" @click="importDialog = false">关闭</el-button>
      </template>
    </el-dialog>

    <div class="bk-card">
      <div class="bk-card__title">这个仓库解决什么问题</div>
      <div class="bk-hint" style="line-height: 2">
        · <b>能查到出处</b>：从凭证能追到发票原件，从发票能追到记在哪张凭证上。<br />
        · <b>能一起打出来</b>：打印凭证册时，每张凭证后面自动附上它关联的发票原件，不用手工配页。<br />
        · <b>不会重复入账</b>：同一份文件按内容哈希去重，同一张发票按「方向+代码+号码」去重。<br />
        · <b>历史数据同样适用</b>：从历史开票记录重建的凭证，只要把发票原件入库并建立勾稽，同样能打印。
      </div>
    </div>
  </div>
</template>

<style scoped>
.title-actions {
  display: flex;
  gap: 8px;
}

.imp-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.imp-row__label {
  font-size: 13px;
  color: var(--bk-ink-2);
}

.imp-drop {
  padding: 16px 20px;
  text-align: center;
}

.imp-drop__icon {
  font-size: 24px;
  color: var(--bk-ink-3);
  line-height: 1;
  margin-bottom: 6px;
}

.imp-results {
  margin-top: 16px;
  max-height: 300px;
  overflow: auto;
}

.imp-item {
  padding: 8px 10px;
  border-left: 3px solid var(--bk-line);
  border-radius: 4px;
  background: var(--bk-page-bg);
  margin-bottom: 8px;
}

.imp-item__name {
  margin-left: 8px;
  font-size: 13px;
  word-break: break-all;
}

.imp-item__findings {
  margin-top: 4px;
  padding-left: 8px;
}

.imp-item__fail {
  color: var(--bk-danger);
  line-height: 1.7;
}
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

.filters {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.doc-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.doc-name__text {
  word-break: break-all;
}

.inv-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.9;
}

.inv-line__party {
  color: var(--bk-ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}
</style>
