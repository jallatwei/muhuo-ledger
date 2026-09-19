<script setup lang="ts">
/**
 * 应用外壳（已登录后的所有页面）
 * ============================================================
 * 顶部固定显示：当前公司 · 当前期间 · 期间状态 · AI 模式 · 记账安全开关。
 * 这些信息直接关系到"会不会记错账"，不能藏在设置页里。
 *
 * ★ 公司切换放在顶栏右上角，与账号菜单并排：
 *   "我现在的身份"和"我看的是哪家公司"是同一件事的两面 ——
 *   换公司等于换角色，两者分开摆会让人以为权限是全局的。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/api';
import AppLogo from '@/components/AppLogo.vue';
import { usePreferencesStore } from '@/stores/preferences';

const store = useAppStore();
const auth = useAuthStore();
const prefs = usePreferencesStore();
const route = useRoute();
const router = useRouter();
const health = ref<Record<string, any> | null>(null);

const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '');
const parentTitle = computed(() => (route.meta.parent as string | undefined) ?? '');

const periodStatusText = computed(() => {
  const s = store.currentPeriod?.status;
  return s === 'OPEN' ? '未结账' : s === 'CLOSING' ? '结账中' : '已结账';
});

const periodStatusType = computed(() => {
  const s = store.currentPeriod?.status;
  return s === 'OPEN' ? 'success' : s === 'CLOSING' ? 'warning' : 'info';
});

const aiTag = computed(() => {
  const h = health.value;
  if (!h) return { text: 'AI 状态未知', type: 'info' as const };
  if (h.ai?.provider === 'mock') return { text: 'AI: Mock（离线）', type: 'info' as const };
  return h.ai?.reachable
    ? { text: `AI: ${h.ai.provider}`, type: 'success' as const }
    : { text: 'AI: 不可用', type: 'danger' as const };
});

/** 菜单项 —— 按角色权限过滤，没权限的干脆不显示（而不是点了才报 403） */
const menus = computed(() =>
  [
    { path: '/dashboard', label: '总览', action: 'READ' },
    { path: '/vouchers', label: '凭证', action: 'READ' },
    { path: '/warehouse', label: '发票仓库', action: 'READ' },
    { path: '/print', label: '凭证册打印', action: 'READ' },
    { path: '/accounts', label: '科目表', action: 'READ' },
    { path: '/tax', label: '税务填报', action: 'READ' },
    { path: '/audit', label: '账务自检', action: 'READ' },
    { path: '/members', label: '成员与账号', action: null },
    { path: '/appearance', label: '外观偏好', action: null },
  ].filter((m) => m.action === null || auth.can(m.action)),
);

const showEntryMenu = computed(() => auth.can('WRITE_VOUCHER') || auth.can('IMPORT_DOCUMENT'));

onMounted(async () => {
  // 先应用本地缓存（避免闪默认色），再从服务端拉全局偏好覆盖
  prefs.applyLocalCache();
  void prefs.load(auth.currentEntityId || undefined);

  await store.bootstrap();
  try {
    health.value = await api.health();
  } catch {
    health.value = null;
  }
});

/** 切换公司要重新拉期间与科目表 —— 否则界面还是上一家的数据 */
async function onEntityChange(id: string): Promise<void> {
  auth.selectEntity(id);
  await store.bootstrap();
  await router.push('/dashboard');
}

async function onUserCommand(cmd: string): Promise<void> {
  switch (cmd) {
    case 'members':
      await router.push('/members');
      break;
    case 'company':
      await router.push('/register/company');
      break;
    case 'logout':
      auth.logoutAndRedirect();
      break;
  }
}

// 令牌刷新后（例如在成员页被改了角色）同步一次外观偏好来源
watch(
  () => auth.currentEntityId,
  (id) => {
    if (id) void prefs.load(id);
  },
);
</script>

