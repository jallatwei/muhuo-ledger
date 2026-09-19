# =============================================================================
#  后端 API —— 多阶段生产镜像
# =============================================================================
#  与 docker/dev/Dockerfile 的根本区别：
#    dev   挂载源码 + 容器内 pnpm install + 跑 nest dev（热重载）
#    prod  构建期编好产物，运行期只带 dist 与生产依赖，源码不进镜像
#
#  为什么必须分成两套而不是共用一套：
#    dev 镜像刻意依赖宿主机挂载的源码与匿名卷来隔离 Windows/Linux 原生依赖，
#    而生产镜像要的是**自包含、可复现** —— 把源码和 devDependencies 一起打进
#    镜像既臃肿又会让"镜像里的东西"和"仓库里的东西"有可能不一致。
# =============================================================================

# ---------------------------------------------------------------- 构建阶段
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_OPTIONS=--max-old-space-size=2048 \
    CI=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /workspace

# ① 先只拷清单文件 —— pnpm 的依赖安装是最慢的一层，
#    这样改业务代码不会让这一层缓存失效。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json  packages/shared/
COPY apps/api/package.json         apps/api/
COPY apps/web/package.json         apps/web/

# ★ 不加 --ignore-scripts。
#   本仓库**没有任何**工作区包定义 postinstall / prepare（已逐个核对），
#   所以 --ignore-scripts 换不来任何"避免源码缺失导致失败"的好处；
#   而"依赖能不能跑安装脚本"这件事已经由 pnpm-workspace.yaml 的
#   allowBuilds 白名单统一裁决（不在名单里的一律拒绝执行）。
#   再叠一层 --ignore-scripts 等于把这份白名单整个废掉 ——
#   bcrypt 的原生二进制就是在这时被跳过的，症状是启动阶段炸：
#     Error: Cannot find module
#       '.../node_modules/.pnpm/bcrypt@5.1.1/node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node'
#   报错指向 bcrypt.js 第 6 行，非常像"bcrypt 没装"，其实是装了没编译。
#
# ★ 补救时别用 `pnpm rebuild bcrypt`：实测它静默退出 0、不产出任何文件，
#   会把"看起来修好了"的假象带给下一个人。正确写法是 --pending：
#     pnpm rebuild --pending   # 补跑装依赖时被 --ignore-scripts 跳过的脚本
#
# 下面这行 require 是**故意**留的构建期断言：bcrypt 是密码哈希的必经之路，
# 缺了它整个登录功能都不可用，必须在镜像构建时就失败，而不是等运行时。
RUN pnpm install --frozen-lockfile \
 && node -e "require('/workspace/apps/api/node_modules/bcrypt'); console.log('bcrypt 原生模块 OK')"

# ② 再拷源码
COPY tsconfig.base.json ./
COPY packages/shared  packages/shared
COPY apps/api         apps/api

# ③ Prisma 客户端（含 Linux 查询引擎）+ 构建
#    ★ prisma generate 必须在源码与 schema 都就位之后跑，
#      它读 prisma/schema.prisma 生成类型与二进制引擎。
RUN pnpm --filter @bookkeeper/api exec prisma generate \
 && pnpm --filter @bookkeeper/shared build \
 && pnpm --filter @bookkeeper/api build

# ---------------------------------------------------------------- 运行阶段
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_OPTIONS=--max-old-space-size=1536 \
    HOST=0.0.0.0 \
    API_PORT=3000 \
    STORAGE_LOCAL_ROOT=/data/attachments

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates openssl postgresql-client tini \
      # 中文字体：凭证册 HTML 与后续 PDF 渲染中文必须，缺了会出方块
      fonts-noto-cjk fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /workspace

# 带上 node_modules 而不是重装：pnpm 的 store 是符号链接结构，
# 只拷 package.json 再 install 会丢掉 workspace 链接关系。
# 体积大一点换来"镜像里跑的就是刚才构建出来的东西"。
COPY --from=build /workspace/node_modules          ./node_modules
COPY --from=build /workspace/package.json          ./package.json
COPY --from=build /workspace/pnpm-workspace.yaml   ./pnpm-workspace.yaml
COPY --from=build /workspace/packages/shared       ./packages/shared
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/apps/api/dist         ./apps/api/dist
COPY --from=build /workspace/apps/api/prisma       ./apps/api/prisma
# ★ 必须带上工作区自己的 node_modules。
#   pnpm 的布局是「根 .pnpm 虚拟store + 各工作区 node_modules 里的符号链接」，
#   CLI 类依赖（prisma / nest / tsc）的真实文件恰恰挂在 apps/api/node_modules 下。
#   只拷 dist 与源码目录会让容器里 node_modules/prisma 解析不到，
#   迁移命令直接找不到 CLI（实测踩到：/workspace/node_modules/prisma 不存在，
#   而 .pnpm/prisma@5.22.0/node_modules 下也没有可执行入口）。
COPY --from=build /workspace/apps/api/node_modules ./apps/api/node_modules
# ★ 刻意不往镜像里放任何 .env 文件。
#   配置一律由运行期环境变量注入（compose 的 environment / 云端密钥管理）。
#   镜像里放 .env 会让人以为"改镜像里的文件就能改配置"，而那需要重建镜像；
#   更糟的是，它给了密钥一个混进版本库的机会。

COPY docker/prod/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh

# 单据原件目录。★ 生产必须挂卷或换成对象存储 ——
# 容器可写层是临时的，重启就没了，而发票原件是这套系统的审计凭证。
RUN chmod +x /usr/local/bin/api-entrypoint.sh \
 && mkdir -p /data/attachments \
 && chown -R node:node /data

USER node

EXPOSE 3000

# 健康检查用 /api/health：它同时验证了进程活着、数据库连得上。
# 只 ping 端口是不够的 —— 数据库断了进程照样在监听。
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/api-entrypoint.sh"]
