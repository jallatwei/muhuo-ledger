/**
 * 凭证册 HTML 渲染器
 * ============================================================
 * ★ 一份模板两处用：既用于屏幕预览，也用于浏览器打印（window.print）。
 *   后端渲染 PDF 时同样复用它。避免"屏幕上一套、打印另一套"的经典不一致。
 *
 * A4 版式要点：
 *   · 210×297mm，@page 设为 A4 并留 12mm 页边距
 *   · 左侧 25mm 装订边（凭证册要装订成册）
 *   · 金额等宽字体、右对齐、千分位、两位小数 —— 会计核对的硬要求
 *   · 每张凭证独立分页；附件各自独立分页
 *   · 打印时隐藏所有屏幕控件（靠 @media print）
 */
import { APP_NAME, formatMoney, round2, toChineseUppercase } from '@bookkeeper/shared';
import type { AttachmentView, VoucherBookView, VoucherPageView } from './voucher-book.model';

export interface RenderOptions {
  /** 附件打印范围：NONE 仅凭证 | IMAGE 图片类附件 | ALL 全部 */
  attachmentMode?: 'NONE' | 'IMAGE' | 'ALL';
  /** 附件图片的 data URL 映射（documentId → data:image/...;base64,...） */
  imageDataUrls?: Map<string, string>;
  /** 是否打印科目汇总表 */
  includeAccountSummary?: boolean;
  /** 每张凭证的打印份数（默认 1） */
  copiesPerVoucher?: number;
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function formatDateCN(d: Date): string {
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

function formatDateISO(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** HTML 转义 —— 单位名称与摘要来自用户数据，必须转义 */
function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 金额显示：千分位 + 2 位小数。空值显示为空白而不是 0.00（便于人工核对） */
function money(v: unknown, blankWhenZero = false): string {
  const d = round2(v as never);
  if (blankWhenZero && d.isZero()) return '';
  return formatMoney(d, { thousands: true });
}

export function renderVoucherBook(book: VoucherBookView, options: RenderOptions = {}): string {
  const {
    attachmentMode = 'IMAGE',
    imageDataUrls = new Map<string, string>(),
    includeAccountSummary = true,
    copiesPerVoucher = 1,
  } = options;

  const pages: string[] = [];

  // ---- 封面 ----
  pages.push(renderCover(book));

  // ---- 凭证页（含附件）----
  for (const voucher of book.vouchers) {
    for (let copy = 0; copy < copiesPerVoucher; copy += 1) {
      pages.push(renderVoucherPage(book, voucher, copy));
    }
    if (attachmentMode !== 'NONE') {
      pages.push(...renderAttachments(voucher, attachmentMode, imageDataUrls));
    }
  }

  // ---- 科目汇总表 ----
  if (includeAccountSummary && book.accountSummary.length > 0) {
    pages.push(renderAccountSummary(book));
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>记账凭证册 ${esc(book.periodLabel)} · ${esc(book.entity.name)}</title>
<style>${STYLES}</style>
</head>
<body>
${pages.join('\n')}
<script>
  // 打印完成后自动关闭（从打印预览窗口打开时）
  window.addEventListener('load', function () {
    if (window.__BK_AUTO_PRINT__) { window.print(); }
  });
</script>
</body>
</html>`;
}

// ============================================================================
//  封面
// ============================================================================

function renderCover(book: VoucherBookView): string {
  const t = book.totals;
  const range =
    t.voucherNoFrom !== null && t.voucherNoTo !== null
      ? `记-${t.voucherNoFrom} 至 记-${t.voucherNoTo}`
      : '—';

  return `
<section class="page page--cover">
  <div class="cover__inner">
    <div class="cover__entity">${esc(book.entity.name)}</div>
    <div class="cover__sub">
      ${book.entity.unifiedSocialCreditCode ? `统一社会信用代码：${esc(book.entity.unifiedSocialCreditCode)}` : ''}
      ${book.entity.taxpayerType === 'GENERAL' ? '　一般纳税人' : '　小规模纳税人'}
    </div>

    <h1 class="cover__title">记 账 凭 证 册</h1>
    <div class="cover__period">${esc(book.periodLabel)}</div>

    <table class="cover__meta">
      <tr><th>凭证张数</th><td>${t.voucherCount} 张</td></tr>
      <tr><th>凭证号范围</th><td>${esc(range)}</td></tr>
      <tr><th>本期借方合计</th><td class="num">${money(t.totalDebit)}</td></tr>
      <tr><th>原始单据</th><td>${t.attachmentCount} 张${
        t.missingAttachmentCount > 0
          ? `　<span class="warn">（${t.missingAttachmentCount} 张凭证无关联单据）</span>`
          : ''
      }</td></tr>
      <tr><th>期间状态</th><td>${
        book.periodStatus === 'CLOSED'
          ? '已结账'
          : book.periodStatus === 'CLOSING'
            ? '<span class="warn">结账中</span>'
            : '<span class="warn">未结账（凭证仍可能变动，建议结账后重新打印）</span>'
      }</td></tr>
      <tr><th>打印日期</th><td>${formatDateISO(book.generatedAt)}</td></tr>
    </table>

    <table class="cover__sign">
      <tr>
        <td>会计主管：____________</td>
        <td>记账：____________</td>
        <td>审核：____________</td>
        <td>制单：____________</td>
      </tr>
    </table>

    <div class="cover__foot">
      本册由 ${APP_NAME} 生成　·　装订线在左侧 25mm 处
    </div>
  </div>
</section>`;
}

// ============================================================================
//  记账凭证页
// ============================================================================

function renderVoucherPage(book: VoucherBookView, v: VoucherPageView, copy: number): string {
  const rows: string[] = [];

  for (const line of v.lines) {
    const isDebit = line.direction === 'DEBIT';
    rows.push(`
      <tr>
        <td class="c">${esc(line.accountCode)}</td>
        <td>${esc(line.accountName)}</td>
        <td class="summary">${esc(line.summary)}${line.partnerName ? `<span class="aux">（${esc(line.partnerName)}）</span>` : ''}</td>
        <td class="num">${isDebit ? money(line.amount) : ''}</td>
        <td class="num">${isDebit ? '' : money(line.amount)}</td>
      </tr>`);
  }

  // 补空行到至少 5 行，让凭证看起来规整、也方便手写补记
  const minRows = 5;
  for (let i = v.lines.length; i < minRows; i += 1) {
    rows.push('<tr class="empty"><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td></tr>');
  }

  const voucherLabel = v.voucherNo > 0 ? `${v.voucherWord}-${v.voucherNo}` : `${v.voucherWord}-（未编号）`;
  const attachmentCount = v.attachments.length;

  return `
<section class="page page--voucher${v.reversed ? ' page--reversed' : ''}">
  <div class="vh">
    <div class="vh__left">
      <div class="vh__entity">${esc(book.entity.name)}</div>
      <div class="vh__doctype">记 账 凭 证</div>
    </div>
    <div class="vh__right">
      <div class="vh__date">${formatDateCN(v.voucherDate)}</div>
      <div class="vh__no">
        字第 <span class="vh__numbox">${esc(voucherLabel)}</span> 号
        ${copy > 0 ? '<span class="copy-tag">副本</span>' : ''}
      </div>
    </div>
  </div>

  ${
    v.reversed
      ? '<div class="banner banner--danger">本凭证已被红冲，仅作历史留存，不参与余额计算</div>'
      : ''
  }
  ${
    v.missingAttachment
      ? '<div class="banner banner--warn">本凭证未关联原始单据，请核对后补挂附件</div>'
      : ''
  }

  <table class="vtable">
    <thead>
      <tr>
        <th class="c" style="width:13%">科目编码</th>
        <th style="width:26%">科目名称</th>
        <th style="width:24%">摘要</th>
        <th class="num" style="width:18.5%">借方金额</th>
        <th class="num" style="width:18.5%">贷方金额</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('')}
    </tbody>
    <tfoot>
      <tr class="total">
        <td colspan="3" class="c">合计：${esc(toChineseUppercase(v.totalDebit))}</td>
        <td class="num">${money(v.totalDebit)}</td>
        <td class="num">${money(v.totalCredit)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="vfoot">
    <div class="vfoot__left">
      <span>附件 ${attachmentCount} 张</span>
      <span>${v.sourceNote ? `依据：${esc(truncate(v.sourceNote, 60))}` : ''}</span>
    </div>
    <div class="vfoot__sign">
      <span>制单：${esc(v.preparedBy ?? '')}</span>
      <span>审核：${esc(v.reviewedBy ?? '')}</span>
      <span>记账：${esc(v.postedBy ?? '')}</span>
    </div>
  </div>

  <div class="vseq">第 ${v.sequence} / ${book.totals.voucherCount} 张　·　${esc(book.periodLabel)}</div>
</section>`;
}

// ============================================================================
//  附件页
// ============================================================================

function renderAttachments(
  v: VoucherPageView,
  mode: 'NONE' | 'IMAGE' | 'ALL',
  imageDataUrls: Map<string, string>,
): string[] {
  const out: string[] = [];
  const voucherLabel = v.voucherNo > 0 ? `${v.voucherWord}-${v.voucherNo}` : `${v.voucherWord}-（未编号）`;

  for (const [index, att] of v.attachments.entries()) {
    const isImage = att.isImage || imageDataUrls.has(att.documentId);

    if (isImage) {
      const dataUrl = imageDataUrls.get(att.documentId);
      out.push(renderImageAttachment(voucherLabel, v, att, index + 1, dataUrl));
    } else if (mode === 'ALL') {
      // PDF 类附件：打印时提示单独打印，避免浏览器静默丢页
      out.push(renderPdfPlaceholder(voucherLabel, v, att, index + 1));
    }
  }

  return out;
}

function renderImageAttachment(
  voucherLabel: string,
  v: VoucherPageView,
  att: AttachmentView,
  seq: number,
  dataUrl?: string,
): string {
  return `
<section class="page page--attachment">
  <div class="ah">
    <span>附件 ${seq}/${v.attachments.length}　·　对应凭证 ${esc(voucherLabel)}</span>
    <span>${esc(att.title)}</span>
  </div>
  ${
    dataUrl
      ? `<div class="aimg"><img src="${dataUrl}" alt="${esc(att.title)}"></div>`
      : `<div class="aimg aimg--missing">
           <div>附件图片未能载入</div>
           <div class="hint">${esc(att.originalName)}（${formatBytes(att.sizeBytes)}）</div>
           <div class="hint">请检查单据存储卷是否已挂载</div>
         </div>`
  }
  <div class="afoot">
    <span>${esc(att.summary)}</span>
    <span class="aamount">${att.amount ? `价税合计 ${money(att.amount)}` : ''}</span>
  </div>
</section>`;
}

function renderPdfPlaceholder(
  voucherLabel: string,
  v: VoucherPageView,
  att: AttachmentView,
  seq: number,
): string {
  return `
<section class="page page--attachment">
  <div class="ah">
    <span>附件 ${seq}/${v.attachments.length}　·　对应凭证 ${esc(voucherLabel)}</span>
    <span>${esc(att.title)}</span>
  </div>
  <div class="aimg aimg--missing">
    <div>该附件为 PDF 格式：${esc(att.originalName)}（${formatBytes(att.sizeBytes)}）</div>
    <div class="hint">浏览器无法把 PDF 可靠地嵌入打印流，请单独打印该文件后与本册一并装订。</div>
    <div class="hint">或在「发票仓库」中下载后打印。</div>
  </div>
  <div class="afoot">
    <span>${esc(att.summary)}</span>
    <span class="aamount">${att.amount ? `价税合计 ${money(att.amount)}` : ''}</span>
  </div>
</section>`;
}

// ============================================================================
//  科目汇总表
// ============================================================================

function renderAccountSummary(book: VoucherBookView): string {
  const rows = book.accountSummary
    .map(
      (a) => `
      <tr>
        <td class="c">${esc(a.accountCode)}</td>
        <td>${esc(a.accountName)}</td>
        <td class="num">${money(a.debit, true)}</td>
        <td class="num">${money(a.credit, true)}</td>
      </tr>`,
    )
    .join('');

  return `
<section class="page page--summary">
  <div class="vh">
    <div class="vh__left">
      <div class="vh__entity">${esc(book.entity.name)}</div>
      <div class="vh__doctype">科 目 发 生 额 汇 总 表</div>
    </div>
    <div class="vh__right">
      <div class="vh__date">${esc(book.periodLabel)}</div>
      <div class="vh__no">共 ${book.totals.voucherCount} 张凭证</div>
    </div>
  </div>

  <table class="vtable">
    <thead>
      <tr>
        <th class="c" style="width:16%">科目编码</th>
        <th style="width:44%">科目名称</th>
        <th class="num" style="width:20%">借方发生额</th>
        <th class="num" style="width:20%">贷方发生额</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr class="total">
        <td colspan="2" class="c">合计</td>
        <td class="num">${money(book.totals.totalDebit)}</td>
        <td class="num">${money(book.totals.totalDebit)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="vfoot">
    <div class="vfoot__left">
      <span>借贷双方合计相等，验证通过</span>
    </div>
    <div class="vfoot__sign">
      <span>制表：____________</span>
      <span>复核：____________</span>
    </div>
  </div>
</section>`;
}

// ============================================================================
//  样式
// ============================================================================

const STYLES = `
@page { size: A4 portrait; margin: 12mm 10mm 12mm 25mm; }

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: #f0f2f5;
  font-family: "SimSun", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif;
  font-size: 10.5pt;
  color: #000;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ---- A4 页面容器 ---- */
.page {
  /* 屏幕预览：模拟 A4（含装订边）。打印时的尺寸由 @page 决定，见 @media print */
  width: 210mm;
  min-height: 275mm;
  padding: 12mm 10mm 12mm 25mm;
  margin: 8mm auto;
  background: #fff;
  box-shadow: 0 1px 6px rgba(0,0,0,0.15);
  position: relative;
  page-break-after: always;
  break-after: page;
}
.page:last-child { page-break-after: auto; break-after: auto; }

@media print {
  html, body { background: #fff; }

  /* ★ 打印时每页必须「分页但不重复占位」：
       @page 已经提供了页边距（含 25mm 装订边），所以这里把 .page 自身的
       width / min-height / padding 全部清零。
       否则 .page 的 min-height:297mm 加上 body 的 @page 边距，
       会变成每节占一页半 —— 表现为凭证页下方大片空白、发票被推到第二张纸。 */
  .page {
    width: auto;
    min-height: 0;
    padding: 0;
    margin: 0;
    box-shadow: none;
    break-after: page;
    page-break-after: always;
  }
  .page:last-child {
    break-after: auto;
    page-break-after: auto;
  }

  /* 绝对定位的页码在打印时改为静态，避免它把页撑高或被裁掉 */
  .vseq {
    position: static;
    text-align: right;
    margin-top: 4mm;
    padding-right: 0;
  }

  /* 凭证页的表格不要跨页断开（一张凭证必须在一张纸上） */
  .vtable { break-inside: avoid; page-break-inside: avoid; }
  .vtable tr { break-inside: avoid; page-break-inside: avoid; }
  .vh { break-after: avoid; page-break-after: avoid; }
  .banner { break-inside: avoid; page-break-inside: avoid; }
  .vfoot { break-inside: avoid; page-break-inside: avoid; }

  /* 附件图片按可用高度缩放，保证整张票在一页内 */
  .aimg { height: 232mm; }
  .afoot { break-before: avoid; page-break-before: avoid; }

  .no-print { display: none !important; }
}

/* ---- 金额：等宽 + 右对齐 + 不换行 ---- */
.num {
  font-family: "Consolas", "DejaVu Sans Mono", monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.c { text-align: center; }
.warn { color: #b45309; font-weight: 700; }

/* ---- 封面 ---- */
.page--cover { display: flex; align-items: center; justify-content: center; }
.cover__inner { width: 100%; text-align: center; padding: 0 10mm; }
.cover__entity { font-size: 20pt; font-weight: 700; letter-spacing: 2px; }
.cover__sub { font-size: 9pt; color: #444; margin-top: 4mm; }
.cover__title {
  font-size: 30pt;
  font-weight: 700;
  letter-spacing: 14px;
  margin: 26mm 0 6mm;
}
.cover__period { font-size: 16pt; letter-spacing: 4px; margin-bottom: 20mm; }
.cover__meta {
  width: 120mm;
  margin: 0 auto;
  border-collapse: collapse;
  font-size: 10pt;
}
.cover__meta th, .cover__meta td {
  border: 1px solid #333;
  padding: 2.5mm 4mm;
  text-align: left;
}
.cover__meta th { width: 40mm; background: #f2f2f2; font-weight: 400; }
.cover__sign {
  width: 100%;
  margin-top: 22mm;
  font-size: 10pt;
  border-collapse: collapse;
}
.cover__sign td { padding: 2mm 0; text-align: left; }
.cover__foot { margin-top: 18mm; font-size: 8pt; color: #666; }

/* ---- 凭证页 ---- */
.vh {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  border-bottom: 1.2pt solid #000;
  padding-bottom: 2mm;
  margin-bottom: 3mm;
}
.vh__entity { font-size: 12pt; font-weight: 700; }
.vh__doctype { font-size: 15pt; letter-spacing: 8px; margin-top: 1mm; }
.vh__right { text-align: right; font-size: 10pt; }
.vh__date { margin-bottom: 1mm; }
.vh__numbox {
  display: inline-block;
  min-width: 26mm;
  padding: 0 1.5mm;
  border-bottom: 1pt solid #000;
  text-align: center;
  font-family: "Consolas", monospace;
}
.copy-tag { font-size: 8pt; color: #999; margin-left: 2mm; }

.banner {
  padding: 1.5mm 3mm;
  margin-bottom: 2.5mm;
  font-size: 9pt;
  border: 1pt solid;
}
.banner--danger { border-color: #b91c1c; color: #b91c1c; background: #fef2f2; font-weight: 700; }
.banner--warn { border-color: #b45309; color: #b45309; background: #fffbeb; }

.vtable {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.vtable th, .vtable td {
  border: 0.6pt solid #000;
  padding: 1.6mm 2mm;
  font-size: 10pt;
  vertical-align: top;
  word-break: break-all;
}
.vtable th {
  background: #f2f2f2;
  font-weight: 400;
  text-align: center;
}
.vtable tbody tr.empty td { height: 8mm; }
.vtable .summary { font-size: 9.5pt; }
.vtable .aux { color: #444; font-size: 9pt; }
.vtable tr.total td {
  border-top: 1.2pt solid #000;
  font-weight: 700;
  background: #fafafa;
}
.vtable tfoot .c { text-align: left; font-weight: 400; font-size: 9pt; }

.vfoot {
  display: flex;
  justify-content: space-between;
  margin-top: 4mm;
  font-size: 9pt;
}
.vfoot__left { display: flex; gap: 6mm; color: #333; }
.vfoot__sign { display: flex; gap: 8mm; }
.vseq {
  position: absolute;
  bottom: 6mm;
  right: 10mm;
  font-size: 8pt;
  color: #888;
}

/* ---- 附件页 ---- */
.ah {
  display: flex;
  justify-content: space-between;
  font-size: 9pt;
  border-bottom: 0.8pt solid #000;
  padding-bottom: 1.5mm;
  margin-bottom: 3mm;
}
.aimg {
  height: 235mm;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 0.5pt dashed #bbb;
}
.aimg img { max-width: 100%; max-height: 100%; object-fit: contain; }
.aimg--missing {
  flex-direction: column;
  gap: 3mm;
  color: #888;
  font-size: 10pt;
  border-style: dashed;
}
.aimg--missing .hint { font-size: 8.5pt; color: #aaa; }
.afoot {
  display: flex;
  justify-content: space-between;
  font-size: 8.5pt;
  color: #444;
  margin-top: 2mm;
}
.aamount { font-family: "Consolas", monospace; }
`;


/** 截断长文本（凭证脚注空间有限） */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** 文件大小的人类可读表示 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}