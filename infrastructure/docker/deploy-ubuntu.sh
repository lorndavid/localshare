#!/usr/bin/env bash
# ==============================================================================
# LocalShare — Production Deployment Script for Ubuntu Home Server
# Target Domain: https://cloud.lorndavid.online (via Cloudflare Tunnel)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
DOMAIN="${1:-https://cloud.lorndavid.online}"
GATEWAY_PORT="${GATEWAY_PORT:-8090}"

echo "============================================================"
echo " LocalShare Production Deployment"
echo " Domain:       ${DOMAIN}"
echo " Gateway Port: 127.0.0.1:${GATEWAY_PORT}"
echo "============================================================"

if [ ! -f "${ENV_FILE}" ]; then
  echo "[1/4] Generating cryptographically strong production secrets in ${ENV_FILE} ..."
  PG_PASS="$(openssl rand -hex 24)"
  JWT_SEC="$(openssl rand -base64 48 | tr -d '\n')"
  ENC_KEY="$(openssl rand -base64 32 | tr -d '\n')"

  cat > "${ENV_FILE}" <<EOF
POSTGRES_USER=localshare
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DB=localshare
JWT_SECRET=${JWT_SEC}
PROVIDER_ENCRYPTION_KEY=${ENC_KEY}
CORS_ORIGINS=${DOMAIN}
GATEWAY_PORT=${GATEWAY_PORT}
CLOUDFLARE_TUNNEL_TOKEN=
EOF
  chmod 600 "${ENV_FILE}"
  echo "      Created ${ENV_FILE} (chmod 600)."
else
  echo "[1/4] Found existing ${ENV_FILE} — keeping existing database & encryption secrets."
fi

echo "[2/4] Building and starting Docker containers (postgres, api, web-dashboard, nginx)..."
cd "${REPO_ROOT}"
docker compose -f infrastructure/docker/docker-compose.prod.yml --env-file "${ENV_FILE}" up -d --build

echo "[3/4] Waiting for LocalShare API & Database migrations to become healthy..."
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/api/v1/health" >/dev/null 2>&1; then
    echo "      Health check passed: http://127.0.0.1:${GATEWAY_PORT}/api/v1/health"
    break
  fi
  sleep 2
done

echo "[4/4] Verifying gateway status..."
curl -i -s "http://127.0.0.1:${GATEWAY_PORT}/api/v1/health" | head -n 10

echo ""
echo "============================================================"
echo " LocalShare is LIVE locally on port ${GATEWAY_PORT}!"
echo " Next: Point your Cloudflare Tunnel for cloud.lorndavid.online"
echo "       to -> http://localhost:${GATEWAY_PORT}"
echo "============================================================"