<template>
  <el-container style="height: 100%">
    <el-aside width="200px" class="aside">
      <AppLogo :size="34" />
      <el-menu
        :default-active="route.path"
        :default-openeds="['entry']"
        router
        class="aside__menu"
        background-color="transparent"
        text-color="var(--bk-aside-text)"
        active-text-color="#ffffff"
      >
        <el-menu-item index="/dashboard">
          <span>总览</span>
        </el-menu-item>
        <el-menu-item index="/vouchers">
          <span>凭证</span>
        </el-menu-item>
        <el-sub-menu v-if="showEntryMenu" index="entry">
          <template #title>
            <span>录入凭证</span>
          </template>
          <el-menu-item index="/vouchers/new">
            <span>手工录入</span>
          </el-menu-item>
          <el-menu-item index="/vouchers/recognition">
            <span>识别录入</span>
          </el-menu-item>
        </el-sub-menu>
        <el-menu-item index="/warehouse">
          <span>发票仓库</span>
        </el-menu-item>
        <el-menu-item index="/print">
          <span>凭证册打印</span>
        </el-menu-item>
        <el-menu-item index="/accounts">
          <span>科目表</span>
        </el-menu-item>
        <el-menu-item index="/tax">
          <span>税务填报</span>
        </el-menu-item>
        <el-menu-item index="/audit">
          <span>账务自检</span>
        </el-menu-item>
        <el-menu-item index="/members">
          <span>成员与账号</span>
        </el-menu-item>
        <el-menu-item index="/appearance">
          <span>外观偏好</span>
        </el-menu-item>
      </el-menu>

      <div class="aside__foot">
        <span class="bk-hint">{{ auth.currentRoleLabel || '—' }}</span>
      </div>
    </el-aside>

    <el-container>
      <el-header height="58px" class="topbar">
        <div class="topbar__left">
          <span v-if="parentTitle" class="topbar__parent">{{ parentTitle }} /</span>
          <span class="topbar__title">{{ pageTitle }}</span>

          <!-- 公司切换：换公司 = 换角色 -->
          <el-select
            v-if="auth.memberships.length"
            :model-value="auth.currentEntityId"
            size="small"
            style="width: 170px"
            @update:model-value="onEntityChange"
          >
            <el-option
              v-for="m in auth.memberships"
              :key="m.entityId"
              :label="`${m.entityName}（${m.roleLabel}）`"
              :value="m.entityId"
            />
          </el-select>

          <el-tag
            size="small"
            :type="store.currentEntity?.taxpayerType === 'GENERAL' ? 'warning' : 'success'"
            effect="plain"
          >
            {{ store.currentEntity?.taxpayerType === 'GENERAL' ? '一般纳税人' : '小规模纳税人' }}
          </el-tag>
        </div>

        <div class="topbar__right">
          <el-select
            v-if="store.periods.length"
            :model-value="store.currentPeriodId"
            size="small"
            style="width: 130px"
            @update:model-value="store.selectPeriod"
          >
            <el-option
              v-for="p in store.periods"
              :key="p.id"
              :label="`${p.fiscalYear}-${String(p.month).padStart(2, '0')}`"
              :value="p.id"
            />
          </el-select>

          <el-tag size="small" :type="periodStatusType" effect="dark">
            {{ periodStatusText }}
          </el-tag>

          <el-tag size="small" :type="aiTag.type" effect="plain">{{ aiTag.text }}</el-tag>

          <el-tooltip
            v-if="health?.bookkeeping"
            placement="bottom"
            :content="(health.bookkeeping.notes as string[]).join('　|　')"
          >
            <el-tag
              size="small"
              :type="health.bookkeeping.autoPost ? 'danger' : 'success'"
              effect="plain"
            >
              {{ health.bookkeeping.autoPost ? '⚠ 自动过账已开启' : '✓ 自动过账已关闭' }}
            </el-tag>
          </el-tooltip>

          <el-dropdown @command="onUserCommand">
            <span class="user">
              {{ auth.user?.displayName || '—' }} ▾
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>
                  {{ auth.user?.email }}
                </el-dropdown-item>
                <el-dropdown-item divided command="members">成员与账号</el-dropdown-item>
                <el-dropdown-item command="company">再开一家公司</el-dropdown-item>
                <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main style="padding: 0; overflow: auto">
        <el-alert
          v-if="store.bootError"
          type="error"
          :closable="false"
          show-icon
          style="margin: 16px"
        >
          <template #title>初始化失败</template>
          <div class="bk-hint">{{ store.bootError }}</div>
          <div style="margin-top: 10px">
            <el-button size="small" type="primary" @click="router.push('/register/company')">
              去创建公司账套
            </el-button>
            <el-button size="small" @click="store.bootstrap()">重试</el-button>
          </div>
        </el-alert>

        <router-view v-else />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
/* 侧边栏取深灰（近真灰，不带色相），刻意不用深蓝黑 —— 那是忌神方位色 */
.aside {
  background: var(--bk-aside-bg);
  border-right: 1px solid var(--bk-aside-bg-2);
  display: flex;
  flex-direction: column;
}

.aside__menu {
  border-right: none;
  flex: 1;
  padding-top: 6px;
}

.aside__foot {
  padding: 10px 16px;
  border-top: 1px solid var(--bk-aside-bg-2);
}

:deep(.el-menu-item) {
  height: 44px;
  line-height: 44px;
  margin: 2px 8px;
  border-radius: 6px;
}

:deep(.el-menu-item:hover) {
  background: rgb(217 90 43 / 14%) !important;
  color: #fff !important;
}

/* 二级菜单：子项缩进、字号略小 */
:deep(.el-sub-menu .el-menu-item) {
  min-width: auto;
  padding-left: 32px !important;
  font-size: 13px;
}

:deep(.el-sub-menu__title) {
  height: 44px;
  line-height: 44px;
  margin: 2px 8px;
  border-radius: 6px;
}

:deep(.el-sub-menu__title:hover) {
  background: rgb(170 93 70 / 14%) !important;
  color: #fff !important;
}

/* 选中项用主色实底 —— 全站唯一的强调色 */
:deep(.el-menu-item.is-active) {
  background: var(--bk-fire-500) !important;
  color: #fff !important;
  font-weight: 500;
  box-shadow: 0 2px 8px rgb(217 90 43 / 35%);
}

.topbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bk-surface);
  border-bottom: 1px solid var(--bk-line-2);
  padding: 0 16px;
}

/* 顶栏底部一道主色渐隐线，呼应主题 */
.topbar::after {
  content: '';
  position: absolute;
  left: 200px;
  right: 0;
  bottom: 0;
  height: 2px;
  background: linear-gradient(
    90deg,
    var(--bk-fire-500) 0%,
    var(--bk-earth-400) 22%,
    transparent 55%
  );
  opacity: 0.55;
}

.topbar__left,
.topbar__right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.topbar__title {
  font-size: 15px;
  font-weight: 600;
}

.topbar__parent {
  font-size: 13px;
  color: var(--bk-ink-3);
}

.user {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--bk-ink-2);
  outline: none;
}

.user:hover {
  color: var(--bk-fire-600);
}
</style>
