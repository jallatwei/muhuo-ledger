/**
 * 环境配置测试
 * ============================================================
 * 只测一件事：**AI 密钥的口径必须唯一**。
 *
 * 起因是一次真实的自摆乌龙：provider 取 key 的优先级是
 * `MIMO_API_KEY || AI_API_KEY`，而 describeAiConfig 的健康自检只看 AI_API_KEY。
 * 结果用户按 MiMo 控制台把密钥填进 MIMO_API_KEY 之后，/api/health 照样报
 * 「AI_API_KEY 未配置，云端模型服务会拒绝请求」—— 而它出现的位置恰好是
 * 「接入模型」这个最需要准确反馈的步骤，等于把人往错误方向指。
 * 这类"两边各写一份判断逻辑"的分叉靠人眼 review 很容易漏，所以用测试钉住。
 */
import { describe, expect, it } from 'vitest';

import { describeAiConfig, resolveAiApiKey, type Env } from '../env';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI_PROVIDER: 'openai-compatible',
    AI_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1',
    AI_VISION_MODEL: 'mimo-v2.5',
    AI_TEXT_MODEL: 'mimo-v2.5',
    AI_API_KEY: '',
    MIMO_API_KEY: '',
    ...overrides,
  } as Env;
}

describe('resolveAiApiKey', () => {
  it('MIMO_API_KEY 优先于 AI_API_KEY', () => {
    expect(resolveAiApiKey({ MIMO_API_KEY: 'mimo', AI_API_KEY: 'generic' })).toBe('mimo');
  });

  it('MIMO_API_KEY 为空时回退到 AI_API_KEY（其他兼容服务商走这个）', () => {
    expect(resolveAiApiKey({ MIMO_API_KEY: '', AI_API_KEY: 'generic' })).toBe('generic');
  });

  it('两个都为空时返回空串（本地模型服务无需密钥）', () => {
    expect(resolveAiApiKey({ MIMO_API_KEY: '', AI_API_KEY: '' })).toBe('');
  });
});

describe('describeAiConfig 的密钥告警', () => {
  it('只填了 MIMO_API_KEY 时**不得**再报密钥未配置（回归：曾经的假告警）', () => {
    const { warnings } = describeAiConfig(makeEnv({ MIMO_API_KEY: 'mimo' }));
    expect(warnings.filter((w) => w.includes('密钥'))).toEqual([]);
  });

  it('MIMO_API_KEY 有值时也不得报 AI_API_KEY 未配置（同一个坑的另一面）', () => {
    const { warnings } = describeAiConfig(makeEnv({ MIMO_API_KEY: 'mimo' }));
    expect(warnings.some((w) => w.includes('AI_API_KEY'))).toBe(false);
  });

  it('确实两个都没配、且指向远端时，告警要把两个变量名都列出来', () => {
    const { warnings } = describeAiConfig(makeEnv());
    const hit = warnings.find((w) => w.includes('密钥'));
    expect(hit).toBeDefined();
    expect(hit).toContain('MIMO_API_KEY');
    expect(hit).toContain('AI_API_KEY');
  });

  it('指向本地模型服务时不报密钥告警（Ollama 之类本来就不校验）', () => {
    const { warnings } = describeAiConfig(makeEnv({ AI_BASE_URL: 'http://localhost:11434/v1' }));
    expect(warnings.some((w) => w.includes('密钥'))).toBe(false);
  });

  it('AI_PROVIDER=mock 时直接短路，不产生任何告警', () => {
    const { warnings, summary } = describeAiConfig(makeEnv({ AI_PROVIDER: 'mock', MIMO_API_KEY: '' }));
    expect(warnings).toEqual([]);
    expect(summary).toContain('mock');
  });
});

