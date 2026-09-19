/**
 * 凭证册数据组装
 * ============================================================
 * 把「会计凭证 + 其关联的原始单据」组装成打印所需的完整结构。
 *
 * ★ 附件关联的三条路径（按可靠性排序）：
 *   ① JournalLine.invoiceId → Invoice.documentId
 *      最强关联：分录行直接指向发票。自动记账生成的凭证走这条。
 *   ② DocumentLink(fromType=VOUCHER, toType=DOCUMENT, linkType=ATTACHMENT)
 *      显式挂接：人工把单据作为附件挂到凭证上。
 *   ③ 手工凭证没有关联 → 打印时提示"缺附件"
 *
 * 三者会去重合并。同一张发票被多行引用时只打印一次。
 */
import { Decimal, round2 } from '@bookkeeper/shared';

export interface VoucherLineView {
  lineNo: number;
  accountCode: string;
  accountName: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: Decimal;
  summary: string;
  /** 辅助核算显示：客户/供应商名称 */
  partnerName?: string;
}

export interface AttachmentView {
  kind: 'INVOICE' | 'DOCUMENT' | 'OTHER';
  /** 附件标题，如"进项专票 12345678 某某办公用品有限公司" */
  title: string;
  /** 关键信息摘要，一行 */
  summary: string;
  documentId: string;
  storageKey: string;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  /** 是否为图片（可直接 <img>），否则视为 PDF */
  isImage: boolean;
  /** 金额（发票价税合计），用于打印时与凭证核对 */
  amount?: Decimal;
  invoiceId?: string;
  direction?: 'INPUT' | 'OUTPUT';
  invoiceDate?: Date;
  sellerName?: string;
  buyerName?: string;
}

export interface VoucherPageView {
  voucherId: string;
  voucherWord: string;
  voucherNo: number;
  /** 打印序号（册内从 1 开始） */
  sequence: number;
  voucherDate: Date;
  summary: string;
  status: string;
  lines: VoucherLineView[];
  totalDebit: Decimal;
  totalCredit: Decimal;
  attachments: AttachmentView[];
  /** 缺少原始单据时为 true —— 打印时显著提示 */
  missingAttachment: boolean;
  /** 来源说明：自动记账时给出命中规则，回答"为什么这么记" */
  sourceNote?: string;
  /** 制单/审核/记账人 */
  preparedBy?: string;
  reviewedBy?: string;
  postedBy?: string;
  /** 是否已被红冲 */
  reversed: boolean;
}

export interface VoucherBookView {
  entity: {
    name: string;
    unifiedSocialCreditCode?: string | null;
    taxpayerType: string;
  };
  periodLabel: string;
  periodStatus: string;
  generatedAt: Date;
  vouchers: VoucherPageView[];
  /** 本册合计 */
  totals: {
    voucherCount: number;
    attachmentCount: number;
    missingAttachmentCount: number;
    totalDebit: Decimal;
    voucherNoFrom: number | null;
    voucherNoTo: number | null;
  };
  /** 科目发生额汇总（册末的科目汇总表） */
  accountSummary: Array<{
    accountCode: string;
    accountName: string;
    debit: Decimal;
    credit: Decimal;
  }>;
}

// ---------------------------------------------------------------- 金额大写
export { toChineseUppercase } from '@bookkeeper/shared';
