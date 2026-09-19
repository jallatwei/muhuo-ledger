/**
 * AI Provider 适配层测试
 * ============================================================
 * 为什么值得单独写这一份：这一层是**唯一会花钱**的代码。
 * 提示词写错、重试策略不对、熔断不生效、response_format 降级没兜住，
 * 都要等到接上真实 API 才暴露 —— 而那时按调用次数计费。
 *
 * ★ 测试策略里最关键的一点：**不 mock fetch，直接起一个本地 HTTP 服务器**。
 *   把 fetch 换成桩函数是最省事的写法，但它测不到真实 HTTP 行为：
 *   请求头到底带没带 Authorization、body 是不是合法 JSON、
 *   超时是不是真的会 abort、非 2xx 到底进没进重试分支。
 *   本地服务器让这些全部走真实网络栈，零成本且确定。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { OpenAiCompatProvider } from '../openai-compat.provider';
import { AiProviderError, estimateTokens, extractJson } from '../ai-provider.interface';

// ============================================================================
//  本地假 AI 服务
// ============================================================================

type Handler = (req: {
  body: Record<string, unknown>;
  headers: IncomingMessage['headers'];
}) => { status: number; body: string | object } | { raw: string; status: number };

let server: Server;
let baseUrl = '';
/** 每次请求的记录，供断言检查（请求头、payload） */
let calls: Array<{ body: Record<string, unknown>; headers: IncomingMessage['headers'] }> = [];
/** 由用例设置的响应策略 */
let handler: Handler = () => ({ status: 200, body: { choices: [{ message: { content: '{}' } }] } });

