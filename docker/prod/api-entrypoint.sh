#!/bin/sh
# =============================================================================
#  API 容器启动脚本
# =============================================================================
#  只做一件事：按配置决定要不要跑数据库迁移，然后启动服务。
#
#  ★ 为什么把迁移放在启动时，而不要求运维单独执行：
#    这是**单实例自托管**部署。单实例下不存在并发迁移，而"忘了跑迁移"
#    会导致应用起来后对着旧 schema 跑 SQL —— 报的是一堆莫名其妙的
#    列不存在错误，排查方向从一开始就偏了。
#    迁移失败时脚本 exit 1，容器直接起不来，问题在启动阶段就暴露。
#
#  ★ 多实例部署必须关掉它（MIGRATE_ON_START=false）：
#    两个副本同时启动会同时尝试迁移，轻则互相阻塞，重则把迁移历史写乱。
#    那种场景应当由部署流水线单独跑一次 prisma migrate deploy。
set -e

if [ "${MIGRATE_ON_START:-true}" = "true" ]; then
  echo "[entrypoint] 执行数据库迁移 prisma migrate deploy ..."
  cd /workspace/apps/api
  #
  # ★ 不用 `pnpm exec prisma`，直接用 node 调 Prisma CLI 的入口文件。
  #   原因：pnpm 启动前会做一次依赖状态检查，并往**工作区根目录**写临时文件
  #   （实测报错：EACCES: permission denied, open '/workspace/_tmp_20_xxx'）。
  #   容器里 /workspace 归 root、进程跑在 node 用户下，于是迁移直接失败。
  #   直接把 /workspace 全 chown 给 node 也能绕过，但那等于让应用进程
  #   对代码目录有写权限 —— 为了跑一次迁移而放宽整个代码目录，不划算。
  #   直接调 CLI 是最小改动：迁移本身完全不需要 pnpm 参与。
  #
  # --schema 显式指定：避免有人改了 WORKDIR 之后静默找错文件。
  if sh /workspace/apps/api/node_modules/.bin/prisma migrate deploy \
       --schema=prisma/schema.prisma; then
    echo "[entrypoint] 迁移完成"
  else
    echo "[entrypoint] ✗ 迁移失败，拒绝启动。" >&2
    echo "[entrypoint]   应用对着旧 schema 跑只会报更难懂的错，所以这里直接退出。" >&2
    echo "[entrypoint]   请检查 DATABASE_URL 连通性与 prisma/migrations 是否完整。" >&2
    exit 1
  fi
else
  echo "[entrypoint] MIGRATE_ON_START=false，跳过迁移（多实例部署时由流水线单独执行）"
fi

echo "[entrypoint] 启动 API ..."
#
# ★ 这里必须用**绝对路径**。
#   上面跑迁移时已经 cd 到了 /workspace/apps/api，任何相对路径都会被拼成
#   /workspace/apps/api/apps/api/dist/main.js —— 报错长这样：
#     Error: Cannot find module '/workspace/apps/api/apps/api/dist/main.js'
#   看起来像"dist 没打进镜像"，其实只是路径接重了，很容易查错方向。
#
exec node /workspace/apps/api/dist/main.js
