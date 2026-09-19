import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 客户端封装
 * ============================================================
 * 除了常规连接管理，额外做两件事：
 *   1. 慢查询日志（记账系统的性能问题通常出在报表取数）
 *   2. 启动时校验数据库层的强制约束是否已就位
 *      —— 触发器没装上而应用层以为装了，是最危险的状态
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('数据库连接已建立');

    // 慢查询提示：超过 500ms 的记账相关查询值得关注
    // @ts-expect-error Prisma 事件类型在 $on 上较宽松
    this.$on('query', (e: { duration: number; query: string }) => {
      if (e.duration > 500) {
        this.logger.warn(`慢查询 ${e.duration}ms: ${e.query.slice(0, 200)}`);
      }
    });

    await this.verifyIntegrityTriggers();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * ★ 校验数据库层的凭证内核约束是否已安装。
   * 触发器缺失 = 最后一道防线失效，必须显式告警（但不阻断启动，
   * 因为在只跑迁移前的新库上启动是正常场景）。
   */
  private async verifyIntegrityTriggers(): Promise<void> {
    try {
      const rows = await this.$queryRaw<Array<{ tgname: string }>>`
        SELECT tgname FROM pg_trigger
         WHERE NOT tgisinternal
           AND tgname IN (
             'trg_journal_line_amount_positive',
             'trg_journal_line_leaf_account',
             'trg_journal_line_period_lock',
             'trg_journal_voucher_balanced',
             'trg_journal_voucher_period_lock',
             'trg_audit_log_immutable'
           )
      `;
      const found = new Set(rows.map((r) => r.tgname));
      const required = [
        'trg_journal_line_amount_positive',
        'trg_journal_line_leaf_account',
        'trg_journal_line_period_lock',
        'trg_journal_voucher_balanced',
        'trg_journal_voucher_period_lock',
        'trg_audit_log_immutable',
      ];
      const missing = required.filter((t) => !found.has(t));

      if (missing.length > 0) {
        this.logger.error(
          `⚠️ 凭证内核的数据库层约束缺失 ${missing.length} 项：${missing.join(', ')}\n` +
            `   借贷平衡与期间锁将只依赖应用层校验。请执行迁移：\n` +
            `   pnpm --filter @bookkeeper/api prisma:migrate`,
        );
      } else {
        this.logger.log('凭证内核数据库约束已就位（借贷平衡 / 期间锁 / 末级科目 / 金额正数）');
      }
    } catch (e) {
      this.logger.warn(`无法校验数据库约束：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 健康检查：供 /health 端点与容器探针使用
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.$queryRaw`SELECT 1`;
      return { ok: true, latencyMs: Date.now() - start };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