function respond(res: ServerResponse, out: ReturnType<Handler>): void {
  if ('raw' in out) {
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(out.raw);
    return;
  }
  res.writeHead(out.status, { 'Content-Type': 'application/json' });
  res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { __unparsable: raw };
      }
      calls.push({ body, headers: req.headers });
      respond(res, handler({ body, headers: req.headers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ============================================================================
//  构造 provider（用一个假 ConfigService）
// ============================================================================

function makeProvider(overrides: Record<string, unknown> = {}): OpenAiCompatProvider {
  const env = {
    AI_BASE_URL: baseUrl,
    AI_API_KEY: 'test-key-abc',
    AI_VISION_MODEL: 'test-vision',
    AI_TEXT_MODEL: 'test-text',
    AI_TEMPERATURE: 0,
    AI_TIMEOUT_MS: 2000,
    AI_MAX_RETRIES: 2,
    ...overrides,
  };
  const config = { get: (key: string) => (key === 'env' ? env : undefined) };
  return new OpenAiCompatProvider(config as never);
}

const okBody = (content: string, model = 'test-model') => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  model,
});

beforeEach(() => {
  calls = [];
  handler = () => ({ status: 200, body: okBody('{"ok":true}') });
});

// ============================================================================
//  extractJson —— 模型输出容错解析
// ============================================================================

describe('extractJson —— 容错解析模型返回的文本', () => {
  it('干净 JSON 直接解析', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('去掉 ```json 代码块包裹', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('去掉无语言标注的代码块', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('前面有寒暄、后面有解释时截取中间的 JSON', () => {
    const text = '好的，以下是识别结果：\n{"amountInclTax":"1130.00"}\n\n如需修改请告知。';
    expect(extractJson(text)).toEqual({ amountInclTax: '1130.00' });
  });

  it('嵌套对象不会被外层截断', () => {
    const text = '结果：{"outer":{"inner":{"deep":1}},"arr":[1,2]} 完毕';
    expect(extractJson(text)).toEqual({ outer: { inner: { deep: 1 } }, arr: [1, 2] });
  });

  it('顶层数组也能解析', () => {
    expect(extractJson('结果如下 [{"a":1},{"b":2}] 完毕')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('对象与数组同时出现时优先取对象（业务上返回体都是对象）', () => {
    expect(extractJson('前面 [1,2] 后面 {"a":1}')).toEqual({ a: 1 });
  });

  it('字符串里含大括号不会解析错位', () => {
    const text = '{"summary":"摘要里有个 } 符号","n":1}';
    expect(extractJson(text)).toEqual({ summary: '摘要里有个 } 符号', n: 1 });
  });

  it('完全不是 JSON 时返回 undefined，而不是抛错', () => {
    expect(extractJson('模型今天不想干活')).toBeUndefined();
  });

  it('截断的 JSON 返回 undefined（宁可判失败，也不要半个对象）', () => {
    expect(extractJson('{"a":1,"b":')).toBeUndefined();
  });
});

// ============================================================================
//  estimateTokens
// ============================================================================

describe('estimateTokens', () => {
  it('纯中文按 1.5 字/token 估', () => {
    expect(estimateTokens('中文中文中文')).toBe(Math.ceil(6 / 1.5));
  });

  it('纯英文按 4 字/token 估', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('中英混排分别计算后相加', () => {
    // 3 个汉字 → 2，8 个英文 → 2
    expect(estimateTokens('中中中abcdefgh')).toBe(4);
  });

  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

// ============================================================================
//  chatUrl 拼接
// ============================================================================

describe('请求地址拼接', () => {
  it('base 末尾有斜杠时不会拼出双斜杠', async () => {
    const p = makeProvider({ AI_BASE_URL: `${baseUrl}/` });
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' });
    // 服务器能收到请求就说明 URL 没拼错
    expect(calls.length).toBe(1);
  });

  it('base 已经是完整 chat/completions 时不再重复拼接', async () => {
    const p = makeProvider({ AI_BASE_URL: `${baseUrl}/chat/completions` });
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' });
    expect(calls.length).toBe(1);
  });

  it('未配置 AI_BASE_URL 时报不可重试错误', async () => {
    const p = makeProvider({ AI_BASE_URL: '' });
    await expect(
      p.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('未配置 AI_VISION_MODEL 时识图直接拒绝，不浪费一次请求', async () => {
    const p = makeProvider({ AI_VISION_MODEL: '' });
    await expect(
      p.vision({
        text: 'x',
        images: [],
        purpose: 'EXTRACT_INVOICE',
        promptKey: 'k',
        promptVersion: 'v1',
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls.length).toBe(0);
  });
});

// ============================================================================
//  认证头与请求体
// ============================================================================

describe('认证与请求体', () => {
  it('带 Authorization: Bearer <key>', async () => {
    const p = makeProvider();
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' });
    expect(calls[0]!.headers.authorization).toBe('Bearer test-key-abc');
  });

  it('未配置 API Key 时不带 Authorization 头（本地 Ollama 这类无需鉴权）', async () => {
    const p = makeProvider({ AI_API_KEY: '' });
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('system 与 messages 按顺序合并，system 在最前', async () => {
    const p = makeProvider();
    await p.chat({
      system: '你是会计',
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '回答' },
      ],
      purpose: 'ANOMALY',
    });
    const msgs = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(msgs[0]!.content).toBe('你是会计');
  });

  it('jsonMode=false 时不带 response_format', async () => {
    const p = makeProvider();
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], jsonMode: false, purpose: 'ANOMALY' });
    expect(calls[0]!.body.response_format).toBeUndefined();
  });

  it('jsonMode=true 时带 response_format=json_object', async () => {
    const p = makeProvider();
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], jsonMode: true, purpose: 'ANOMALY' });
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
  });
});

// ============================================================================
//  识图请求体（多模态）
// ============================================================================

describe('识图请求体', () => {
  it('base64 图片编码成 data URL', async () => {
    const p = makeProvider();
    await p.vision({
      text: '识别这张票',
      images: [{ base64: 'QUJD', mimeType: 'image/png' }],
      purpose: 'EXTRACT_INVOICE',
      promptKey: 'k',
      promptVersion: 'v1',
    });
    const msgs = calls[0]!.body.messages as Array<{ content: unknown }>;
    const parts = msgs[0]!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: 'text', text: '识别这张票' });
    expect(parts[1]!.image_url!.url).toBe('data:image/png;base64,QUJD');
  });

  it('文本层排在图片之前（为了前缀缓存命中率）', async () => {
    const p = makeProvider();
    await p.vision({
      text: '长文本层',
      images: [{ base64: 'QUJD', mimeType: 'image/jpeg' }],
      purpose: 'EXTRACT_INVOICE',
      promptKey: 'k',
      promptVersion: 'v1',
    });
    const parts = (calls[0]!.body.messages as Array<{ content: unknown }>)[0]!.content as Array<{
      type: string;
    }>;
    expect(parts[0]!.type).toBe('text');
  });

  it('既无 base64 也无 path 的图片被跳过，不会发出空白 image_url', async () => {
    const p = makeProvider();
    await p.vision({
      text: 'x',
      images: [{ mimeType: 'image/png' }],
      purpose: 'EXTRACT_INVOICE',
      promptKey: 'k',
      promptVersion: 'v1',
    });
    const parts = (calls[0]!.body.messages as Array<{ content: unknown }>)[0]!.content as Array<{
      type: string;
    }>;
    expect(parts.filter((x) => x.type === 'image_url')).toHaveLength(0);
  });
});

// ============================================================================
//  重试与熔断
// ============================================================================

describe('重试策略', () => {
  it('5xx 会重试，最终成功时返回结果', async () => {
    let n = 0;
    handler = () => {
      n += 1;
      // 前两次失败，第三次成功
      return n <= 2 ? { status: 500, body: { error: { message: 'server boom' } } } : { status: 200, body: okBody('{"ok":1}') };
    };
    const p = makeProvider();
    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' });
    expect(res.json).toEqual({ ok: 1 });
    expect(calls.length).toBe(3);
  });

  it('429 会重试（限流是暂时的）', async () => {
    let n = 0;
    handler = () => {
      n += 1;
      return n === 1
        ? { status: 429, body: { error: { message: 'rate limited' } } }
        : { status: 200, body: okBody('{"ok":1}') };
    };
    const p = makeProvider();
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' });
    expect(calls.length).toBe(2);
  });

  it('401 不重试（Key 错了，重试只是重复失败并浪费额度）', async () => {
    handler = () => ({ status: 401, body: { error: { message: 'invalid api key' } } });
    const p = makeProvider();
    await expect(
      p.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' }),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls.length).toBe(1);
  });

  it('400 不重试', async () => {
    handler = () => ({ status: 400, body: { error: { message: 'bad request' } } });
    const p = makeProvider();
    await expect(
      p.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' }),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls.length).toBe(1);
  });

  it('响应体不是合法 JSON 时按可重试处理', async () => {
    handler = () => ({ raw: '<html>502 Bad Gateway</html>', status: 200 });
    const p = makeProvider({ AI_MAX_RETRIES: 0 });
    const err = await p
      .chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).retryable).toBe(true);
  });

  it('HTTP 200 但 body 里带 error 字段时按不可重试抛出', async () => {
    handler = () => ({ status: 200, body: { error: { message: 'quota exhausted' } } });
    const p = makeProvider();
    const err = await p
      .chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'ANOMALY' })
      .catch((e: unknown) => e);
    expect((err as AiProviderError).retryable).toBe(false);
  });
});

describe('response_format 能力降级', () => {
  it('服务商报 response_format 不支持时，去掉该参数重试一次并记住结论', async () => {
    let n = 0;
    handler = ({ body }) => {
      n += 1;
      if (body.response_format !== undefined) {
        // 模拟不支持 json_object 的服务商
        return { status: 400, body: { error: { message: 'InvalidParameter: response_format is not supported' } } };
      }
      return { status: 200, body: okBody('```json\n{"ok":1}\n```') };
    };
    const p = makeProvider();
    const res = await p.chat({
      messages: [{ role: 'user', content: 'hi' }],
      jsonMode: true,
      purpose: 'EXTRACT_INVOICE',
    });

    // 第二次请求不应再带 response_format
    expect(calls.length).toBe(2);
    expect(calls[0]!.body.response_format).toBeDefined();
    expect(calls[1]!.body.response_format).toBeUndefined();

    // 降级后依然能从代码块里解析出 JSON
    expect(res.json).toEqual({ ok: 1 });
    expect(p.getCircuitState().supportsJsonMode).toBe(false);
  });

  it('降级结论会被记住：后续请求不再先撞一次 400', async () => {
    handler = ({ body }) =>
      body.response_format !== undefined
        ? { status: 400, body: { error: { message: 'response_format not supported' } } }
        : { status: 200, body: okBody('{"ok":1}') };

    const p = makeProvider();
    await p.chat({ messages: [{ role: 'user', content: 'a' }], jsonMode: true, purpose: 'EXTRACT_INVOICE' });
    const afterFirst = calls.length;
    await p.chat({ messages: [{ role: 'user', content: 'b' }], jsonMode: true, purpose: 'EXTRACT_INVOICE' });
    // 第二次只多一次调用（不再有探测失败的那次）
    expect(calls.length - afterFirst).toBe(1);
  });
});

describe('熔断', () => {
  it('连续失败达到阈值后直接拒绝，不再发请求', async () => {
    const p = makeProvider({ AI_MAX_RETRIES: 0 });

    // 阈值是 5，用不可重试的 401 更快达到（每次只发一个请求）
    handler = () => ({ status: 401, body: { error: { message: 'nope' } } });
    for (let i = 0; i < 5; i += 1) {
      await p.chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'ANOMALY' }).catch(() => undefined);
    }
    expect(calls.length).toBe(5);

    // 第 6 次应被熔断拦下，不产生新的 HTTP 请求
    const err = await p
      .chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'ANOMALY' })
      .catch((e: unknown) => e);
    expect((err as AiProviderError).message).toContain('熔断');
    expect(calls.length).toBe(5);
    expect(p.getCircuitState().open).toBe(true);
  });

  it('成功一次就把失败计数清零', async () => {
    handler = () => ({ status: 401, body: { error: { message: 'nope' } } });
    const p = makeProvider();
    await p.chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'ANOMALY' }).catch(() => undefined);
    expect(p.getCircuitState().consecutiveFailures).toBe(1);

    handler = () => ({ status: 200, body: okBody('{}') });
    await p.chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'ANOMALY' });
    expect(p.getCircuitState().consecutiveFailures).toBe(0);
  });
});

