import { deductibleByVoucherType, type VoucherType } from '../domain/tax/voucher-type';
/**
 * 发票接口
 * ============================================================
 * 发票是「电子发票仓库」的核心业务对象：
 *   Document（原始文件）—1:1— Invoice（结构化数据）—N:M— JournalLine（凭证分录）
 *
 * ★ 幂等：按业务唯一键（主体+方向+代码+号码+红冲标记）去重。
 *   同一张票被重复导入时，不会产生第二条记录，而是把新文件挂为补充附件。
 *
 * ★ 关联单据：创建发票时若带 documentId，同时写一条 DocumentLink，
 *   这样即使分录行没有引用该发票，凭证册也能通过显式挂接把它打出来。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, type Invoice } from '@prisma/client';
import { Decimal, assertTaxConsistency, round2 } from '@bookkeeper/shared';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { AuditService } from '../infrastructure/prisma/audit.service';
import { AccountService } from '../infrastructure/prisma/account.service';
import { fromDb, toDb, toDbRate } from '../common/decimal';
import { buildInvoiceDedupHash, DEDUP_NS_INVOICE } from '../common/dedup';

export interface CreateInvoiceInput {
  entityId: string;
  direction: 'INPUT' | 'OUTPUT';
  /** 受控的进项凭证类型；不传按 OTHER（没认出来）处理，绝不默认成专票 */
  category?: VoucherType;
  invoiceCode?: string | null;
  invoiceNumber: string;
  digitalInvoiceNo?: string | null;
  invoiceDate: string;
  sellerName: string;
  sellerTaxNo?: string | null;
  buyerName: string;
  buyerTaxNo?: string | null;
  amountExclTax: string;
  taxRate: string;
  taxAmount: string;
  amountInclTax: string;
  isRedFlushed?: boolean;
  isDeductible?: boolean;
  businessType?: string | null;
  accountCode?: string | null;
  partnerId?: string | null;
  contractId?: string | null;
  /** 原始单据文件 id（发票扫描件/电子原件） */
  documentId?: string | null;
  /** 该发票所属凭证（若已经入账，直接建立勾稽） */
  voucherId?: string | null;
  items?: Array<{
    itemName: string;
    spec?: string | null;
    unit?: string | null;
    quantity?: string | null;
    unitPrice?: string | null;
    amountExclTax: string;
    taxRate: string;
    taxAmount: string;
    accountCode?: string | null;
  }>;
}

