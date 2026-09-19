/**
 * 凭证服务 —— 应用层编排
 * ============================================================
 * 事务边界就在这里。领域层负责"对不对"，本服务负责"怎么落库"。
 *
 * 关键实现点：
 *   1. 科目编码 → 科目实体：在进入领域层之前解析好，带上 isLeaf/auxRequired
 *   2. 凭证号在**过账事务内**分配，事务回滚时号一并回滚，不留空洞
 *   3. 过账前重新从数据库读一遍分录再校验一次借贷平衡
 *      —— 拦住"草稿期间被人改过金额，而内存对象还是旧的"这类真实事故
 *   4. 幂等：同一 idempotencyKey 只可能有一张非作废凭证
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal, checkBalance, dec } from '@bookkeeper/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AccountService, type AccountMeta } from '../../infrastructure/prisma/account.service';
import { AuditService } from '../../infrastructure/prisma/audit.service';
import { VoucherNumberService } from './voucher-number.service';
import {
  JournalVoucher,
  type LineDraft,
  type PeriodInfo,
  type VoucherDraft,
} from './voucher.entity';
import { fromDb, toDb, toDbNullable, toDbRate } from '../../common/decimal';
import { assertWritable } from './period';
import { BusinessRuleError } from './errors';

// ---------------------------------------------------------------- DTO
export interface CreateVoucherInput {
  entityId: string;
  /** 会计期间 id；不传则按 voucherDate 自动定位 */
  periodId?: string;
  voucherDate: string | Date;
  summary: string;
  voucherWord?: string;
  sourceType?: 'MANUAL' | 'INVOICE' | 'BANK' | 'PAYROLL' | 'CLOSING' | 'OPENING';
  sourceId?: string;
  idempotencyKey?: string;
  ruleId?: string;
  ruleReason?: string;
  ruleVersion?: number;
  confidence?: string | number;
  attachments?: number;
  lines: Array<{
    accountCode: string;
    direction: 'DEBIT' | 'CREDIT';
    amount: string;
    summary?: string;
    partnerId?: string;
    auxProject?: string;
    auxDepartment?: string;
    contractId?: string;
    taxRate?: string;
    taxAmount?: string;
    invoiceId?: string;
  }>;
}

