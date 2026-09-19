<script setup lang="ts">
/**
 * 页面登录
 * ============================================================
 * 三件刻意做的事：
 *
 *   ① 错误信息**不区分**「邮箱不存在」和「密码错误」——
 *      后端已经统一了，前端也不额外提示，避免泄露哪些邮箱注册过。
 *
 *   ② 登录后按身份分流，而不是无脑进总览：
 *        有公司 → 回 redirect 指定的页面（或总览）
 *        没有公司 → 直接去「公司注册」，否则进去也是一片"没有核算主体"
 *
 *   ③ 已登录的人误入 /login 时直接送走，不让他再登一次。
 */
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { toastError } from '@/api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const form = reactive({ email: '', password: '' });
const formRef = ref();
const submitting = ref(false);

const rules = {
  email: [
    { required: true, message: '请填写邮箱', trigger: 'blur' },
    { type: 'email' as const, message: '邮箱格式不正确，应形如 name@example.com', trigger: 'blur' },
  ],
  password: [{ required: true, message: '请填写密码', trigger: 'blur' }],
};

/** 从哪来的（登录后跳回）；只接受站内路径，避免被拿来做跳转钓鱼 */
function safeRedirect(): string {
  const raw = route.query.redirect;
  const value = typeof raw === 'string' ? raw : '';
  if (!value) return '';
  if (!value.startsWith('/') || value.startsWith('//')) return '';
  return value;
}

onMounted(async () => {
  // 被 401 踢回来时说明令牌过期了，明确告诉用户原因，否则会以为是系统坏了
  if (route.query.reason === 'expired') {
    ElMessage({ type: 'warning', message: '登录已过期，请重新登录。', duration: 5000 });
  }
  if (!auth.resolved) await auth.restore();
  if (auth.isLoggedIn) {
    await router.replace(auth.needsCompany ? '/register/company' : safeRedirect() || '/dashboard');
  }
});

async function submit(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;

  submitting.value = true;
  try {
    const res = await auth.login(form.email.trim(), form.password);
    ElMessage.success(`欢迎回来，${res.user.displayName}`);
    await router.replace(auth.needsCompany ? '/register/company' : safeRedirect() || '/dashboard');
  } catch (e) {
    toastError(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-form
    ref="formRef"
    :model="form"
    :rules="rules"
    label-position="top"
    size="large"
    @keyup.enter="submit"
  >
    <el-form-item label="邮箱" prop="email">
      <el-input
        v-model="form.email"
        placeholder="name@example.com"
        autocomplete="username"
        clearable
      />
    </el-form-item>

    <el-form-item label="密码" prop="password">
      <el-input
        v-model="form.password"
        type="password"
        placeholder="请输入密码"
        autocomplete="current-password"
        show-password
      />
    </el-form-item>

    <el-button
      type="primary"
      size="large"
      style="width: 100%; margin-top: 4px"
      :loading="submitting"
      @click="submit"
    >
      登录
    </el-button>

    <div class="links">
      <router-link to="/register">还没有账号？注册</router-link>
      <router-link to="/register/company">已有账号，再开一家公司</router-link>
    </div>

    <el-alert type="info" :closable="false" style="margin-top: 20px">
      <div class="bk-hint">
        登录后只能看到<strong>你自己是成员</strong>的公司。
        账号权限按公司分别授予，换了公司就是另一套身份。
      </div>
    </el-alert>
  </el-form>
</template>

<style scoped>
.links {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
  font-size: 13px;
}

.links a {
  color: var(--bk-fire-600);
  text-decoration: none;
}

.links a:hover {
  text-decoration: underline;
}
</style>
