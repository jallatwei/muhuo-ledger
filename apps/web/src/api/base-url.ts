/**
 * API 基地址解析
 * ============================================================
 * ★ 这个文件为什么单独存在，而不是写在 api/index.ts 里一行了事
 *
 *   因为这行代码曾经以最难发现的方式坏过：
 *
 *     const baseURL = import.meta.env.VITE_API_BASE_URL ?? '/api';
 *
 *   Docker 构建时会把 VITE_API_BASE_URL **显式定义成空字符串**
 *   （web.Dockerfile 的 ARG PUBLIC_API_BASE_URL 默认为空）。
 *   而 `'' ?? '/api'` 的结果是 `''` —— 空串不是 null/undefined，
 *   `??` 不会回退。于是 axios 的 baseURL 变成空串，
 *   **所有请求丢掉 /api 前缀**：
 *
 *     实际发出    POST /auth/login
 *     应该发出    POST /api/auth/login
 *
 *   nginx 对 GET 会做 SPA 回退返回 index.html，对 POST 则直接 405。
 *   界面上看到的是"无法连接到后端服务"，与真实原因（路径少了前缀）
 *   毫无关系。
 *
 *   ★ 最阴的一点：开发态没人设这个变量，它是 undefined，
 *     `??` 正常回退到 /api —— 所以**本地怎么点都是好的**，
 *     只有构建出来的镜像坏。靠"本地跑通了"永远发现不了。
 *
 *   所以把它抽成纯函数并配上测试：这条规则必须有断言守着，
 *   不能靠下次再有人肉眼看一遍。
 */

/**
 * 由构建期注入的原始值算出 axios 的 baseURL。
 *
 * 规则：
 *   空 / 空白 / 未设置  →  '/api'（相对路径，由 nginx 同源转发）
 *   有值                → 原样使用，但去掉结尾多余的斜杠
 *                         （否则 baseURL + '/auth/login' 会拼出 //auth/login）
 */
export function resolveApiBaseUrl(raw: string | undefined | null): string {
  const v = (raw ?? '').trim();
  if (v === '') return '/api';
  return v.replace(/\/+$/, '');
}
