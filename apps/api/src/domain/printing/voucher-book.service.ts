/**
 * 凭证册服务
 * ============================================================
 * 组装「会计凭证 + 原始单据（发票）」→ 生成可打印的 A4 凭证册。
 *
 * 打印策略（与业务约定一致）：
 *   · 日常不打印，**月末结账后一次性打一本**
 *   · 未结账期间也允许打印，但会显著标注「未结账，凭证可能变动」
 *   · 已作废凭证不打印；已红冲凭证打印并标注
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Decimal, round2 } from '@bookkeeper/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { fromDb } from '../../common/decimal';
import type {
  AttachmentView,
  VoucherBookView,
  VoucherLineView,
  VoucherPageView,
} from '../printing/voucher-book.model';

@Injectable()
export class VoucherBookService {
  private readonly logger = new Logger(VoucherBookService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 生成整册数据。
   *
   * @param voucherIds 指定则只打印这些凭证（单张补打场景）；不传则打印整个期间
   */
  async build(params: {
    entityId: string;
    periodId: string;
    voucherIds?: string[];
    /** 是否包含已红冲的凭证（默认包含并标注） */
    includeReversed?: boolean;
  }): Promise<VoucherBookView> {
    const { entityId, periodId, voucherIds } = params;

    const [entity, period] = await Promise.all([
      this.prisma.entity.findUnique({ where: { id: entityId } }),
      this.prisma.period.findFirst({ where: { id: periodId, entityId } }),
    ]);
    if (!entity) throw new NotFoundException(`核算主体不存在：${entityId}`);
    if (!period) throw new NotFoundException(`会计期间不存在：${periodId}`);

    const vouchers = await this.prisma.journalVoucher.findMany({
      where: {
        entityId,
        periodId,
        // 作废凭证不打印；其余（含已红冲）都打印
        status: { in: ['POSTED', 'REVERSED'] },
        ...(voucherIds?.length ? { id: { in: voucherIds } } : {}),
      },
      orderBy: [{ voucherWord: 'asc' }, { voucherNo: 'asc' }],
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            account: { select: { code: true, name: true, fullName: true } },
          },
        },
      },
    });

    if (vouchers.length === 0) {
      throw new NotFoundException(
        `${period.fiscalYear}-${String(period.month).padStart(2, '0')} 期间没有已过账的凭证。` +
          `凭证册只收录已过账凭证 —— 请先完成审核与过账。`,
      );
    }

    // ---- 批量解析附件（避免 N+1 查询）----
    const attachmentMap = await this.resolveAttachments(entityId, vouchers.map((v) => v.id));

    const pages: VoucherPageView[] = vouchers.map((v, index) => {
      const lines: VoucherLineView[] = v.lines.map((l) => ({
        lineNo: l.lineNo,
        accountCode: l.account.code,
        accountName: l.account.fullName || l.account.name,
        direction: l.direction,
        amount: fromDb(l.amount),
        summary: l.summary ?? v.summary,
        partnerName: undefined,
      }));

      const attachments = attachmentMap.get(v.id) ?? [];

      return {
        voucherId: v.id,
        voucherWord: v.voucherWord,
        voucherNo: v.voucherNo,
        sequence: index + 1,
        voucherDate: v.voucherDate,
        summary: v.summary,
        status: v.status,
        lines,
        totalDebit: fromDb(v.totalDebit),
        totalCredit: fromDb(v.totalCredit),
        attachments,
        // 自动记账生成的凭证必须有附件；手工凭证允许无附件（如结转、计提）
        missingAttachment: attachments.length === 0 && v.sourceType !== 'MANUAL' && v.sourceType !== 'CLOSING',
        sourceNote: v.ruleReason ?? undefined,
        preparedBy: v.createdBy ?? undefined,
        reviewedBy: v.reviewedBy ?? undefined,
        postedBy: v.postedBy ?? undefined,
        reversed: v.status === 'REVERSED',
      };
    });

    // ---- 科目发生额汇总 ----
    const accountAgg = new Map<string, { accountName: string; debit: Decimal; credit: Decimal }>();
    for (const page of pages) {
      for (const line of page.lines) {
        const cur = accountAgg.get(line.accountCode) ?? {
          accountName: line.accountName,
          debit: new Decimal(0),
          credit: new Decimal(0),
        };
        if (line.direction === 'DEBIT') cur.debit = cur.debit.plus(line.amount);
        else cur.credit = cur.credit.plus(line.amount);
        accountAgg.set(line.accountCode, cur);
      }
    }

    const sortedVouchers = [...vouchers].sort((a, b) => a.voucherNo - b.voucherNo);

    return {
      entity: {
        name: entity.name,
        unifiedSocialCreditCode: entity.unifiedSocialCreditCode,
        taxpayerType: entity.taxpayerType,
      },
      periodLabel: `${period.fiscalYear}-${String(period.month).padStart(2, '0')}`,
      periodStatus: period.status,
      generatedAt: new Date(),
      vouchers: pages,
      totals: {
        voucherCount: pages.length,
        attachmentCount: pages.reduce((s, p) => s + p.attachments.length, 0),
        missingAttachmentCount: pages.filter((p) => p.missingAttachment).length,
        totalDebit: round2(pages.reduce((s, p) => s.plus(p.totalDebit), new Decimal(0))),
        voucherNoFrom: sortedVouchers[0]?.voucherNo ?? null,
        voucherNoTo: sortedVouchers[sortedVouchers.length - 1]?.voucherNo ?? null,
      },
      accountSummary: [...accountAgg.entries()]
        .map(([accountCode, v]) => ({
          accountCode,
          accountName: v.accountName,
          debit: round2(v.debit),
          credit: round2(v.credit),
        }))
        .sort((a, b) => a.accountCode.localeCompare(b.accountCode)),
    };
  }

  /**
   * 批量解析凭证附件。
   *
   * 路径 ①：JournalLine.invoiceId → Invoice → Document
   * 路径 ②：DocumentLink(VOUCHER → DOCUMENT, ATTACHMENT)
   */
  private async resolveAttachments(
    entityId: string,
    voucherIds: string[],
  ): Promise<Map<string, AttachmentView[]>> {
    const result = new Map<string, AttachmentView[]>();
    if (voucherIds.length === 0) return result;

    // ---- 路径 ①：分录行关联的发票 ----
    const lines = await this.prisma.journalLine.findMany({
      where: { voucherId: { in: voucherIds }, invoiceId: { not: null } },
      select: { voucherId: true, invoiceId: true },
    });

    const invoiceIdsByVoucher = new Map<string, Set<string>>();
    for (const l of lines) {
      if (!l.invoiceId) continue;
      const set = invoiceIdsByVoucher.get(l.voucherId) ?? new Set<string>();
      set.add(l.invoiceId);
      invoiceIdsByVoucher.set(l.voucherId, set);
    }

    const allInvoiceIds = [...new Set([...invoiceIdsByVoucher.values()].flatMap((s) => [...s]))];

    const invoices = allInvoiceIds.length
      ? await this.prisma.invoice.findMany({
          where: { id: { in: allInvoiceIds } },
          include: {
            document: {
              select: {
                id: true,
                storageKey: true,
                mimeType: true,
                originalName: true,
                sizeBytes: true,
              },
            },
          },
        })
      : [];

    const invoiceById = new Map(invoices.map((i) => [i.id, i]));

    for (const [voucherId, ids] of invoiceIdsByVoucher) {
      const list = result.get(voucherId) ?? [];
      for (const id of ids) {
        const inv = invoiceById.get(id);
        if (!inv?.document) continue;
        list.push({
          kind: 'INVOICE',
          title: `${inv.direction === 'INPUT' ? '进项' : '销项'}发票 ${
            inv.digitalInvoiceNo ?? inv.invoiceNumber
          }`,
          summary:
            `${inv.sellerName} → ${inv.buyerName}　` +
            `${round2(fromDb(inv.amountExclTax)).toFixed(2)} + ${round2(fromDb(inv.taxAmount)).toFixed(2)} ` +
            `= ${round2(fromDb(inv.amountInclTax)).toFixed(2)}`,
          documentId: inv.document.id,
          storageKey: inv.document.storageKey,
          mimeType: inv.document.mimeType,
          originalName: inv.document.originalName,
          sizeBytes: inv.document.sizeBytes,
          // 扩展名也算数：mimeType 可能不准，但 .png/.jpg 一定是图片
          isImage:
            inv.document.mimeType.startsWith('image/') ||
            /\\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(inv.document.originalName),
          amount: fromDb(inv.amountInclTax),
          invoiceId: inv.id,
          direction: inv.direction,
          invoiceDate: inv.invoiceDate,
          sellerName: inv.sellerName,
          buyerName: inv.buyerName,
        });
      }
      result.set(voucherId, list);
    }

    // ---- 路径 ②：显式挂接的附件 ----
    const links = await this.prisma.documentLink.findMany({
      where: {
        entityId,
        fromType: 'VOUCHER',
        fromId: { in: voucherIds },
        toType: 'DOCUMENT',
      },
    });

    if (links.length > 0) {
      const docIds = [...new Set(links.map((l) => l.toId))];
      const docs = await this.prisma.document.findMany({
        where: { id: { in: docIds } },
        select: { id: true, storageKey: true, mimeType: true, originalName: true, sizeBytes: true, docType: true },
      });
      const docById = new Map(docs.map((d) => [d.id, d]));

      for (const link of links) {
        const doc = docById.get(link.toId);
        if (!doc) continue;
        const list = result.get(link.fromId) ?? [];
        // 去重：同一文档可能既被发票路径带入，又被显式挂接
        if (list.some((a) => a.documentId === doc.id)) continue;
        list.push({
          kind: 'DOCUMENT',
          title: doc.originalName,
          summary: `附件（${doc.docType}）`,
          documentId: doc.id,
          storageKey: doc.storageKey,
          mimeType: doc.mimeType,
          originalName: doc.originalName,
          sizeBytes: doc.sizeBytes,
          isImage:
            doc.mimeType.startsWith('image/') ||
            /\\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(doc.originalName),
        });
        result.set(link.fromId, list);
      }
    }

    // 按发票日期/文档名排序，保证打印顺序稳定可复现
    for (const [, list] of result) {
      list.sort((a, b) => {
        const da = a.invoiceDate?.getTime() ?? 0;
        const db = b.invoiceDate?.getTime() ?? 0;
        if (da !== db) return da - db;
        return a.title.localeCompare(b.title);
      });
    }

    return result;
  }

  /** 附件统计（用于列表页显示"x 张凭证，y 张附件，z 张缺附件"） */
  async attachmentStats(params: { entityId: string; periodId: string }): Promise<{
    voucherCount: number;
    withAttachment: number;
    missingAttachment: number;
    attachmentCount: number;
  }> {
    const vouchers = await this.prisma.journalVoucher.findMany({
      where: { entityId: params.entityId, periodId: params.periodId, status: { in: ['POSTED', 'REVERSED'] } },
      select: { id: true, sourceType: true },
    });
    if (vouchers.length === 0) {
      return { voucherCount: 0, withAttachment: 0, missingAttachment: 0, attachmentCount: 0 };
    }

    const map = await this.resolveAttachments(params.entityId, vouchers.map((v) => v.id));

    let withAttachment = 0;
    let missingAttachment = 0;
    let attachmentCount = 0;

    for (const v of vouchers) {
      const list = map.get(v.id) ?? [];
      attachmentCount += list.length;
      if (list.length > 0) withAttachment += 1;
      else if (v.sourceType !== 'MANUAL' && v.sourceType !== 'CLOSING') missingAttachment += 1;
    }

    return { voucherCount: vouchers.length, withAttachment, missingAttachment, attachmentCount };
  }
}
