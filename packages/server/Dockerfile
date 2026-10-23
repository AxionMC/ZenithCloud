# syntax=docker/dockerfile:1.7
#
# ZenithCloud 服务端镜像（不含 Nginx，直接监听 2055）。
# 构建（在仓库根目录执行）：
#   docker build -f packages/server/Dockerfile -t zenithcloud-server:latest .
# 运行（在仓库根目录执行）：
#   docker compose -f packages/server/docker-compose.yml up -d --build
#
# 首次启动会创建管理员账号（ZENITH_ADMIN_EMAIL / ZENITH_ADMIN_PASSWORD），
# 数据保存在 /data 卷中；删除卷才会重新初始化管理员。

FROM node:24.14.0-bookworm AS build

ARG PNPM_VERSION=10.33.2
ENV CI=1 \
    HUSKY=0 \
    PNPM_HOME=/pnpm \
    NODE_OPTIONS=--max-old-space-size=4096 \
    TURBO_TELEMETRY_DISABLED=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    ZCODE_ENV=production
ENV PATH="${PNPM_HOME}:${PATH}"

# node-pty / ssh2 等原生依赖需要编译工具。
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update -qq && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
      make \
      g++ && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /workspace
COPY . .

# 仓库锁文件未变化时直接复用缓存层。
RUN pnpm install --frozen-lockfile

# 服务端（含 Web 静态资源）构建。
RUN pnpm --filter @zcode/server build
RUN pnpm --filter @zcode/web build

FROM node:24.14.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=2055 \
    HOST=0.0.0.0 \
    ZCODE_SERVER_HOST=0.0.0.0 \
    ZCODE_ENV=production \
    ZENITH_DATA_DIR=/data \
    ZCODE_WEB_STATIC_ROOT=/app/packages/web/dist

WORKDIR /app

# 保留 pnpm 的 node_modules 布局，外部依赖（ssh2、node-pty 等）通过相对软链解析。
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /workspace/packages/server ./packages/server
COPY --from=build /workspace/packages/web/dist ./packages/web/dist

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 2055

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:2055/api/public/settings').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/entry-http.js"]
