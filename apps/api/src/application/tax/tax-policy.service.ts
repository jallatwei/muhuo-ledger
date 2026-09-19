/**
 * 税务政策检索服务
 * ============================================================
 * 把「抓取 → 比对 → 落库 → 留痕」串起来。
 *
 * 三条设计约束（都是为了避免这类功能最常见的失败模式）：
 *
 *   ① **每次执行都留下记录**，包括失败的。
 *      "看起来跑了但什么都没拿到"是最危险的状态：
 *      没有执行记录就无法分辨"本期确实没有新政策"与"抓取全挂了"。
 *
 *   ② **抓取时间必须随政策一起存**。
 *      政策会改，同一个链接在不同时间看到的内容可能不同。
 *      没有抓取时间，事后无法判断"当时看到的是哪一版"。
 *
 *   ③ **需要人工阅读的标记默认打开**。
 *      系统不做适用性判断，"这条政策跟你有没有关系"必须由人确认。
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DomainError } from '../../domain/accounting/errors';
import {
  BuiltinCatalogFetcher,
  POLICY_SOURCES,
  deriveStatus,
  diffPolicies,
  extractConditions,
  extractDocumentNo,
  extractKeywords,
  hashPolicy,
  inferTaxTypes,
  runFetch,
  type PolicyFetcher,
  type RawPolicyItem,
} from '../../domain/tax/policy-search';

export interface PolicySearchResult {
  runId: string;
  jurisdiction: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  fetcher: string;
  sourcesTried: number;
  sourcesFailed: number;
  policiesFound: number;
  policiesNew: number;
  policiesChanged: number;
  unchanged: number;
  added: Array<{ id: string; title: string; documentNo: string | null; effectiveFrom: string | null }>;
  changed: Array<{ id: string; title: string; note: string }>;
  warnings: string[];
  /** ★ 必须随结果返回：本次抓取用的是哪一天的口径 */
  fetchedAt: string;
  disclaimer: string;
}

const DISCLAIMER =
  '本功能只把官方来源的政策**原文与关键日期**呈现给你，供你判断是否需要进一步了解。' +
  '系统**不判断某条政策是否适用于你**，也不替你决定申报口径 —— ' +
  '政策的适用通常取决于正文中的限定条件（如"同时符合下列条件"），请阅读原文或咨询税务专业人士。' +
  '政策库只覆盖已登记的来源，未覆盖到的政策不会出现在这里。';

