import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';

// 样式引入顺序很重要：
//   1. Element Plus 默认样式
//   2. 主题变量覆盖（必须在 1 之后，否则 :root 变量会被默认值压掉）
//   3. 全局业务样式（依赖主题变量）
import 'element-plus/dist/index.css';
import './styles/theme.css';
import './styles/global.css';

import App from './App.vue';
import { router } from './router';

// ★ 在挂载之前先把本地缓存的主题应用到 :root，
//   否则刷新时会先闪一下默认色，再跳到用户配色。
import { usePreferencesStore } from './stores/preferences';

const app = createApp(App);

app.use(createPinia());

// pinia 装好之后、挂载之前应用缓存
usePreferencesStore().applyLocalCache();

app.use(router);
app.use(ElementPlus, { locale: zhCn });

app.mount('#app');
