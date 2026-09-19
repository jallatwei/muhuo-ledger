<script setup lang="ts">
/**
 * 入口页
 * ============================================================
 * 只做一件事：等身份确认完，然后把人送到该去的地方。
 *
 * ★ 为什么不直接在路由表里写 `redirect: '/dashboard'`：
 *   `/dashboard` 是受保护路由，未登录时守卫会把用户弹到 /login，
 *   于是访问 `/` 的人会经历一次"先跳到总览、又被踢回登录页"的闪烁。
 *   在这里等 restore() 完成再决定，全程只跳一次。
 */
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

onMounted(async () => {
  if (!auth.resolved) await auth.restore();

  if (!auth.isLoggedIn) {
    await router.replace('/login');
  } else if (auth.needsCompany) {
    await router.replace('/register/company');
  } else {
    await router.replace('/dashboard');
  }
});
</script>

<template>
  <div class="splash" v-loading="true" element-loading-text="正在确认登录状态…"></div>
</template>

<style scoped>
.splash {
  height: 100vh;
  background: var(--bk-page-bg);
}
</style>
