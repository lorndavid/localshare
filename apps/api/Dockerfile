# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY scripts ./scripts
COPY packages/config ./packages/config
COPY packages/shared-types ./packages/shared-types
COPY packages/validation ./packages/validation
COPY apps/api ./apps/api

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @localshare/shared-types build && \
    pnpm --filter @localshare/validation build && \
    pnpm --filter @localshare/api build

FROM node:22-alpine AS runner
WORKDIR /workspace/apps/api
ENV NODE_ENV=production
RUN addgroup -S localshare && adduser -S localshare -G localshare

COPY --from=builder --chown=localshare:localshare /workspace/node_modules /workspace/node_modules
COPY --from=builder --chown=localshare:localshare /workspace/packages /workspace/packages
COPY --from=builder --chown=localshare:localshare /workspace/apps/api/package.json ./package.json
COPY --from=builder --chown=localshare:localshare /workspace/apps/api/dist ./dist
COPY --from=builder --chown=localshare:localshare /workspace/apps/api/prisma ./prisma
COPY --from=builder --chown=localshare:localshare /workspace/apps/api/node_modules ./node_modules

USER localshare
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/api/v1/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]

