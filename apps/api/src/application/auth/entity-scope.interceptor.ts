/**
 * 主体归属校验拦截器 —— 「你只能看自己公司的账」
 * ============================================================
 * 这是整个认证体系里**最重要的一道边界**。
 *
 * 在它之前，所有接口都接受请求方传的 entityId：任何登录用户把 url 里的
 * entityId 换成别家公司的，就能看到别人的全部账簿。对小企业来说这是致命的。
 *
 * ★ 为什么做成全局拦截器而不是在每个接口里写一行校验：
 *   现有 57 个接口方法、以后还会加。逐个写就是逐个会忘。
 *   做成全局的，**默认全部受保护**，新接口天然继承这道检查。
 *
 * ★ 为什么是 Interceptor 而不是 Guard：
 *   归属校验需要读 body / query 里的 entityId，而 Guard 在管道之前跑，
 *   body 还没解析出来。Interceptor 在管道之后、控制器之前，拿到的是解析好的值。
 *
 * 判定规则（三条，都很直白）：
 *   ① 请求带了 entityId + 当前已登录  → 必须是该公司成员（成员即可，动作级权限另说）
 *   ② 请求带了 entityId + 无人登录    → 看 AUTH_REQUIRED：
 *                                        true  → 401（正常情况，Guard 已经拦了）
 *                                        false → 放行（本地 e2e 用，见 env.ts 说明）
 *   ③ 请求没带 entityId               → 无事可判，放行
 *                                        （跨主体的接口如"我有哪些公司"由 @NoEntityScope 显式声明）
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';

import { AuthService } from './auth.service';
import { NO_ENTITY_SCOPE_KEY } from './auth.decorators';
import { DomainError } from '../../domain/accounting/errors';
import type { AuthedRequest } from './auth.guard';
import type { Env } from '../../config/env';

/** 从请求里取 entityId —— body 优先，其次 query，最后路径参数 */
export function pickEntityId(req: AuthedRequest): string | null {
  const fromBody = (req.body as Record<string, unknown> | undefined)?.['entityId'];
  if (typeof fromBody === 'string' && fromBody) return fromBody;

  const fromQuery = req.query?.['entityId'];
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;

  const fromParams = (req.params as Record<string, unknown> | undefined)?.['entityId'];
  if (typeof fromParams === 'string' && fromParams) return fromParams;

  return null;
}

@Injectable()
export class EntityScopeInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const skip = this.reflector.getAllAndOverride<boolean>(NO_ENTITY_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const entityId = pickEntityId(req);

    // 没带 entityId 的接口（跨主体查询、账号自服务）不在这里判
    if (!entityId) return next.handle();

    const actor = req.actor;
    if (!actor) {
      if (this.env.AUTH_REQUIRED) {
        throw new DomainError(
          'BK_E_UNAUTHORIZED',
          '请先登录后再访问公司数据。',
          401,
          `entityId=${entityId} 但未认证`,
        );
      }
      // 本地 e2e 放行口子：不强制登录。
      return next.handle();
    }

    // ★ 逐请求查库。多一次 SELECT，换来的是"权限改了立刻生效"——
    //   把成员关系缓存进令牌的话，把某人移出公司后他手上的令牌仍然有效，
    //   直到过期为止。对小企业来说，"移除后立刻进不去"比省这一次查询重要。
    const membership = await this.auth.resolveMembership(actor.userId, entityId);

    // 挂到请求上，控制器里可以用 @CurrentMembership() 直接取，不必再查一遍
    (req as AuthedRequest & { membership?: unknown }).membership = membership;

    return next.handle();
  }

  private get env(): Env {
    return this.config.get<Env>('env') as Env;
  }
}
