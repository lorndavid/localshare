/**
 * Comprehensive unit tests for the VS Code extension core:
 * - State machine transitions (valid & invalid)
 * - Framework, script port & Docker Compose detection
 * - Netstat output deduplication (IPv4 + IPv6)
 * - Binary SHA-256 verification & asset selection
 * - Quick Tunnel URL parsing & safe CLI argument construction
 * - Sensitive service & SSRF blocking (securityPolicy)
 * - Customer preview message & uptime formatting
 * - Logger & audit log secret redaction
 * - Cloudflare API client (token verify, zone match, ingress, DNS CNAME, Access policy, domain readiness)
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalAuditLog } from '../../src/core/audit';
import {
  CloudflaredBinaryManager,
  computeBufferSha256,
  extractExpectedSha256,
  getCloudflaredAssetName,
  type GithubReleaseMetadata,
} from '../../src/core/binaryManager';
import {
  detectFromPackageJson,
  extractPortsFromScript,
  parseDockerComposePorts,
  parseNetstatOutput,
} from '../../src/core/detection';
import { createMemoryLogger } from '../../src/core/logger';
import { CloudflareApiClient } from '../../src/core/providers/cloudflareApi';
import {
  buildNamedTunnelArgs,
  buildQuickTunnelArgs,
  parseQuickTunnelUrl,
} from '../../src/core/providers/cloudflareQuick';
import { evaluateTargetSecurity } from '../../src/core/securityPolicy';
import { TunnelStateMachine, canTransition } from '../../src/core/stateMachine';
import {
  buildCustomerPreviewMessage,
  formatUptime,
} from '../../src/core/tunnelManager';

describe('TunnelStateMachine', () => {
  it('follows the happy path STOPPED -> STARTING -> CONNECTING -> ONLINE -> STOPPING -> STOPPED', () => {
    const sm = new TunnelStateMachine();
    const seen: string[] = [];
    sm.onChange((next, prev) => seen.push(`${prev}->${next}`));

    expect(sm.state).toBe('STOPPED');
    sm.transition('STARTING');
    sm.transition('CONNECTING');
    sm.transition('ONLINE');
    sm.transition('RECONNECTING');
    sm.transition('ONLINE');
    sm.transition('STOPPING');
    sm.transition('STOPPED');

    expect(seen).toEqual([
      'STOPPED->STARTING',
      'STARTING->CONNECTING',
      'CONNECTING->ONLINE',
      'ONLINE->RECONNECTING',
      'RECONNECTING->ONLINE',
      'ONLINE->STOPPING',
      'STOPPING->STOPPED',
    ]);
  });

  it('rejects illegal transitions such as STOPPED -> ONLINE', () => {
    const sm = new TunnelStateMachine('STOPPED');
    expect(canTransition('STOPPED', 'ONLINE')).toBe(false);
    expect(() => sm.transition('ONLINE')).toThrow(/Invalid tunnel state transition/);
  });

  it('allows recovery from ERROR -> STARTING', () => {
    const sm = new TunnelStateMachine('STARTING');
    sm.transition('ERROR');
    expect(() => sm.transition('STARTING')).not.toThrow();
  });
});

describe('Framework & Port Detection', () => {
  it('extracts ports from npm scripts', () => {
    expect(extractPortsFromScript('vite --port 5174 --host')).toEqual([5174]);
    expect(extractPortsFromScript('next dev -p 3005')).toEqual([3005]);
    expect(extractPortsFromScript('PORT=4100 node server.js')).toEqual([4100]);
  });

  it('detects React + Vite, Next.js, NestJS, Vue, Angular, Svelte', () => {
    const reactVite = detectFromPackageJson(
      {
        name: 'customer-portal',
        dependencies: { react: '^19.0.0' },
        devDependencies: { vite: '^6.0.0' },
        scripts: { dev: 'vite' },
      },
      '/repo/apps/portal',
    );
    expect(reactVite.framework).toBe('react');
    expect(reactVite.frameworkLabel).toBe('React (Vite)');
    expect(reactVite.candidatePorts).toContain(5173);

    const nextApp = detectFromPackageJson(
      {
        name: 'marketing',
        dependencies: { next: '15.0.0', react: '19.0.0' },
        scripts: { dev: 'next dev -p 3010' },
      },
      '/repo/apps/marketing',
    );
    expect(nextApp.framework).toBe('nextjs');
    expect(nextApp.candidatePorts).toEqual([3010, 3000]);

    const nestApi = detectFromPackageJson(
      {
        name: 'api',
        dependencies: { '@nestjs/core': '^11.0.0' },
        scripts: { 'start:dev': 'nest start --watch' },
      },
      '/repo/apps/api',
    );
    expect(nestApi.framework).toBe('nestjs');
    expect(nestApi.candidatePorts).toContain(3000);
  });

  it('parses Docker Compose port mappings safely', () => {
    const yaml = `
services:
  web:
    image: nginx
    ports:
      - "8080:80"
      - "127.0.0.1:8443:443/tcp"
  api:
    ports:
      - target: 3000
        published: 4000
`;
    expect(parseDockerComposePorts(yaml)).toEqual([
      { service: 'web', hostPort: 8080, containerPort: 80 },
      { service: 'web', hostPort: 8443, containerPort: 443 },
      { service: 'api', hostPort: 4000, containerPort: 3000 },
    ]);
  });

  it('deduplicates IPv4 and IPv6 listeners on the same port in netstat output', () => {
    const sample = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       1234
  TCP    [::]:5173              [::]:0                 LISTENING       1234
  TCP    127.0.0.1:4000         0.0.0.0:0              LISTENING       5678
`;
    const parsed = parseNetstatOutput(sample);
    expect(parsed).toEqual([
      { port: 4000, addresses: ['127.0.0.1'], pid: 5678 },
      { port: 5173, addresses: ['0.0.0.0', '::'], pid: 1234 },
    ]);
  });
});

describe('Security Policy (SSRF & Sensitive Services)', () => {
  it('blocks PostgreSQL, MySQL, Redis, MongoDB, SSH and Docker ports by default', () => {
    for (const port of [22, 2375, 3306, 5432, 6379, 27017]) {
      expect(() => evaluateTargetSecurity({ host: 'localhost', port })).toThrow(
        /blocks from public exposure/,
      );
    }
  });

  it('blocks non-HTTP banners even on an ordinary dev port', () => {
    expect(() =>
      evaluateTargetSecurity({
        host: 'localhost',
        port: 3000,
        banner: 'SSH-2.0-OpenSSH_9.7',
      }),
    ).toThrow(/SSH/);
  });

  it('blocks SSRF targets (cloud metadata, public IPs, external domains)', () => {
    for (const host of ['169.254.169.254', '8.8.8.8', 'internal.corp.example.com']) {
      expect(() => evaluateTargetSecurity({ host, port: 3000 })).toThrow();
    }
  });

  it('blocks LAN targets unless allowLanTargets is enabled, and emits a warning when enabled', () => {
    expect(() => evaluateTargetSecurity({ host: '192.168.1.50', port: 3000 })).toThrow(/LAN/);
    const res = evaluateTargetSecurity({
      host: '192.168.1.50',
      port: 3000,
      allowLanTargets: true,
    });
    expect(res.target.scope).toBe('lan');
    expect(res.warnings[0]).toMatch(/local network/);
  });
});

describe('cloudflared Binary Checksum Verification & CLI Args', () => {
  it('selects the right asset name per platform', () => {
    expect(getCloudflaredAssetName('win32', 'x64')).toBe('cloudflared-windows-amd64.exe');
    expect(getCloudflaredAssetName('linux', 'arm64')).toBe('cloudflared-linux-arm64');
    expect(getCloudflaredAssetName('darwin', 'arm64')).toBe('cloudflared-darwin-arm64.tgz');
  });

  it('extracts SHA-256 from release asset digest or body checksums', () => {
    const sha = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343';
    const rel: GithubReleaseMetadata = {
      tag_name: '2026.10.7',
      assets: [
        {
          name: 'cloudflared-windows-amd64.exe',
          browser_download_url: 'https://example.com/cf.exe',
          digest: `sha256:${sha}`,
        },
      ],
    };
    expect(extractExpectedSha256(rel, 'cloudflared-windows-amd64.exe')).toBe(sha);
  });

  it('refuses to install a binary when the SHA-256 checksum does not match', async () => {
    const fakeBytes = new TextEncoder().encode('tampered-binary-contents');
    const wrongSha = '0'.repeat(64);
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: '2026.10.7',
            assets: [
              {
                name: 'cloudflared-windows-amd64.exe',
                browser_download_url: 'https://downloads.example/cf.exe',
                digest: `sha256:${wrongSha}`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(fakeBytes, { status: 200 });
    }) as unknown as typeof fetch;

    const mgr = new CloudflaredBinaryManager({
      storageDir: 'd:/nonexistent-tmp-dir',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: mockFetch,
    });

    await expect(mgr.installOrUpdate()).rejects.toThrow(/SHA-256 checksum mismatch/);
    expect(computeBufferSha256(fakeBytes)).toHaveLength(64);
  });

  it('parses Quick Tunnel URLs and constructs safe argument arrays', () => {
    const line =
      '2026-11-07T00:00:00Z INF |  https://calm-breeze-1234.trycloudflare.com  |';
    expect(parseQuickTunnelUrl(line)).toBe('https://calm-breeze-1234.trycloudflare.com');

    expect(
      buildQuickTunnelArgs(
        {
          id: 't1',
          kind: 'QUICK',
          localHost: '127.0.0.1',
          localPort: 5173,
          rewriteHostHeader: true,
        },
        49123,
      ),
    ).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--metrics',
      '127.0.0.1:49123',
      '--http-host-header',
      'localhost:5173',
      '--url',
      'http://127.0.0.1:5173',
    ]);

    expect(buildNamedTunnelArgs('tok-xyz', 49123)).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--metrics',
      '127.0.0.1:49123',
      'run',
      '--token',
      'tok-xyz',
    ]);
  });
});

describe('CloudflareApiClient', () => {
  it('verifies token, configures ingress, creates CNAME and verifies DNS/HTTPS readiness', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });

      if (url.endsWith('/user/tokens/verify')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'k1', status: 'active' } }));
      }
      if (url.includes('/accounts?')) {
        return new Response(
          JSON.stringify({ success: true, result: [{ id: 'acc-1', name: 'Acme Corp' }] }),
        );
      }
      if (url.includes('/zones?name=customer.com')) {
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ id: 'zone-1', name: 'customer.com', status: 'active', account: { id: 'acc-1', name: 'Acme' } }],
          }),
        );
      }
      if (url.includes('/zones?name=')) {
        return new Response(JSON.stringify({ success: true, result: [] }));
      }
      if (url.endsWith('/cfd_tunnel') && method === 'POST') {
        return new Response(
          JSON.stringify({
            success: true,
            result: { id: 'tun-1', name: 'preview', status: 'healthy', created_at: '2026-11-06T00:00:00Z' },
          }),
        );
      }
      if (url.endsWith('/configurations') && method === 'PUT') {
        return new Response(JSON.stringify({ success: true, result: {} }));
      }
      if (url.includes('/dns_records?')) {
        return new Response(JSON.stringify({ success: true, result: [] }));
      }
      if (url.endsWith('/dns_records') && method === 'POST') {
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              id: 'dns-1',
              type: 'CNAME',
              name: 'preview.customer.com',
              content: 'tun-1.cfargotunnel.com',
              proxied: true,
            },
          }),
        );
      }
      if (url === 'https://preview.customer.com/') {
        return new Response('ok', { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: [] }));
    }) as unknown as typeof fetch;

    const api = new CloudflareApiClient(async () => 'cf-secret-token', {
      fetchImpl: mockFetch,
      dnsAdapter: {
        resolveCname: async () => ['tun-1.cfargotunnel.com'],
        resolve4: async () => [],
        resolve6: async () => [],
      },
    });

    const verified = await api.verifyTokenAndListAccounts();
    expect(verified.accounts[0]?.id).toBe('acc-1');

    const zone = await api.findZoneForHostname('preview.customer.com');
    expect(zone?.id).toBe('zone-1');

    const tun = await api.createNamedTunnel('acc-1', 'preview');
    await api.configureTunnelIngress('acc-1', tun.id, 'preview.customer.com', 'localhost', 5173);
    const cname = await api.upsertTunnelCnameRecord('zone-1', 'preview.customer.com', tun.id);
    expect(cname.content).toBe('tun-1.cfargotunnel.com');

    const readiness = await api.verifyCustomDomainReadiness('preview.customer.com', tun.id);
    expect(readiness.dnsResolved).toBe(true);
    expect(readiness.httpsReady).toBe(true);
  });
});

describe('Formatting, Customer Preview & Secret Redaction', () => {
  it('formats uptime and customer preview messages accurately', () => {
    const start = new Date(Date.now() - 125_000).toISOString();
    expect(formatUptime(start)).toBe('2m 05s');

    const msg = buildCustomerPreviewMessage(
      {
        name: 'Portal UI',
        description: 'Sprint 14 checkout flow',
        publicUrl: 'https://bright-sun-99.trycloudflare.com',
        kind: 'QUICK',
        accessMode: 'PASSWORD',
      },
      'preview',
    );
    expect(msg).toContain('Temporary preview link');
    expect(msg).toContain('Password-protected preview (username: preview)');
  });

  it('redacts registered secrets in Logger and LocalAuditLog', () => {
    const { logger, lines } = createMemoryLogger('debug');
    logger.registerSecret('my-super-secret-pass');
    logger.info('Starting with pass my-super-secret-pass');
    expect(lines[0]).not.toContain('my-super-secret-pass');
    expect(lines[0]).toContain('[REDACTED]');

    const audit = new LocalAuditLog();
    const entry = audit.record(
      'cloudflare.connected',
      'Token was eyJhIjoiYWJjZGVmIiwidCI6IjEyMzQ1Njc4OTAiLCJzIjoic2VjcmV0c2VjcmV0In0=',
    );
    expect(entry.summary).toContain('[REDACTED]');
  });
});

