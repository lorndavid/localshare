/**
 * Integration tests for LocalShare extension workflows:
 * - Real local HTTP servers & workspace project detection
 * - Real LocalPasswordGateway (HTTP Basic Auth, signed cookie & WebSocket upgrade forwarding)
 * - Multi-tunnel lifecycle (start frontend, start backend, stop one while the other stays online,
 *   stop all, auto-reconnect, verify developer servers are never killed)
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAuditLog } from '../../src/core/audit';
import { detectLocalServers, probeLocalPort } from '../../src/core/detection';
import { createMemoryLogger } from '../../src/core/logger';
import { LocalPasswordGateway } from '../../src/core/passwordGateway';
import { CloudflareTunnelProvider } from '../../src/core/providers/cloudflareQuick';
import {
  TunnelManager,
  type PersistedSessionRecord,
  type ShareHistoryEntry,
} from '../../src/core/tunnelManager';

async function startTestHttpServer(responseText = 'hello from local dev server'): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Received-Host': req.headers.host ?? '' });
    res.end(responseText);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  server.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.on('data', (d) => socket.write(d));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as net.AddressInfo;
  return {
    server,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

class FakeCloudflaredProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = Math.floor(10_000 + Math.random() * 50_000);
  exitCode: number | null = null;
  killed = false;

  kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, 'SIGTERM'));
    return true;
  }

  crash(code = 1): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

describe('Integration: Local Server Detection & Health Probes', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('detects a workspace project and its live HTTP port', async () => {
    const srv = await startTestHttpServer('vite-app-ok');
    cleanups.push(srv.close);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'localshare-ws-'));
    cleanups.push(() => rm(tmpDir, { recursive: true, force: true }));

    await writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'acme-web',
        dependencies: { react: '^19.0.0' },
        devDependencies: { vite: '^6.0.0' },
        scripts: { dev: `vite --port ${srv.port}` },
      }),
      'utf8',
    );

    const probe = await probeLocalPort(srv.port);
    expect(probe.reachable).toBe(true);
    expect(probe.isHttp).toBe(true);
    expect(probe.httpStatus).toBe(200);

    const detected = await detectLocalServers({
      workspaceFolders: [tmpDir],
    });
    expect(detected.projects[0]?.name).toBe('acme-web');
    const found = detected.servers.find((s) => s.port === srv.port);
    expect(found).toBeDefined();
    expect(found?.frameworkLabel).toBe('React (Vite)');
    expect(found?.health).toBe('healthy-http');
    expect(found?.shareable).toBe(true);
  });
});

describe('Integration: LocalPasswordGateway (HTTP + Cookie + WebSocket)', () => {
  it('blocks unauthenticated requests, authenticates Basic Auth, sets session cookie and forwards WebSockets', async () => {
    const upstream = await startTestHttpServer('secret-preview-body');
    const authFailures: string[] = [];
    const gateway = new LocalPasswordGateway({
      targetHost: '127.0.0.1',
      targetPort: upstream.port,
      username: 'preview',
      password: 'correct-horse-battery',
      onAuthFailure: (ip) => authFailures.push(ip ?? 'unknown'),
    });

    const gwPort = await gateway.start();

    try {
      // 1. Unauthenticated -> 401
      const unauth = await fetch(`http://127.0.0.1:${gwPort}/`);
      expect(unauth.status).toBe(401);
      expect(authFailures.length).toBe(1);

      // 2. Wrong password -> 401
      const wrong = await fetch(`http://127.0.0.1:${gwPort}/`, {
        headers: {
          Authorization: `Basic ${Buffer.from('preview:wrong-password-1').toString('base64')}`,
        },
      });
      expect(wrong.status).toBe(401);

      // 3. Valid Basic Auth -> 200 + Set-Cookie + rewritten Host header
      const okRes = await fetch(`http://127.0.0.1:${gwPort}/`, {
        headers: {
          Authorization: `Basic ${Buffer.from('preview:correct-horse-battery').toString('base64')}`,
        },
      });
      expect(okRes.status).toBe(200);
      expect(await okRes.text()).toBe('secret-preview-body');
      expect(okRes.headers.get('x-received-host')).toBe(`localhost:${upstream.port}`);
      const setCookie = okRes.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('__localshare_auth=');
      const cookiePair = setCookie.split(';')[0]!;

      // 4. Subsequent request using only the session cookie -> 200
      const cookieRes = await fetch(`http://127.0.0.1:${gwPort}/`, {
        headers: { Cookie: cookiePair },
      });
      expect(cookieRes.status).toBe(200);

      // 5. WebSocket upgrade with cookie -> 101 Switching Protocols + echo
      const echoed = await new Promise<string>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: gwPort,
          path: '/ws',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            Cookie: cookiePair,
          },
        });
        req.once('upgrade', (_res, socket, upgradeHead) => {
          if (upgradeHead && upgradeHead.length > 0) {
            socket.destroy();
            resolve(upgradeHead.toString('utf8'));
            return;
          }
          socket.once('data', (chunk: Buffer) => {
            socket.destroy();
            resolve(chunk.toString('utf8'));
          });
          socket.write('ping-hmr');
        });
        req.once('response', (res) => {
          reject(new Error(`Unexpected non-upgrade response: ${res.statusCode}`));
        });
        req.once('error', reject);
        req.end();
      });
      expect(echoed).toBe('ping-hmr');
    } finally {
      await gateway.stop();
      await upstream.close();
    }
  });
});

describe('Integration: Multi-Tunnel Lifecycle & Auto-Reconnect', () => {
  it('runs multiple concurrent tunnels, stops one without affecting the other or the developer app, and cleans up all processes', async () => {
    const frontendSrv = await startTestHttpServer('frontend-ui');
    const backendSrv = await startTestHttpServer('backend-api');

    const spawnedProcs: FakeCloudflaredProcess[] = [];
    const { logger } = createMemoryLogger('debug');
    const audit = new LocalAuditLog();
    let historyStore: ShareHistoryEntry[] = [];
    let sessionStore: PersistedSessionRecord[] = [];

    const provider = new CloudflareTunnelProvider({
      resolveBinaryPath: async () => 'cloudflared-mock',
      spawnProcess: (_cmd, args) => {
        const proc = new FakeCloudflaredProcess();
        spawnedProcs.push(proc);
        const urlArg = args[args.indexOf('--url') + 1] ?? '';
        const slug = urlArg.endsWith(String(frontendSrv.port)) ? 'frontend-demo' : 'backend-demo';
        setTimeout(() => {
          proc.stderr.write(
            `2026-11-07T00:00:00Z INF |  https://${slug}.trycloudflare.com  |\n`,
          );
          proc.stderr.write('2026-11-07T00:00:01Z INF Registered tunnel connection connIndex=0\n');
        }, 15);
        return proc as unknown as ChildProcess;
      },
      logger,
    });

    const manager = new TunnelManager({
      provider,
      logger,
      audit,
      getSecurityConfig: () => ({
        allowLanTargets: false,
        allowedSensitivePorts: [],
        rewriteHostHeader: true,
        startupTimeoutSeconds: 10,
        autoReconnect: true,
        passwordSessionHours: 12,
      }),
      getGatewayCredentials: async () => undefined,
      loadHistory: () => historyStore,
      saveHistory: async (h) => {
        historyStore = h;
      },
      loadActiveSessionRecords: () => sessionStore,
      saveActiveSessionRecords: async (s) => {
        sessionStore = s;
      },
    });

    try {
      // 1. Start frontend share
      const fe = await manager.startShare({
        name: 'Frontend',
        host: 'localhost',
        port: frontendSrv.port,
        framework: 'react',
        frameworkLabel: 'React (Vite)',
      });
      expect(fe.state).toBe('ONLINE');
      expect(fe.publicUrl).toBe('https://frontend-demo.trycloudflare.com');

      // 2. Prevent duplicate share on same port
      await expect(
        manager.startShare({
          name: 'Duplicate Frontend',
          host: 'localhost',
          port: frontendSrv.port,
        }),
      ).rejects.toThrow(/already being shared/);

      // 3. Start backend share concurrently
      const be = await manager.startShare({
        name: 'Backend API',
        host: 'localhost',
        port: backendSrv.port,
        framework: 'nestjs',
        frameworkLabel: 'NestJS',
      });
      expect(be.state).toBe('ONLINE');
      expect(be.publicUrl).toBe('https://backend-demo.trycloudflare.com');
      expect(manager.listShares()).toHaveLength(2);

      // 4. Rename, describe and group shares
      const renamed = await manager.renameShare(fe.id, 'Customer Portal UI');
      expect(renamed.name).toBe('Customer Portal UI');
      await manager.updateShareDescription(fe.id, 'Ready for sprint review');
      await manager.setShareGroup(fe.id, 'Commerce Stack');
      await manager.setShareGroup(be.id, 'Commerce Stack');

      // 5. Simulate unexpected connector crash on backend -> auto-reconnects to ONLINE
      const beProc = spawnedProcs[1]!;
      beProc.crash(1);
      await new Promise((r) => setTimeout(r, 900));
      expect(manager.getShare(be.id)?.state).toBe('ONLINE');

      // 6. Stop frontend tunnel -> backend stays ONLINE and developer's frontend HTTP server STILL responds
      await manager.stopShare(fe.id);
      expect(manager.listShares()).toHaveLength(1);
      expect(manager.getShare(be.id)?.state).toBe('ONLINE');

      const stillAlive = await fetch(`http://127.0.0.1:${frontendSrv.port}/`);
      expect(stillAlive.status).toBe(200);
      expect(await stillAlive.text()).toBe('frontend-ui');

      // 7. Stop all tunnels -> no orphaned processes
      await manager.stopAllShares();
      expect(manager.listShares()).toHaveLength(0);
      expect(spawnedProcs.every((p) => p.exitCode !== null)).toBe(true);
      expect(historyStore).toHaveLength(2);
      expect(sessionStore).toHaveLength(0);
    } finally {
      await frontendSrv.close();
      await backendSrv.close();
    }
  });
});
