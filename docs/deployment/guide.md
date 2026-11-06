# LocalShare Development, Testing & Deployment Guide

## Development Prerequisites
- Node.js `>= 20.11` (tested on Node `24.22.2`)
- `pnpm 9.15.0`
- Docker (for PostgreSQL integration & E2E tests)

## Commands Reference

| Scope | Command | Description |
|---|---|---|
| Monorepo | `pnpm build:packages` | Build `@localshare/shared-types` and `@localshare/validation` |
| Validation | `pnpm --filter @localshare/validation test` | Run 115 unit tests for IP/port/hostname/SSRF/redaction |
| Extension | `pnpm --filter localshare-vscode test` | Run unit, integration, security & performance tests |
| Extension | `pnpm --filter localshare-vscode package` | Bundle with esbuild and create `dist/localshare.vsix` |
| API | `pnpm --filter @localshare/api test` | Run API unit tests |
| API | `pnpm --filter @localshare/api test:integration` | Run PostgreSQL integration & tenant-isolation tests |
| Dashboard | `pnpm --filter @localshare/web-dashboard test` | Run Vitest + React Testing Library suite |
| Dashboard | `pnpm --filter @localshare/web-dashboard test:e2e` | Run Playwright full-stack E2E + Axe accessibility suite |

## Production Deployment & Database Backup / Recovery

### Deploying with Docker Compose
1. Copy `infrastructure/docker/.env.example` to `infrastructure/docker/.env` and set strong values for `POSTGRES_PASSWORD`, `JWT_SECRET` (>= 32 bytes), and `PROVIDER_ENCRYPTION_KEY` (base64-encoded 32 random bytes: `openssl rand -base64 32`).
2. Start the stack:
   ```bash
   docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/docker-compose.prod.yml up --build -d
   ```
3. The API container automatically runs `npx prisma migrate deploy` on startup and exposes `/api/v1/health` for container health checks.

### PostgreSQL Backup & Restore
- **Backup:**
  ```bash
  docker exec <postgres-container> pg_dump -U localshare -Fc localshare > localshare_$(date +%F).dump
  ```
- **Restore:**
  ```bash
  docker exec -i <postgres-container> pg_restore -U localshare -d localshare --clean < localshare_2026-11-07.dump
  ```

