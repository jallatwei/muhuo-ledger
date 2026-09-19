/**
 * 应用入口
 * ============================================================
 * 启动时会显式打印「记账安全开关」状态 —— 这些开关直接关系到会不会记错账，
 * 不能藏在配置文件里没人看。
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger as NestLogger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { APP_NAME } from '@bookkeeper/shared';
import { describeAiConfig, describeBookkeepingSafety, type Env } from './config/env';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PrismaService } from './infrastructure/prisma/prisma.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');

  const config = app.get(ConfigService);
  const env = config.get<Env>('env') as Env;

  // ---- 安全 ----
  app.use(
    helmet({
      // Swagger UI 需要放开 CSP
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    origin: origins.length > 0 ? origins : true,
    credentials: true,
  });

  // ---- 入参校验 ----
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // ---- 统一异常翻译 ----
  // 把领域错误 / 数据库触发器错误翻译成「说清哪里错了 + 该怎么办」的中文提示。
  // 没有这一层，用户只会看到 "Internal server error"。
  app.useGlobalFilters(new AllExceptionsFilter());

  // ---- OpenAPI ----
  if (env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(`${APP_NAME} API`)
      .setDescription(
        '导入合同/发票 → 自动记账 → 凭证册 → 税务申报表。\n\n' +
          '会计准则：小企业会计准则 ｜ 纳税人身份：一般纳税人',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  app.enableShutdownHooks();

  const port = env.API_PORT;
  const host = env.HOST;
  await app.listen(port, host);

  // ---- 启动横幅：把关键状态一次说清 ----
  const logger = new NestLogger('Bootstrap');
  const ai = describeAiConfig(env);

  logger.log('════════════════════════════════════════════════════════');
  logger.log(`  ${APP_NAME} API 已启动`);
  logger.log('════════════════════════════════════════════════════════');
  logger.log(`  环境      : ${env.NODE_ENV}  时区: ${env.TZ}`);
  logger.log(`  监听      : http://${host}:${port}/api`);
  if (env.NODE_ENV !== 'production') {
    logger.log(`  接口文档  : http://localhost:${port}/api/docs`);
  }
  logger.log(`  数据库    : ${maskDbUrl(env.DATABASE_URL)}`);
  logger.log(`  AI 识图   : ${ai.summary}`);
  for (const w of ai.warnings) logger.warn(`  ${w}`);
  logger.log('  ── 记账安全开关 ──');
  for (const note of describeBookkeepingSafety(env)) logger.log(`  ${note}`);
  logger.log('════════════════════════════════════════════════════════');

  // 验证数据库与凭证内核约束
  const prisma = app.get(PrismaService);
  const db = await prisma.healthCheck();
  if (!db.ok) {
    logger.error(`数据库连接失败：${db.error}`);
  }
}

/** 隐藏连接串里的密码，日志里不能出现明文口令 */
function maskDbUrl(url: string): string {
  try {
    return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
  } catch {
    return '(无法解析)';
  }
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('服务启动失败：', e);
  process.exit(1);
});
