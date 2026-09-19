/**
 * 认证守卫与主体归属拦截器的单元测试
 * ============================================================
 * 这一层是「看不到别家公司的账」的唯一保证，所以测试重点不是"能不能登录"，
 * 而是**越权访问会不会被拦住**：
 *
 *   · 未登录 + AUTH_REQUIRED=true          → 401（不是 200）
 *   · 已登录但不是该公司成员                → 403（不是 200）
 *   · 已登录且是成员                        → 放行
 *   · @Public 的接口未登录也放行
 *   · AUTH_REQUIRED=false（本地跑 e2e 用）只关"强制登录"，**归属校验仍生效**
 *
 * 最后一条尤其要测：如果那个开关连归属校验一起关掉，
 * 本地就再也测不出越权漏洞了，等于把一个安全开关变成了安全隐患。
 */
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';

import { AuthGuard } from '../auth.guard';
import { EntityScopeInterceptor, pickEntityId } from '../entity-scope.interceptor';
import { IS_PUBLIC_KEY, NO_ENTITY_SCOPE_KEY } from '../auth.decorators';
import { DomainError } from '../../../domain/accounting/errors';

// ---------------------------------------------------------------------------
//  测试替身
// ---------------------------------------------------------------------------

/** 只实现被用到的两个方法 */
function fakeAuth(options: { members?: Record<string, boolean> } = {}) {
  const members = options.members ?? {};
  return {
    verifyToken: vi.fn(async (token: string) => {
      if (token === 'good') return { sub: 'u1', email: 'a@b.com' };
      throw new DomainError('BK_E_UNAUTHORIZED', '无效令牌', 401, 'jwt verify 失败');
    }),
    resolveMembership: vi.fn(async (userId: string, entityId: string) => {
      if (!members[`${userId}:${entityId}`]) {
        throw new DomainError('BK_E_NOT_MEMBER', '不是成员', 403, 'no membership');
      }
      return {
        entityId,
        entityName: '测试公司',
        role: 'OWNER' as const,
        roleLabel: '实控人',
        actions: ['READ'],
      };
    }),
  };
}

function fakeConfig(authRequired: boolean) {
  return {
    get: vi.fn((key: string) => (key === 'env' ? { AUTH_REQUIRED: authRequired } : undefined)),
  };
}

