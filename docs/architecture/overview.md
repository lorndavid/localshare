# LocalShare Architecture Overview

LocalShare is structured into three decoupled layers:

1. **Layer A — VS Code Extension (`apps/vscode-extension`)**
   - Workspace, framework, `package.json`, Python, Laravel, and Docker Compose detection.
   - Cross-platform OS TCP listener discovery (`netstat`/`tasklist` on Windows, `lsof` on macOS/Linux) with IPv4/IPv6 port deduplication.
   - Multi-tunnel lifecycle management (`TunnelManager`) backed by an explicit state machine (`STOPPED`, `STARTING`, `CONNECTING`, `ONLINE`, `RECONNECTING`, `STOPPING`, `ERROR`).
   - Optional local password gateway (`LocalPasswordGateway`) listening on `127.0.0.1:0` with HTTP Basic Auth (`crypto.timingSafeEqual`), HMAC-signed session cookies, and WebSocket upgrade proxying.
   - Native 6-panel VS Code sidebar (`Workspace`, `Local Servers`, `Active Shares`, `Custom Domains`, `Security`, `Settings`).

2. **Layer B — Tunnel Provider Abstraction (`src/core/providers/*`)**
   - Exposes a provider-agnostic `TunnelProvider` interface (`connect()`, `disconnect()`, `getStatus()`, `getPublicUrl()`, `listTunnels()`, `validateConfiguration()`).
   - `CloudflareTunnelProvider` manages Quick Tunnels and Named Tunnels using safe argument arrays (`shell: false`), SHA-256 verified `cloudflared` binaries, and `/ready` metrics verification before reporting `ONLINE`.
   - `CloudflareApiClient` integrates with Cloudflare API v4 for account verification, zone discovery, Named Tunnel ingress rules, DNS CNAME setup, Cloudflare Access policies, and live DNS + HTTPS verification.

3. **Layer C — Optional LocalShare Cloud Platform (`apps/api`, `apps/web-dashboard`)**
   - Stores **metadata only** (organizations, members, workspaces, tunnel metadata, custom domains, access policies, encrypted provider connections, and audit events).
   - Never proxies customer application traffic and never stores source code.
   - The VS Code extension works 100% offline in local-only mode when the cloud platform is not configured.

