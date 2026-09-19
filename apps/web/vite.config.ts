import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';

export default defineConfig({
  plugins: [
    vue(),
    /*
     * Element Plus 按需引入。
     *
     * ★ dev 下必须关掉 importStyle —— 否则主题配色在开发态整体失效。
     *
     *   组件解析器默认会为每个用到的组件注入它自己的样式（importStyle: 'css'），
     *   而那是**运行时**注入，时机晚于 main.ts 里的 `import 'element-plus/dist/index.css'`。
     *   于是开发态下 --el-color-primary 的最终声明来自 Element Plus（#409eff），
     *   把 styles/theme.css 里的木绿主色压掉 —— 按钮、tag、开关全是默认蓝。
     *   生产构建里两者在打包期按 import 顺序落盘，顺序正确，所以 dist 是好的。
     *   「同一份 CSS 只在 dev 坏」这种问题最难查，实测用 CDP 查
     *   document.styleSheets 才定位到。
     *
     *   关掉 importStyle 之后，dev 与 prod 都只保留 main.ts 那一次全量引入，
     *   顺序与生产一致（Element Plus → theme.css → global.css）。
     *   代价是 dev 内存里多一份全量 CSS —— 构建产物不受影响（本来就是全量引入）。
     *
     *   真实收益是判据可靠：dev 下看到什么颜色，dist 里就是什么颜色。
     */
    AutoImport({ resolvers: [ElementPlusResolver({ importStyle: false })] }),
    Components({ resolvers: [ElementPlusResolver({ importStyle: false })] }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // ★ 直接指向 shared 源码，而不是 dist：
      //   前端改 shared 后无需先构建就能热更新，也避免 dist 过期导致
      //   "is not exported by dist/index.js" 这类假错误。
      '@bookkeeper/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT ?? 5173),
    // 容器内热重载需要轮询（Windows 宿主机挂载卷不触发 inotify）
    watch: { usePolling: true, interval: 300 },
    proxy: {
      // 开发态把 /api 代理到后端，避免 CORS 与地址硬编码
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
