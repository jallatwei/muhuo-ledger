import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // 领域层是纯逻辑测试，不需要数据库，跑得快
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bookkeeper/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
