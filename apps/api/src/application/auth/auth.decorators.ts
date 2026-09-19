/**
 * 认证相关的装饰器
 * ============================================================
 * 只做两件事：标记「不需要登录」和「不需要归属校验」。
 *
 * ★ 为什么不反过来标记「需要登录」：
 *   安全默认值必须是**拒绝**。如果默认放行、靠每个接口记得加 @RequireAuth，
 *   那么将来新加的接口只要忘了加，就是敞开的 —— 而且没人会发现。
 *   现在是默认拦，忘了加 @Public 最多是"打不开"，会立刻暴露。
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'bk:isPublic';
export const NO_ENTITY_SCOPE_KEY = 'bk:noEntityScope';

/**
 * 不需要登录就能访问。
 *
 * 只应当用在真正公开的接口上：登录、注册、健康检查、注册引导信息。
 * ★ 不要为了"先跑起来"往业务接口上加这个 —— 那等于把门留着。
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * 跳过「主体归属校验」。
 *
 * 用于那些天然没有 entityId 的接口（如"我有哪些公司""改自己的密码"）。
 * 注意：跳过归属校验**不等于**跳过登录 —— 除非同时标了 @Public。
 */
export const NoEntityScope = () => SetMetadata(NO_ENTITY_SCOPE_KEY, true);
