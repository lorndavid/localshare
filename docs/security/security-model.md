# LocalShare Security Model

## Core Security Controls

1. **Explicit Public Exposure Confirmation**
   - Before any local server is exposed, LocalShare prompts the developer and clearly states whether the link is an unauthenticated public URL or protected by a preview password / Cloudflare Access policy.
   - Temporary random URLs (`*.trycloudflare.com`) are never described as private.

2. **Sensitive Service Blocking by Default**
   - LocalShare blocks databases (`PostgreSQL :5432`, `MySQL/MariaDB :3306`, `SQL Server :1433`, `Oracle :1521`, `MongoDB :27017`, `CouchDB :5984`, `Elasticsearch :9200`, `Cassandra :9042`), caches (`Redis :6379`, `Memcached :11211`), remote administration (`SSH :22`, `Telnet :23`, `RDP :3389`, `VNC :5900`, `WinRM :5985/5986`, `SMB :445`), and container control planes (`Docker :2375/2376`, `Kubernetes :6443/10250`, `etcd :2379`).
   - Also inspects initial TCP greeting banners (`SSH-`, `MySQL`, `Redis`, `SMTP`, `VNC`) and OS process names (`postgres.exe`, `mysqld.exe`, `redis-server.exe`, `mongod.exe`, `sshd.exe`, `dockerd.exe`).

3. **SSRF & DNS Rebinding Protection**
   - Only loopback targets (`localhost`, `127.0.0.1`, `::1`) are allowed by default.
   - Link-local addresses (`169.254.0.0/16`, `fe80::/10`, including cloud metadata endpoints), public IPs, multicast, and arbitrary external hostnames are unconditionally rejected.
   - RFC1918 LAN targets require explicit opt-in via `localshare.security.allowLanTargets` and display a prominent warning in the Security sidebar.

4. **Verified Binary Execution & Safe Process Spawning**
   - Downloaded `cloudflared` binaries are verified against official GitHub release SHA-256 digests before being written or executed, and re-verified on every launch.
   - Child processes are spawned with `shell: false` and validated argument arrays. Stopping a tunnel terminates only the `cloudflared` connector process and never the developer's application.

5. **Secret Storage & Automatic Redaction**
   - Extension secrets are stored exclusively in VS Code `SecretStorage`.
   - Cloud provider tokens are encrypted at rest using `AES-256-GCM`.
   - `redactSecrets` scrubs bearer tokens, Basic credentials, Cloudflare tunnel tokens, API keys, and registered secret values across logs, error responses, and audit records.

