# LocalShare Automated Testing Strategy

## 1. Unit Tests
- **`@localshare/validation` (`packages/validation/test/validation.test.ts` — 115 tests):**
  - Port range & format validation (`validatePort`).
  - IPv4 & IPv6 literal parsing and classification (`loopback`, `private`, `linkLocal`, `unspecified`, `multicast`, `reserved`, `public`).
  - SSRF & DNS rebinding guards (`validateLocalHost`, `validateLocalTarget`).
  - Hostname & punycode validation (`validateHostname`, `isHostnameInZone`, `candidateZones`).
  - Sensitive port, process & protocol banner detection (`getSensitiveService`, `getSensitiveProcess`, `detectNonHttpBanner`).
  - Credential & token redaction (`redactSecrets`).
- **VS Code Extension Core (`apps/vscode-extension/test/unit/core.test.ts` & `securityAndPerf.test.ts` — 42 tests):**
  - Explicit tunnel state machine valid and invalid transitions.
  - Framework detection (`React`, `Vite`, `Next.js`, `NestJS`, `Docker Compose`, `netstat` IPv4/IPv6 deduplication).
  - `cloudflared` SHA-256 checksum verification and tamper rejection.
  - Cloudflare REST API v4 adapter (`CloudflareApiClient`) for token verification, zone lookup, Named Tunnel creation, ingress rules, CNAME management, and DNS/HTTPS verification.
  - Command-injection, SSRF, and sensitive-port blocking across all 35+ sensitive ports.
  - Performance benchmarks: 40-project monorepo scan (`< 800ms`), 10 concurrent tunnels, and 1,000-line redaction throughput (`< 300ms`).
- **Cloud API (`apps/api/test/unit/api.unit.spec.ts` — 4 tests):**
  - `AES-256-GCM` provider token encryption/decryption & tamper detection.
  - `lsk_` personal API token & refresh token SHA-256 hashing.
  - Environment configuration validation and RBAC role hierarchy.
- **Web Dashboard (`apps/web-dashboard/test/dashboard.test.tsx` — 2 tests):**
  - In-memory access token storage & automatic single-flight `/auth/refresh` on `401`.
  - Login form validation, organization overview rendering, and DNS TXT verification challenge display.

## 2. Integration Tests
- **Extension Workflow (`apps/vscode-extension/test/integration/extensionFlow.test.ts` — 3 tests):**
  - Live HTTP server detection and health probes on temporary workspace fixtures.
  - Live `LocalPasswordGateway` HTTP Basic Auth, signed session cookie, and WebSocket upgrade proxying.
  - Concurrent multi-tunnel lifecycle (Frontend + Backend), duplicate prevention, auto-reconnect on unexpected process exit, and verification that stopping a tunnel never terminates the developer's local server.
- **Cloud API + PostgreSQL 16 (`apps/api/test/integration/api.integration.spec.ts` — 2 comprehensive suites):**
  - Real Prisma migrations applied to PostgreSQL 16.
  - Registration, login, refresh token rotation, refresh token reuse revocation, personal API token (`lsk_`) lifecycle, strict cross-tenant isolation (`404` across organizations), RBAC (`VIEWER` vs `MEMBER` vs `ADMIN` vs `OWNER`, last-`OWNER` protection), idempotent tunnel upsert, DNS TXT domain verification, and redacted audit events.

## 3. End-to-End (E2E) Tests
- **Playwright Full-Stack E2E (`apps/web-dashboard/e2e/dashboard.spec.ts`):**
  - Boots the NestJS API against PostgreSQL and the Vite dashboard, runs `@axe-core/playwright` accessibility checks, registers a user, creates an organization, creates a workspace, adds a custom domain and verifies its TXT record challenge, creates an access policy, generates a show-once `lsk_` API token, verifies audit activity logs, toggles dark/light themes, and logs out.

