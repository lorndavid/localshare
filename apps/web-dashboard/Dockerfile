# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY scripts ./scripts
COPY packages/config ./packages/config
COPY packages/shared-types ./packages/shared-types
COPY packages/validation ./packages/validation
COPY apps/web-dashboard ./apps/web-dashboard

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @localshare/shared-types build && \
    pnpm --filter @localshare/validation build && \
    pnpm --filter @localshare/web-dashboard build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runner
COPY apps/web-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /workspace/apps/web-dashboard/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ || exit 1

