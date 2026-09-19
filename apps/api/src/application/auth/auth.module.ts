/**
 * 认证模块
 * ============================================================
 * 只导出 AuthService —— Guard 与归属拦截器虽然注册在 AppModule，
 * 但它们注入的是这里的 AuthService，必须导出，否则 Nest 解析不了依赖。
 *
 * JWT 密钥**不从 JwtModule.register 的常量里传**，而是在 AuthService 里
 * 每次签名/校验时显式带上（取自 ConfigService）。
 * 这样做是为了让"密钥缺失"在**启动时**就报错（env 校验会拦），
 * 而不是等到第一次登录才发现签不出来。
 */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { EntityScopeInterceptor } from './entity-scope.interceptor';

@Module({
  imports: [JwtModule.register({})],
  providers: [AuthService, AuthGuard, EntityScopeInterceptor],
  exports: [AuthService, AuthGuard, EntityScopeInterceptor],
})
export class AuthModule {}
