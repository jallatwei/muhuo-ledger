/**
 * 种子数据
 * ============================================================
 * 用法：
 *   pnpm --filter @bookkeeper/api seed
 *   或容器内：docker compose -f docker/dev/docker-compose.yml exec api pnpm --filter @bookkeeper/api seed
 *
 * 幂等：可重复执行。已存在的主体/科目/规则会被更新而非重复创建。
 *
 * 灌入内容：
 *   1. 一个演示核算主体（可改）
 *   2. 小企业会计准则科目表（约 138 个，见 prisma/data/accounts.ts）
 *   3. 内置自动记账规则（28 条，见 prisma/data/rules.ts）
 *   4. 内置风险规则（12 条）
 *   5. 税务档案（含税率与优惠政策参数 —— 全部配置化，不硬编码）
 *   6. 会计期间（当年 12 个月）+ 税期（月度增值税 / 季度所得税）
 *   7. 管理员账号
 *   8. 系统配置（税率表等可变参数）
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { BUILTIN_ACCOUNTS } from '../src/domain/accounting/chart-of-accounts';
import { upsertBuiltinAccounts } from '../src/domain/accounting/account-tree';
import { BUILTIN_RULES, BUILTIN_RISK_RULES } from './data/rules';

const prisma = new PrismaClient();

const DEMO_ENTITY_NAME = process.env.SEED_ENTITY_NAME ?? '演示科技有限公司';
const DEMO_ENTITY_TAXNO = process.env.SEED_ENTITY_TAXNO ?? '91310000MA1DEMO001';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@bookkeeper.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'admin12345';
const SEED_YEAR = Number(process.env.SEED_YEAR ?? new Date().getFullYear());
// 科目辅助计算（computeLevel / computeFullName / computeIsLeaf）已抽到
// src/domain/accounting/account-tree.ts —— 公司注册时要用同一套口径，
// 两处各写一份必然分叉，而科目表分叉会让报表口径分叉。

// ============================================================================
//  主体
// ============================================================================

async function upsertEntity() {
  const existing = await prisma.entity.findFirst({ where: { unifiedSocialCreditCode: DEMO_ENTITY_TAXNO } });
  if (existing) {
    console.log(`  · 主体已存在：${existing.name} (${existing.id})`);
    return existing;
  }
  const entity = await prisma.entity.create({
    data: {
      name: DEMO_ENTITY_NAME,
      unifiedSocialCreditCode: DEMO_ENTITY_TAXNO,
      taxpayerType: 'GENERAL', // 一般纳税人
      accountingStandard: 'SMALL_ENTERPRISE_2013',
      baseCurrency: 'CNY',
      fiscalYearStartMonth: 1,
      legalPerson: '张三',
      accountantName: '李四',
      bookkeepingEnforced: true,
    },
  });
  console.log(`  · 已创建主体：${entity.name} (${entity.id})`);
  return entity;
}

// ============================================================================
//  科目表
// ============================================================================

async function seedAccounts(entityId: string) {
  // ★ 整段 upsert 逻辑复用领域层的 upsertBuiltinAccounts，
  //   与「公司注册」走同一份实现 —— 新增主体的科目表因此与演示主体逐字段一致。
  const { idByCode, count, parentCount } = await upsertBuiltinAccounts(
    prisma as unknown as Parameters<typeof upsertBuiltinAccounts>[0],
    entityId,
    BUILTIN_ACCOUNTS,
  );

  console.log(`  · 科目表：${count} 个已就绪（其中 ${parentCount} 个非末级科目）`);
  return idByCode;
}

// ============================================================================
//  期间与税期
// ============================================================================

async function seedPeriods(entityId: string, year: number) {
  let count = 0;
  for (let month = 1; month <= 12; month += 1) {
    const startsOn = new Date(Date.UTC(year, month - 1, 1));
    const endsOn = new Date(Date.UTC(year, month, 0)); // 当月最后一天
    await prisma.period.upsert({
      where: { entityId_fiscalYear_month: { entityId, fiscalYear: year, month } },
      create: { entityId, fiscalYear: year, month, startsOn, endsOn, status: 'OPEN' },
      update: { startsOn, endsOn },
    });
    count += 1;

    // 增值税：月报（一般纳税人）
    await prisma.taxPeriod.upsert({
      where: { entityId_taxType_label: { entityId, taxType: 'VAT', label: `${year}-${String(month).padStart(2, '0')}` } },
      create: {
        entityId,
        taxType: 'VAT',
        year,
        month,
        label: `${year}-${String(month).padStart(2, '0')}`,
        startsOn,
        endsOn,
        status: 'OPEN',
      },
      update: { startsOn, endsOn },
    });
  }

  // 企业所得税：季报
  for (let q = 1; q <= 4; q += 1) {
    const startMonth = (q - 1) * 3 + 1;
    await prisma.taxPeriod.upsert({
      where: { entityId_taxType_label: { entityId, taxType: 'CIT_PREPAY', label: `${year}Q${q}` } },
      create: {
        entityId,
        taxType: 'CIT_PREPAY',
        year,
        quarter: q,
        label: `${year}Q${q}`,
        startsOn: new Date(Date.UTC(year, startMonth - 1, 1)),
        endsOn: new Date(Date.UTC(year, startMonth + 2, 0)),
        status: 'OPEN',
      },
      update: {},
    });
  }

  await prisma.fiscalYear.upsert({
    where: { entityId_year: { entityId, year } },
    create: { entityId, year, status: 'OPEN' },
    update: {},
  });

  console.log(`  · 会计期间：${count} 个月 + ${count} 个增值税税期 + 4 个所得税季度`);
}

// ============================================================================
//  税务档案
// ============================================================================

async function seedTaxProfile(entityId: string) {
  await prisma.taxProfile.upsert({
    where: { entityId },
    create: {
      entityId,
      taxpayerType: 'GENERAL',
      vatFilingCycle: 'MONTHLY',
      citPrepayCycle: 'QUARTERLY',
      isSmallLowProfit: true,
      // 城建 7%（市区）+ 教育费附加 3% + 地方教育附加 2%
      surtaxRates: { city: 0.07, edu: 0.03, localEdu: 0.02 },
      // 六税两费减半征收
      surtaxReduction: '0.5',
      surtaxLocation: 'CITY',
      invoiceCertMode: 'AUTO_ON_IMPORT',
      // 小型微利企业：应纳税所得额减按 25% 计入，按 20% 税率缴纳 → 实际税负 5%
      smallProfitDeductionRate: '0.25',
      smallProfitTaxRate: '0.2',
      policyNote:
        '小型微利企业优惠：应纳税所得额减按25%计入，按20%税率缴纳（实际税负5%）。' +
        '条件：年度应纳税所得额≤300万、从业人数≤300人、资产总额≤5000万。',
      policyEffectiveFrom: new Date(Date.UTC(2023, 0, 1)),
      policyEffectiveTo: new Date(Date.UTC(2027, 11, 31)),
    },
    update: {},
  });
  console.log('  · 税务档案：一般纳税人 / 增值税月报 / 小微优惠参数已配置');
}

// ============================================================================
//  规则
// ============================================================================

async function seedRules(entityId: string) {
  for (const rule of BUILTIN_RULES) {
    const data = {
      entityId,
      code: rule.code,
      name: rule.name,
      priority: rule.priority,
      enabled: true,
      trigger: rule.trigger,
      conditions: rule.conditions as never,
      template: rule.template as never,
      confidence: rule.confidence,
      autoPost: rule.autoPost,
      isSystem: true,
      remark: rule.remark ?? null,
    };
    await prisma.journalRule.upsert({
      where: { entityId_code: { entityId, code: rule.code } },
      create: data,
      update: {
        name: data.name,
        priority: data.priority,
        trigger: data.trigger,
        conditions: data.conditions,
        template: data.template,
        confidence: data.confidence,
        remark: data.remark,
        isSystem: true,
      },
    });
  }

  for (const risk of BUILTIN_RISK_RULES) {
    const data = {
      entityId,
      code: risk.code,
      name: risk.name,
      category: risk.category,
      engine: risk.engine,
      definition: risk.definition as never,
      level: risk.level,
      enabled: true,
    };
    await prisma.riskRule.upsert({
      where: { entityId_code: { entityId, code: risk.code } },
      create: data,
      update: {
        name: data.name,
        category: data.category,
        engine: data.engine,
        definition: data.definition,
        level: data.level,
      },
    });
  }

  console.log(`  · 规则库：${BUILTIN_RULES.length} 条记账规则 + ${BUILTIN_RISK_RULES.length} 条风险规则`);
}

// ============================================================================
//  系统配置
// ============================================================================

async function seedSystemConfig(entityId: string) {
  const configs: Array<{ key: string; value: unknown; remark: string }> = [
    {
      key: 'vat.rates',
      value: [
        { rate: '0.13', label: '13%', type: 'RATE' },
        { rate: '0.09', label: '9%', type: 'RATE' },
        { rate: '0.06', label: '6%', type: 'RATE' },
        { rate: '0.05', label: '5%（简易计税）', type: 'LEVY' },
        { rate: '0.03', label: '3%（征收率）', type: 'LEVY' },
        { rate: '0.01', label: '1%（小规模减征）', type: 'LEVY' },
        { rate: '0', label: '免税', type: 'EXEMPT' },
      ],
      remark: '增值税税率与征收率。政策调整时改这里，不要改业务代码。',
    },
    {
      key: 'deductibility.keywords',
      value: {
        nonDeductible: ['餐饮', '招待', '娱乐', '礼品', '福利', '慰问', '贷款利息', '个人消费'],
        travelDeductible: ['火车', '机票', '航空', '旅客运输', '客票'],
        fixedAsset: ['设备', '机器', '电脑', '服务器', '空调', '车辆', '办公家具'],
        inventory: ['原料', '材料', '配件', '钢材', '包装', '元器件', '库存商品'],
      },
      remark: '进项抵扣判定与业务类型识别的关键词。用于规则引擎与 AI 提示词。',
    },
    {
      key: 'voucher.print',
      value: { vouchersPerPage: 2, pageSize: 'A4', bindingMarginMm: 25, fontFamily: 'SimSun' },
      remark: '凭证册打印参数',
    },
    {
      key: 'risk.thresholds',
      value: {
        vatBurdenDeviationPct: 50,
        inputNoOutputMonths: 3,
        uncertifiedAgingDays: 180,
        arAgingDays: 365,
        expenseSpikePct: 200,
        duplicateSummaryCount: 3,
      },
      remark: '风险预警阈值',
    },
    {
      key: 'accounting.tolerance',
      value: { taxAmountTolerance: 0.02, balanceTolerance: 0 },
      remark: '税额勾稽容差（分）；借贷平衡容差固定为 0，不允许配置',
    },
  ];

  for (const cfg of configs) {
    await prisma.systemConfig.upsert({
      where: { entityId_key: { entityId, key: cfg.key } },
      create: { entityId, key: cfg.key, value: cfg.value as never, remark: cfg.remark },
      update: { value: cfg.value as never, remark: cfg.remark },
    });
  }
  console.log(`  · 系统配置：${configs.length} 项（税率表、抵扣关键词、打印参数、风险阈值）`);
}

// ============================================================================
//  管理员账号
// ============================================================================

async function seedAdmin(entityId: string) {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  // ★ 账号是平台级的，与主体的关系放在 Membership 里。
  //   User 上的 role / entityIds 已废弃（数组无外键、表达不了"在这家公司是什么角色"）。
  const user = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      email: ADMIN_EMAIL,
      passwordHash,
      displayName: '系统管理员',
      accountType: 'COMPANY_STAFF',
      // seed 出来的管理员是平台管理员：否则演示环境里没人能管理成员
      isPlatformAdmin: true,
    },
    update: { isPlatformAdmin: true },
  });

  const membership = await prisma.membership.findUnique({
    where: { userId_entityId: { userId: user.id, entityId } },
  });
  if (membership) {
    console.log(`  · 管理员已存在：${ADMIN_EMAIL}（角色 ${membership.role}）`);
    return;
  }

  await prisma.membership.create({
    data: { userId: user.id, entityId, role: 'OWNER' },
  });
  console.log(`  · 管理员已创建：${ADMIN_EMAIL} / ${ADMIN_PASSWORD}  ← 请首次登录后立即修改`);
}

// ============================================================================
//  主流程
// ============================================================================

async function main() {
  console.log('');
  console.log('════════════════════════════════════════════════════════');
  console.log('  小企业自动记账系统 — 种子数据初始化');
  console.log('════════════════════════════════════════════════════════');

  console.log('\n[1/7] 核算主体');
  const entity = await upsertEntity();

  console.log('\n[2/7] 会计科目（小企业会计准则）');
  await seedAccounts(entity.id);

  console.log('\n[3/7] 会计期间与税期');
  await seedPeriods(entity.id, SEED_YEAR);

  console.log('\n[4/7] 税务档案');
  await seedTaxProfile(entity.id);

  console.log('\n[5/7] 规则库');
  await seedRules(entity.id);

  console.log('\n[6/7] 系统配置');
  await seedSystemConfig(entity.id);

  console.log('\n[7/7] 用户');
  await seedAdmin(entity.id);

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  ✅ 初始化完成');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  主体 ID : ${entity.id}`);
  console.log(`  主体名称: ${entity.name}`);
  console.log(`  纳税人  : 一般纳税人（增值税月报）`);
  console.log(`  会计年度: ${SEED_YEAR}`);
  console.log(`  登录账号: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log('');
}

main()
  .catch((e) => {
    console.error('\n❌ 种子数据初始化失败：');
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
