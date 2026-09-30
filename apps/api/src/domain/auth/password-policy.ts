/**
 * 密码强度策略
 * ============================================================
 * ★ 为什么把它从 AuthService 里抽出来：
 *   这条规则现在有两个使用方 —— 注册/改密走的 AuthService，
 *   以及管理员重置密码的命令行工具（tools/reset-password.ts）。
 *   留在 service 私有函数里，CLI 就只有两个选择：把整个 NestJS
 *   service 拖进来当依赖，或者**复制一份规则**。
 *   复制一份是这里最危险的选项：两份规则迟早会不一致，
 *   于是"界面允许设的密码，命令行工具拒绝"（或反过来 ——
 *   更糟：命令行绕过强度校验设出一个界面本来不允许的弱口令）。
 *
 * ★ 规则刻意宽松，只拦真正危险的三种：
 *   太短、纯数字、以及（由调用方另行判断的）把邮箱当密码。
 *   过严的规则会把人逼去用 `Passw0rd!` 这类可预测组合，反而更弱。
 */

/** bcrypt 成本因子。12 在现代硬件上约 250ms，足够慢到难以暴力破解，又不影响体验 */
export const BCRYPT_ROUNDS = 12;

/** 密码最短长度 */
export const MIN_PASSWORD_LENGTH = 8;

/** 密码不合规时抛出。调用方自行决定映射成 400 还是命令行退出码 */
export class WeakPasswordError extends Error {
  constructor(
    message: string,
    /** 给用户看的那句（比 message 更具体、更可操作） */
    readonly userMessage: string,
    /** 内部判据，便于日志与测试断言 */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

/**
 * 校验密码强度。不合规则抛 WeakPasswordError。
 *
 * ★ 这里不抛 DomainError（那是 API 层的错误类型）：
 *   CLI 不经过 HTTP，抛一个带 httpStatus 的错误没有意义。
 *   AuthService 负责把 WeakPasswordError 转成 DomainError。
 */
export function assertPassword(pwd: string): void {
  if (!pwd || pwd.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `密码至少 ${MIN_PASSWORD_LENGTH} 位`,
      `密码至少 ${MIN_PASSWORD_LENGTH} 位。建议用一句只有你记得住的话（如「我家猫叫豆豆2019」），比复杂但记不住的组合更安全。`,
      '密码过短',
    );
  }
  if (/^\d+$/.test(pwd)) {
    throw new WeakPasswordError(
      '密码不能是纯数字',
      '密码不能是纯数字。请混合字母或符号 —— 纯数字在几秒内就能被穷举。',
      '密码为纯数字',
    );
  }
}
