import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { AccountService } from './account.service';
import { AuditService } from './audit.service';

/**
 * 基础设施模块（全局）
 * 提供：Prisma 客户端、科目解析、审计日志
 *
 * 注意：@Global() 只是省去重复 import，消费模块仍需显式 import 本模块
 * 才能注入这里的 provider。
 */
@Global()
@Module({
  providers: [PrismaService, AccountService, AuditService],
  exports: [PrismaService, AccountService, AuditService],
})
export class PrismaModule {}