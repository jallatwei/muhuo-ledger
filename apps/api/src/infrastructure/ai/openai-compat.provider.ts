/**
 * OpenAI 兼容 Provider
 * ============================================================
 * 一个适配器覆盖 90% 的云端与本地模型 —— 因为它们几乎都暴露
 * OpenAI 兼容的 /v1/chat/completions（含 image_url 多模态入参）：
 *
 *   DeepSeek   https://api.deepseek.com/v1
 *   通义千问VL  https://dashscope.aliyuncs.com/compatible-mode/v1
 *   豆包        https://ark.cn-beijing.volces.com/api/v3
 *   智谱 GLM   https://open.bigmodel.cn/api/paas/v4
 *   Ollama     http://host.docker.internal:11434/v1
 *   vLLM       http://your-host:8000/v1
 *
 * 差异只在 baseUrl / model / 是否支持 response_format，
 * 所以实现「能力探测 + 参数降级」，而不是给每家写一个 Provider。
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from '@bookkeeper/shared';
import {
  AiProviderError,
  estimateTokens,
  extractJson,
  type AiProvider,
  type ChatRequest,
  type ChatResponse,
  type ProviderHealth,
  type VisionRequest,
} from './ai-provider.interface';
import type { Env } from '../../config/env';

interface OpenAiChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}
interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage;
  model?: string;
  error?: { message?: string; type?: string; code?: string };
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

@Injectable()
export class OpenAiCompatProvider implements AiProvider {
  readonly name = 'openai-compatible';
  private readonly logger = new Logger(OpenAiCompatProvider.name);

  /** 能力探测结果缓存：服务商是否支持 response_format=json_object */
  private supportsJsonMode: boolean | null = null;
  /** 连续失败计数，用于熔断 */
  private consecutiveFailures = 0;
  private static readonly CIRCUIT_THRESHOLD = 5;

  constructor(private readonly config: ConfigService) {}

  private get env(): Env {
    return this.config.get<Env>('env') as Env;
  }

  private chatUrl(): string {
    const base = this.env.AI_BASE_URL.replace(/\/+$/, '');
    if (!base) throw new AiProviderError('未配置 AI_BASE_URL', this.name, false);
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  }

  async ping(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const res = await this.call({
        model: this.env.AI_TEXT_MODEL || this.env.AI_VISION_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        temperature: 0,
      });
      return {
        ok: true,
        provider: this.name,
        model: res.model,
        latencyMs: Date.now() - start,
        message: `连通正常，模型 ${res.model}`,
      };
    } catch (e) {
      return {
        ok: false,
        provider: this.name,
        latencyMs: Date.now() - start,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async vision(req: VisionRequest): Promise<ChatResponse> {
    if (!this.env.AI_VISION_MODEL) {
      throw new AiProviderError('未配置 AI_VISION_MODEL，无法识图', this.name, false);
    }
    if (this.isCircuitOpen()) {
      throw new AiProviderError(
        `AI Provider 连续失败 ${this.consecutiveFailures} 次，已熔断。请检查 API Key 与额度；` +
          `期间请使用手工录入，后台会自动重试。`,
        this.name,
        true,
      );
    }

    const parts: ContentPart[] = [];
    // ★ 顺序有讲究：长文本（含 PDF 文本层）放前面，图片放后面，
    //   可提高服务商前缀缓存的命中率，显著降低成本。
    if (req.text) parts.push({ type: 'text', text: req.text });
    for (const img of req.images) {
      const url = img.base64
        ? `data:${img.mimeType};base64,${img.base64}`
        : img.path
          ? img.path
          : null;
      if (!url) continue;
      parts.push({ type: 'image_url', image_url: { url } });
    }

    const messages: Array<{ role: string; content: string | ContentPart[] }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: parts });

    return this.invoke(req, {
      model: this.env.AI_VISION_MODEL,
      messages,
      temperature: req.temperature ?? this.env.AI_TEMPERATURE,
      max_tokens: req.maxTokens ?? 4000,
      jsonMode: req.jsonMode ?? true,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (this.isCircuitOpen()) {
      throw new AiProviderError(
        `AI Provider 连续失败 ${this.consecutiveFailures} 次，已熔断。`,
        this.name,
        true,
      );
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });

    return this.invoke(req, {
      model: this.env.AI_TEXT_MODEL || this.env.AI_VISION_MODEL,
      messages,
      temperature: req.temperature ?? this.env.AI_TEMPERATURE,
      max_tokens: req.maxTokens ?? 2000,
      jsonMode: req.jsonMode ?? false,
    });
  }

  // --------------------------------------------------------------------------
  //  内部：带重试与降级的调用
  // --------------------------------------------------------------------------
  private async invoke(
    req: ChatRequest | VisionRequest,
    body: {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      temperature: number;
      max_tokens: number;
      jsonMode: boolean;
    },
  ): Promise<ChatResponse> {
    const maxRetries = this.env.AI_MAX_RETRIES;
    const timeoutMs = req.timeoutMs ?? this.env.AI_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const start = Date.now();
      try {
        const payload: Record<string, unknown> = {
          model: body.model,
          messages: body.messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
        };

        // 能力探测：只有确认支持时才带 response_format，否则服务商会直接 400
        if (body.jsonMode && this.supportsJsonMode !== false) {
          payload.response_format = { type: 'json_object' };
        }

        const res = await this.call(payload, timeoutMs);
        const latencyMs = Date.now() - start;

        const text = res.choices?.[0]?.message?.content ?? '';
        const json = body.jsonMode || text.trim().startsWith('{') ? extractJson(text) : undefined;

        // 成功，重置熔断计数
        this.consecutiveFailures = 0;

        return {
          text,
          json,
          usage: res.usage
            ? {
                promptTokens: res.usage.prompt_tokens ?? 0,
                completionTokens: res.usage.completion_tokens ?? 0,
              }
            : undefined,
          model: res.model ?? body.model,
          latencyMs,
          raw: res,
        };
      } catch (e) {
        lastError = e;

        // response_format 不被支持 → 降级重试一次，不再带该参数
        if (
          body.jsonMode &&
          this.supportsJsonMode === null &&
          e instanceof AiProviderError &&
          /response_format|InvalidParameter|invalid.*parameter/i.test(e.message)
        ) {
          this.logger.warn(
            `${this.name} 不支持 response_format=json_object，降级为「提示词强制 JSON + 后处理提取」`,
          );
          this.supportsJsonMode = false;
          continue;
        }

        const retryable = e instanceof AiProviderError ? e.retryable : true;
        if (!retryable || attempt === maxRetries) break;

        const backoff = Math.min(8000, 500 * 2 ** attempt);
        this.logger.warn(
          `AI 调用失败（第 ${attempt + 1}/${maxRetries + 1} 次）：${
            e instanceof Error ? e.message : String(e)
          }，${backoff}ms 后重试`,
        );
        await sleep(backoff);
      }
    }

    this.consecutiveFailures += 1;
    throw lastError instanceof AiProviderError
      ? lastError
      : new AiProviderError(
          `AI 调用失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
          this.name,
          true,
          lastError,
        );
  }

  /** 单次 HTTP 调用 */
  private async call(payload: Record<string, unknown>, timeoutMs?: number): Promise<OpenAiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.env.AI_TIMEOUT_MS);

    try {
      const res = await fetch(this.chatUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.env.AI_API_KEY ? { Authorization: `Bearer ${this.env.AI_API_KEY}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const textBody = await res.text();

      if (!res.ok) {
        // 402/429 属于额度问题，重试无意义 → 标记为不可重试，触发熔断
        const nonRetryable = [400, 401, 402, 403, 404].includes(res.status);
        throw new AiProviderError(
          `AI 服务返回 ${res.status}：${textBody.slice(0, 400)}`,
          this.name,
          !nonRetryable,
        );
      }

      let parsed: OpenAiResponse;
      try {
        parsed = JSON.parse(textBody) as OpenAiResponse;
      } catch {
        throw new AiProviderError(
          `AI 服务返回的不是合法 JSON：${textBody.slice(0, 300)}`,
          this.name,
          true,
        );
      }

      if (parsed.error) {
        throw new AiProviderError(`AI 服务返回错误：${parsed.error.message}`, this.name, false);
      }

      return parsed;
    } catch (e) {
      if (e instanceof AiProviderError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new AiProviderError(`AI 调用超时（>${timeoutMs ?? this.env.AI_TIMEOUT_MS}ms）`, this.name, true, e);
      }
      throw new AiProviderError(
        `AI 调用失败：${e instanceof Error ? e.message : String(e)}`,
        this.name,
        true,
        e,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private isCircuitOpen(): boolean {
    return this.consecutiveFailures >= OpenAiCompatProvider.CIRCUIT_THRESHOLD;
  }

  async estimateCost(req: ChatRequest | VisionRequest): Promise<Decimal | null> {
    // 无法准确得知服务商价格，给一个基于 token 量的粗略估算
    const text =
      'messages' in req
        ? req.messages.map((m) => m.content).join('\n')
        : req.text;
    const images = 'images' in req ? req.images.length : 0;
    const promptTokens = estimateTokens(text) + images * 1200;
    const completionTokens = 800;
    // 按 ¥2/百万 input token、¥8/百万 output token 粗算（仅用于预算控制）
    const cost = new Decimal(promptTokens).div(1_000_000).times(2).plus(
      new Decimal(completionTokens).div(1_000_000).times(8),
    );
    return cost.toDecimalPlaces(6);
  }

  /** 供健康检查展示当前熔断状态 */
  getCircuitState(): { open: boolean; consecutiveFailures: number; supportsJsonMode: boolean | null } {
    return {
      open: this.isCircuitOpen(),
      consecutiveFailures: this.consecutiveFailures,
      supportsJsonMode: this.supportsJsonMode,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
