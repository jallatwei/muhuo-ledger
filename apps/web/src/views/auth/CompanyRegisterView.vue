<script setup lang="ts">
/**
 * 公司注册 + 账套注册
 * ============================================================
 * 这两件事在本系统里是**同一次操作**，刻意不拆成两个页面：
 *
 *   「建主体」和「建账套」如果分两步，中间必然出现
 *   "有公司、但没科目表/没会计期间"的中间状态 ——
 *   那时用户点任何菜单都会报错，而且他不知道自己还差一步。
 *   后端也是放在同一个事务里做的，前端自然应当一次问完。
 *
 * 三步走，但只有第 2 步真的写库：
 *   ① 主体信息（营业执照口径）
 *   ② 账套设置（启用年度、纳税人身份）→ 这一步提交
 *   ③ 完成：给出接下来该做什么
 *
 * ★ 对于账下一家公司都没有的用户（首次注册、或注册时没勾建公司），
 *   这个页面是必经之路，所以不提供"跳过"。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { toastError } from '@/api';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

const step = ref(0);
const formRef = ref();
const formRef2 = ref();
const submitting = ref(false);
const created = ref<{ entityId: string; entityName: string } | null>(null);

const form = reactive({
  name: '',
  unifiedSocialCreditCode: '',
  taxpayerType: 'GENERAL' as 'GENERAL' | 'SMALL_SCALE',
  legalPerson: '',
  address: '',
  phone: '',
  startYear: new Date().getFullYear(),
});

/** 名下一家公司都没有 → 这是必经之路，不给"稍后再说" */
const isMandatory = computed(() => auth.memberships.length === 0);

const rules = {
  name: [{ required: true, message: '请填写公司名称（与营业执照一致）', trigger: 'blur' }],
  unifiedSocialCreditCode: [
    {
      validator: (_r: unknown, v: string, cb: (e?: Error) => void) => {
        // 选填；填了就要像 —— 它是报税时的纳税人识别号，写错会导致申报表对不上
        if (v && !/^[0-9A-HJ-NPQRTUWXY]{18}$/i.test(v.trim())) {
          return cb(new Error('统一社会信用代码应为 18 位（数字与大写字母，不含 I O S V Z）'));
        }
        cb();
      },
      trigger: 'blur',
    },
  ],
  startYear: [{ required: true, message: '请选择账套启用年度', trigger: 'change' }],
};

onMounted(async () => {
  if (!auth.resolved) await auth.restore();
  if (!auth.isLoggedIn) {
    await router.replace('/login?redirect=/register/company');
  }
});

async function next(): Promise<void> {
  // 第 ① 步只校验主体信息，通过后进第 ② 步，不直接建
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  step.value = 1;
}

