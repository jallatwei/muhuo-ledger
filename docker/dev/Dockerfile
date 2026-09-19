# =============================================================================
#  开发用镜像：只装运行时与工具链，不装业务依赖
#  业务依赖由 compose 的 command 在容器内 pnpm install（利用命名卷缓存）
#  这样 Windows 宿主与 Linux 容器的原生依赖不会互相污染
# =============================================================================
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_OPTIONS=--max-old-space-size=2048

# 基础工具 + 中文字体（凭证册 PDF 渲染中文必须）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      wget \
      git \
      openssl \
      tini \
      fonts-noto-cjk \
      fonts-wqy-zenhei \
      postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Chromium（后期 Puppeteer 生成凭证册 PDF 用）
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 启用 corepack，使用 package.json 中声明的 pnpm 版本
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /workspace

# 容器内 node_modules 的归属目录（实际由 compose 匿名卷覆盖）
RUN mkdir -p /data/attachments && chown -R node:node /data

EXPOSE 3000 5173

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-lc", "node --version && pnpm --version && sleep infinity"]
