/**
 * 认证 Guard —— 解析令牌，把「当前是谁」挂到请求上
 * ============================================================
 * 它**只负责回答"你是谁"**，不负责"你能不能看这家公司"。
 * 后者是 EntityScopeInterceptor 的事 —— 两者分开的理由：
 *   · 身份是全局的（一个人），归属是逐个主体判定的
 *   · 归属校验需要读到 body/query 里的 entityId，那是 interceptor 才方便做的事
 *
 * ★ 它注册为**全局** Guard（在 AppModule 里用 APP_GUARD 注册），
 *   所以默认所有接口都要登录，只有显式标了 @Public 的才放行。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './auth.decorators';
import { DomainError } from '../../domain/accounting/errors';
import type { Env } from '../../config/env';

/** 挂在 request 上的当前身份 */
export interface AuthenticatedActor {
  userId: string;
  email: string;
}

/** 扩展后的请求对象（express Request + 我们的字段） */
export interface AuthedRequest extends Request {
  actor?: AuthenticatedActor;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 方法上的 @Public 优先于类上的
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = extractBearer(req);

    // 不管是不是公开接口，带了令牌就解析 ——
    // 这样"登录页"也能顺带识别出已登录用户，不需要额外接口。
    if (token) {
      const payload = await this.auth.verifyToken(token);
      req.actor = { userId: payload.sub, email: payload.email };
    }

    if (isPublic) return true;

    if (!req.actor) {
      const required = this.env.AUTH_REQUIRED;
      if (required) {
        throw new DomainError(
          'BK_E_UNAUTHORIZED',
          '请先登录。若刚才是登录状态，可能是令牌已过期，重新登录即可。',
          401,
          '缺少 Authorization: Bearer <token>',
        );
      }
      // AUTH_REQUIRED=false：本地跑既有 e2e 脚本时的临时放行。
      // 注意这里只是"不强制登录"，归属校验仍然生效（见 EntityScopeInterceptor）。
      return true;
    }

    return true;
  }

  private get env(): Env {
    return this.config.get<Env>('env') as Env;
  }
}

/** 从 Authorization 头里取 Bearer 令牌 */
export function extractBearer(req: Request): string | null {
  const raw = req.headers?.authorization;
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m?.[1]?.trim() || null;
}