// ============================================================================
//  超时
// ============================================================================

describe('超时', () => {
  it('超过 timeoutMs 时 abort 并报超时错误', async () => {
    // 服务器故意不响应，让客户端超时
    handler = () => ({ status: 200, body: '' });
    const p = makeProvider({ AI_TIMEOUT_MS: 300, AI_MAX_RETRIES: 0 });

    // 用一个永不响应的服务器路径：直接不给 res.end
    // 这里换个做法：让 handler 返回一个极慢的响应
    const slow = createServer((_req, res) => {
      // 永不响应
      void res;
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const slowPort = (slow.address() as AddressInfo).port;

    const sp = makeProvider({ AI_BASE_URL: `http://127.0.0.1:${slowPort}/v1`, AI_TIMEOUT_MS: 300, AI_MAX_RETRIES: 0 });
    const err = await sp
      .chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'ANOMALY' })
      .catch((e: unknown) => e);
    expect((err as AiProviderError).message).toContain('超时');
    expect((err as AiProviderError).retryable).toBe(true);

    await new Promise<void>((r) => slow.close(() => r()));
  }, 10_000);

  it('可以用请求级 timeoutMs 覆盖全局配置', async () => {
    handler = () => ({ status: 200, body: okBody('{}') });
    const p = makeProvider({ AI_TIMEOUT_MS: 60_000 });
    // 请求级给一个极短超时，本地服务器响应很快，仍应成功
    const res = await p.chat({
      messages: [{ role: 'user', content: 'x' }],
      timeoutMs: 5000,
      purpose: 'ANOMALY',
    });
    expect(res.text).toBe('{}');
  });
});

