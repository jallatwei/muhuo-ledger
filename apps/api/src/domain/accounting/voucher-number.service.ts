/**
 * 凭证号分配器
 * ============================================================
 * ★ 绝不用 MAX(voucherNo)+1 —— 并发过账时会重号，而重号凭证的后果是
 *   凭证册错乱、审计时对不上号。必须用行锁串行化。
 *
 * 实现方式：
 *   BEGIN;
 *     SELECT next_no FROM voucher_sequence
 *      WHERE entity_id=$1 AND period_id=$2 AND voucher_word=$3
 *      FOR UPDATE;                       ← 行锁
 *     -- 不存在则创建（并发创建时用 ON CONFLICT DO NOTHING 后重读）
 *     UPDATE voucher_sequence SET next_no = next_no + 1;
 *   COMMIT;
 *
 * 凭证号的连续性由「只在过账时分配」保证：
 *   草稿没有号，删除草稿不会造成号段空洞。
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface VoucherNumberAllocation {
  voucherNo: number;
  voucherWord: string;
}

@Injectable()
export class VoucherNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 在给定事务内分配下一个凭证号。
   *
   * 必须在**过账事务内**调用，这样「取号 + 写凭证」是一个原子操作：
   * 事务回滚时号也回滚，不会留下空洞。
   */
  async allocate(
    tx: Prisma.TransactionClient,
    params: { entityId: string; periodId: string; voucherWord: string },
  ): Promise<number> {
    const { entityId, periodId, voucherWord } = params;

    // 1) 尝试取行锁。首次使用该凭证字时序列行还不存在，需要先创建。
    let rows = await tx.$queryRaw<Array<{ nextNo: number }>>`
      SELECT "nextNo" FROM voucher_sequence
       WHERE "entityId" = ${entityId}
         AND "periodId" = ${periodId}
         AND "voucherWord" = ${voucherWord}
       FOR UPDATE
    `;

    if (rows.length === 0) {
      // 并发下可能有两个事务同时走到这里，用 ON CONFLICT 保证只插一条
      await tx.$executeRaw`
        INSERT INTO voucher_sequence (id, "entityId", "periodId", "voucherWord", "nextNo")
        VALUES (gen_random_uuid()::text, ${entityId}, ${periodId}, ${voucherWord}, 1)
        ON CONFLICT ("entityId", "periodId", "voucherWord") DO NOTHING
      `;
      // 重新加锁读取
      rows = await tx.$queryRaw<Array<{ nextNo: number }>>`
        SELECT "nextNo" FROM voucher_sequence
         WHERE "entityId" = ${entityId}
           AND "periodId" = ${periodId}
           AND "voucherWord" = ${voucherWord}
         FOR UPDATE
      `;
    }

    const current = rows[0]?.nextNo;
    if (current === undefined) {
      throw new Error(`无法分配凭证号：voucher_sequence 行创建失败（${entityId}/${periodId}/${voucherWord}）`);
    }

    // 2) 递增
    await tx.$executeRaw`
      UPDATE voucher_sequence
         SET "nextNo" = "nextNo" + 1
       WHERE "entityId" = ${entityId}
         AND "periodId" = ${periodId}
         AND "voucherWord" = ${voucherWord}
    `;

    return current;
  }

  /** 查看当前下一个可用号（只读，用于 UI 预览） */
  async peek(entityId: string, periodId: string, voucherWord = '记'): Promise<number> {
    const row = await this.prisma.voucherSequence.findUnique({
      where: { entityId_periodId_voucherWord: { entityId, periodId, voucherWord } },
    });
    return row?.nextNo ?? 1;
  }

  /**
   * 重建序列（仅在自检发现号段异常、或批量导入后使用）。
   * 取当前已过账凭证的最大号 + 1。
   */
  async rebuild(
    tx: Prisma.TransactionClient,
    params: { entityId: string; periodId: string; voucherWord?: string },
  ): Promise<number> {
    const voucherWord = params.voucherWord ?? '记';
    const agg = await tx.journalVoucher.aggregate({
      where: {
        entityId: params.entityId,
        periodId: params.periodId,
        voucherWord,
        status: { in: ['POSTED', 'REVERSED'] },
      },
      _max: { voucherNo: true },
    });
    const nextNo = (agg._max.voucherNo ?? 0) + 1;

    await tx.voucherSequence.upsert({
      where: {
        entityId_periodId_voucherWord: {
          entityId: params.entityId,
          periodId: params.periodId,
          voucherWord,
        },
      },
      create: { entityId: params.entityId, periodId: params.periodId, voucherWord, nextNo },
      update: { nextNo },
    });

    return nextNo;
  }
}
