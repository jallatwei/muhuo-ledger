<script setup lang="ts">
/**
 * 成员与账号
 * ============================================================
 * 两块内容，正好回答"谁能进这家公司"和"我自己怎么改密码"：
 *
 *   ① 成员列表 —— 谁能进这家公司、是什么角色；实控人可加人、改角色
 *   ② 我的账号 —— 改自己的密码、看自己在各家公司的身份
 *
 * ★ 为什么"加成员"只接受**已注册**邮箱：
 *   自动建号意味着实控人能用别人的邮箱开户，而对方毫不知情。
 *   正确流程是让对方先自己注册，再由实控人邀请进来。
 *
 * ★ 为什么"最后一个实控人不能降级"：
 *   降了就再也没人能管成员，公司变成谁也改不动的僵尸主体。
 *   后端拦了，界面也要提前把按钮禁掉并说明原因，免得用户白点一次。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { authApi, toastError, type MemberListResult } from '@/api';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';

const app = useAppStore();
const auth = useAuthStore();

const data = ref<MemberListResult | null>(null);
const loading = ref(false);

const addVisible = ref(false);
const addForm = reactive({ email: '', role: 'ACCOUNTANT' });
const adding = ref(false);

const pwdVisible = ref(false);
const pwdForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' });
const changing = ref(false);

const canManage = computed(() => !!data.value?.canManage);
const ownerCount = computed(
  () => data.value?.members.filter((m) => m.role === 'OWNER' && m.isActive).length ?? 0,
);

/** 操作说明：让用户知道每个角色到底能做什么，而不是只看名字猜 */
const ROLE_NOTE: Record<string, string> = {
  OWNER: '全部权限，含改公司信息、加人与删除公司',
  ACCOUNTANT: '记账、审核、过账、结账、报税；不能改公司信息、不能加人',
  VIEWER: '只能看账、看报表、打印，不能做任何写操作',
};

