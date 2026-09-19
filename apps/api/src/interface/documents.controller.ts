/**
 * 单据与发票仓库
 * ============================================================
 * 电子发票仓库 = 原始单据库 + 与凭证的勾稽关系。
 *
 * 仓库本身不额外建表 —— 它由三张已有表构成：
 *   Document（原始文件）→ Invoice（结构化发票）→ JournalLine（分录）
 *   + DocumentLink（显式挂接的附件）
 *
 * 这样设计的理由：仓库的价值在于「能查到」与「能打出来」，
 * 而这两件事都依赖与凭证的勾稽关系。单独再建一张"仓库表"只会产生同步问题。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { StorageService, inferMimeType } from '../infrastructure/storage/storage.service';
import { AuditService } from '../infrastructure/prisma/audit.service';
import { round2 } from '@bookkeeper/shared';
import { fromDb } from '../common/decimal';
import { DocumentRecognitionService } from '../application/recognition/document-recognition.service';

@ApiTags('单据与发票仓库')
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly recognition: DocumentRecognitionService,
  ) {}

  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: '上传原始单据（发票图片 / PDF / 回单）' })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { entityId: string; docType?: string; uploadedBy?: string },
  ) {
    if (!file) throw new NotFoundException('未收到文件');

    const saved = await this.storage.save({
      entityId: body.entityId,
      fileName: file.originalname,
      buffer: file.buffer,
      mimeType: file.mimetype,
    });

    // ★ 幂等：同一文件（内容哈希相同）只入库一次
    const existing = await this.prisma.document.findFirst({
      where: { entityId: body.entityId, contentHash: saved.contentHash },
      select: { id: true, originalName: true, createdAt: true },
    });
    if (existing) {
      return {
        documentId: existing.id,
        duplicated: true,
        message: `该文件已于 ${existing.createdAt.toISOString().slice(0, 10)} 入库（${existing.originalName}），未重复创建。`,
      };
    }

    const doc = await this.prisma.document.create({
      data: {
        entityId: body.entityId,
        docType: (body.docType as never) ?? 'INVOICE_PURCHASE',
        source: 'UPLOAD',
        originalName: file.originalname,
        // ★ 按扩展名推断，不信任客户端 content-type（见 inferMimeType 的说明）
        mimeType: inferMimeType(file.originalname, file.mimetype),
        sizeBytes: saved.sizeBytes,
        contentHash: saved.contentHash,
        storageKey: saved.storageKey,
        status: 'PENDING',
        uploadedBy: body.uploadedBy ?? null,
      },
      select: { id: true, originalName: true, sizeBytes: true, mimeType: true },
    });

    await this.audit.record({
      entityId: body.entityId,
      userId: body.uploadedBy,
      action: 'CREATE',
      subjectType: 'Document',
      subjectId: doc.id,
      afterData: { originalName: doc.originalName, sizeBytes: doc.sizeBytes },
    });

    return { documentId: doc.id, duplicated: false, ...doc };
  }

  @Post(':id/recognize')
  @ApiOperation({
    summary: '★ 识别一份已入库的单据 → 校验 → 落为发票台账',
    description:
      '这是「上传 → 识别 → 入库」的第二步，把电子发票仓库真正闭合。\n\n' +
      '为什么上传与识别分成两步：\n' +
      '· 文件入库是**无损的**，识别是**有损的** —— 先保证原件一定存住；\n' +
      '· 识别要花钱，让用户自己决定什么时候花；\n' +
      '· 识别结果必须**校验通过**才允许落库。金额勾稽不成立的票写进台账会污染进项抵扣统计，\n' +
      '  所以默认拒绝写入（可用 force 在人工核对票面后强制落库）。\n\n' +
      '★ 本接口只落发票台账，**不生成凭证**。',
  })
  async recognize(
    @Param('id') id: string,
    @Body()
    body: {
      entityId: string;
      targetType?: 'INVOICE' | 'BANK_SLIP' | 'BANK_STATEMENT';
      /** 仅 Mock 模式有效：强制指定样例，便于演示各条分支 */
      mockCase?: string;
      /** 人工已核对票面，校验不通过也落库 */
      force?: boolean;
      userId?: string;
    },
  ) {
    if (!body.entityId) throw new BadRequestException('缺少 entityId');
    return this.recognition.recognizeDocument({
      entityId: body.entityId,
      documentId: id,
      targetType: body.targetType,
      mockCase: body.mockCase,
      force: body.force,
      userId: body.userId,
    });
  }

  @Get()
  @ApiOperation({ summary: '单据列表（可按是否已关联凭证筛选）' })
  async list(
    @Query('entityId') entityId: string,
    @Query('linked') linked?: 'true' | 'false',
    @Query('docType') docType?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const take = Math.min(200, Math.max(1, Number(pageSize ?? 50)));
    const skip = (Math.max(1, Number(page ?? 1)) - 1) * take;

    const where: Record<string, unknown> = { entityId };
    if (docType) where.docType = docType;
    if (keyword) {
      where.OR = [
        { originalName: { contains: keyword, mode: 'insensitive' } },
        { invoices: { some: { OR: [{ sellerName: { contains: keyword } }, { invoiceNumber: { contains: keyword } }] } } },
      ];
    }

    /**
     * ★ 「已/未勾稽」的筛选必须在**数据库层**做，不能取回一页再在内存里 filter。
     *
     *   曾经的写法是先取前 50 条、再按 isLinked 过滤 ——
     *   于是"已勾稽"只反映**第 1 页里**已勾稽的那些单据：
     *   第 51 条之后已勾稽的单据永远查不到，而 total 返回的是过滤后的条数，
     *   前端一看 total 变小就以为勾稽关系丢了。
     *   数据量小的时候完全看不出来，录满一两个月必然踩到。
     *
     *   判定口径：单据 → 至少一张发票 → 至少一条分录。
     *   这里不写 `voucherId: { not: null }` —— JournalLine.voucherId 是必填外键，
     *   有分录就一定有凭证；判到"有分录"这一层既准确又省一次关联。
     *   与下面 enriched 里的 isLinked 是同一口径（那边遍历分录取 voucher，
     *   有分录就必有 voucher，所以两者等价）。
     */
    const LINKED_SOME = { invoices: { some: { journalLines: { some: {} } } } };
    if (linked === 'true') where.AND = [LINKED_SOME];
    else if (linked === 'false') where.NOT = LINKED_SOME;

    const [items, total, linkedCount] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          invoices: {
            select: {
              id: true,
              direction: true,
              invoiceNumber: true,
              digitalInvoiceNo: true,
              invoiceDate: true,
              sellerName: true,
              buyerName: true,
              amountInclTax: true,
              status: true,
              journalLines: {
                select: {
                  voucherId: true,
                  voucher: {
                    select: { id: true, voucherWord: true, voucherNo: true, status: true, periodYear: true, periodMonth: true },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.document.count({ where }),
      // 概览用**整库**的已勾稽数，不是当前页的 —— 否则统计随翻页跳动
      this.prisma.document.count({ where: { entityId, AND: [LINKED_SOME] } }),
    ]);

    // 勾稽关系：每个单据关联到哪些凭证
    const enriched = items.map((d) => {
      const voucherSet = new Map<string, { id: string; label: string; status: string }>();
      let invoiceAmount = 0;

      for (const inv of d.invoices) {
        invoiceAmount += Number(inv.amountInclTax.toString());
        for (const line of inv.journalLines) {
          if (line.voucher) {
            voucherSet.set(line.voucher.id, {
              id: line.voucher.id,
              label:
                line.voucher.voucherNo > 0
                  ? `${line.voucher.voucherWord}-${line.voucher.voucherNo}`
                  : `${line.voucher.voucherWord}-（草稿）`,
              status: line.voucher.status,
            });
          }
        }
      }

      // 显式挂接的附件关系
      return {
        id: d.id,
        originalName: d.originalName,
        docType: d.docType,
        detectedType: d.detectedType,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        status: d.status,
        isImage: d.mimeType.startsWith('image/'),
        createdAt: d.createdAt,
        invoices: d.invoices.map((inv) => ({
          id: inv.id,
          direction: inv.direction,
          number: inv.digitalInvoiceNo ?? inv.invoiceNumber,
          invoiceDate: inv.invoiceDate,
          sellerName: inv.sellerName,
          buyerName: inv.buyerName,
          amountInclTax: round2(fromDb(inv.amountInclTax)).toFixed(2),
          status: inv.status,
        })),
        invoiceAmount: invoiceAmount.toFixed(2),
        linkedVouchers: [...voucherSet.values()],
        isLinked: voucherSet.size > 0,
      };
    });

    return {
      items: enriched,
      total,
      page: Number(page ?? 1),
      pageSize: take,
      summary: {
        totalDocuments: total,
        // 整库口径，不随筛选与翻页变化
        linkedCount,
        unlinkedCount: Math.max(0, total - linkedCount),
      },
    };
  }

  @Get('warehouse/stats')
  @ApiOperation({ summary: '发票仓库总览（按年度与方向统计）' })
  async warehouseStats(@Query('entityId') entityId: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: { entityId },
      select: {
        direction: true,
        invoiceDate: true,
        amountInclTax: true,
        taxAmount: true,
        documentId: true,
        status: true,
      },
    });

    const byYear = new Map<
      string,
      { output: { count: number; amount: number }; input: { count: number; amount: number } }
    >();

    let withDocument = 0;

    for (const inv of invoices) {
      const year = String(inv.invoiceDate.getUTCFullYear());
      const cur = byYear.get(year) ?? {
        output: { count: 0, amount: 0 },
        input: { count: 0, amount: 0 },
      };
      const bucket = inv.direction === 'OUTPUT' ? cur.output : cur.input;
      bucket.count += 1;
      bucket.amount += Number(inv.amountInclTax.toString());
      byYear.set(year, cur);
      if (inv.documentId) withDocument += 1;
    }

    const documents = await this.prisma.document.count({ where: { entityId } });

    return {
      totalInvoices: invoices.length,
      invoicesWithDocument: withDocument,
      documentsWithoutInvoice: documents - withDocument,
      totalDocuments: documents,
      byYear: [...byYear.entries()]
        .map(([year, v]) => ({
          year: Number(year),
          outputCount: v.output.count,
          outputAmount: v.output.amount.toFixed(2),
          inputCount: v.input.count,
          inputAmount: v.input.amount.toFixed(2),
        }))
        .sort((a, b) => a.year - b.year),
      hint:
        '发票仓库的价值在于「能查到出处」与「能跟凭证一起打出来」。' +
        '未关联发票的单据（如回单、合同）会作为通用附件保留。',
    };
  }

  @Get(':id/file')
  @ApiOperation({ summary: '下载 / 预览原始单据文件' })
  async file(
    @Res() res: Response,
    @Param('id') id: string,
    @Query('download') download?: string,
  ): Promise<void> {
    const doc = await this.prisma.document.findUnique({
      where: { id },
      select: { storageKey: true, mimeType: true, originalName: true },
    });
    if (!doc) throw new NotFoundException(`单据不存在：${id}`);

    const buf = await this.storage.read(doc.storageKey);
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${download === 'true' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(doc.originalName)}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  }

  @Get(':id')
  @ApiOperation({ summary: '单据详情（含勾稽到的凭证）' })
  async detail(@Param('id') id: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id },
      include: {
        invoices: {
          include: {
            lines: true,
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
        },
      },
    });
    if (!doc) throw new NotFoundException(`单据不存在：${id}`);
    return doc;
  }
}
