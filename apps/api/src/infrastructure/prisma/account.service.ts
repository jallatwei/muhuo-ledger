/**
 * 科目服务
 * ============================================================
 * 主要职责：把「科目编码」解析成「科目实体」。
 *
 * ★ 为什么规则模板用科目编码而不是 id：
 *   编码稳定、可读、可导出导入。而 id 是 uuid，规则从别的账套拷过来就失效了。
 *   所以模板里写 '660202'，由本服务在运行时解析。
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Account } from '@prisma/client';
import { PrismaService } from './prisma.service';

/** 已经解析好的科目元数据，用于凭证校验 */
export interface AccountMeta {
  id: string;
  code: string;
  name: string;
  fullName: string;
  isLeaf: boolean;
  isActive: boolean;
  direction: 'DEBIT' | 'CREDIT';
  category: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'COST' | 'PROFIT_LOSS';
  auxRequired: string[];
  taxTag: string | null;
  reportItem: string | null;
  cashflowTag: string | null;
}

/** 科目编码不存在 */
export class AccountCodeNotFoundError extends Error {
  constructor(readonly codes: string[]) {
    super(`以下科目编码不存在：${codes.join('、')}。请在科目表中确认，或修正规则模板中的科目编码。`);
    this.name = 'AccountCodeNotFoundError';
  }
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  // 科目表变化很少（初始化 + 偶尔增改），缓存避免每张凭证都查库
  private cache = new Map<string, Map<string, AccountMeta>>();
  private cacheLoadedAt = new Map<string, number>();
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  /** 取某主体的全部科目（带缓存） */
  async listMeta(entityId: string, force = false): Promise<Map<string, AccountMeta>> {
    const loadedAt = this.cacheLoadedAt.get(entityId) ?? 0;
    const cached = this.cache.get(entityId);
    if (!force && cached && Date.now() - loadedAt < AccountService.CACHE_TTL_MS) {
      return cached;
    }

    const rows = await this.prisma.account.findMany({
      where: { entityId },
      orderBy: { code: 'asc' },
    });
    const map = new Map<string, AccountMeta>();
    for (const a of rows) map.set(a.code, toMeta(a));
    this.cache.set(entityId, map);
    this.cacheLoadedAt.set(entityId, Date.now());
    return map;
  }

  /** 按编码取科目 */
  async requireByCode(entityId: string, code: string): Promise<AccountMeta> {
    const map = await this.listMeta(entityId);
    const account = map.get(code);
    if (!account) throw new AccountCodeNotFoundError([code]);
    return account;
  }

  /**
   * 按编码批量解析。
   * 一次列出全部缺失项 —— 一次说清所有问题，比逐个报错体验好得多。
   */
  async resolveMany(entityId: string, codes: string[]): Promise<Map<string, AccountMeta>> {
    const map = await this.listMeta(entityId);
    const result = new Map<string, AccountMeta>();
    const missing: string[] = [];
    for (const code of new Set(codes)) {
      const account = map.get(code);
      if (account) result.set(code, account);
      else missing.push(code);
    }
    if (missing.length > 0) throw new AccountCodeNotFoundError(missing);
    return result;
  }

  /** 手动作废缓存（科目表增删改后调用） */
  invalidate(entityId?: string): void {
    if (entityId) {
      this.cache.delete(entityId);
      this.cacheLoadedAt.delete(entityId);
    } else {
      this.cache.clear();
      this.cacheLoadedAt.clear();
    }
  }

  /** 按报表行项目汇总末级科目编码（报表取数用） */
  async codesByReportItem(entityId: string): Promise<Map<string, string[]>> {
    const map = await this.listMeta(entityId);
    const result = new Map<string, string[]>();
    for (const a of map.values()) {
      if (!a.reportItem || !a.isLeaf) continue;
      const arr = result.get(a.reportItem) ?? [];
      arr.push(a.code);
      result.set(a.reportItem, arr);
    }
    return result;
  }

  /** 按税标记取科目编码（增值税归集用） */
  async codesByTaxTag(entityId: string): Promise<Map<string, string[]>> {
    const map = await this.listMeta(entityId);
    const result = new Map<string, string[]>();
    for (const a of map.values()) {
      if (!a.taxTag) continue;
      const arr = result.get(a.taxTag) ?? [];
      arr.push(a.code);
      result.set(a.taxTag, arr);
    }
    return result;
  }

  /** 检查科目表完整性：末级科目应有 reportItem，否则报表取不到数 */
  async checkReportMapping(entityId: string): Promise<{ unmapped: AccountMeta[] }> {
    const map = await this.listMeta(entityId);
    const unmapped = [...map.values()].filter((a) => a.isLeaf && a.isActive && !a.reportItem);
    return { unmapped };
  }
}

function toMeta(a: Account): AccountMeta {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    fullName: a.fullName,
    isLeaf: a.isLeaf,
    isActive: a.isActive,
    direction: a.direction,
    category: a.category,
    auxRequired: a.auxRequired as string[],
    taxTag: a.taxTag,
    reportItem: a.reportItem,
    cashflowTag: a.cashflowTag,
  };
}