async function submit(): Promise<void> {
  // ★ 两个 el-form 各挂各的 ref，所以两边都要校验。
  //   只校验可见的那个会漏掉另一步的必填项 —— 而那些字段是建账套要用的。
  const ok2 = await formRef2.value?.validate().catch(() => false);
  if (!ok2) return;
  const ok1 = await formRef.value?.validate().catch(() => false);
  if (!ok1) return;

  submitting.value = true;
  try {
    const res = await auth.registerEntity({
      name: form.name.trim(),
      unifiedSocialCreditCode: form.unifiedSocialCreditCode.trim() || undefined,
      taxpayerType: form.taxpayerType,
      legalPerson: form.legalPerson.trim() || undefined,
      address: form.address.trim() || undefined,
      phone: form.phone.trim() || undefined,
      startYear: form.startYear,
    });
    created.value = res;
    step.value = 2;
    ElMessage.success(`公司「${res.entityName}」与账套已创建`);
  } catch (e) {
    toastError(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="company">
    <el-steps :active="step" simple style="margin-bottom: 20px">
      <el-step title="主体信息" />
      <el-step title="账套设置" />
      <el-step title="完成" />
    </el-steps>

    <!-- ── ① 主体信息 ─────────────────────────────────── -->
    <!--
      ★ 两步各自独立的 el-form，不共用一个 ref。
        两个 el-form 挂同一个 ref 时后者会覆盖前者，validate() 只会校验到
        当前可见的那个，提交时另一步的字段就静默漏过去了。
    -->
    <el-form
      v-show="step === 0"
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      @keyup.enter="next"
    >
      <el-alert
        v-if="isMandatory"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      >
        <template #title>你还没有公司</template>
        <div class="bk-hint">
          记账必须先有核算主体 —— 凭证、科目表、报表都挂在主体下面。
          填完这一页就有账套可以开始录账了。
        </div>
      </el-alert>

      <el-form-item label="公司名称" prop="name">
        <el-input v-model="form.name" placeholder="与营业执照一致的全称" />
      </el-form-item>

      <el-form-item label="统一社会信用代码（选填）" prop="unifiedSocialCreditCode">
        <el-input v-model="form.unifiedSocialCreditCode" placeholder="18 位" maxlength="18" />
        <div class="bk-hint">
          报税时的纳税人识别号。现在不填也行，但<strong>申报前必须补上</strong>，
          否则申报表抬头对不上。
        </div>
      </el-form-item>

      <el-form-item label="法定代表人（选填）">
        <el-input v-model="form.legalPerson" placeholder="如：张三" />
      </el-form-item>

      <el-form-item label="注册地址（选填）">
        <el-input v-model="form.address" placeholder="用于判断城建税税率（市区 7% / 县镇 5%）" />
      </el-form-item>

      <el-form-item label="联系电话（选填）">
        <el-input v-model="form.phone" maxlength="20" />
      </el-form-item>

      <el-button type="primary" size="large" style="width: 100%" @click="next">下一步</el-button>
    </el-form>

    <!-- ── ② 账套设置 ─────────────────────────────────── -->
    <el-form
      v-show="step === 1"
      ref="formRef2"
      :model="form"
      :rules="rules"
      label-position="top"
    >
      <el-form-item label="纳税人身份">
        <el-radio-group v-model="form.taxpayerType">
          <el-radio-button value="GENERAL">一般纳税人</el-radio-button>
          <el-radio-button value="SMALL_SCALE">小规模纳税人</el-radio-button>
        </el-radio-group>
        <div class="bk-hint">
          一般纳税人按税率抵扣进项、增值税月报；小规模按征收率、多为季报。
          这个选择会影响申报底稿的算法，<strong>后期变更需要重新核对历史申报</strong>。
        </div>
      </el-form-item>

      <el-form-item label="账套启用年度" prop="startYear">
        <el-input-number v-model="form.startYear" :min="2000" :max="2100" style="width: 100%" />
        <div class="bk-hint">
          会为该年度建立 1–12 月的会计期间。启用之前的账（历史开票、已申报记录）
          走「历史数据导入 → 期初建账」，不在这里补录。
        </div>
      </el-form-item>

      <el-alert type="info" :closable="false" style="margin-bottom: 18px">
        <template #title>提交后会一次性完成</template>
        <div class="bk-hint" style="line-height: 2">
          · 建主体「{{ form.name || '（未命名）' }}」<br />
          · 建<strong>小企业会计准则</strong>科目表（约 138 个科目，含末级标记与报表行映射）<br />
          · 建 {{ form.startYear }} 年 12 个会计期间<br />
          · 把你设为该公司的<strong>实控人</strong>（全部权限）<br />
          全部在一个事务里，任一步失败都会整体回滚。
        </div>
      </el-alert>

      <div class="actions">
        <el-button size="large" @click="step = 0">上一步</el-button>
        <el-button type="primary" size="large" :loading="submitting" @click="submit">
          创建公司与账套
        </el-button>
      </div>

      <div v-if="!isMandatory" style="margin-top: 12px; text-align: center">
        <el-button link @click="router.push('/dashboard')">暂不创建，回到账上</el-button>
      </div>
    </el-form>

    <!-- ── ③ 完成 ─────────────────────────────────────── -->
    <div v-show="step === 2" class="done">
      <div class="done__head">
        <div class="done__title">「{{ created?.entityName ?? '' }}」已就绪</div>
        <div class="bk-hint">
          科目表与 {{ form.startYear }} 年会计期间已建好，你在这家公司是<strong>实控人</strong>。
        </div>
      </div>

      <div class="next-steps">
        <p><b>接下来通常做这两件事之一：</b></p>
        <ol>
          <li>
            <b>有历史账</b> → 走「历史数据导入」：导入已开发票、已勾选进项、税务年报，
            倒轧出启用前期末余额并<strong>人工确认</strong>后建账。
          </li>
          <li>
            <b>从零开始</b> → 直接去「识别录入」，把发票扫进来自动生成凭证草稿，审核过账即可。
          </li>
        </ol>
      </div>

      <div class="actions" style="margin-top: 18px">
        <el-button size="large" @click="router.push('/vouchers/recognition')">去识别录入</el-button>
        <el-button type="primary" size="large" @click="router.push('/dashboard')">进入总览</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.company {
  min-width: 0;
}

.actions {
  display: flex;
  gap: 10px;
}

.actions .el-button {
  flex: 1;
}

.done {
  text-align: left;
}

.done__head {
  padding-bottom: 14px;
  border-bottom: 1px solid var(--bk-line-2);
}

.done__title {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--bk-ok);
}

.next-steps {
  text-align: left;
  font-size: 13px;
  line-height: 1.9;
  color: var(--bk-ink-2);
  background: var(--bk-page-bg);
  border: 1px solid var(--bk-line);
  border-radius: 6px;
  padding: 14px 16px;
  margin-top: 8px;
}

.next-steps ol {
  margin: 8px 0 0;
  padding-left: 20px;
}

.next-steps li {
  margin-bottom: 8px;
}

.next-steps b {
  color: var(--bk-ink);
}
</style>
