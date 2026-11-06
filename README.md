# LocalShare — Production-Ready VS Code Extension & Developer Platform

LocalShare allows developers to expose local development applications (`React`, `Vue`, `Vite`, `Next.js`, `Nuxt`, `Angular`, `Svelte`, `NestJS`, `Express`, `FastAPI`, `Flask`, `Laravel`, and `Docker Compose` services) to authorized external viewers through verified HTTPS URLs.

**Core workflow:**
`Open project → Detect servers → Select server → Confirm exposure → Start sharing → Copy URL → Customer previews application.`

---

## Repository Structure

```text
localshare/
├── apps/
│   ├── vscode-extension/      # Layer A & B: VS Code Extension + Tunnel Provider Adapters
│   ├── api/                   # Layer C: Optional NestJS + Prisma + PostgreSQL Control Plane API
│   └── web-dashboard/         # Layer C: Optional React 19 + Vite + Tailwind v4 Team Dashboard
├── packages/
│   ├── config/                # Shared TypeScript & ESLint flat configuration
│   ├── shared-types/          # Shared DTO & state machine contracts
│   └── validation/            # Pure SSRF, IP/port, domain, sensitive-port & secret-redaction validators
├── infrastructure/
│   ├── docker/                # Docker Compose (dev & production)
│   └── nginx/                 # Reverse proxy with rate limiting & security headers
├── docs/
│   ├── architecture/          # System design & layer boundaries
│   ├── development/           # Local development & contribution guide
│   ├── security/              # Threat model, SSRF, sensitive port blocking & redaction
│   ├── testing/               # Unit, integration, E2E, security & performance test guide
│   └── deployment/            # Production deployment, backups & recovery
└── .github/workflows/ci.yml   # Windows, Linux & macOS CI/CD pipeline
```

---

## Quick Start

### 1. Build & Package the VS Code Extension (No Cloud Required)

```powershell
pnpm install
pnpm build:packages
pnpm --filter localshare-vscode run test
pnpm --filter localshare-vscode run package
```

Install the generated VSIX package (`apps/vscode-extension/dist/localshare.vsix`) in VS Code:
```powershell
code --install-extension apps/vscode-extension/dist/localshare.vsix
```

### 2. Run the Optional LocalShare Cloud Platform

```powershell
docker compose -f infrastructure/docker/docker-compose.yml up --build -d
```

- **Web Dashboard:** `http://localhost:5180`
- **REST API & OpenAPI Docs:** `http://localhost:3100/api/docs`
- **Health Endpoint:** `http://localhost:3100/api/v1/health`

---

## Documentation

- [Architecture Overview](docs/architecture/overview.md)
- [Development Guide](docs/development/guide.md)
- [Security Model & Access Control](docs/security/security-model.md)
- [Testing Strategy](docs/testing/strategy.md)
- [Deployment, Backup & Recovery Guide](docs/deployment/guide.md)