@ApiTags('发票')
@Controller('invoices')
export class InvoiceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounts: AccountService,
  ) {}

  @Post()
  @ApiOperation({
    summary: '创建发票（幂等：同主体+方向+代码+号码+红冲标记 只保留一条）',
    description:
      '金额三项（不含税/税额/价税合计）会做勾稽校验，不一致时拒绝写入 —— ' +
      '这是拦住 OCR 数字错误的第一道闸门。',
  })
  async create(@Body() body: CreateInvoiceInput) {
    if (!body.entityId) throw new BadRequestException('缺少 entityId');
    if (!body.invoiceNumber) throw new BadRequestException('缺少发票号码');

    const excl = round2(new Decimal(body.amountExclTax ?? 0));
    const tax = round2(new Decimal(body.taxAmount ?? 0));
    const incl = round2(new Decimal(body.amountInclTax ?? 0));

    // ★ 金额勾稽：与识别阶段的 V1 同一套判定，容忍票面 2 分舍入
    const consistency = assertTaxConsistency(excl, tax, incl, '0.02');
    if (!consistency.ok) {
      throw new BadRequestException(
        `金额勾稽不成立：不含税 ${excl.toFixed(2)} + 税额 ${tax.toFixed(2)} = ` +
          `${round2(excl.plus(tax)).toFixed(2)}，但价税合计为 ${incl.toFixed(2)}，` +
          `差异 ${consistency.difference.toFixed(2)}。请核对票面金额再提交。`,
      );
    }

    const invoiceCode = body.invoiceCode?.trim() || null;
    const isRedFlushed = body.isRedFlushed ?? false;

    /*
     * ★ 凭证类型决定进项税能不能抵，不能有"缺省就当专票"的默认值。
     *
     *   这里曾经是 `body.category ?? 'SPECIAL_VAT'` —— 一张出租车卷式票、
     *   一张没认出来的收据，只要调用方漏传类别，落库就成了
     *   "可抵扣的增值税专用发票"。isDeductible 同理，曾默认成 true。
     *   缺失时取 OTHER（"没认出来"），并让可抵扣性跟着凭证类型的口径走：
     *   宁可保守地不抵扣、要求人工指定，也不要凭空造出一张专票。
     */
    const categoryValue: VoucherType = body.category ?? 'OTHER';

    // 幂等：命中已有发票则补充附件后返回
    const existing = await this.prisma.invoice.findFirst({
      where: {
        entityId: body.entityId,
        direction: body.direction,
        invoiceCode,
        invoiceNumber: body.invoiceNumber,
        isRedFlushed,
      },
    });
    if (existing) {
      if (body.documentId && existing.documentId !== body.documentId) {
        await this.linkDocumentToVoucher(body.entityId, existing.id, body.documentId, body.voucherId ?? null);
      }
      return {
        id: existing.id,
        duplicated: true,
        message: `该发票已存在（${existing.invoiceNumber}），未重复创建。${
          body.documentId ? '新文件已挂为该发票的补充附件。' : ''
        }`,
      };
    }

    // 解析科目（若给了 accountCode）
    let accountId: string | null = null;
    if (body.accountCode) {
      const meta = await this.accounts.requireByCode(body.entityId, body.accountCode);
      accountId = meta.id;
    }

    const invoiceDate = new Date(`${body.invoiceDate.slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(invoiceDate.getTime())) {
      throw new BadRequestException(`开票日期无法解析：${body.invoiceDate}`);
    }

    const dedupHash = buildDedupHash({
      entityId: body.entityId,
      direction: body.direction,
      invoiceCode,
      invoiceNumber: body.invoiceNumber,
      invoiceDate,
      sellerTaxNo: body.sellerTaxNo ?? null,
      amountInclTax: incl,
      isRedFlushed,
    });

    const created = await this.prisma.invoice.create({
      data: {
        entityId: body.entityId,
        direction: body.direction,
        category: categoryValue,
        invoiceCode,
        invoiceNumber: body.invoiceNumber,
        digitalInvoiceNo: body.digitalInvoiceNo ?? null,
        invoiceDate,
        sellerName: body.sellerName,
        sellerTaxNo: body.sellerTaxNo ?? null,
        buyerName: body.buyerName,
        buyerTaxNo: body.buyerTaxNo ?? null,
        amountExclTax: toDb(excl),
        taxRate: toDbRate(body.taxRate ?? '0'),
        taxAmount: toDb(tax),
        amountInclTax: toDb(incl),
        isRedFlushed,
        isDeductible: body.isDeductible ?? deductibleByVoucherType(categoryValue),
        businessType: body.businessType ?? null,
        accountId,
        partnerId: body.partnerId ?? null,
        contractId: body.contractId ?? null,
        documentId: body.documentId ?? null,
        status: 'IMPORTED',
        dedupHash,
        lines: body.items?.length
          ? {
              create: body.items.map((it, i) => ({
                lineNo: i + 1,
                itemName: it.itemName,
                spec: it.spec ?? null,
                unit: it.unit ?? null,
                quantity: it.quantity ? new Prisma.Decimal(it.quantity) : null,
                unitPrice: it.unitPrice ? new Prisma.Decimal(it.unitPrice) : null,
                amountExclTax: new Prisma.Decimal(it.amountExclTax),
                taxRate: toDbRate(it.taxRate),
                taxAmount: new Prisma.Decimal(it.taxAmount),
              })),
            }
          : undefined,
      },
    });

    // 建立与凭证的显式勾稽（凭证册打印时据此带出附件）
    if (body.documentId) {
      await this.linkDocumentToVoucher(body.entityId, created.id, body.documentId, body.voucherId ?? null);
    }

    await this.audit.record({
      entityId: body.entityId,
      action: 'CREATE',
      subjectType: 'Invoice',
      subjectId: created.id,
      afterData: {
        direction: body.direction,
        invoiceNumber: body.invoiceNumber,
        amountInclTax: incl.toFixed(2),
        documentId: body.documentId ?? null,
      },
    });

    return { id: created.id, duplicated: false };
  }

  @Get()
  @ApiOperation({ summary: '发票列表（可按年度、方向、是否已入账筛选）' })
  async list(
    @Query('entityId') entityId: string,
    @Query('year') year?: string,
    @Query('direction') direction?: 'INPUT' | 'OUTPUT',
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const take = Math.min(200, Math.max(1, Number(pageSize ?? 50)));
    const skip = (Math.max(1, Number(page ?? 1)) - 1) * take;

    const where: Prisma.InvoiceWhereInput = { entityId };
    if (direction) where.direction = direction;
    if (status) where.status = status as never;
    if (year) {
      where.invoiceDate = {
        gte: new Date(Date.UTC(Number(year), 0, 1)),
        lt: new Date(Date.UTC(Number(year) + 1, 0, 1)),
      };
    }
    if (keyword) {
      where.OR = [
        { sellerName: { contains: keyword } },
        { buyerName: { contains: keyword } },
        { invoiceNumber: { contains: keyword } },
        { digitalInvoiceNo: { contains: keyword } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }],
        skip,
        take,
        include: {
          document: { select: { id: true, mimeType: true, originalName: true, sizeBytes: true } },
          journalLines: {
            select: {
              voucher: {
                select: {
                  id: true,
                  voucherWord: true,
                  voucherNo: true,
                  status: true,
                  periodYear: true,
                  periodMonth: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return {
      items: items.map((inv) => ({
        ...serializeInvoice(inv),
        document: inv.document
          ? { ...inv.document, isImage: inv.document.mimeType.startsWith('image/') }
          : null,
        linkedVouchers: dedupeVouchers(inv.journalLines.map((l) => l.voucher).filter(Boolean)),
        isPosted: inv.journalLines.length > 0,
      })),
      total,
      page: Number(page ?? 1),
      pageSize: take,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: '发票详情（含明细行与勾稽到的凭证）' })
  async detail(@Param('id') id: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        document: true,
        journalLines: {
          include: {
            voucher: {
              select: {
                id: true,
                voucherWord: true,
                voucherNo: true,
                status: true,
                voucherDate: true,
                summary: true,
                periodYear: true,
                periodMonth: true,
              },
            },
          },
        },
      },
    });
    if (!inv) throw new NotFoundException(`发票不存在：${id}`);
    return {
      ...serializeInvoice(inv),
      lines: inv.lines,
      document: inv.document,
      linkedVouchers: dedupeVouchers(inv.journalLines.map((l) => l.voucher)),
    };
  }

  @Patch(':id')
  @ApiOperation({
    summary: '修正发票信息（人工复核后用）',
    description: '已入账的发票也允许修正非金额字段；金额字段修正会影响申报表取数，请谨慎。',
  })
  async update(@Param('id') id: string, @Body() body: Partial<CreateInvoiceInput>) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException(`发票不存在：${id}`);

    const data: Prisma.InvoiceUpdateInput = {};
    if (body.sellerName) data.sellerName = body.sellerName;
    if (body.buyerName) data.buyerName = body.buyerName;
    if (body.sellerTaxNo !== undefined) data.sellerTaxNo = body.sellerTaxNo;
    if (body.buyerTaxNo !== undefined) data.buyerTaxNo = body.buyerTaxNo;
    if (body.isDeductible !== undefined) data.isDeductible = body.isDeductible;
    if (body.businessType !== undefined) data.businessType = body.businessType;
    // 更新关联单据要用 relation 形式（Prisma 的 UpdateInput 不含标量外键）
    if (body.documentId !== undefined) {
      data.document = body.documentId ? { connect: { id: body.documentId } } : { disconnect: true };
    }

    // 金额修改要重新勾稽，避免改出不平的票
    if (body.amountExclTax !== undefined || body.taxAmount !== undefined || body.amountInclTax !== undefined) {
      const excl = round2(new Decimal(body.amountExclTax ?? inv.amountExclTax.toString()));
      const tax = round2(new Decimal(body.taxAmount ?? inv.taxAmount.toString()));
      const incl = round2(new Decimal(body.amountInclTax ?? inv.amountInclTax.toString()));
      const c = assertTaxConsistency(excl, tax, incl, '0.02');
      if (!c.ok) {
        throw new BadRequestException(
          `修改后金额勾稽不成立：${excl.toFixed(2)} + ${tax.toFixed(2)} ≠ ${incl.toFixed(2)}（差异 ${c.difference.toFixed(2)}）。`,
        );
      }
      data.amountExclTax = toDb(excl);
      data.taxAmount = toDb(tax);
      data.amountInclTax = toDb(incl);
    }

    const updated = await this.prisma.invoice.update({ where: { id }, data });

    await this.audit.record({
      entityId: inv.entityId,
      action: 'UPDATE',
      subjectType: 'Invoice',
      subjectId: id,
      beforeData: serializeInvoice(inv),
      afterData: serializeInvoice(updated),
    });

    return serializeInvoice(updated);
  }

  @Post(':id/mark-posted')
  @ApiOperation({ summary: '标记发票为已入账（无对应自动生成凭证时手工标注）' })
  async markPosted(@Param('id') id: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException(`发票不存在：${id}`);
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { status: 'POSTED' },
    });
    return serializeInvoice(updated);
  }

  // --------------------------------------------------------------------------
  //  内部
  // --------------------------------------------------------------------------

  /**
   * 建立「单据 → 凭证」的显式附件关联。
   * 凭证册打印时会走这条路径把附件带出来（即使分录行没有引用发票）。
   */
  private async linkDocumentToVoucher(
    entityId: string,
    invoiceId: string,
    documentId: string,
    voucherId: string | null,
  ): Promise<void> {
    // 发票 ↔ 单据
    await this.prisma.documentLink.upsert({
      where: {
        fromType_fromId_toType_toId_linkType: {
          fromType: 'INVOICE',
          fromId: invoiceId,
          toType: 'DOCUMENT',
          toId: documentId,
          linkType: 'ATTACHMENT',
        },
      },
      create: {
        entityId,
        fromType: 'INVOICE',
        fromId: invoiceId,
        toType: 'DOCUMENT',
        toId: documentId,
        linkType: 'ATTACHMENT',
      },
      update: {},
    });

    // 凭证 ↔ 单据（凭证册靠这条关系带附件）
    if (voucherId) {
      await this.prisma.documentLink.upsert({
        where: {
          fromType_fromId_toType_toId_linkType: {
            fromType: 'VOUCHER',
            fromId: voucherId,
            toType: 'DOCUMENT',
            toId: documentId,
            linkType: 'ATTACHMENT',
          },
        },
        create: {
          entityId,
          fromType: 'VOUCHER',
          fromId: voucherId,
          toType: 'DOCUMENT',
          toId: documentId,
          linkType: 'ATTACHMENT',
        },
        update: {},
      });
    }
  }
}

// ============================================================================
//  辅助
// ============================================================================

function serializeInvoice(
  inv: Invoice,
): Record<string, unknown> {
  return {
    id: inv.id,
    entityId: inv.entityId,
    direction: inv.direction,
    category: inv.category,
    invoiceCode: inv.invoiceCode,
    invoiceNumber: inv.invoiceNumber,
    digitalInvoiceNo: inv.digitalInvoiceNo,
    displayNumber: inv.digitalInvoiceNo ?? inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    sellerName: inv.sellerName,
    sellerTaxNo: inv.sellerTaxNo,
    buyerName: inv.buyerName,
    buyerTaxNo: inv.buyerTaxNo,
    amountExclTax: round2(fromDb(inv.amountExclTax)).toFixed(2),
    taxRate: round2(fromDb(inv.taxRate)).toString(),
    taxAmount: round2(fromDb(inv.taxAmount)).toFixed(2),
    amountInclTax: round2(fromDb(inv.amountInclTax)).toFixed(2),
    isRedFlushed: inv.isRedFlushed,
    isDeductible: inv.isDeductible,
    businessType: inv.businessType,
    accountId: inv.accountId,
    partnerId: inv.partnerId,
    documentId: inv.documentId,
    status: inv.status,
    createdAt: inv.createdAt,
  };
}

function dedupeVouchers(
  vouchers: Array<{
    id: string;
    voucherWord: string;
    voucherNo: number;
    status: string;
    periodYear: number;
    periodMonth: number;
    voucherDate?: Date;
    summary?: string;
  } | null>,
): Array<Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const v of vouchers) {
    if (!v || map.has(v.id)) continue;
    map.set(v.id, {
      id: v.id,
      label: v.voucherNo > 0 ? `${v.voucherWord}-${v.voucherNo}` : `${v.voucherWord}-（草稿）`,
      status: v.status,
      periodLabel: `${v.periodYear}-${String(v.periodMonth).padStart(2, '0')}`,
      voucherDate: v.voucherDate,
      summary: v.summary,
    });
  }
  return [...map.values()];
}

/**
 * 去重键：委托给 common/dedup 的唯一实现。
 *
 * ★ 原先这里自己写了一份公式，与历史导入模块那份**并不一致**。
 *   重复入账最常见的来源就是"同一规则多处实现、改了一处漏了一处"，
 *   所以统一到公共模块，这里只负责把参数映射过去。
 */
function buildDedupHash(p: {
  entityId: string;
  direction: string;
  invoiceCode: string | null;
  invoiceNumber: string;
  invoiceDate: Date;
  sellerTaxNo: string | null;
  amountInclTax: Decimal;
  isRedFlushed: boolean;
}): string {
  return buildInvoiceDedupHash(DEDUP_NS_INVOICE, {
    direction: p.direction,
    invoiceCode: p.invoiceCode,
    invoiceNumber: p.invoiceNumber,
    invoiceDate: p.invoiceDate,
    isRedFlushed: p.isRedFlushed,
    counterpartyTaxNo: p.sellerTaxNo,
    amountInclTax: p.amountInclTax,
  });
}
