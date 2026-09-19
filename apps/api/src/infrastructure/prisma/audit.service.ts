/**
 * 审计日志服务
 * ============================================================
 * 会计系统的审计日志要求：
 *   · 只追加，不修改（数据库触发器强制）
 *   · 关键操作必须记录理由（作废、反结账、忽略发票）
 *   · 记录「改前 / 改后」，便于追责与恢复
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'SUBMIT'
  | 'APPROVE'
  | 'REJECT'
  | 'POST'
  | 'REVERSE'
  | 'VOID'
  | 'CLOSE'
  | 'REOPEN'
  | 'EXPORT'
  | 'CONFIG'
  | 'IGNORE'
  | 'REBUILD'
  // 账号体系（2026-09 加入）
  | 'LOGIN'
  | 'LOGOUT'
  | 'LOGIN_FAILED'
  | 'REGISTER'
  | 'PASSWORD_CHANGE'
  | 'MEMBER_ADD'
  | 'MEMBER_ROLE';

export interface AuditEntry {
  entityId?: string | null;
  userId?: string | null;
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  beforeData?: unknown;
  afterData?: unknown;
  reason?: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 写一条审计日志。失败不阻断业务（但会告警） */
  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    try {
      await client.auditLog.create({
        data: {
          entityId: entry.entityId ?? null,
          userId: entry.userId ?? null,
          action: entry.action,
          subjectType: entry.subjectType,
          subjectId: entry.subjectId,
          beforeData: (entry.beforeData ?? null) as never,
          afterData: (entry.afterData ?? null) as never,
          reason: entry.reason ?? null,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (e) {
      this.logger.error(
        `审计日志写入失败（action=${entry.action} subject=${entry.subjectType}:${entry.subjectId}）：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
