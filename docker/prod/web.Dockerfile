# =============================================================================
#  前端 Web —— 构建 + Nginx 静态托管
# =============================================================================
#  ★ 关键点：前端与 API **同源**。
#    构建时把 VITE_API_BASE_URL 留空，前端会回退到相对路径 /api
#    （见 apps/web/src/api/index.ts 的 `?? '/api'`），
#    再由这里的 nginx 把 /api 转发到 api 服务。
#
#    为什么不给前端塞一个 http://api:3000 这样的绝对地址：
#      · 那样浏览器要跨域，得配 CORS，还要处理预检
#      · 换域名/换端口就得重新构建前端
#      · 同源之后 cookie/凭证/相对路径下载全都自然成立
#        （凭证册 HTML、附件下载都是相对路径拼出来的）
# =============================================================================

# ---------------------------------------------------------------- 构建阶段
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_OPTIONS=--max-old-space-size=2048 \
    CI=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json        apps/api/
COPY apps/web/package.json        apps/web/

# ★ 这里**故意**保留 --ignore-scripts，与 api.Dockerfile 不同 —— 不是漏改。
#   理由：前端这条链路不需要任何靠安装脚本才能拿到的原生二进制。
#   esbuild（Vite 的构建核心）的二进制是作为**平台可选依赖包**
#   @esbuild/linux-x64 随 npm 一起下载的，不走 postinstall；
#   所以跳过脚本后 `vite build` 依然成立（本镜像已实测构建通过）。
#   代价是构建时不会跑 prisma / bcrypt 的下载，省几十秒。
#   ★ 判断依据很明确：只要哪天 web 依赖树里出现 node-pre-gyp 那一类包
#     （安装期下载 .node 产物），这行就必须删掉，否则症状会像 api 那样 ——
#     构建成功、运行时才报 Cannot find module '.../xxx.node'。
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web        apps/web

# ★ apps/web 的 build 脚本里有 `node ../../tools/check-routes.mjs` ——
#   构建期静态校验所有跳转链接都能匹配到路由声明。
#   漏掉这一步的后果是"构建成功但点某按钮页面空白"，
#   所以它必须在镜像构建里跑，不能只在本地跑。
COPY tools/check-routes.mjs tools/check-routes.mjs

# ★ 默认留空 —— 前端回退到相对路径 /api，由 nginx 同源转发。
#   传了值才会被 Vite 内联进产物（用于把前端单独部署到另一个域名的场景）。
ARG PUBLIC_API_BASE_URL=
ENV VITE_API_BASE_URL=${PUBLIC_API_BASE_URL}

# shared 必须先构建：apps/web 通过 vite alias 直接引 shared 源码，
# 但 vue-tsc 构建检查走的是 tsconfig 的 paths，指向 dist/index.d.ts。
RUN pnpm --filter @bookkeeper/shared build \
 && pnpm --filter @bookkeeper/web build

# ---------------------------------------------------------------- 运行阶段
FROM nginx:1.27-alpine AS runner

ENV TZ=Asia/Shanghai

# 用 envsubst 在启动时把 ${API_UPSTREAM} 替换成实际的上游地址，
# 这样同一份镜像可以在不同环境（compose 内 / 云端）复用，不必重建。
COPY docker/prod/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html

# 默认上游：compose 里的服务名
ENV API_UPSTREAM=api:3000

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1/nginx-health >/dev/null 2>&1 || exit 1