async function load(): Promise<void> {
  const entityId = app.currentEntityId || auth.currentEntityId;
  if (!entityId) return;
  loading.value = true;
  try {
    data.value = await authApi.members(entityId);
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function submitAdd(): Promise<void> {
  if (!addForm.email.trim()) {
    ElMessage.warning('请填写对方的注册邮箱');
    return;
  }
  const entityId = data.value?.entityId;
  if (!entityId) return;

  adding.value = true;
  try {
    await authApi.addMember(entityId, addForm.email.trim(), addForm.role);
    ElMessage.success(`${addForm.email.trim()} 已加入`);
    addVisible.value = false;
    addForm.email = '';
    addForm.role = 'ACCOUNTANT';
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    adding.value = false;
  }
}

async function changeRole(m: MemberListResult['members'][number], role: string): Promise<void> {
  const entityId = data.value?.entityId;
  if (!entityId || role === m.role) return;

  // 最后一个实控人不能降级 —— 后端会拒，但让他先看到原因比白点一次好
  if (m.role === 'OWNER' && role !== 'OWNER' && ownerCount.value <= 1) {
    ElMessage.warning(
      '这是本公司唯一的实控人，不能降级 —— 否则就没有人能管理成员了。请先指定另一位实控人。',
    );
    return;
  }

  try {
    await ElMessageBox.confirm(
      `把 ${m.displayName}（${m.email}）的角色从「${m.roleLabel}」改为「${
        data.value?.roles.find((r) => r.value === role)?.label ?? role
      }」？`,
      '确认变更角色',
      { type: 'warning' },
    );
  } catch {
    return; // 用户取消
  }

  try {
    await authApi.changeMemberRole(entityId, m.membershipId, role);
    ElMessage.success('角色已变更');
    await load();
    // 改的可能是自己 —— 本地身份要跟着刷新，否则界面权限还是旧的
    if (m.userId === auth.user?.id) await auth.refresh();
  } catch (e) {
    toastError(e);
  }
}

async function submitPassword(): Promise<void> {
  if (!pwdForm.currentPassword || !pwdForm.newPassword) {
    ElMessage.warning('请填写当前密码与新密码');
    return;
  }
  if (pwdForm.newPassword !== pwdForm.confirmPassword) {
    ElMessage.warning('两次输入的新密码不一致');
    return;
  }
  if (pwdForm.newPassword.length < 8 || /^\d+$/.test(pwdForm.newPassword)) {
    ElMessage.warning('新密码至少 8 位，且不能是纯数字');
    return;
  }

  changing.value = true;
  try {
    await authApi.changePassword(pwdForm.currentPassword, pwdForm.newPassword);
    ElMessage.success('密码已修改。下次登录请用新密码');
    pwdVisible.value = false;
    pwdForm.currentPassword = '';
    pwdForm.newPassword = '';
    pwdForm.confirmPassword = '';
  } catch (e) {
    toastError(e);
  } finally {
    changing.value = false;
  }
}
</script>

<template>
  <div class="bk-page" v-loading="loading">
    <el-row :gutter="16">
      <!-- ── 成员 ──────────────────────────────────────── -->
      <el-col :span="16">
        <div class="bk-card">
          <div class="bk-card__title">
            <span>「{{ data?.entityName ?? '—' }}」的成员</span>
            <span class="bk-hint">
              我的身份：{{ data?.myRoleLabel ?? '—' }}
              <template v-if="!canManage">（只有实控人能加人与改角色）</template>
            </span>
          </div>

          <el-table :data="data?.members ?? []" size="small" border>
            <el-table-column label="成员" min-width="180">
              <template #default="{ row }">
                <div class="member">
                  <b>{{ row.displayName }}</b>
                  <span v-if="row.userId === data?.selfUserId" class="self-tag">（我）</span>
                  <div class="bk-hint">{{ row.email }}</div>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="角色" width="180">
              <template #default="{ row }">
                <el-select
                  v-if="canManage"
                  :model-value="row.role"
                  size="small"
                  style="width: 100%"
                  @update:model-value="(v: string) => changeRole(row, v)"
                >
                  <el-option
                    v-for="r in data?.roles ?? []"
                    :key="r.value"
                    :label="r.label"
                    :value="r.value"
                  />
                </el-select>
                <el-tag v-else size="small" effect="plain">{{ row.roleLabel }}</el-tag>
              </template>
            </el-table-column>

            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.isActive ? 'success' : 'info'" effect="plain">
                  {{ row.isActive ? '正常' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>

            <el-table-column label="加入时间" width="120">
              <template #default="{ row }">
                <span class="bk-mono">{{ String(row.createdAt).slice(0, 10) }}</span>
              </template>
            </el-table-column>
          </el-table>

          <div class="actions">
            <el-button type="primary" :disabled="!canManage" @click="addVisible = true">
              邀请成员
            </el-button>
            <el-button @click="load">刷新</el-button>
            <span v-if="!canManage" class="bk-hint" style="align-self: center">
              邀请成员与调整角色需要「实控人」权限
            </span>
          </div>
        </div>

        <div class="bk-card">
          <div class="bk-card__title">角色权限说明</div>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item
              v-for="r in data?.roles ?? []"
              :key="r.value"
              :label="r.label"
            >
              <div>{{ ROLE_NOTE[r.value] }}</div>
            </el-descriptions-item>
          </el-descriptions>
          <div class="bk-hint" style="margin-top: 10px">
            权限<strong>按公司分别授予</strong>：同一个人在这家公司是会计，在另一家可能是实控人。
            切换公司与换一套身份是同一件事。
          </div>
        </div>
      </el-col>

      <!-- ── 我的账号 ──────────────────────────────────── -->
      <el-col :span="8">
        <div class="bk-card">
          <div class="bk-card__title">我的账号</div>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="称呼">{{ auth.user?.displayName }}</el-descriptions-item>
            <el-descriptions-item label="邮箱">{{ auth.user?.email }}</el-descriptions-item>
            <el-descriptions-item label="账号性质">
              {{ auth.user?.accountType === 'COMPANY_STAFF' ? '企业员工' : '个人自用' }}
            </el-descriptions-item>
            <el-descriptions-item label="平台管理员">
              {{ auth.user?.isPlatformAdmin ? '是（可跨主体排障）' : '否' }}
            </el-descriptions-item>
          </el-descriptions>

          <div class="actions">
            <el-button @click="pwdVisible = true">修改密码</el-button>
            <el-button type="danger" plain @click="auth.logoutAndRedirect()">退出登录</el-button>
          </div>
        </div>

        <div class="bk-card">
          <div class="bk-card__title">我名下的公司</div>
          <div v-if="auth.memberships.length === 0" class="bk-hint">还没有公司</div>
          <div v-for="m in auth.memberships" :key="m.entityId" class="entity-row">
            <div>
              <b>{{ m.entityName }}</b>
              <div class="bk-hint">{{ m.roleLabel }} · {{ m.actions.length }} 项权限</div>
            </div>
            <el-button
              v-if="m.entityId !== auth.currentEntityId"
              size="small"
              @click="auth.selectEntity(m.entityId); $router.push('/dashboard')"
            >
              切换
            </el-button>
            <el-tag v-else size="small" type="success" effect="plain">当前</el-tag>
          </div>

          <div class="actions">
            <el-button type="primary" plain @click="$router.push('/register/company')">
              再开一家公司
            </el-button>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- ── 邀请成员 ──────────────────────────────────────── -->
    <el-dialog v-model="addVisible" title="邀请成员" width="440px">
      <el-alert type="info" :closable="false" style="margin-bottom: 16px">
        <div class="bk-hint">
          只能邀请<strong>已经自己注册过</strong>的邮箱。系统不会替别人创建账号 ——
          否则就等于你能拿别人的邮箱开户，而对方毫不知情。
        </div>
      </el-alert>

      <el-form label-position="top">
        <el-form-item label="对方的注册邮箱">
          <el-input v-model="addForm.email" placeholder="name@example.com" />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="addForm.role">
            <el-radio-button v-for="r in data?.roles ?? []" :key="r.value" :value="r.value">
              {{ r.label }}
            </el-radio-button>
          </el-radio-group>
          <div class="bk-hint">{{ ROLE_NOTE[addForm.role] }}</div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" :loading="adding" @click="submitAdd">加入成员</el-button>
      </template>
    </el-dialog>

    <!-- ── 修改密码 ──────────────────────────────────────── -->
    <el-dialog v-model="pwdVisible" title="修改密码" width="420px">
      <el-form label-position="top" @keyup.enter="submitPassword">
        <el-form-item label="当前密码">
          <el-input v-model="pwdForm.currentPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="pwdForm.newPassword" type="password" show-password />
          <div class="bk-hint">至少 8 位，不能是纯数字。一句只有你记得住的话比复杂组合更安全。</div>
        </el-form-item>
        <el-form-item label="再输一次新密码">
          <el-input v-model="pwdForm.confirmPassword" type="password" show-password />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="pwdVisible = false">取消</el-button>
        <el-button type="primary" :loading="changing" @click="submitPassword">确认修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.member b {
  font-size: 13px;
}

.self-tag {
  font-size: 12px;
  color: var(--bk-fire-600);
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.entity-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px dashed var(--bk-line);
  font-size: 13px;
}

.entity-row:last-of-type {
  border-bottom: none;
}
</style>
