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
    AI_BASE_URL: 'https://api.xiaomimimo.com/v1',
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