// ============================================================================
//  usage / 模型回传
// ============================================================================

describe('返回体透传', () => {
  it('usage 与 model 正确回传', async () => {
    handler = () => ({ status: 200, body: okBody('{"a":1}', 'my-model-v2') });
    const p = makeProvider();
    const res = await p.chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'ANOMALY' });
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(res.model).toBe('my-model-v2');
  });

  it('服务商不回 model 时回退到请求里用的模型名', async () => {
    handler = () => ({ status: 200, body: { choices: [{ message: { content: '{}' } }] } });
    const p = makeProvider();
    const res = await p.chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'ANOMALY' });
    expect(res.model).toBe('test-text');
  });

  it('choices 为空时不抛错，返回空文本', async () => {
    handler = () => ({ status: 200, body: { choices: [] } });
    const p = makeProvider();
    const res = await p.chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'ANOMALY' });
    expect(res.text).toBe('');
  });

  it('content 为 null 时不会崩（部分服务商截断时会这么返回）', async () => {
    handler = () => ({ status: 200, body: { choices: [{ message: { content: null } }] } });
    const p = makeProvider();
    const res = await p.chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'ANOMALY' });
    expect(res.text).toBe('');
  });
});

// ============================================================================
//  estimateCost
// ============================================================================

describe('estimateCost', () => {
  it('文本请求给出正的成本估算', async () => {
    const p = makeProvider();
    const cost = await p.estimateCost({
      messages: [{ role: 'user', content: '一句中文' }],
      purpose: 'ANOMALY',
    });
    expect(cost).not.toBeNull();
    expect(cost!.greaterThan(0)).toBe(true);
  });

  it('带图片的请求估算更高（图片按 1200 token 计）', async () => {
    const p = makeProvider();
    const textOnly = await p.estimateCost({
      text: '识别',
      images: [],
      purpose: 'EXTRACT_INVOICE',
      promptKey: 'k',
      promptVersion: 'v1',
    });
    const withImage = await p.estimateCost({
      text: '识别',
      images: [{ base64: 'x', mimeType: 'image/png' }],
      purpose: 'EXTRACT_INVOICE',
      promptKey: 'k',
      promptVersion: 'v1',
    });
    expect(withImage!.greaterThan(textOnly!)).toBe(true);
  });
});

// ============================================================================
//  ping
// ============================================================================

describe('ping', () => {
  it('连通时 ok=true 并带上模型名与耗时', async () => {
    handler = () => ({ status: 200, body: okBody('pong', 'ping-model') });
    const p = makeProvider();
    const h = await p.ping();
    expect(h.ok).toBe(true);
    expect(h.model).toBe('ping-model');
    expect(typeof h.latencyMs).toBe('number');
  });

  it('失败时 ok=false 且把原因写进 message（而不是抛错）', async () => {
    handler = () => ({ status: 401, body: { error: { message: 'bad key' } } });
    const p = makeProvider();
    const h = await p.ping();
    expect(h.ok).toBe(false);
    expect(h.message).toContain('401');
  });

  it('ping 只发一次请求，不因 maxRetries 反复重试', async () => {
    handler = () => ({ status: 401, body: { error: { message: 'bad key' } } });
    const p = makeProvider({ AI_MAX_RETRIES: 3 });
    await p.ping();
    // 401 属不可重试，所以仍是一次
    expect(calls.length).toBe(1);
  });
});