@Injectable()
export class TaxPolicyService {
  private readonly logger = new Logger(TaxPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 执行一次政策检索。
   *
   * fetcher 可注入：默认用内置目录（离线可用、结果确定），
   * 接入真实 HTTP 抓取器后即可自动获取。这一点是刻意的 ——
   * 让这个功能在不能出网的环境下也能用，且抓取失败能被看见。
   */
  async runSearch(params: {
    jurisdiction: string;
    fetcher?: PolicyFetcher;
    triggeredBy?: string;
  }): Promise<PolicySearchResult> {
    const jurisdiction = (params.jurisdiction || 'CN-GENERAL').trim();
    const fetcher = params.fetcher ?? new BuiltinCatalogFetcher();

    // ── 开一条执行记录（先建后更新，保证失败也有痕迹）──
    const run = await this.prisma.taxPolicyFetchRun.create({
      data: {
        jurisdiction,
        status: 'RUNNING',
        triggeredBy: params.triggeredBy ?? 'MANUAL',
      },
    });

    try {
      const fetched = await runFetch({ jurisdiction, fetcher });

      const existing = await this.prisma.taxPolicyRecord.findMany({
        where: { jurisdiction },
        select: { sourceUrl: true, contentHash: true, title: true },
      });

      const { added, changed, unchanged } = diffPolicies({
        fetched: fetched.items,
        existing,
      });

      const now = new Date();

      // ── 落库：新增 ──
      const addedRows: PolicySearchResult['added'] = [];
      for (const item of added) {
        const row = await this.upsertPolicy({ jurisdiction, item, fetchedAt: now });
        addedRows.push({
          id: row.id,
          title: row.title,
          documentNo: row.documentNo,
          effectiveFrom: item.effectiveFrom ?? null,
        });
      }

      // ── 落库：内容变更（链接没变、正文变了 —— 这种最容易被漏掉）──
      const changedRows: PolicySearchResult['changed'] = [];
      for (const { item } of changed) {
        const row = await this.upsertPolicy({ jurisdiction, item, fetchedAt: now });
        changedRows.push({
          id: row.id,
          title: row.title,
          note:
            '该政策的来源链接未变，但**正文内容已变化**（可能是修订）。' +
            '这类变更最容易漏掉，请对照原文确认改了什么、从什么时候起适用。',
        });
      }

      // ── 更新执行记录 ──
      await this.prisma.taxPolicyFetchRun.update({
        where: { id: run.id },
        data: {
          finishedAt: now,
          status: fetched.status,
          sourcesTried: fetched.sourcesTried,
          sourcesFailed: fetched.sourcesFailed,
          policiesFound: fetched.items.length,
          policiesNew: added.length,
          policiesChanged: changed.length,
          sourceResults: fetched.sourceResults as never,
          warnings: fetched.warnings as never,
        },
      });

      this.logger.log(
        `政策检索 ${jurisdiction}：来源 ${fetched.sourcesTried} 个（失败 ${fetched.sourcesFailed}），` +
          `新增 ${added.length} 条、变更 ${changed.length} 条、未变 ${unchanged} 条`,
      );

      return {
        runId: run.id,
        jurisdiction,
        status: fetched.status,
        fetcher: fetcher.name,
        sourcesTried: fetched.sourcesTried,
        sourcesFailed: fetched.sourcesFailed,
        policiesFound: fetched.items.length,
        policiesNew: added.length,
        policiesChanged: changed.length,
        unchanged,
        added: addedRows,
        changed: changedRows,
        warnings: fetched.warnings,
        fetchedAt: now.toISOString(),
        disclaimer: DISCLAIMER,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.prisma.taxPolicyFetchRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          status: 'FAILED',
          errorMessage: msg,
        },
      });
      this.logger.error(`政策检索失败：${msg}`);
      throw new DomainError(
        'BK_E_POLICY_FETCH_FAILED',
        `政策检索执行失败：${msg}。本次未获取到任何政策，` +
          '这**不代表**没有新政策 —— 请检查来源可用性后重试。',
        500,
        msg,
      );
    }
  }

  /** 查询政策库 */
  async listPolicies(params: {
    jurisdiction?: string;
    status?: 'EFFECTIVE' | 'UPCOMING' | 'EXPIRED';
    taxType?: string;
    needsReviewOnly?: boolean;
    take?: number;
  }) {
    const where: Record<string, unknown> = {};
    if (params.jurisdiction) where.jurisdiction = params.jurisdiction;
    if (params.status) where.status = params.status;
    if (params.taxType) where.taxTypes = { has: params.taxType };
    if (params.needsReviewOnly) where.needsReview = true;

    const rows = await this.prisma.taxPolicyRecord.findMany({
      where,
      orderBy: [{ effectiveFrom: 'desc' }, { fetchedAt: 'desc' }],
      take: Math.min(params.take ?? 100, 300),
    });

    return rows.map((r) => ({
      ...r,
      conditions: extractConditions(r.rawContent ?? ''),
      displayStatus: statusLabel(r.status as never),
    }));
  }

  /** 某条政策的完整原文（用于"我要看原文"） */
  async getPolicy(id: string) {
    const row = await this.prisma.taxPolicyRecord.findUnique({ where: { id } });
    if (!row) {
      throw new DomainError('NOT_FOUND', '找不到这条政策记录。', 404, `id=${id}`);
    }
    return {
      ...row,
      conditions: extractConditions(row.rawContent ?? ''),
      // ★ 界面必须能看到"这条是什么时候抓的" —— 政策会改
      fetchedAtLabel: row.fetchedAt.toISOString(),
      disclaimer: DISCLAIMER,
    };
  }

  /** 标记为已阅（人工确认过） */
  async markReviewed(params: { id: string; userId?: string; notes?: string }) {
    const row = await this.prisma.taxPolicyRecord.findUnique({ where: { id: params.id } });
    if (!row) {
      throw new DomainError('NOT_FOUND', '找不到这条政策记录。', 404, `id=${params.id}`);
    }
    await this.prisma.taxPolicyRecord.update({
      where: { id: params.id },
      data: {
        needsReview: false,
        reviewedAt: new Date(),
        reviewedBy: params.userId ?? null,
        notes: params.notes ?? row.notes,
      },
    });
    return { ok: true };
  }

  /** 检索执行历史（★ 含失败的，这样才能分辨"没新政策"与"抓取挂了"） */
  async listRuns(params: { jurisdiction?: string; take?: number }) {
    const rows = await this.prisma.taxPolicyFetchRun.findMany({
      where: params.jurisdiction ? { jurisdiction: params.jurisdiction } : {},
      orderBy: { startedAt: 'desc' },
      take: Math.min(params.take ?? 20, 100),
    });
    return rows.map((r) => ({
      ...r,
      statusLabel:
        r.status === 'SUCCESS'
          ? '全部来源成功'
          : r.status === 'PARTIAL'
            ? '部分来源失败'
            : r.status === 'FAILED'
              ? '抓取失败（不代表没有新政策）'
              : '执行中',
    }));
  }

  /** 已登记的官方来源清单 */
  listSources(jurisdiction?: string) {
    const sources = jurisdiction
      ? POLICY_SOURCES.filter(
          (s) => s.jurisdiction === jurisdiction || s.jurisdiction === 'CN-GENERAL',
        )
      : POLICY_SOURCES;
    return {
      sources,
      note:
        '政策库只覆盖这里登记的来源。未登记的来源不会被检索到 —— ' +
        '"没有搜到"不等于"没有这条政策"。',
    };
  }

  // --------------------------------------------------------------------------

  /** 落库一条政策（同来源链接视为同一条，内容变化时更新） */
  private async upsertPolicy(params: {
    jurisdiction: string;
    item: RawPolicyItem;
    fetchedAt: Date;
  }) {
    const { jurisdiction, item, fetchedAt } = params;
    const contentHash = hashPolicy(item);
    const status = deriveStatus(item.effectiveFrom, item.effectiveTo, fetchedAt);
    const taxTypes = inferTaxTypes(item.title, item.content);
    const keywords = extractKeywords(item.title, item.content);
    const documentNo = item.documentNo ?? extractDocumentNo(item.title, item.content);

    const parseDate = (v: string | null | undefined): Date | null => {
      if (!v) return null;
      const d = new Date(`${v.slice(0, 10)}T00:00:00.000Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const data = {
      jurisdiction,
      issuer: item.issuer ?? null,
      title: item.title,
      sourceUrl: item.sourceUrl,
      sourceName: item.sourceName ?? null,
      documentNo,
      publishedAt: parseDate(item.publishedAt),
      effectiveFrom: parseDate(item.effectiveFrom),
      effectiveTo: parseDate(item.effectiveTo),
      rawExcerpt: item.content.slice(0, 2000),
      rawContent: item.content,
      // ★ 每次抓到都刷新抓取时间：它记录的是"我们最后一次看到这一版是什么时候"
      fetchedAt,
      contentHash,
      status,
      taxTypes,
      keywords,
      // 内容变化或首次入库都要人工看一眼
      needsReview: true,
    };

    return this.prisma.taxPolicyRecord.upsert({
      where: {
        jurisdiction_sourceUrl: { jurisdiction, sourceUrl: item.sourceUrl },
      },
      create: data,
      update: data,
    });
  }
}

function statusLabel(status: 'EFFECTIVE' | 'UPCOMING' | 'EXPIRED'): string {
  return status === 'EFFECTIVE'
    ? '按公布日期推算：已施行'
    : status === 'UPCOMING'
      ? '按公布日期推算：尚未施行'
      : '按公布日期推算：已过失效日期';
}
