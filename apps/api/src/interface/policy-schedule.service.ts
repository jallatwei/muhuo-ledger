/**
 * 税务政策月度检索调度
 * ============================================================
 * 用户要求的是「每月月底进行一次当前税务政策（报税地）的搜索」。
 *
 * ★ 为什么不用 cron 库、而是自己算"这个月跑过没有"：
 *   ① 不引入依赖：这个需求只是"每月一次"，一个每日检查就够
 *   ② 更重要的是**幂等**：进程重启、机器休眠、手动跑过一次，
 *      都不能导致同一个月份跑两遍或一遍没跑。
 *      cron 表达式本身不提供这个保证，而"本月是否已有成功记录"
 *      是一个可以从数据库查出来的事实 —— 用它判断比用时间表达式可靠。
 *
 * ★ 为什么在月初也检查（而不是只在 28~31 号）：
 *   如果机器在月底关机了，只检查月底就会整月漏跑。
 *   这里改成"每天检查一次：本月还没有成功的检索记录 → 跑一次"，
 *   于是月底没开机也会在下个月初补上，且不会重复跑。
 *
 * ★ 失败要重试：只有 SUCCESS / PARTIAL 才算"本月跑过了"。
 *   全失败（FAILED）不算，下次检查会重试 —— 否则一次网络抖动
 *   就会让这个月彻底没有政策数据。
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { TaxPolicyService } from '../application/tax/tax-policy.service';

/** 检查间隔：每天一次。政策不是实时数据，没必要更频繁。 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 启动后延迟多久做第一次检查：避开启动高峰 */
const INITIAL_DELAY_MS = 3 * 60 * 1000;

@Injectable()
export class PolicyScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolicyScheduleService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: TaxPolicyService,
  ) {}

  onModuleInit(): void {
    // 允许通过环境变量关闭（测试与 CI 里不应自动出网）
    if (process.env.TAX_POLICY_SCHEDULE === 'off') {
      this.logger.log('税务政策定时检索已关闭（TAX_POLICY_SCHEDULE=off）');
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
    // 不阻止进程退出
    this.timer.unref?.();

    const first = setTimeout(() => {
      void this.tick();
    }, INITIAL_DELAY_MS);
    first.unref?.();

    this.logger.log(
      `税务政策定时检索已启用：每 ${CHECK_INTERVAL_MS / 3600000} 小时检查一次，` +
        `本月无成功记录时自动执行。可用 TAX_POLICY_SCHEDULE=off 关闭。`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 检查并（必要时）执行检索。
   *
   * 幂等的关键：**本月是否已有成功记录**由数据库回答，
   * 而不是靠内存标志位 —— 后者在进程重启后就失效了。
   */
  private async tick(): Promise<void> {
    if (this.running) return; // 上一轮还没跑完
    this.running = true;
    try {
      const jurisdictions = await this.configuredJurisdictions();
      for (const jurisdiction of jurisdictions) {
        const alreadyDone = await this.hasSucceededThisMonth(jurisdiction);
        if (alreadyDone) continue;

        this.logger.log(`本月尚未完成政策检索，开始执行（报税地 ${jurisdiction}）`);
        try {
          const result = await this.policy.runSearch({
            jurisdiction,
            triggeredBy: 'SCHEDULED',
          });
          this.logger.log(
            `政策检索完成（${jurisdiction}）：${result.status}，` +
              `新增 ${result.policiesNew} 条、变更 ${result.policiesChanged} 条`,
          );
        } catch (e) {
          // 单次失败不抛出：下次 tick 会自动重试
          this.logger.warn(
            `政策检索失败（${jurisdiction}），将在下次检查时重试：` +
              `${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      this.logger.warn(`政策检索调度检查出错：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * 本月是否已有**成功或部分成功**的检索记录。
   *
   * ★ 只认 SUCCESS / PARTIAL：全 FAILED 不算跑过，否则一次网络抖动
   *   就会让这个月彻底没有政策数据，而这种"静默缺失"没人会发现。
   */
  private async hasSucceededThisMonth(jurisdiction: string): Promise<boolean> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const count = await this.prisma.taxPolicyFetchRun.count({
      where: {
        jurisdiction,
        triggeredBy: { in: ['SCHEDULED', 'MANUAL'] },
        status: { in: ['SUCCESS', 'PARTIAL'] },
        startedAt: { gte: monthStart },
      },
    });
    return count > 0;
  }

  /** 要检索哪些报税地：从已有主体上取，去重 */
  private async configuredJurisdictions(): Promise<string[]> {
    try {
      // 主体上暂时没有"报税地"字段时，退回国家层面 —— 国家政策对所有地区都适用，
      // 至少不会漏掉增值税与企业所得税的主要变动。
      const entities = await this.prisma.entity.findMany({
        select: { id: true },
        take: 50,
      });
      if (entities.length === 0) return ['CN-GENERAL'];
      // 目前统一按国家层面检索；地方口径待主体配置报税地后按 CN-XX 细化
      return ['CN-GENERAL'];
    } catch {
      return ['CN-GENERAL'];
    }
  }
}
