/**
 * AI Provider 接口
 * ============================================================
 * 设计目标（见 design/07）：
 *   · 一个 OpenAiCompatProvider 覆盖 90% 的云端模型（DeepSeek / Qwen-VL / 豆包 / GLM-4V）
 *   · MockProvider 让开发与 CI 完全离线、零成本、结果确定
 *   · 上层只依赖本接口，换 Provider 不改业务代码
 *
 * ★ 三条硬边界（写进代码，不依赖提示词）：
 *   1. AI 永远不能决定金额 —— 金额一律由系统按模板与票面字段计算
 *   2. AI 输出必须通过 Schema 校验 + 会计交叉校验
 *   3. AI 建议永远不允许自动过账
 */
import type { Decimal } from '@bookkeeper/shared';

export type AiPurpose =
  | 'EXTRACT_INVOICE'
  | 'EXTRACT_BANK_SLIP'
  | 'EXTRACT_CONTRACT'
  | 'EXTRACT_BANK_STATEMENT'
  | 'EXTRACT_BALANCE_SHEET'
  | 'EXTRACT_INCOME_STATEMENT'
  | 'EXTRACT_TAX_RETURN'
  | 'SUGGEST_ACCOUNT'
  | 'ANOMALY';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 要求返回严格 JSON */
  jsonMode?: boolean;
  timeoutMs?: number;
  purpose: AiPurpose;
  entityId?: string;
  documentId?: string;
  promptKey?: string;
  promptVersion?: string;
}

/** 可识别的目标类型（合同的抽取走 EXTRACT_CONTRACT 的独立入口，不在此列） */
export type ExtractTargetType =
  | 'INVOICE'
  | 'BANK_SLIP'
  | 'BANK_STATEMENT'
  | 'BALANCE_SHEET'
  | 'INCOME_STATEMENT'
  | 'TAX_RETURN';

export interface VisionRequest {
  system?: string;
  /** 伴随图片的文本指令（或 PDF 的文本层） */
  text: string;
  images: Array<{ base64?: string; path?: string; mimeType: string }>;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  purpose: AiPurpose;
  entityId?: string;
  documentId?: string;
  promptKey: string;
  promptVersion: string;
}

export interface ChatResponse {
  text: string;
  /** jsonMode 且解析成功时填充 */
  json?: unknown;
  usage?: { promptTokens: number; completionTokens: number };
  model: string;
  latencyMs: number;
  raw: unknown;
}

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  model?: string;
  latencyMs?: number;
  message?: string;
}

export interface AiProvider {
  readonly name: string;
  ping(): Promise<ProviderHealth>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  vision(req: VisionRequest): Promise<ChatResponse>;
  estimateCost(req: ChatRequest | VisionRequest): Promise<Decimal | null>;
}

/**
 * AI 调用失败
 *
 * `httpStatus` 让错误自己声明该回给客户端什么状态码，默认 502（上游模型服务出问题）。
 *
 * ★ 为什么需要它，而不是在异常过滤器里按类型一刀切：
 *   同一个 AiProviderError 可能是两种完全不同的情况 ——
 *     · 上游超时 / 限流 / Key 失效 → 502，用户该做的是稍后重试或找运维
 *     · 调用方传了不存在的样例名 / 非法参数 → 400，用户该做的是改请求
 *   一刀切成 502 会把后者误报成"服务不可用"，
 *   用户会一直重试一个永远不会成功的请求。
 */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
    /** 建议回给客户端的 HTTP 状态码。默认 502 */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/**
 * 从模型返回的文本里尽力提取 JSON。
 *
 * 现实情况：即使明确要求「只输出 JSON」，模型仍可能：
 *   · 用 ```json 代码块包起来
 *   · 前面加一句"好的，以下是识别结果："
 *   · 结尾加解释文字
 * 所以需要一层容错解析，而不是直接 JSON.parse。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // 1) 直接解析
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试 */
  }

  // 2) 去掉 Markdown 代码块包裹
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* 继续尝试 */
    }
  }

  // 3) 截取第一个 { 到最后一个 }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* 继续尝试 */
    }
  }

  // 4) 数组形式
  const firstArr = trimmed.indexOf('[');
  const lastArr = trimmed.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) {
    try {
      return JSON.parse(trimmed.slice(firstArr, lastArr + 1));
    } catch {
      /* 放弃 */
    }
  }

  return undefined;
}

/** 估算 token 数（粗略：中文约 1.5 字符/token，英文约 4 字符/token） */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}
