<script setup lang="ts">
/**
 * 新用户注册
 * ============================================================
 * 一个页面承担两种注册形态，靠「是否同时建公司」切换：
 *
 *   · 个人自用 —— 只建账号，之后再决定开不开公司
 *   · 公司/团队 —— 建账号 + 建主体 + 建账套（科目表 + 12 个会计期间）
 *
 * ★ 一个反直觉但重要的点：系统里**第一个**注册的人会成为平台管理员。
 *   不这样做的系统装好后没有任何人能管理成员，等于把自己锁在门外。
 *   这一点必须写在界面上，否则这个账号的实际权限会出乎用户意料。
 *
 * ★ 注册即登录（后端直接返回令牌），不需要再走一次登录 ——
 *   注册完还要登录一次是纯粹的摩擦。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { authApi, toastError } from '@/api';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

const formRef = ref();
const submitting = ref(false);

const info = ref<{
  isFirstUser: boolean;
  userCount: number;
  note: string;
  roles: Array<{ value: string; label: string; actions: string[] }>;
} | null>(null);

const form = reactive({
  email: '',
  password: '',
  confirmPassword: '',
  displayName: '',
  phone: '',
  accountType: 'PERSONAL' as 'PERSONAL' | 'COMPANY_STAFF',
  withCompany: false,
  companyName: '',
  unifiedSocialCreditCode: '',
  taxpayerType: 'GENERAL' as 'GENERAL' | 'SMALL_SCALE',
  legalPerson: '',
  startYear: new Date().getFullYear(),
});

const roleLabels = computed(() =>
  (info.value?.roles ?? []).map((r) => `${r.label}（${r.actions.length} 项权限）`).join(' · '),
);

/** 密码强度：只做"太短/纯数字"这两条硬拦，与后端口径一致 */
const passwordHint = computed(() => {
  const p = form.password;
  if (!p) return '';
  if (p.length < 8) return `还差 ${8 - p.length} 位`;
  if (/^\d+$/.test(p)) return '不能是纯数字';
  return '';
});

