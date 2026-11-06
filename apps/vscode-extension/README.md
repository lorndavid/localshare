# LocalShare — Secure Local Server Sharing for VS Code

LocalShare lets developers expose local development applications (`React`, `Vue`, `Next.js`, `Nuxt`, `Vite`, `Angular`, `Svelte`, `NestJS`, `Express`, `FastAPI`, `Flask`, `Laravel`, and `Docker Compose` services) through verified HTTPS URLs in one click.

## Key Features

- **Smart Server & Framework Detection:** Automatically identifies your workspace framework, dev scripts, Docker Compose port mappings, and active local TCP listeners.
- **One-Click Temporary Sharing:** Uses Cloudflare Quick Tunnels (`*.trycloudflare.com`) with zero mandatory account setup. Downloads and verifies `cloudflared` against official SHA-256 release digests before execution.
- **Multiple Concurrent Tunnels:** Share frontend (`localhost:5173`), backend (`localhost:4000`), and admin (`localhost:3001`) simultaneously with independent lifecycles and grouped sharing.
- **Security by Default:**
  - Explicit confirmation before any local port becomes public.
  - Blocks databases (`PostgreSQL`, `MySQL`, `MariaDB`, `Redis`, `MongoDB`, `SQL Server`), `SSH`, and `Docker` daemons by default.
  - Optional local password gateway (HTTP Basic + signed session cookies, WebSocket/HMR compatible).
  - Automatic secret redaction across logs and diagnostics.
- **Custom Domains & Named Tunnels:** Connect a Cloudflare account to route persistent hostnames (e.g. `preview.customer.com`) with DNS & HTTPS verification and Cloudflare Access policies.

