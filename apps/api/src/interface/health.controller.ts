import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { describeAiConfig, describeBookkeepingSafety, type Env } from '../config/env';
import { Public } from '../application/auth/auth.decorators';

/**
 * 健康检查
 * ============================================================
 * ★ 整个控制器标 @Public，理由是**探针不可能带令牌**：
 *   docker-compose 里 web 的 depends_on: api: condition: service_healthy
 *   就是靠这里判断能不能起 —— 它没法先登录再探活。
 *   不加 @Public 的后果实测过：Healthcheck 每次都拿到 401，
 *   容器状态永远 unhealthy、web 永远起不来，而日志里只有一行
 *   "GET /api/health → 401"，看起来像认证配错了，其实认证完全正常。
 *
 * ★ 这里不返回任何机密：只有 AI provider / 模型名，以及三个记账安全开关，
 *   连 API Key 本身都不出现（describeAiConfig 只报「未配置」这类告警）。
 *
 * ★ 为什么不拆成「公开的 liveness + 需登录的 detail」：
 *   那会改掉这个端点的响应形状，而 tools/ 下多套 e2e 脚本都按现在的
 *   形状断言，收益（藏起几个布尔值）不抵成本。真到要藏的那天再拆。
 */
@ApiTags('健康检查')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: '服务健康状态（含记账安全开关自检）' })
  async health() {
    const db = await this.prisma.healthCheck();
    const env = this.config.get<Env>('env') as Env;
    const ai = describeAiConfig(env);

    return {
      ok: db.ok,
      timestamp: new Date().toISOString(),
      database: db,
      ai: {
        provider: env.AI_PROVIDER,
        summary: ai.summary,
        warnings: ai.warnings,
        /*
         * ★ 给界面顶栏用的**配置**信号，刻意不含连通性。
         *
         *   顶栏徽标原先判断 `ai.reachable`，而这个字段只存在于
         *   GET /api/ai/health（它要真调一次模型，实测约 5.8 秒）。
         *   于是任何非 mock 的 provider 都会显示「AI: 不可用」——
         *   哪怕模型完全正常。这是本次修掉的 UI bug。
         *   真实连通性仍由 /api/ai/health 按需提供，总览页在用。
         */
        configured: ai.configured,
        label: ai.label,
        visionModel: env.AI_VISION_MODEL || null,
      },
      bookkeeping: {
        autoPost: env.BOOKKEEPING_AUTO_POST,
        dbConstraints: env.BOOKKEEPING_DB_CONSTRAINTS,
        notes: describeBookkeepingSafety(env),
      },
    };
  }
}