export interface VoucherListQuery {
  entityId: string;
  periodId?: string;
  status?: string[];
  sourceType?: string;
  accountCode?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class VoucherService {
  private readonly logger = new Logger(VoucherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly numbers: VoucherNumberService,
    private readonly audit: AuditService,
  ) {}

  // ==========================================================================
  //  创建
  // ==========================================================================

  /**
   * 创建凭证草稿。
   *
   * ★ 幂等：若 idempotencyKey 已存在，直接返回已有凭证，不报错。
   *   这让"重复点击""任务重试""断点续跑"都变成安全操作。
   */
  async create(input: CreateVoucherInput, userId?: string): Promise<{ id: string; alreadyExists: boolean }> {
    const voucherDate = toDate(input.voucherDate);

    // ---- 幂等检查 ----
    if (input.idempotencyKey) {
      const existing = await this.prisma.journalVoucher.findFirst({
        where: {
          entityId: input.entityId,
          idempotencyKey: input.idempotencyKey,
          status: { not: 'VOID' },
        },
        select: { id: true },
      });
      if (existing) {
        this.logger.log(`幂等命中，返回已有凭证 ${existing.id}（key=${input.idempotencyKey}）`);
        return { id: existing.id, alreadyExists: true };
      }
    }

    // ---- 定位会计期间 ----
    const period = input.periodId
      ? await this.requirePeriod(input.entityId, input.periodId)
      : await this.requirePeriodByDate(input.entityId, voucherDate);

    assertWritable(period);

    // ---- 解析科目：把编码变成实体，并带上末级/辅助核算信息 ----
    const metaMap = await this.accounts.resolveMany(
      input.entityId,
      input.lines.map((l) => l.accountCode),
    );

    // ---- ★ 校验引用的发票存在 ----
    //
    // 分录行可以带 invoiceId 建立与发票的勾稽关系（打印凭证册时靠它带出附件）。
    // 若不校验，传错 id 只会撞上数据库外键，用户看到的是"系统内部错误"，
    // 完全不知道该改什么。这里提前查一次，给出明确的错因。
    const invoiceIds = [...new Set(input.lines.map((l) => l.invoiceId).filter((id): id is string => !!id))];
    if (invoiceIds.length > 0) {
      const found = await this.prisma.invoice.findMany({
        where: { id: { in: invoiceIds }, entityId: input.entityId },
        select: { id: true },
      });
      const foundSet = new Set(found.map((i) => i.id));
      const missing = invoiceIds.filter((id) => !foundSet.has(id));
      if (missing.length > 0) {
        throw new BusinessRuleError(
          `以下发票不存在或不属于本主体：${missing.join('、')}。` +
            `分录行引用发票用于建立勾稽关系（打印凭证册时据此带出附件），` +
            `请确认发票已导入，或去掉该引用后重试。`,
        );
      }
    }

    const lines = input.lines.map((l) => this.buildLineDraft(l, metaMap));

    // ---- 组装领域对象（构造时即校验借贷平衡） ----
    const draft: VoucherDraft = {
      entityId: input.entityId,
      periodId: period.id,
      periodYear: period.fiscalYear,
      periodMonth: period.month,
      voucherWord: input.voucherWord ?? '记',
      voucherDate,
      summary: input.summary,
      lines,
      sourceType: input.sourceType ?? 'MANUAL',
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
      ruleId: input.ruleId,
      ruleReason: input.ruleReason,
      ruleVersion: input.ruleVersion,
      confidence: input.confidence === undefined ? undefined : dec(input.confidence),
      attachments: input.attachments ?? 0,
      createdBy: userId,
    };

    const voucher = JournalVoucher.create(draft);

    // ---- 落库 ----
    const created = await this.prisma.$transaction(async (tx) =>
      tx.journalVoucher.create({
        data: {
          entityId: voucher.entityId,
          periodId: voucher.periodId,
          periodYear: voucher.periodYear,
          periodMonth: voucher.periodMonth,
          voucherWord: voucher.voucherWord,
          // ★ 草稿不分配凭证号，用 0 占位；过账时才写入真实号
          voucherNo: 0,
          voucherDate: voucher.voucherDate,
          status: 'DRAFT',
          totalDebit: toDb(voucher.totalDebit),
          totalCredit: toDb(voucher.totalCredit),
          summary: voucher.summary,
          attachments: voucher.attachments,
          sourceType: voucher.sourceType,
          sourceId: voucher.sourceId,
          idempotencyKey: voucher.idempotencyKey,
          ruleId: voucher.ruleId,
          ruleReason: voucher.ruleReason,
          ruleVersion: voucher.ruleVersion,
          confidence: toDbNullable(voucher.confidence),
          createdBy: voucher.createdBy,
          lines: {
            create: voucher.lines.map((l, i) => ({
              entityId: voucher.entityId,
              periodId: voucher.periodId,
              lineNo: i + 1,
              accountId: l.accountId,
              direction: l.direction,
              amount: toDb(l.amount),
              summary: l.summary,
              partnerId: l.partnerId,
              auxProject: l.auxProject,
              auxDepartment: l.auxDepartment,
              contractId: l.contractId,
              taxRate: l.taxRate === undefined ? null : toDbRate(l.taxRate),
              taxAmount: toDbNullable(l.taxAmount),
              invoiceId: l.invoiceId,
            })),
          },
        },
        select: { id: true },
      }),
    );

    await this.audit.record({
      entityId: voucher.entityId,
      userId,
      action: 'CREATE',
      subjectType: 'JournalVoucher',
      subjectId: created.id,
      afterData: {
        summary: voucher.summary,
        totalDebit: voucher.totalDebit.toFixed(2),
        totalCredit: voucher.totalCredit.toFixed(2),
        sourceType: voucher.sourceType,
        ruleReason: voucher.ruleReason,
        lineCount: voucher.lines.length,
      },
    });

    return { id: created.id, alreadyExists: false };
  }

  // ==========================================================================
  //  状态流转
  // ==========================================================================

  /** 提交审核 */
  async submit(voucherId: string, userId?: string): Promise<void> {
    const { voucher, period } = await this.loadDomain(voucherId);
    assertWritable(period);
    voucher.submit();
    await this.persistStatus(voucherId, 'REVIEWING', {});
    await this.audit.record({
      entityId: voucher.entityId,
      userId,
      action: 'SUBMIT',
      subjectType: 'JournalVoucher',
      subjectId: voucherId,
    });
  }

  /** 审核通过 */
  async approve(voucherId: string, userId: string): Promise<void> {
    const { voucher, period } = await this.loadDomain(voucherId);
    assertWritable(period);
    voucher.approve(userId);
    await this.persistStatus(voucherId, 'APPROVED', {
      reviewedBy: userId,
      reviewedAt: voucher.reviewedAt,
      // 审核通过了，上一次的退回理由不再适用，清掉避免误导
      reviewNote: null,
    });
    await this.audit.record({
      entityId: voucher.entityId,
      userId,
      action: 'APPROVE',
      subjectType: 'JournalVoucher',
      subjectId: voucherId,
    });
  }

  /**
   * 审核退回：待审核 → 草稿。
   *
   * ★ 理由写进凭证的 reviewNote，制单人一打开就能看到要改什么。
   *   只写审计日志是不够的 —— 审计日志是给检查的人看的，
   *   而最需要知道理由的是那个要返工的人。
   */
  async reject(voucherId: string, userId: string, reason: string): Promise<void> {
    const { voucher, period } = await this.loadDomain(voucherId);
    assertWritable(period);
    voucher.reject(userId, reason);
    await this.persistStatus(voucherId, 'DRAFT', {
      reviewedBy: userId,
      reviewedAt: new Date(),
      reviewNote: voucher.reviewNote ?? reason.trim(),
    });
    await this.audit.record({
      entityId: voucher.entityId,
      userId,
      action: 'REJECT',
      subjectType: 'JournalVoucher',
      subjectId: voucherId,
      reason,
      beforeData: { status: 'REVIEWING' },
      afterData: { status: 'DRAFT', stage: 'REVIEW' },
    });
  }

  /**
   * 过账前退回审核：已审核 → 待审核。
   *
   * 与审核退回分开：退回审核是"审核那一步看漏了"，责任在审核环节；
   * 直接退草稿是"单据本身要改"，责任在制单环节。两者的状态不同，
   * 对应的人也不同，混成一条会让流程责任不清。
   */
  async rejectAfterReview(voucherId: string, userId: string, reason: string): Promise<void> {
    const { voucher, period } = await this.loadDomain(voucherId);
    assertWritable(period);
    voucher.rejectAfterReview(reason);
    await this.persistStatus(voucherId, 'REVIEWING', {
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: voucher.reviewNote ?? reason.trim(),
    });
    await this.audit.record({
      entityId: voucher.entityId,
      userId,
      action: 'REJECT',
      subjectType: 'JournalVoucher',
      subjectId: voucherId,
      reason,
      beforeData: { status: 'APPROVED' },
      afterData: { status: 'REVIEWING', stage: 'POST_CHECK' },
    });
  }

  /** 反审核：已审核未过账 → 草稿 */
  async unapprove(voucherId: string, userId: string, reason: string): Promise<void> {
    const { voucher, period } = await this.loadDomain(voucherId);
    assertWritable(period);
    voucher.unapprove(reason);
    await this.persistStatus(voucherId, 'DRAFT', {
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: voucher.reviewNote ?? reason.trim(),
    });
    await this.audit.record({
      entityId: voucher.entityId,
      userId,
      action: 'REJECT',
      subjectType: 'JournalVoucher',
      subjectId: voucherId,
      reason,
      beforeData: { status: 'APPROVED' },
      afterData: { status: 'DRAFT', stage: 'UNAPPROVE' },
    });
  }

  /**
   * ★ 过账：分配凭证号 + 置为 POSTED。
   *
   * 三重保险：
   *   ① 领域层校验（内存对象）
   *   ② 过账前从数据库重读分录再算一次借贷平衡（防内存对象过期）
   *   ③ 数据库触发器（防绕过应用层）
   */
  async post(voucherId: string, userId: string): Promise<{ voucherNo: number }> {
    const { voucher, period } = await this.loadDomain(voucherId);
    assertWritable(period);

    // ---- ② 重读数据库中的分录，重新校验 ----
    const dbLines = await this.prisma.journalLine.findMany({
      where: { voucherId },
      select: { direction: true, amount: true },
    });
    const result = checkBalance(
      dbLines.map((l) => ({ direction: l.direction, amount: fromDb(l.amount) })),
    );
    if (!result.balanced) {
      throw new Error(
        `过账前复核发现凭证借贷不平：借方 ${result.totalDebit.toFixed(2)}，` +
          `贷方 ${result.totalCredit.toFixed(2)}，差额 ${result.difference.toFixed(2)}。` +
          `该凭证的草稿可能已被修改，请刷新后重试。`,
      );
    }

    const voucherNo = await this.prisma.$transaction(async (tx) => {
      // ---- ① 事务内取号（行锁，并发安全） ----
      const no = await this.numbers.allocate(tx, {
        entityId: voucher.entityId,
        periodId: voucher.periodId,
        voucherWord: voucher.voucherWord,
      });

      voucher.post(no, userId);

      await tx.journalVoucher.update({
        where: { id: voucherId },
        data: {
          status: 'POSTED',
          voucherNo: no,
          postedBy: userId,
          postedAt: voucher.postedAt,
          totalDebit: toDb(voucher.totalDebit),
          totalCredit: toDb(voucher.totalCredit),
        },
      });

      // ★ 过账即同步科目余额表。
      //
      // 为什么必须在这里做：
      //   I4 不变式要求「余额表的本期发生额 == 凭证分录聚合」。
      //   如果过账后不同步，余额表就与凭证脱节 —— 报表和明细账对不上，
      //   而且中间没有任何报错，是最危险的一类静默错误。
      //
      // 放在同一事务内的好处：事务回滚时余额也回滚，不会出现"凭证没进但余额进了"。
      // 重算是幂等的（先删后算），重复过账不会累积误差。
      await rebalancePeriod(tx, voucher.entityId, voucher.periodId);

      return no;
    });

    await this.audit.record({
      entityId: voucher.entityId,
      userId,
      action: 'POST',
      subjectType: 'JournalVoucher',
      subjectId: voucherId,
      afterData: { voucherNo, status: 'POSTED' },
    });

    this.logger.log(`凭证已过账 ${voucher.voucherWord}-${voucherNo}（${voucherId}）`);
    return { voucherNo };
  }

  /**
   * ★ 红冲：生成一张反向凭证冲销原凭证。
   *
   * 为什么不是删除？
   *   会计凭证是审计证据，只能追加冲销，不能抹掉历史。
   *   红冲后原凭证置 REVERSED，但**两者分录都参与余额计算**，净额为 0。
   */
  async reverse(voucherId: string, userId: string, reason: string): Promise<{ reversalVoucherId: string }> {
    if (!reason || reason.trim().length === 0) {
      throw new Error('红冲必须填写理由，该理由会写入新凭证的摘要并永久保留。');
    }

    const { voucher, period } = await this.loadDomain(voucherId);
    assertWritable(period);

    const reversalDraft = voucher.buildReversal({
      reversalDate: new Date(),
      operatorId: userId,
      reason: reason.trim(),
    });

    const result = await this.prisma.$transaction(async (tx) => {
      // 1) 创建红冲凭证（草稿，无号）
      const created = await tx.journalVoucher.create({
        data: {
          entityId: reversalDraft.entityId,
          periodId: reversalDraft.periodId,
          periodYear: reversalDraft.periodYear,
          periodMonth: reversalDraft.periodMonth,
          voucherWord: reversalDraft.voucherWord,
          voucherNo: 0,
          voucherDate: reversalDraft.voucherDate,
          status: 'DRAFT',
          totalDebit: toDb(voucher.totalCredit), // 借贷互换
          totalCredit: toDb(voucher.totalDebit),
          summary: reversalDraft.summary,
          attachments: 0,
          sourceType: 'MANUAL',
          sourceId: reversalDraft.sourceId,
          idempotencyKey: reversalDraft.idempotencyKey,
          createdBy: userId,
          lines: {
            create: reversalDraft.lines.map((l, i) => ({
              entityId: reversalDraft.entityId,
              periodId: reversalDraft.periodId,
              lineNo: i + 1,
              accountId: l.accountId,
              direction: l.direction,
              amount: toDb(l.amount),
              summary: l.summary,
              partnerId: l.partnerId,
              auxProject: l.auxProject,
              auxDepartment: l.auxDepartment,
              contractId: l.contractId,
              taxRate: l.taxRate === undefined ? null : toDbRate(l.taxRate),
              taxAmount: toDbNullable(l.taxAmount),
              invoiceId: l.invoiceId,
            })),
          },
        },
        select: { id: true },
      });

      // 2) 红冲凭证直接取号并过账（红冲是明确动作，不需要二次审核）
      const no = await this.numbers.allocate(tx, {
        entityId: reversalDraft.entityId,
        periodId: reversalDraft.periodId,
        voucherWord: reversalDraft.voucherWord,
      });
      await tx.journalVoucher.update({
        where: { id: created.id },
        data: {
          status: 'POSTED',
          voucherNo: no,
          postedBy: userId,
          postedAt: new Date(),
          reversesId: voucherId,
        },
      });

      // 3) 原凭证置为 REVERSED，并留下反向引用
      await tx.journalVoucher.update({
        where: { id: voucherId },
        data: { status: 'REVERSED', reversedById: created.id },
      });

      // 4) 同步余额表（原本被红冲的凭证状态变了，余额表需要刷新）
      await rebalancePeriod(tx, voucher.entityId, voucher.periodId);

      return { id: created.id, voucherNo: no };
    });

    await this.audit.record({
      entityId: voucher.entityId,
      userId,
      action: 'REVERSE',
      subjectType: 'JournalVoucher',
      subjectId: voucherId,
      reason,
      afterData: { reversalVoucherId: result.id, reversalVoucherNo: result.voucherNo },
    });

    this.logger.log(`凭证 ${voucher.label} 已红冲，红冲凭证号 ${result.voucherNo}`);
    return { reversalVoucherId: result.id };
  }

  /** 作废：仅未过账可作废 */
  async void(voucherId: string, userId: string, reason: string): Promise<void> {
    const { voucher, period } = await this.loadDomain(voucherId);
    assertWritable(period);
    voucher.void(reason);
    await this.persistStatus(voucherId, 'VOID', { voidReason: reason.trim() });
    await this.audit.record({
      entityId: voucher.entityId,
      userId,
      action: 'VOID',
      subjectType: 'JournalVoucher',
      subjectId: voucherId,
      reason,
    });
  }

  // ==========================================================================
  //  查询
  // ==========================================================================

  async list(query: VoucherListQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

    const where: Prisma.JournalVoucherWhereInput = { entityId: query.entityId };
    if (query.periodId) where.periodId = query.periodId;
    if (query.status?.length) where.status = { in: query.status as never };
    if (query.sourceType) where.sourceType = query.sourceType as never;
    if (query.keyword) {
      where.OR = [
        { summary: { contains: query.keyword, mode: 'insensitive' } },
        { ruleReason: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    if (query.accountCode) {
      where.lines = { some: { account: { code: query.accountCode } } };
    }

    const [items, total] = await Promise.all([
      this.prisma.journalVoucher.findMany({
        where,
        orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }, { voucherNo: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          lines: {
            orderBy: { lineNo: 'asc' },
            include: { account: { select: { code: true, name: true, fullName: true } } },
          },
        },
      }),
      this.prisma.journalVoucher.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  async getById(voucherId: string) {
    const voucher = await this.prisma.journalVoucher.findUnique({
      where: { id: voucherId },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { account: { select: { code: true, name: true, fullName: true, direction: true } } },
        },
      },
    });
    if (!voucher) throw new NotFoundException(`凭证不存在：${voucherId}`);
    return voucher;
  }

  /** 期间内的凭证汇总（凭证册封面用） */
  async periodSummary(entityId: string, periodId: string) {
    const vouchers = await this.prisma.journalVoucher.findMany({
      where: { entityId, periodId, status: { in: ['POSTED', 'REVERSED'] } },
      select: { voucherNo: true, voucherWord: true, totalDebit: true, attachments: true },
      orderBy: { voucherNo: 'asc' },
    });
    return {
      count: vouchers.length,
      totalDebit: vouchers.reduce((s, v) => s.plus(fromDb(v.totalDebit)), new Decimal(0)).toFixed(2),
      attachments: vouchers.reduce((s, v) => s + v.attachments, 0),
      firstNo: vouchers[0]?.voucherNo ?? null,
      lastNo: vouchers[vouchers.length - 1]?.voucherNo ?? null,
    };
  }

  // ==========================================================================
  //  内部
  // ==========================================================================

  private buildLineDraft(
    line: CreateVoucherInput['lines'][number],
    metaMap: Map<string, AccountMeta>,
  ): LineDraft {
    const meta = metaMap.get(line.accountCode);
    if (!meta) {
      throw new Error(`科目 ${line.accountCode} 未解析成功，这是内部错误。`);
    }
    return {
      accountId: meta.id,
      accountCode: meta.code,
      accountName: meta.name,
      accountIsLeaf: meta.isLeaf,
      accountIsActive: meta.isActive,
      accountAuxRequired: meta.auxRequired,
      direction: line.direction,
      amount: dec(line.amount),
      summary: line.summary,
      partnerId: line.partnerId,
      auxProject: line.auxProject,
      auxDepartment: line.auxDepartment,
      contractId: line.contractId,
      taxRate: line.taxRate === undefined ? undefined : dec(line.taxRate),
      taxAmount: line.taxAmount === undefined ? undefined : dec(line.taxAmount),
      invoiceId: line.invoiceId,
    };
  }

  /** 从数据库加载并重建领域对象 */
  private async loadDomain(
    voucherId: string,
  ): Promise<{ voucher: JournalVoucher; period: PeriodInfo }> {
    const row = await this.prisma.journalVoucher.findUnique({
      where: { id: voucherId },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { account: { select: { code: true, name: true, isLeaf: true, isActive: true, auxRequired: true } } },
        },
      },
    });
    if (!row) throw new NotFoundException(`凭证不存在：${voucherId}`);

    const period = await this.requirePeriod(row.entityId, row.periodId);

    const voucher = JournalVoucher.rehydrate({
      entityId: row.entityId,
      periodId: row.periodId,
      periodYear: row.periodYear,
      periodMonth: row.periodMonth,
      voucherWord: row.voucherWord,
      voucherNo: row.voucherNo === 0 ? null : row.voucherNo,
      voucherDate: row.voucherDate,
      summary: row.summary,
      sourceType: row.sourceType,
      sourceId: row.sourceId ?? undefined,
      idempotencyKey: row.idempotencyKey ?? undefined,
      ruleId: row.ruleId ?? undefined,
      ruleReason: row.ruleReason ?? undefined,
      ruleVersion: row.ruleVersion ?? undefined,
      confidence: row.confidence ? fromDb(row.confidence) : undefined,
      attachments: row.attachments,
      createdBy: row.createdBy ?? undefined,
      status: row.status,
      reviewedBy: row.reviewedBy ?? undefined,
      reviewedAt: row.reviewedAt ?? undefined,
      postedBy: row.postedBy ?? undefined,
      postedAt: row.postedAt ?? undefined,
      reversedById: row.reversedById ?? undefined,
      lines: row.lines.map((l) => ({
        accountId: l.accountId,
        accountCode: l.account.code,
        accountName: l.account.name,
        accountIsLeaf: l.account.isLeaf,
        accountIsActive: l.account.isActive,
        accountAuxRequired: l.account.auxRequired as string[],
        direction: l.direction,
        amount: fromDb(l.amount),
        summary: l.summary ?? undefined,
        partnerId: l.partnerId ?? undefined,
        auxProject: l.auxProject ?? undefined,
        auxDepartment: l.auxDepartment ?? undefined,
        contractId: l.contractId ?? undefined,
        taxRate: l.taxRate ? fromDb(l.taxRate) : undefined,
        taxAmount: l.taxAmount ? fromDb(l.taxAmount) : undefined,
        invoiceId: l.invoiceId ?? undefined,
      })),
    });

    return { voucher, period };
  }

  private async persistStatus(
    voucherId: string,
    status: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.journalVoucher.update({
      where: { id: voucherId },
      data: { status: status as never, ...(extra as object) },
    });
  }

  private async requirePeriod(entityId: string, periodId: string): Promise<PeriodInfo> {
    const p = await this.prisma.period.findFirst({ where: { id: periodId, entityId } });
    if (!p) throw new NotFoundException(`会计期间不存在：${periodId}`);
    return toPeriodInfo(p);
  }

  /** 按凭证日期定位会计期间 */
  private async requirePeriodByDate(entityId: string, date: Date): Promise<PeriodInfo> {
    const p = await this.prisma.period.findFirst({
      where: {
        entityId,
        startsOn: { lte: date },
        endsOn: { gte: date },
      },
    });
    if (!p) {
      throw new NotFoundException(
        `找不到 ${date.toISOString().slice(0, 10)} 所属的会计期间。请先初始化该年度的会计期间。`,
      );
    }
    return toPeriodInfo(p);
  }
}

function toPeriodInfo(p: {
  id: string;
  fiscalYear: number;
  month: number;
  status: string;
  startsOn: Date;
  endsOn: Date;
}): PeriodInfo {
  return {
    id: p.id,
    fiscalYear: p.fiscalYear,
    month: p.month,
    status: p.status as PeriodInfo['status'],
    startsOn: p.startsOn,
    endsOn: p.endsOn,
  };
}

function toDate(input: string | Date): Date {
  if (input instanceof Date) return input;
  // 只取日期部分，统一按 UTC 零点，避免时区导致跨日
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (!m) {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new Error(`无法解析日期：${input}`);
    return d;
  }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * 重算指定期间的科目余额（幂等）。
 *
 * 由数据库函数 bk_rebuild_balances 实现：先删该期间余额，
 * 再由已过账凭证重新聚合，并按科目方向计算期末余额。
 *
 * 任何时候余额表与凭证脱节，都可以安全地调用它 —— 不会造成数据损坏。
 */
async function rebalancePeriod(
  tx: Prisma.TransactionClient,
  entityId: string,
  periodId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT bk_rebuild_balances(${entityId}, ${periodId})`;
}