const rules = {
  email: [
    { required: true, message: '请填写邮箱', trigger: 'blur' },
    { type: 'email' as const, message: '邮箱格式不正确，应形如 name@example.com', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请设置密码', trigger: 'blur' },
    {
      validator: (_r: unknown, v: string, cb: (e?: Error) => void) => {
        if (!v || v.length < 8) return cb(new Error('密码至少 8 位'));
        if (/^\d+$/.test(v)) return cb(new Error('密码不能是纯数字 —— 纯数字几秒就能被穷举'));
        cb();
      },
      trigger: 'blur',
    },
  ],
  confirmPassword: [
    {
      validator: (_r: unknown, v: string, cb: (e?: Error) => void) => {
        if (v !== form.password) return cb(new Error('两次输入的密码不一致'));
        cb();
      },
      trigger: 'blur',
    },
  ],
  displayName: [{ required: true, message: '请填写称呼（会显示在凭证的制单人处）', trigger: 'blur' }],
  companyName: [
    {
      validator: (_r: unknown, v: string, cb: (e?: Error) => void) => {
        if (form.withCompany && !v?.trim()) return cb(new Error('请填写公司名称'));
        cb();
      },
      trigger: 'blur',
    },
  ],
};

onMounted(async () => {
  if (!auth.resolved) await auth.restore();
  if (auth.isLoggedIn) {
    await router.replace(auth.needsCompany ? '/register/company' : '/dashboard');
    return;
  }
  try {
    info.value = await authApi.registrationInfo();
  } catch (e) {
    toastError(e);
  }
});

async function submit(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;

  submitting.value = true;
  try {
    const res = await auth.register({
      email: form.email.trim(),
      password: form.password,
      displayName: form.displayName.trim(),
      phone: form.phone.trim() || undefined,
      accountType: form.withCompany ? 'COMPANY_STAFF' : 'PERSONAL',
      company: form.withCompany
        ? {
            name: form.companyName.trim(),
            unifiedSocialCreditCode: form.unifiedSocialCreditCode.trim() || undefined,
            taxpayerType: form.taxpayerType,
            legalPerson: form.legalPerson.trim() || undefined,
            startYear: form.startYear,
          }
        : undefined,
    });

    ElMessage.success(
      form.withCompany
        ? `注册成功，公司「${res.memberships[0]?.entityName ?? form.companyName}」的账套已建好`
        : '注册成功',
    );
    await router.replace(form.withCompany ? '/dashboard' : '/register/company');
  } catch (e) {
    toastError(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @keyup.enter="submit">
    <el-alert
      v-if="info"
      :type="info.isFirstUser ? 'warning' : 'info'"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    >
      <template #title>{{ info.isFirstUser ? '这是系统的第一个账号' : '注册说明' }}</template>
      <div class="bk-hint">{{ info.note }}</div>
    </el-alert>

    <el-row :gutter="12">
      <el-col :span="12">
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="form.email" placeholder="name@example.com" autocomplete="username" />
        </el-form-item>
      </el-col>
      <el-col :span="12">
        <el-form-item label="称呼" prop="displayName">
          <el-input v-model="form.displayName" placeholder="如：张三" />
        </el-form-item>
      </el-col>
    </el-row>

    <el-row :gutter="12">
      <el-col :span="12">
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="至少 8 位"
            autocomplete="new-password"
            show-password
          />
          <div v-if="passwordHint" class="hint-warn">{{ passwordHint }}</div>
        </el-form-item>
      </el-col>
      <el-col :span="12">
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            placeholder="再输一次"
            autocomplete="new-password"
            show-password
          />
        </el-form-item>
      </el-col>
    </el-row>

    <el-form-item label="手机号（选填，仅用于联系）">
      <el-input v-model="form.phone" placeholder="11 位手机号" maxlength="20" />
    </el-form-item>

    <el-divider content-position="left">
      <span style="font-size: 13px">公司账套</span>
    </el-divider>

    <el-form-item>
      <el-switch
        v-model="form.withCompany"
        active-text="同时创建公司并建好账套"
        inactive-text="只建账号（之后再开公司）"
      />
    </el-form-item>

    <template v-if="form.withCompany">
      <el-form-item label="公司名称" prop="companyName">
        <el-input v-model="form.companyName" placeholder="与营业执照一致的全称" />
      </el-form-item>

      <el-row :gutter="12">
        <el-col :span="12">
          <el-form-item label="纳税人身份">
            <el-radio-group v-model="form.taxpayerType">
              <el-radio-button value="GENERAL">一般纳税人</el-radio-button>
              <el-radio-button value="SMALL_SCALE">小规模</el-radio-button>
            </el-radio-group>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="账套启用年度">
            <el-input-number v-model="form.startYear" :min="2000" :max="2100" style="width: 100%" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item label="统一社会信用代码（选填，报税时要用）">
        <el-input v-model="form.unifiedSocialCreditCode" placeholder="18 位" maxlength="18" />
      </el-form-item>

      <el-form-item label="法定代表人（选填）">
        <el-input v-model="form.legalPerson" placeholder="如：张三" />
      </el-form-item>

      <el-alert type="success" :closable="false" style="margin-bottom: 16px">
        <div class="bk-hint">
          提交后会一次性完成：建主体 → 建小企业会计准则科目表（约 138 个科目）→
          建 {{ form.startYear }} 年 12 个会计期间 → 把你设为该公司的<strong>实控人</strong>。
          中途失败会整体回滚，不会留下"有公司没科目表"的废主体。
        </div>
      </el-alert>
    </template>

    <el-button type="primary" size="large" style="width: 100%" :loading="submitting" @click="submit">
      {{ form.withCompany ? '注册并创建公司' : '注册账号' }}
    </el-button>

    <div class="links">
      <router-link to="/login">已有账号？去登录</router-link>
      <span v-if="roleLabels" class="bk-hint" :title="roleLabels">成员角色：实控人 / 会计 / 只读</span>
    </div>
  </el-form>
</template>

<style scoped>
.links {
  display: flex;
  justify-content: space-between;
  align-items: center;
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

.hint-warn {
  font-size: 12px;
  color: var(--bk-danger);
  line-height: 1.8;
}
</style>