/** 构造一个最小的 ExecutionContext */
function makeContext(
  req: Record<string, unknown>,
  meta: { handler?: boolean; klass?: boolean } = {},
): ExecutionContext {
  const handler = function handler() {};
  const klass = class Controller {};

  return {
    getType: () => 'http',
    getHandler: () => {
      // 用 metadata 打标，让 Reflector 的假实现能读到
      if (meta.handler) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
      return handler;
    },
    getClass: () => {
      if (meta.klass) Reflect.defineMetadata(NO_ENTITY_SCOPE_KEY, true, klass);
      return klass;
    },
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const next: CallHandler = { handle: () => of('ok') };

// ---------------------------------------------------------------------------
//  AuthGuard
// ---------------------------------------------------------------------------

describe('AuthGuard —— 解决"你是谁"', () => {
  const reflector = new Reflector();

  it('未登录访问受保护接口 → 401', async () => {
    const guard = new AuthGuard(reflector, fakeAuth() as never, fakeConfig(true) as never);
    const ctx = makeContext({ headers: {} });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'BK_E_UNAUTHORIZED' });
  });

  it('@Public 的接口未登录也放行（登录页、健康检查）', async () => {
    const guard = new AuthGuard(reflector, fakeAuth() as never, fakeConfig(true) as never);
    const ctx = makeContext({ headers: {} }, { handler: true });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('合法令牌把身份挂到 request.actor 上', async () => {
    const guard = new AuthGuard(reflector, fakeAuth() as never, fakeConfig(true) as never);
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer good' } };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.actor).toEqual({ userId: 'u1', email: 'a@b.com' });
  });

  it('令牌无效 → 401（不区分"过期"与"伪造"，避免给攻击者线索）', async () => {
    const guard = new AuthGuard(reflector, fakeAuth() as never, fakeConfig(true) as never);
    const ctx = makeContext({ headers: { authorization: 'Bearer nope' } });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'BK_E_UNAUTHORIZED' });
  });

  it('AUTH_REQUIRED=false 时未登录放行 —— 但这个口子只为本地 e2e 存在', async () => {
    const guard = new AuthGuard(reflector, fakeAuth() as never, fakeConfig(false) as never);
    const ctx = makeContext({ headers: {} });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('大小写不敏感的 Bearer 前缀也能识别', async () => {
    const guard = new AuthGuard(reflector, fakeAuth() as never, fakeConfig(true) as never);
    const req: Record<string, unknown> = { headers: { authorization: 'bearer good' } };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.actor).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
//  EntityScopeInterceptor
// ---------------------------------------------------------------------------

describe('EntityScopeInterceptor —— 解决"你能不能看这家公司"', () => {
  const reflector = new Reflector();

  async function run(
    req: Record<string, unknown>,
    members: Record<string, boolean>,
    authRequired = true,
    meta: { klass?: boolean } = {},
  ) {
    const interceptor = new EntityScopeInterceptor(
      reflector,
      fakeAuth({ members }) as never,
      fakeConfig(authRequired) as never,
    );
    return interceptor.intercept(makeContext(req, meta), next);
  }

  it('已登录但不是该公司成员 → 403（这是最关键的越权防线）', async () => {
    const req = {
      actor: { userId: 'u1', email: 'a@b.com' },
      query: { entityId: 'someone-else' },
      headers: {},
    };

    await expect(run(req, {})).rejects.toMatchObject({
      code: 'BK_E_NOT_MEMBER',
      httpStatus: 403,
    });
  });

  it('已登录且是成员 → 放行，并把成员信息挂到 request.membership', async () => {
    const req: Record<string, unknown> = {
      actor: { userId: 'u1', email: 'a@b.com' },
      query: { entityId: 'e1' },
      headers: {},
    };

    await expect(run(req, { 'u1:e1': true })).resolves.toBeTruthy();
    expect((req as { membership?: { entityId: string } }).membership?.entityId).toBe('e1');
  });

  it('body 里的 entityId 优先于 query', async () => {
    const req = {
      actor: { userId: 'u1', email: 'a@b.com' },
      body: { entityId: 'e1' },
      query: { entityId: 'e2' },
      headers: {},
    };

    // 只有 e1 是成员；如果实现漏读了 body，就会拿 e2 去判并抛 403
    await expect(run(req, { 'u1:e1': true })).resolves.toBeTruthy();
  });

  it('路径参数里的 entityId 也能取到', async () => {
    const req = {
      actor: { userId: 'u1', email: 'a@b.com' },
      params: { entityId: 'e1' },
      headers: {},
    };

    await expect(run(req, { 'u1:e1': true })).resolves.toBeTruthy();
  });

  it('没带 entityId 的接口（跨主体查询）不在这里判', async () => {
    const req = { actor: { userId: 'u1', email: 'a@b.com' }, headers: {} };

    await expect(run(req, {})).resolves.toBeTruthy();
  });

  it('@NoEntityScope 显式跳过后不再校验（如"我有哪些公司"）', async () => {
    const req = {
      actor: { userId: 'u1', email: 'a@b.com' },
      query: { entityId: 'someone-else' },
      headers: {},
    };

    await expect(run(req, {}, true, { klass: true })).resolves.toBeTruthy();
  });

  it('★ AUTH_REQUIRED=false 只关"强制登录"，归属校验仍然生效', async () => {
    // 未登录（没有 actor）时才放行
    const anon = { query: { entityId: 'e1' }, headers: {} };
    await expect(run(anon, {}, false)).resolves.toBeTruthy();

    // 但一旦带了身份，越权照样 403 —— 这个开关不能顺手把安全边界也关了
    const authed = {
      actor: { userId: 'u1', email: 'a@b.com' },
      query: { entityId: 'someone-else' },
      headers: {},
    };
    await expect(run(authed, {}, false)).rejects.toMatchObject({ code: 'BK_E_NOT_MEMBER' });
  });

  it('AUTH_REQUIRED=true 且未登录时请求带了 entityId → 401', async () => {
    const req = { query: { entityId: 'e1' }, headers: {} };

    await expect(run(req, {}, true)).rejects.toMatchObject({ code: 'BK_E_UNAUTHORIZED' });
  });
});

// ---------------------------------------------------------------------------
//  pickEntityId
// ---------------------------------------------------------------------------

describe('pickEntityId', () => {
  it('按 body → query → params 的顺序取', () => {
    expect(pickEntityId({ body: { entityId: 'b' }, query: { entityId: 'q' } } as never)).toBe('b');
    expect(pickEntityId({ query: { entityId: 'q' }, params: { entityId: 'p' } } as never)).toBe('q');
    expect(pickEntityId({ params: { entityId: 'p' } } as never)).toBe('p');
  });

  it('空字符串与数组形式一律当作没传（query 参数可能是数组）', () => {
    expect(pickEntityId({ query: { entityId: '' } } as never)).toBeNull();
    expect(pickEntityId({ query: { entityId: ['a', 'b'] } } as never)).toBeNull();
    expect(pickEntityId({} as never)).toBeNull();
  });
});
