/**
 * 账号与登录状态 —— 全局 store
 *
 * ★ 令牌存 localStorage 而不是 Cookie：
 *   前后端分离部署（前端静态站 + API 独立域名）下这是常规做法，
 *   也避免了 Cookie 的 CSRF 问题（浏览器不会自动带上 Authorization 头）。
 *   代价是 XSS 一旦发生令牌会被读走 —— 所以前端不允许渲染用户输入的 HTML。
 *
 * ★ 「能进哪家公司」以**服务端返回的 memberships 为准**，
 *   本地只缓存"上次选的是哪家"（纯体验优化），绝不作为权限依据。
 *   角色被改掉后用本地缓存判断会一直显示旧权限，所以要定期 refresh。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  authApi,
  type AuthMembership,
  type AuthUserDto,
  type CompanyInputDto,
  type LoginResultDto,
} from '@/api';

const TOKEN_KEY = 'bk.auth.token';
const ENTITY_KEY = 'bk.auth.entityId';

export const useAuthStore = defineStore('auth', () => {
  const token = ref('');
  const user = ref<AuthUserDto | null>(null);
  const memberships = ref<AuthMembership[]>([]);
  const currentEntityId = ref('');
  const loading = ref(false);
  /** 是否已完成一次「我是谁」的确认。未确认前路由守卫不能放行 */
  const resolved = ref(false);

  const isLoggedIn = computed(() => !!token.value && !!user.value);

  const currentMembership = computed(
    () => memberships.value.find((m) => m.entityId === currentEntityId.value) ?? null,
  );
  const currentRole = computed(() => currentMembership.value?.role ?? null);
  const currentRoleLabel = computed(() => currentMembership.value?.roleLabel ?? '');

  /** 当前身份能否做某动作。界面用它禁用按钮，真正的判定仍然在服务端 */
  function can(action: string): boolean {
    const m = currentMembership.value;
    return !!m && m.actions.includes(action);
  }

  /** 一家公司都没有 —— 应引导去「公司注册」 */
  const needsCompany = computed(() => isLoggedIn.value && memberships.value.length === 0);

  // ---------------------------------------------------------------- 本地存取

  function persist(key: string, value: string): void {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      // 隐私模式写不了：本次会话仍然可用，只是刷新后要重新登录
    }
  }

  function readLocal(key: string): string {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  }

  function clearLocal(): void {
    persist(TOKEN_KEY, '');
    persist(ENTITY_KEY, '');
  }

  // ---------------------------------------------------------------- 身份

  function applyIdentity(
    nextUser: AuthUserDto,
    nextMemberships: AuthMembership[],
    defaultEntityId: string | null,
  ): void {
    user.value = nextUser;
    memberships.value = nextMemberships;

    // 优先沿用本地记住的那家（多公司用户切换时不必每次重选），
    // 但它必须仍在服务端返回的列表里 —— 否则说明权限已被移除
    const remembered = readLocal(ENTITY_KEY);
    const stillValid = (id: string | null | undefined): id is string =>
      !!id && nextMemberships.some((m) => m.entityId === id);

    const chosen = stillValid(remembered)
      ? remembered
      : stillValid(defaultEntityId)
        ? defaultEntityId
        : (nextMemberships[0]?.entityId ?? '');

    currentEntityId.value = chosen;
    persist(ENTITY_KEY, chosen);
  }

  /** 页面启动：用本地令牌换回身份。返回是否已登录 */
  async function restore(): Promise<boolean> {
    token.value = readLocal(TOKEN_KEY);
    if (!token.value) {
      resolved.value = true;
      return false;
    }
    try {
      const me = await authApi.me();
      applyIdentity(me.user, me.memberships, me.defaultEntityId);
      return true;
    } catch {
      // 令牌过期或服务端不认 —— 清掉，交给路由守卫送去登录页。
      // 这里不弹错误提示：启动时弹一条红条很烦，登录页本身会说明情况。
      token.value = '';
      user.value = null;
      memberships.value = [];
      clearLocal();
      return false;
    } finally {
      resolved.value = true;
    }
  }

  function acceptLogin(res: LoginResultDto): LoginResultDto {
    token.value = res.token;
    persist(TOKEN_KEY, res.token);
    applyIdentity(res.user, res.memberships, res.defaultEntityId);
    resolved.value = true;
    return res;
  }

  // ---------------------------------------------------------------- 对外动作

  async function login(email: string, password: string): Promise<LoginResultDto> {
    loading.value = true;
    try {
      return acceptLogin(await authApi.login(email, password));
    } finally {
      loading.value = false;
    }
  }

  /** 新用户注册（可同时建公司账套） */
  async function register(payload: {
    email: string;
    password: string;
    displayName: string;
    phone?: string;
    accountType?: 'PERSONAL' | 'COMPANY_STAFF';
    company?: CompanyInputDto;
  }): Promise<LoginResultDto> {
    loading.value = true;
    try {
      return acceptLogin(await authApi.register(payload));
    } finally {
      loading.value = false;
    }
  }

  /** 公司注册：已有账号再建一家（同时建科目表与 12 个会计期间） */
  async function registerEntity(
    company: CompanyInputDto,
  ): Promise<{ entityId: string; entityName: string }> {
    loading.value = true;
    try {
      const res = await authApi.registerEntity(company);
      // 建完就切过去 —— 刚注册完公司的人一定是要开始用它
      await refresh();
      selectEntity(res.entityId);
      return res;
    } finally {
      loading.value = false;
    }
  }

  /** 重新拉一次身份（成员或角色可能被别处改过） */
  async function refresh(): Promise<void> {
    if (!token.value) return;
    const me = await authApi.me();
    applyIdentity(me.user, me.memberships, me.defaultEntityId);
  }

  async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await authApi.changePassword(currentPassword, newPassword);
  }

  function selectEntity(id: string): void {
    currentEntityId.value = id;
    persist(ENTITY_KEY, id);
  }

  function logout(): void {
    token.value = '';
    user.value = null;
    memberships.value = [];
    currentEntityId.value = '';
    clearLocal();
    resolved.value = true;
  }

  /** 登出并回登录页（记住"从哪来"，登录后跳回） */
  function logoutAndRedirect(): void {
    const from = `${window.location.pathname}${window.location.search}`;
    logout();
    const target =
      from && !from.startsWith('/login')
        ? `/login?redirect=${encodeURIComponent(from)}`
        : '/login';
    window.location.replace(target);
  }

  return {
    // 状态
    token,
    user,
    memberships,
    currentEntityId,
    currentMembership,
    currentRole,
    currentRoleLabel,
    isLoggedIn,
    needsCompany,
    loading,
    resolved,
    // 判定
    can,
    // 动作
    restore,
    login,
    register,
    registerEntity,
    refresh,
    changePassword,
    selectEntity,
    logout,
    logoutAndRedirect,
  };
});