describe('describeAiConfig 的深度思考告警', () => {
  // ★ 开启深度思考的两个副作用都是**静默**的：不报错，只是结果变差。
  //   MiMo 官方文档：思考模式下 mimo-v2.5 / mimo-v2.5-pro 不支持自定义
  //   temperature 与 top_p，传入也会被强制成 1.0 / 0.95。
  //   也就是说 AI_TEMPERATURE=0 会被无声忽略，同一张票两次识别可能不一致 ——
  //   这种"偶发不一致"在记账场景里极难排查，所以必须在 /api/health 里点出来。
  it('AI_THINKING_ENABLED=true 时告警要点明 temperature 被忽略', () => {
    const { warnings } = describeAiConfig(makeEnv({ MIMO_API_KEY: 'k', AI_THINKING_ENABLED: true }));
    const hit = warnings.find((w) => w.includes('AI_THINKING_ENABLED'));
    expect(hit).toBeDefined();
    expect(hit).toContain('temperature');
    expect(hit).toContain('1.0');
  });

  it('AI_THINKING_ENABLED=true 时告警也要提到截断风险', () => {
    const { warnings } = describeAiConfig(makeEnv({ MIMO_API_KEY: 'k', AI_THINKING_ENABLED: true }));
    const hit = warnings.find((w) => w.includes('AI_THINKING_ENABLED'))!;
    expect(hit).toContain('截断');
  });

  it('AI_THINKING_ENABLED=false（默认）时没有这条告警', () => {
    const { warnings } = describeAiConfig(makeEnv({ MIMO_API_KEY: 'k', AI_THINKING_ENABLED: false }));
    expect(warnings.some((w) => w.includes('AI_THINKING_ENABLED'))).toBe(false);
  });
});

describe('describeAiConfig 的 configured / label（顶栏徽标依赖它）', () => {
  /*
   * ★ 这两个字段是给界面顶栏用的，起因是一个真实的 UI bug：
   *   徽标原先判断 `ai.reachable`，而 /health 根本不返回这个字段
   *   （只有 /api/ai/health 有，且它要真调一次模型、约 5.8 秒）。
   *   结果是**任何非 mock 的 provider 都显示「AI: 不可用」**，
   *   哪怕模型完全正常。改用"配置齐备"这个廉价信号。
   */

  it('mock：算配置齐备，标签是 Mock（离线）', () => {
    const d = describeAiConfig(makeEnv({ AI_PROVIDER: 'mock', MIMO_API_KEY: '' }));
    expect(d.configured).toBe(true);
    expect(d.label).toBe('Mock（离线）');
  });

  it('openai-compatible 且 key/baseUrl/模型齐全 → configured=true，标签用视觉模型名', () => {
    const d = describeAiConfig(makeEnv({ MIMO_API_KEY: 'k' }));
    expect(d.configured).toBe(true);
    expect(d.label).toBe('mimo-v2.5');
  });

  it('缺密钥 → configured=false（界面应显示「未配置」）', () => {
    const d = describeAiConfig(makeEnv({ MIMO_API_KEY: '', AI_API_KEY: '' }));
    expect(d.configured).toBe(false);
  });

  it('缺 baseUrl / 视觉模型名 → configured=false', () => {
    expect(describeAiConfig(makeEnv({ MIMO_API_KEY: 'k', AI_BASE_URL: '' })).configured).toBe(false);
    expect(describeAiConfig(makeEnv({ MIMO_API_KEY: 'k', AI_VISION_MODEL: '' })).configured).toBe(false);
  });

  it('★ 开了深度思考只是"有风险"，不能算成"未配置"', () => {
    // 把"配置缺失"和"配置有风险"混成一个列表是个很容易犯的错：
    // 一旦混了，用户只是打开了思考开关，顶栏就会红着脸说"AI 未配置"，
    // 而实际上模型好得很 —— 会把人引去查一个不存在的问题。
    const d = describeAiConfig(makeEnv({ MIMO_API_KEY: 'k', AI_THINKING_ENABLED: true }));
    expect(d.warnings.some((w) => w.includes('AI_THINKING_ENABLED'))).toBe(true);
    expect(d.configured).toBe(true);
  });

  it('本地模型地址（localhost）没有密钥也算配置齐备', () => {
    const d = describeAiConfig(
      makeEnv({ AI_BASE_URL: 'http://localhost:11434/v1', MIMO_API_KEY: '', AI_API_KEY: '' }),
    );
    expect(d.configured).toBe(true);
  });
});