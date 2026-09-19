import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { MulterModule } from '@nestjs/platform-express';
import { join } from 'node:path';

import { validateEnv, type Env } from './config/env';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { AiModule } from './infrastructure/ai/ai.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { AccountingModule } from './domain/accounting/accounting.module';
import { AuthModule } from './application/auth/auth.module';
import { AuthGuard } from './application/auth/auth.guard';
import { EntityScopeInterceptor } from './application/auth/entity-scope.interceptor';
import { BasicController } from './interface/basic.controller';
import { AuthController } from './interface/auth.controller';
import { HealthController } from './interface/health.controller';
import { SelfCheckController } from './interface/self-check.controller';
import { AiController } from './interface/ai.controller';
import { PrintingController } from './interface/printing.controller';
import { DocumentsController } from './interface/documents.controller';
import { InvoiceController } from './interface/invoices.controller';
import { HistoryController } from './interface/history.controller';
import { PreferencesController } from './interface/preferences.controller';
import { PreferencesService } from './application/preferences/preferences.service';
import { VoucherBookService } from './domain/printing/voucher-book.service';
import { HistoryImportService } from './application/history/history-import.service';
import { StatementImportService } from './application/history/statement-import.service';
import { RecognitionIngestService } from './application/recognition/recognition-ingest.service';
import { PdfRasterizer } from './infrastructure/pdf/pdf-rasterizer';
import { DocumentRecognitionService } from './application/recognition/document-recognition.service';
import { TaxFilingService } from './application/tax/tax-filing.service';
import { TaxPolicyService } from './application/tax/tax-policy.service';
import { PolicyScheduleService } from './interface/policy-schedule.service';
import { TaxController } from './interface/tax.controller';

@Module({
  imports: [
    // ---------------------------------------------------------------- 配置
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // 本地开发从 apps/api/.env 读取（由 tools/setup-api-env.ps1 生成）
      // 容器内由 compose 注入环境变量，此处读不到文件也不报错
      envFilePath: [join(process.cwd(), '.env'), join(process.cwd(), '../../.env')],
      validate: (raw: Record<string, unknown>) => ({ env: validateEnv(raw) }),
    }),

    // ---------------------------------------------------------------- 日志
    LoggerModule.forRootAsync({
      inject: [],
      useFactory: () => {
        const env = process.env as unknown as Env;
        const pretty = String(process.env.LOG_PRETTY ?? 'false').toLowerCase() === 'true';
        return {
          pinoHttp: {
            level: process.env.LOG_LEVEL ?? 'info',
            transport: pretty
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } }
              : undefined,
            // 记账系统的日志要能追到具体凭证，但不能泄露金额到第三方采集
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
              remove: true,
            },
            genReqId: () => cryptoRandomId(),
            customProps: () => ({ service: 'bookkeeper-api', env: env.NODE_ENV }),
          },
        };
      },
    }),

    // ---------------------------------------------------------------- 文件上传
    // 上传上限与 STORAGE_MAX_FILE_MB 保持一致；发票扫描件可能较大，用内存存储
    // 后立刻落盘到存储卷（文件不会长时间驻留内存）。
    MulterModule.register({
      limits: { fileSize: 50 * 1024 * 1024 },
    }),

    // ---------------------------------------------------------------- 领域
    PrismaModule,
    AiModule,
    StorageModule,
    AccountingModule,
    AuthModule,
  ],
  controllers: [
    HealthController,
    AuthController,
    BasicController,
    SelfCheckController,
    AiController,
    PrintingController,
    DocumentsController,
    InvoiceController,
    HistoryController,
    PreferencesController,
    TaxController,
  ],
  providers: [
    // ---------------------------------------------------------------- 安全边界
    // ★ 注册成**全局**的，顺序不能反：
    //     Guard 先跑（解决"你是谁"，未登录且非 @Public → 401）
    //     Interceptor 后跑（解决"你能不能看这家公司"，body 此时已解析）
    //   反过来的话拦截器读不到 body 里的 entityId，归属校验会静默失效。
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: EntityScopeInterceptor },

    VoucherBookService,
    HistoryImportService,
    StatementImportService,
    PdfRasterizer,
    RecognitionIngestService,
    DocumentRecognitionService,
    TaxFilingService,
    TaxPolicyService,
    PolicyScheduleService,
    PreferencesService,
  ],
})
export class AppModule {}

function cryptoRandomId(): string {
  // 只用于日志追踪，不需要密码学强度
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
