# LocalShare Production Deployment Guide

This guide covers:
1. Deploying the **LocalShare Cloud Control Plane** (`https://cloud.lorndavid.online`) on an **Ubuntu Home Server** behind a private ISP/CGNAT using **Docker Compose** and **Cloudflare Tunnel**.
2. Publishing the **LocalShare VS Code Extension** to the **Visual Studio Marketplace**.
3. How external developers use the extension from anywhere in the world.

---

## 1. Deploy Backend & Dashboard on Your Ubuntu Home Server (`cloud.lorndavid.online`)

Because your Ubuntu server (16 GB RAM, 8-Core CPU) sits behind a Cambodian ISP private network (no public static IP / CGNAT), **Cloudflare Tunnel (`cloudflared`)** makes an outbound encrypted connection from your Ubuntu server to Cloudflare's edge and routes `https://cloud.lorndavid.online` to your local Docker Nginx gateway (`http://localhost:8080`) with zero router port-forwarding required.

### Step 1.1 — Copy or Clone the Project onto Your Ubuntu Server
```bash
git clone <your-git-repo-url> ~/localshare
cd ~/localshare
```
*(Or copy the project folder from your Windows PC to your Ubuntu server using `scp -r "d:/REAL LIFE PROJECT/Argon Test" user@<ubuntu-lan-ip>:~/localshare`).*

### Step 1.2 — Run the One-Command Production Deployment Script
On your Ubuntu server, run:
```bash
chmod +x infrastructure/docker/deploy-ubuntu.sh
./infrastructure/docker/deploy-ubuntu.sh https://cloud.lorndavid.online
```
What `deploy-ubuntu.sh` does automatically:
1. Generates cryptographically random `POSTGRES_PASSWORD`, `JWT_SECRET` (48 bytes), and `PROVIDER_ENCRYPTION_KEY` (32-byte AES-256-GCM key) in `infrastructure/docker/.env` (`chmod 600`).
2. Sets `CORS_ORIGINS=https://cloud.lorndavid.online` and `GATEWAY_PORT=8080`.
3. Builds and starts 4 production containers (`restart: always`):
   - `postgres` (`postgres:16-alpine` with persistent volume `pgdata_prod`)
   - `api` (NestJS Cloud API — automatically runs `prisma migrate deploy` on boot)
   - `web-dashboard` (React + Vite production bundle)
   - `nginx` (Unified reverse proxy listening on `http://localhost:8080`, routing `/` to the Web Dashboard and `/api/v1/*` to the NestJS API)
4. Verifies `http://127.0.0.1:8080/api/v1/health` returns `200 OK`.

### Step 1.3 — Point Your Cloudflare Tunnel (`cloud.lorndavid.online`) to Port `8080`
Depending on how you manage your Cloudflare Tunnel on Ubuntu:

- **Option A: Via Cloudflare Zero Trust Dashboard (Recommended if you already run `cloudflared` on Ubuntu):**
  1. Open [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels**.
  2. Select your Ubuntu server's tunnel → **Configure** → **Public Hostname** → **Add a public hostname**:
     - **Subdomain:** `cloud`
     - **Domain:** `lorndavid.online`
     - **Service Type:** `HTTP`
     - **URL:** `localhost:8080` (or `host.docker.internal:8080` if your `cloudflared` runs in another Docker container)
  3. Click **Save hostname**.
- **Option B: Via Local `/etc/cloudflared/config.yml` on Ubuntu:**
  Add the ingress rule above the catch-all `http_status:404`:
  ```yaml
  ingress:
    - hostname: cloud.lorndavid.online
      service: http://localhost:8080
    - service: http_status:404
  ```
  Then restart `cloudflared`:
  ```bash
  sudo systemctl restart cloudflared
  ```

### Step 1.4 — Verify `https://cloud.lorndavid.online`
Run from anywhere:
```bash
curl -i https://cloud.lorndavid.online/api/v1/health
```
And open `https://cloud.lorndavid.online` in your browser to register your admin account and create your organization.

---

## 2. Publish the VS Code Extension to the Visual Studio Marketplace

The extension in `apps/vscode-extension` is already preconfigured with:
- `"publisher": "lorndavid"`
- Default Cloud URL: `https://cloud.lorndavid.online/api/v1`
- Built VSIX package: `apps/vscode-extension/dist/localshare.vsix`

### Step 2.1 — Create Your Publisher on Visual Studio Marketplace
1. Open https://marketplace.visualstudio.com/manage/createpublisher?managePageRedirect=true and sign in with your Microsoft account.
2. Fill in the form:
   - **ID (Publisher ID):** `lorndavid` *(Important: this must match `"publisher"` in `apps/vscode-extension/package.json`. If you pick a different ID on the website, update `"publisher"` in `apps/vscode-extension/package.json` and run `pnpm --filter localshare-vscode run package`).*
   - **Name (Display Name):** `Lorn David` (or `LocalShare`)
3. Click **Create**.

### Step 2.2 — Upload `localshare.vsix` (Easiest — Direct Web Upload)
1. On your publisher management page (`https://marketplace.visualstudio.com/manage/publishers/lorndavid`), click **+ New extension** → **Visual Studio Code**.
2. Drag and drop the file:
   `d:\REAL LIFE PROJECT\Argon Test\apps\vscode-extension\dist\localshare.vsix`
3. Click **Upload**. Microsoft will verify the VSIX in ~2–3 minutes and publish **LocalShare** live to the VS Code Marketplace!

*(Optional CLI method for future updates: create a Personal Access Token in Azure DevOps with **Marketplace (Manage)** scope, then run `npx @vscode/vsce login lorndavid` and `npx @vscode/vsce publish`).*

