/**
 * 凭证册打印接口
 * ============================================================
 * GET /api/printing/voucher-book?entityId=&periodId=[&voucherIds=&attachmentMode=]
 *   → 返回完整的 A4 凭证册 HTML
 *
 * 为什么返回 HTML 而不是 PDF：
 *   ① 浏览器 window.print() 的排版保真度与打印驱动配合最好，且零额外依赖
 *   ② 同一份 HTML 可直接用于屏幕预览，避免"屏幕一套、打印另一套"
 *   ③ 后续要出 PDF 时，用 Puppeteer 渲染同一份 HTML 即可，业务代码不变
 *
 * 附件图片会以 data URL 内联进 HTML：
 *   这样打开的页面是自包含的，打印时不会因为路径失效而丢图。
 */
import { Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { StorageService } from '../infrastructure/storage/storage.service';
import { VoucherBookService } from '../domain/printing/voucher-book.service';
import { inferMimeType } from '../infrastructure/storage/storage.service';
import { renderVoucherBook } from '../domain/printing/voucher-book.renderer';

@ApiTags('凭证册打印')
@Controller('printing')
export class PrintingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly book: VoucherBookService,
  ) {}

  @Get('voucher-book')
  @ApiOperation({
    summary: '生成 A4 凭证册（HTML，可直接浏览器打印）',
    description:
      '按月打印是常规做法：日常记账不打印，月末结账后一次性打一本。' +
      '同时收录凭证与其关联的发票原件。',
  })
  async voucherBook(
    @Res() res: Response,
    @Query('entityId') entityId: string,
    @Query('periodId') periodId: string,
    @Query('voucherId') voucherId?: string,
    @Query('attachmentMode') attachmentMode?: 'NONE' | 'IMAGE' | 'ALL',
    @Query('includeAccountSummary') includeAccountSummary?: string,
    @Query('copies') copies?: string,
    @Query('autoPrint') autoPrint?: string,
  ): Promise<void> {
    const mode = attachmentMode ?? 'IMAGE';

    const book = await this.book.build({
      entityId,
      periodId,
      // ★ 过滤空字符串：'?voucherId=' 会 split 出 ['']，落库查询时变成 [undefined] 直接报错
      voucherIds: voucherId ? voucherId.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });

    // ---- 附件图片内联为 data URL ----
    const imageDataUrls = new Map<string, string>();
    if (mode !== 'NONE') {
      const targets = book.vouchers
        .flatMap((v) => v.attachments)
        .filter((a) => a.isImage);

      // 去重：同一发票可能被多张凭证引用
      const unique = new Map(targets.map((a) => [a.documentId, a]));

      for (const [documentId, att] of unique) {
        try {
          const buf = await this.storage.read(att.storageKey);
          // 单张附件超过 8MB 就不内联了 —— 否则 HTML 会大到浏览器打不开
          if (buf.length > 8 * 1024 * 1024) {
            continue;
          }
          imageDataUrls.set(documentId, `data:${att.mimeType};base64,${buf.toString('base64')}`);
        } catch {
          // 读不到就跳过，渲染器会显示"附件图片未能载入"
        }
      }
    }

    const html = renderVoucherBook(book, {
      attachmentMode: mode,
      imageDataUrls,
      includeAccountSummary: includeAccountSummary !== 'false',
      copiesPerVoucher: copies ? Math.max(1, Math.min(3, Number(copies))) : 1,
    });

    // 预览用 inline（可在 iframe 里展示）；打印用 attachment
    const disposition = autoPrint === 'true' ? 'inline' : 'inline';
    const finalHtml = autoPrint === 'true'
      ? html.replace('</head>', '<script>window.__BK_AUTO_PRINT__=true;</script></head>')
      : html;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `${disposition}; filename="voucher-book-${book.periodLabel}.html"`);
    res.send(finalHtml);
  }

  @Get('voucher-book/stats')
  @ApiOperation({ summary: '本期凭证与附件统计（打印前先看这个）' })
  async stats(@Query('entityId') entityId: string, @Query('periodId') periodId: string) {
    const stats = await this.book.attachmentStats({ entityId, periodId });
    const period = await this.prisma.period.findFirst({ where: { id: periodId, entityId } });

    return {
      ...stats,
      periodLabel: period ? `${period.fiscalYear}-${String(period.month).padStart(2, '0')}` : null,
      periodStatus: period?.status ?? null,
      /** 是否可以打印 */
      printable: stats.voucherCount > 0,
      hints: [
        stats.voucherCount === 0
          ? '本期还没有已过账凭证。凭证册只收录已过账凭证，请先完成审核与过账。'
          : `本期可打印 ${stats.voucherCount} 张凭证、${stats.attachmentCount} 张原始单据。`,
        stats.missingAttachment > 0
          ? `有 ${stats.missingAttachment} 张自动生成的凭证未关联原始单据，打印时会被标注，建议先补挂附件。`
          : null,
        period && period.status !== 'CLOSED'
          ? '本期尚未结账。建议结账后再打印正式凭证册，避免凭证变动导致重复打印。'
          : null,
      ].filter((h): h is string => h !== null),
    };
  }


  @Get('voucher/:id/attachments')
  @ApiOperation({ summary: '单张凭证的附件清单（补打与核对用）' })
  async voucherAttachments(
    @Query('entityId') entityId: string,
    // ★ 路径参数必须用 @Param 取。写成 @Query 会一直取不到值 ——
    //   这个坑实际踩到过：路由是 voucher/:id/attachments，参数在路径里。
    @Param('id') id: string,
    @Query('voucherId') voucherId?: string,
  ) {
    // 路径参数优先，其次兼容 ?voucherId= 的调用方式
    const targetId = (id ?? voucherId ?? '').trim();
    if (!targetId) {
      throw new NotFoundException('缺少 voucherId 参数。用法：/api/printing/voucher/{voucherId}/attachments?entityId=xxx');
    }
    const voucher = await this.prisma.journalVoucher.findFirst({
      where: { id: targetId, entityId },
      select: { id: true, periodId: true, voucherWord: true, voucherNo: true, summary: true },
    });
    if (!voucher) throw new NotFoundException(`凭证不存在：${voucherId}`);

    const book = await this.book.build({
      entityId,
      periodId: voucher.periodId,
      voucherIds: [targetId],
    });

    const page = book.vouchers[0];
    return {
      voucher: {
        label: `${voucher.voucherWord}-${voucher.voucherNo}`,
        summary: voucher.summary,
      },
      attachments: page?.attachments ?? [],
      missingAttachment: page?.missingAttachment ?? false,
    };
  }
}
