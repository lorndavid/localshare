# LocalShare Production Deployment Checklists

1. **Environment Variables (`infrastructure/docker/.env`)**
   - `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
   - `JWT_SECRET` (at least 32 characters of cryptographic randomness)
   - `PROVIDER_ENCRYPTION_KEY` (base64-encoded 32-byte key for AES-256-GCM encryption of Cloudflare tokens)
   - `CORS_ORIGINS` (exact origin of the web dashboard, e.g. `https://localshare.example.com`)
2. **TLS Termination**
   - Place Cloudflare Proxy (Full Strict SSL) or an upstream TLS terminator in front of the `nginx` service in `infrastructure/docker/docker-compose.prod.yml`.
3. **Database Migrations**
   - `apps/api/Dockerfile` runs `npx prisma migrate deploy` automatically before starting `dist/main.js`.
4. **Health Monitoring**
   - Monitor `GET /api/v1/health` (returns HTTP 200 with `{ "status": "ok", "checks": { "database": { "status": "up" } } }`).

