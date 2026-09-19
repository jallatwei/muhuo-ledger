import { Global, Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';
import { MockAiProvider } from './mock.provider';
import { OpenAiCompatProvider } from './openai-compat.provider';
import type { AiProvider } from './ai-provider.interface';
import type { Env } from '../../config/env';

/**
 * AI 适配层模块
 * ============================================================
 * 按 AI_PROVIDER 环境变量选择实现：
 *   mock               → MockAiProvider（离线、零成本、结果确定）
 *   openai-compatible  → OpenAiCompatProvider（覆盖 DeepSeek/Qwen-VL/豆包/GLM/Ollama/vLLM）
 *   local              → 预留（未来的本地专用模型）
 *
 * ★ 上层只依赖 AiProvider 接口，换服务商不改业务代码。
 */
@Global()
@Module({
  providers: [
    MockAiProvider,
    OpenAiCompatProvider,
    {
      provide: 'AI_PROVIDER',
      inject: [ConfigService, MockAiProvider, OpenAiCompatProvider],
      useFactory: (
        config: ConfigService,
        mock: MockAiProvider,
        compat: OpenAiCompatProvider,
      ): AiProvider => {
        const logger = new Logger('AiProviderFactory');
        const env = config.get<Env>('env') as Env;

        switch (env.AI_PROVIDER) {
          case 'openai-compatible':
            logger.log(
              `AI 识图使用 OpenAI 兼容 Provider：${env.AI_BASE_URL || '(未配置 BASE_URL)'} / ${
                env.AI_VISION_MODEL || '(未配置视觉模型)'
              }`,
            );
            return compat;
          case 'local':
            logger.warn('AI_PROVIDER=local 尚未实现，暂时回退到 mock');
            return mock;
          case 'mock':
          default:
            logger.log('AI 识图使用 Mock Provider：离线运行，返回固定样例，不消耗任何 API 额度');
            return mock;
        }
      },
    },
    AiService,
  ],
  exports: ['AI_PROVIDER', AiService],
})
export class AiModule {}
