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
import { json, urlencoded } from 'express';

import { AppModule } from './app.module';
import { APP_NAME } from '@bookkeeper/shared';
import { describeAiConfig, describeBookkeepingSafety, type Env } from './config/env';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PrismaService } from './infrastructure/prisma/prisma.service';

/**
 * 请求体上限。
 *
 * ★ 这个值必须 ≥ 一次性提交的最大业务负载。历史上这里用的是框架默认的
 *   100kb，导致历史数据导入（几百行明细）直接失败 —— 详见下面注册处。
 */
const BODY_LIMIT = '50mb';

async function bootstrap(): Promise<void> {
  /*
   * ★ bodyParser: false 是必须的，不能省。
   *
   *   Nest 默认会注册 express.json()，用的是它自带的 **100kb** 上限。
   *   而 `app.use(json({ limit }))` 是**追加**一个解析器 —— 默认那个仍排在
   *   前面、仍会先以 100kb 拒绝。也就是说"只加一行 app.use(json(...))"
   *   看起来改好了，实际一点用都没有（很容易误判为修完了）。
   *   所以这里显式关掉默认的，再自己按需要的上限注册。
   *
   *   multipart（附件上传）由 Multer 经 FileInterceptor 处理，不受影响。
   */
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });

  /*
   * ★ 上限为什么给到 50MB：
   *   历史数据导入是**整表一次性提交**的 —— 实测一份 383 行 × 27 列的
   *   进项明细导出，序列化成 JSON 后远超 100kb，直接报
   *   "request entity too large"。而当年这一批数据往往就是几千行。
   *
   *   50MB 与 STORAGE_MAX_FILE_MB（单文件 50MB）取齐；nginx 侧
   *   client_max_body_size 是 60m，比它宽，网关不会先拦。
   *   这是自托管单租户场景的合理取舍；上云多租户时应改为按接口限流 +
   *   分片上传，而不是继续放大这个数字。
   */
  app.use(json({ limit: BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: BODY_LIMIT }));

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
