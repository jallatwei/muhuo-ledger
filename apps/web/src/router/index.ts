import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { APP_NAME } from '@bookkeeper/shared';
import { useAuthStore } from '@/stores/auth';

/**
 * 路由表
 * ============================================================
 * 分成三棵子树，每棵套自己的外壳：
 *
 *   /login /register …      → AuthLayout   （未登录，没有"当前公司"这个概念）
 *   /dashboard /vouchers …  → AppShell     （已登录，需要主体与期间）
 *   /:pathMatch(.*)*        → NotFound     （不带外壳，避免未登录时也渲染菜单）
 *
 * ★ 为什么不把外壳做成一个组件、在里面 v-if 判断登录：
 *   未登录时"当前主体/当前期间"全都不存在，外壳里每个控件都要写一次
 *   v-if，漏一个就是空控件或报错。分成两棵子树之后，两类页面互不干扰。
 */
const routes: RouteRecordRaw[] = [
  // ───────────────────────────────────────────── 入口
  {
    path: '/',
    name: 'root',
    component: () => import('@/views/auth/RootView.vue'),
    meta: { title: '正在进入…', public: true },
  },

  // ───────────────────────────────────────────── 未登录
  {
    path: '/',
    component: () => import('@/layouts/AuthLayout.vue'),
    children: [
      {
        path: 'login',
        name: 'login',
        component: () => import('@/views/auth/LoginView.vue'),
        meta: { title: '登录', public: true },
      },
      {
        path: 'register',
        name: 'register',
        component: () => import('@/views/auth/RegisterView.vue'),
        meta: {
          title: '注册新用户',
          subtitle: '注册后你可以自己用，也可以把会计和只读账号加进来一起用',
          public: true,
        },
      },
      {
        // 公司注册 = 建主体 + 建账套，一次完成。
        // 已有账号也能来（开第二家公司），所以**不是** public
        path: 'register/company',
        name: 'company-register',
        component: () => import('@/views/auth/CompanyRegisterView.vue'),
        meta: {
          title: '公司注册 / 账套注册',
          subtitle: '建主体、建小企业会计准则科目表、建当年 12 个会计期间，一次完成',
        },
      },
    ],
  },

  // ───────────────────────────────────────────── 已登录
  {
    path: '/',
    component: () => import('@/layouts/AppShell.vue'),
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '总览' },
      },
      {
        path: 'vouchers',
        name: 'vouchers',
        component: () => import('@/views/VoucherListView.vue'),
        meta: { title: '凭证' },
      },
      {
        path: 'vouchers/new',
        name: 'voucher-new',
        component: () => import('@/views/VoucherEditView.vue'),
        meta: { title: '录入凭证' },
      },
      {
        // ★ 识别录入必须排在 `/vouchers/:id` 之前。
        //   vue-router 按声明顺序匹配，`:id` 是个万能通配 ——
        //   若它在前，`/vouchers/recognition` 会被当成"凭证 id = recognition"，
        //   渲染出一个加载失败的凭证详情页（表现为"点进去什么都没有"）。
        //   这是静态路径与动态参数共处一个前缀时的经典陷阱。
        path: 'vouchers/recognition',
        name: 'recognition',
        component: () => import('@/views/RecognitionView.vue'),
        meta: { title: '识别录入', parent: '录入凭证' },
      },
      {
        path: 'vouchers/:id',
        name: 'voucher-detail',
        component: () => import('@/views/VoucherEditView.vue'),
        meta: { title: '凭证详情' },
      },
      {
        path: 'warehouse',
        name: 'warehouse',
        component: () => import('@/views/WarehouseView.vue'),
        meta: { title: '发票仓库' },
      },
      {
        path: 'print',
        name: 'print',
        component: () => import('@/views/PrintView.vue'),
        meta: { title: '凭证册打印' },
      },
      {
        path: 'accounts',
        name: 'accounts',
        component: () => import('@/views/AccountListView.vue'),
        meta: { title: '科目表' },
      },
      {
        path: 'members',
        name: 'members',
        component: () => import('@/views/MemberManagementView.vue'),
        meta: { title: '成员与账号' },
      },
      {
        path: 'appearance',
        name: 'appearance',
        component: () => import('@/views/AppearanceView.vue'),
        meta: { title: '外观偏好' },
      },
      {
        path: 'tax',
        name: 'tax',
        component: () => import('@/views/TaxView.vue'),
        meta: { title: '税务填报' },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('@/views/AuditView.vue'),
        meta: { title: '账务自检' },
      },
    ],
  },

  // ───────────────────────────────────────────── 兜底
  {
    // ★ 必须放在最后，且必须存在。
    //   没有它时，写错的 URL（例如曾经的 /recognition）会被浏览器接受，
    //   却渲染出一片空白 —— 看起来像"功能没做"，实际只是路径写错了。
    //   有一个明确的 404 页面，这类问题一眼就能定位。
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { title: '页面不存在', public: true },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// 路由 meta 的类型补充。不声明的话 `to.meta.public` 会报"属性不存在"
declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    /** 面包屑上一级 */
    parent?: string;
    /** 未登录也能访问 */
    public?: boolean;
    /** 登录页的副标题 */
    subtitle?: string;
  }
}

/** 只接受站内路径，避免 ?redirect= 被拿去做跳转钓鱼 */
export function safeRedirect(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  if (!value.startsWith('/') || value.startsWith('//')) return '';
  return value;
}

/**
 * 全局前置守卫：认证与引导
 * ============================================================
 * 顺序很重要：
 *   ① 公开页  → 直接放行（已登录的人访问 /login 会被页面自己送走）
 *   ② 恢复身份（整个会话只做一次，之后由 store 记住）
 *   ③ 未登录  → 去 /login，带上"从哪来"
 *   ④ 已登录但一家公司都没有 → 去公司注册
 *      （否则进总览只会看到"名下还没有公司"，而他不知道该点哪）
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore();

  if (to.meta.public) return true;

  if (!auth.resolved) {
    await auth.restore();
  }

  if (!auth.isLoggedIn) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }

  if (auth.needsCompany && to.name !== 'company-register') {
    return { path: '/register/company' };
  }

  return true;
});

router.afterEach((to) => {
  const title = (to.meta.title as string | undefined) ?? '';
  document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
});
