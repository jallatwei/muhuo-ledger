/**
 * 环境配置
 * ============================================================
 * 设计原则（见 design/01 第 2 节）：
 *   软件本体只认环境变量，不知道自己跑在本地还是云端。
 *   「怎么跑起来」由 docker/ 目录负责，与业务代码完全分离。
 *
 * ★ 关键变量缺失时**启动即失败**，而不是运行到一半才发现。
 *   记账系统的静默错误代价太高，宁可起不来。
 */
import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['true', '1', 'yes', 'on'].includes(v.toLowerCase())));

const numeric = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .pipe(z.number().finite());

export const envSchema = z.object({
  // ---- 运行模式 ----
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TZ: z.string().default('Asia/Shanghai'),
  HOST: z.string().default('0.0.0.0'),
  API_PORT: numeric.default(3000),
  API_BASE_URL: z.string().default('http://localhost:3000/api'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // ---- 数据库 ----
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 必填：数据库连接串'),

  // ---- 认证 ----
  JWT_SECRET: z.string().min(16, 'JWT_SECRET 至少 16 位，请用 openssl rand -hex 32 生成'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  /**
   * 是否强制要求登录。
   *
   * ★ 默认 true（生产口径）：没有合法令牌一律 401。
   *
   * 置 false 只用于**本地跑既有 e2e 脚本**：那些脚本直接打接口、不带令牌。
   * 它的语义是「*强制*登录」被关掉，**不是**「归属校验被关掉」——
   * 只要请求带了令牌，仍然会校验「你是不是这家公司的成员」，
   * 带了别人的 entityId 照样 403。这一点很重要：
   * 如果连归属校验一起关掉，本地就再也测不出越权漏洞了。
   *
   * 云端部署必须保持 true。
   */
  AUTH_REQUIRED: booleanish.default(true),

  // ---- 单据存储 ----
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('/data/attachments'),
  STORAGE_MAX_FILE_MB: numeric.default(50),

  // ---- AI 适配层 ----
  AI_PROVIDER: z.enum(['mock', 'openai-compatible', 'local']).default('mock'),
  AI_BASE_URL: z.string().optional().default(''),
  AI_API_KEY: z.string().optional().default(''),
  /**
   * MiMo（小米）专用 API Key。
   *
   * ★ 为什么单独一个变量而不是复用 AI_API_KEY：
   *   MiMo 的官方示例与 Token Plan 控制台都用 MIMO_API_KEY 这个名字，
   *   运维从控制台复制过来直接就能填，不必去猜要改名成什么。
   *   AI_API_KEY 仍可用作通用回退（其他兼容服务商走那个）。
   */
  MIMO_API_KEY: z.string().optional().default(''),
  /**
   * 是否开启 MiMo 的深度思考（thinking.type = enabled / disabled）。
   *
   * ★ 默认关闭，这是刻意的：
   *   ① MiMo v2.5 默认**开启**深度思考，而开启时 temperature / top_p
   *      会被强制成 1.0 / 0.95 —— 对票据抽取来说这是把确定性丢掉了。
   *   ② 思考内容与最终回答共享同一个输出上限，长思考会把 JSON 挤掉，
   *      导致"输出被截断、JSON 不完整"。
   *   ③ 抽取是照着票面抄字段，不需要多步推理，开着只是烧 token 和拖延迟。
   *   需要它做复杂判断时（比如风险分析）再单独打开。
   */
  AI_THINKING_ENABLED: booleanish.default(false),
  /**
   * 是否在请求体里附带 `thinking` 参数。
   *
   * ★ 默认关闭，因为 `thinking` **不是 OpenAI 标准参数**：
   *   大部分兼容服务商收到未知参数会直接 400。
   *   只有 MiMo 这类明确支持它、且默认开启思考的服务商才该打开。
   *   打开后按 AI_THINKING_ENABLED 决定 enabled / disabled。
   */
  AI_SEND_THINKING_PARAM: booleanish.default(false),
  AI_VISION_MODEL: z.string().optional().default(''),
  AI_TEXT_MODEL: z.string().optional().default(''),
  AI_TEMPERATURE: numeric.default(0),
  AI_TIMEOUT_MS: numeric.default(60000),
  AI_MAX_RETRIES: numeric.default(2),
  AI_DAILY_BUDGET: numeric.default(20),
  OCR_MIN_CONFIDENCE: numeric.default(0.85),
  AI_SUGGEST_MIN_CONFIDENCE: numeric.default(0.75),

  // ---- 记账行为 ----
  /** ★ 自动生成的凭证是否允许免人工审核直接过账。强烈建议永远保持 false */
  BOOKKEEPING_AUTO_POST: booleanish.default(false),
  BOOKKEEPING_AUTO_POST_MAX_AMOUNT: numeric.default(1000),
  /** 数据库层强制约束（借贷平衡触发器、期间锁等） */
  BOOKKEEPING_DB_CONSTRAINTS: booleanish.default(true),
  /** 同一纠错特征被纠正多少次后，提示创建自动规则 */
  RULE_PROMOTION_THRESHOLD: numeric.default(3),

  // ---- 后台作业 ----
  JOB_WORKER_ENABLED: booleanish.default(true),
  JOB_POLL_INTERVAL_MS: numeric.default(2000),
  JOB_BATCH_SIZE: numeric.default(5),

  // ---- 日志 ----
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: booleanish.default(false),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `环境变量校验失败，服务无法启动：\n${issues}\n\n` +
        `请检查 deploy/env/.env.dev（本地）或云端环境变量注入。\n` +
        `模板见 deploy/env/.env.dev.example`,
    );
  }
  return parsed.data;
}

/**
 * AI 配置完整性与安全提示。
 * 不阻断启动（mock 模式是合法的），但要在日志里说清楚。
 */
export function describeAiConfig(env: Env): { warnings: string[]; summary: string } {
  const warnings: string[] = [];

  if (env.AI_PROVIDER === 'mock') {
    return {
      warnings,
      summary: 'AI_PROVIDER=mock：识图走离线样例，零成本、结果确定。适合开发与测试。',
    };
  }

  if (!env.AI_BASE_URL) warnings.push('AI_BASE_URL 未配置，识图将无法调用真实模型');
  if (!env.AI_VISION_MODEL) warnings.push('AI_VISION_MODEL 未配置，无法识图');
  if (!env.AI_API_KEY && !env.AI_BASE_URL.includes('localhost') && !env.AI_BASE_URL.includes('host.docker.internal')) {
    warnings.push('AI_API_KEY 未配置，云端模型服务会拒绝请求');
  }

  return {
    warnings,
    summary: `AI_PROVIDER=${env.AI_PROVIDER}，视觉模型 ${env.AI_VISION_MODEL || '(未配置)'}，文本模型 ${
      env.AI_TEXT_MODEL || '(未配置)'
    }`,
  };
}

/**
 * 记账安全配置的自检提示。
 * 这些开关直接关系到"会不会记错账"，启动时必须显式提醒。
 */
export function describeBookkeepingSafety(env: Env): string[] {
  const notes: string[] = [];

  if (env.BOOKKEEPING_AUTO_POST) {
    notes.push(
      '⚠️ BOOKKEEPING_AUTO_POST=true：自动生成的凭证可能免审核直接过账。' +
        '一张错凭证的排查成本远高于人工点一次确认，建议关闭。',
    );
  } else {
    notes.push('✓ 自动记账只生成「待确认」凭证，人工确认后才入账');
  }

  if (!env.BOOKKEEPING_DB_CONSTRAINTS) {
    notes.push('⚠️ BOOKKEEPING_DB_CONSTRAINTS=false：数据库层的借贷平衡与期间锁校验已关闭，仅应用于批量导入');
  } else {
    notes.push('✓ 数据库层强制约束已启用（借贷平衡、期间锁、末级科目、金额正数）');
  }

  return notes;
}
