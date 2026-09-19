import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { describeAiConfig, describeBookkeepingSafety, type Env } from '../config/env';

@ApiTags('健康检查')
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
      },
      bookkeeping: {
        autoPost: env.BOOKKEEPING_AUTO_POST,
        dbConstraints: env.BOOKKEEPING_DB_CONSTRAINTS,
        notes: describeBookkeepingSafety(env),
      },
    };
  }
}
