/**
 * Cloudflare Tunnel provider adapter (Quick Tunnels & Named Tunnels).
 *
 * Security & reliability guarantees:
 * - Never invokes a shell (`shell: false`, argument array only).
 * - Never reports ONLINE until both a public URL is assigned and readiness is verified.
 * - Cleans up only the cloudflared connector process it spawned; never touches the developer's app.
 * - Supports cancellation, startup timeouts and bounded automatic reconnection.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import {
  formatHostPort,
  validateHostname,
  validateLocalTarget,
  type ValidationResult,
} from '@localshare/validation';
import { LocalShareError } from '../errors';
import type { Logger } from '../logger';
import { TunnelStateMachine } from '../stateMachine';
import type {
  TunnelConnectConfig,
  TunnelConnectionHandle,
  TunnelProvider,
  TunnelStatusSnapshot,
} from './types';

const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\b/i;
const REGISTERED_CONN_RE = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;

/** Parse a trycloudflare.com HTTPS URL from cloudflared stdout/stderr log output. */
export function parseQuickTunnelUrl(logLine: string): string | undefined {
  const m = TRYCLOUDFLARE_URL_RE.exec(logLine);
  return m?.[0]?.toLowerCase();
}

/** Build the safe CLI argument vector for a Quick Tunnel. */
export function buildQuickTunnelArgs(
  config: TunnelConnectConfig,
  metricsPort: number,
): string[] {
  const targetUrl = `http://${formatHostPort(config.localHost, config.localPort)}`;
  const args = [
    'tunnel',
    '--no-autoupdate',
    '--metrics',
    `127.0.0.1:${metricsPort}`,
  ];
  if (config.rewriteHostHeader !== false) {
    const hostPort = config.originPort ?? config.localPort;
    args.push('--http-host-header', `localhost:${hostPort}`);
  }
  args.push('--url', targetUrl);
  return args;
}

/** Build the safe CLI argument vector for a Named Tunnel run with a connector token. */
export function buildNamedTunnelArgs(
  token: string,
  metricsPort: number,
): string[] {
  return [
    'tunnel',
    '--no-autoupdate',
    '--metrics',
    `127.0.0.1:${metricsPort}`,
    'run',
    '--token',
    token,
  ];
}

/** Allocate an ephemeral free loopback port for cloudflared's `/ready` metrics endpoint. */
export async function allocateFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Check cloudflared's local `/ready` endpoint (`200 OK` with `readyConnections > 0`). */
export function checkMetricsReady(metricsPort: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: metricsPort,
        path: '/ready',
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.once('error', () => resolve(false));
  });
}

export type SpawnProcessFn = (
  command: string,
  args: readonly string[],
) => ChildProcess;

export interface CloudflareProviderDeps {
  resolveBinaryPath: () => Promise<string>;
  spawnProcess?: SpawnProcessFn;
  checkReady?: (metricsPort: number, publicUrl: string) => Promise<boolean>;
  logger?: Logger;
  onProcessSpawned?: (tunnelId: string, pid: number) => void;
  onProcessExited?: (tunnelId: string, pid: number | undefined) => void;
}

const defaultSpawn: SpawnProcessFn = (command, args) =>
  spawn(command, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export class CloudflareTunnelProvider implements TunnelProvider {
  readonly id = 'cloudflare' as const;
  private readonly handles = new Map<string, ManagedCloudflareHandle>();

  constructor(private readonly deps: CloudflareProviderDeps) {}

  validateConfiguration(config: TunnelConnectConfig): ValidationResult<TunnelConnectConfig> {
    const target = validateLocalTarget(config.localHost, config.localPort, {
      allowLanTargets: true,
    });
    if (!target.ok) return { ok: false, error: target.error };

    if (config.kind === 'NAMED') {
      if (!config.tunnelToken || config.tunnelToken.trim().length < 16) {
        return { ok: false, error: 'Named tunnel requires a valid connector token.' };
      }
      if (!config.hostname) {
        return { ok: false, error: 'Named tunnel requires an authorized public hostname.' };
      }
      const h = validateHostname(config.hostname);
      if (!h.ok) return { ok: false, error: h.error };
    }
    return { ok: true, value: config };
  }

  async connect(config: TunnelConnectConfig): Promise<TunnelConnectionHandle> {
    const valid = this.validateConfiguration(config);
    if (!valid.ok) {
      throw new LocalShareError('INVALID_HOST', valid.error);
    }
    if (this.handles.has(config.id)) {
      throw new LocalShareError(
        'DUPLICATE_SHARE',
        `A tunnel with id "${config.id}" is already active.`,
      );
    }

    const binaryPath = await this.deps.resolveBinaryPath();
    if (config.tunnelToken) {
      this.deps.logger?.registerSecret(config.tunnelToken);
    }

    const handle = new ManagedCloudflareHandle(binaryPath, config, this.deps, () => {
      this.handles.delete(config.id);
    });
    this.handles.set(config.id, handle);

    try {
      await handle.start();
      return handle;
    } catch (err) {
      this.handles.delete(config.id);
      throw err;
    }
  }

  async disconnect(tunnelId: string): Promise<void> {
    const h = this.handles.get(tunnelId);
    if (h) {
      await h.disconnect();
    }
  }

  getStatus(tunnelId: string): TunnelStatusSnapshot | undefined {
    return this.handles.get(tunnelId)?.getStatus();
  }

  getPublicUrl(tunnelId: string): string | undefined {
    return this.handles.get(tunnelId)?.getPublicUrl();
  }

  listTunnels(): TunnelStatusSnapshot[] {
    return [...this.handles.values()].map((h) => h.getStatus());
  }
}

class ManagedCloudflareHandle implements TunnelConnectionHandle {
  readonly id: string;
  private readonly sm = new TunnelStateMachine('STOPPED');
  private readonly statusListeners = new Set<(s: TunnelStatusSnapshot) => void>();
  private child: ChildProcess | undefined;
  private publicUrl: string | undefined;
  private startedAt: string | undefined;
  private lastError: string | undefined;
  private reconnectAttempts = 0;
  private stoppingIntentionally = false;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly binaryPath: string,
    private readonly config: TunnelConnectConfig,
    private readonly deps: CloudflareProviderDeps,
    private readonly onRemoved: () => void,
  ) {
    this.id = config.id;
    this.sm.onChange(() => this.emitStatus());
  }

  getStatus(): TunnelStatusSnapshot {
    return {
      id: this.id,
      provider: 'cloudflare',
      kind: this.config.kind,
      state: this.sm.state,
      publicUrl: this.publicUrl,
      pid: this.child?.pid,
      startedAt: this.startedAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  getPublicUrl(): string | undefined {
    return this.publicUrl;
  }

  onStatusChange(listener: (snapshot: TunnelStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async start(): Promise<void> {
    this.stoppingIntentionally = false;
    this.lastError = undefined;
    this.sm.transition('STARTING');
    await this.spawnAndAwaitOnline();
  }

  async disconnect(): Promise<void> {
    this.stoppingIntentionally = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.sm.state !== 'STOPPED' && this.sm.state !== 'STOPPING') {
      this.sm.transition('STOPPING');
    }
    await this.terminateChild();
    if (this.sm.state !== 'STOPPED') {
      this.sm.transition('STOPPED');
    }
    this.onRemoved();
  }

  private async spawnAndAwaitOnline(): Promise<void> {
    const metricsPort = await allocateFreeLoopbackPort();
    const args =
      this.config.kind === 'NAMED'
        ? buildNamedTunnelArgs(this.config.tunnelToken ?? '', metricsPort)
        : buildQuickTunnelArgs(this.config, metricsPort);

    if (this.config.kind === 'NAMED' && this.config.hostname) {
      this.publicUrl = `https://${this.config.hostname.toLowerCase()}`;
    }

    const spawnFn = this.deps.spawnProcess ?? defaultSpawn;
    const child = spawnFn(this.binaryPath, args);
    this.child = child;
    if (child.pid !== undefined) {
      this.deps.onProcessSpawned?.(this.id, child.pid);
    }

    this.sm.transition('CONNECTING');
    const timeoutMs = this.config.startupTimeoutMs ?? 45_000;
    const recentStderr: string[] = [];

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let registeredSeen = false;

      const finishErr = (err: LocalShareError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearInterval(readyPoll);
        this.lastError = err.message;
        if (this.sm.state !== 'STOPPING' && this.sm.state !== 'STOPPED') {
          this.sm.transition('ERROR');
        }
        void this.terminateChild();
        reject(err);
      };

      const finishOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearInterval(readyPoll);
        this.startedAt = this.startedAt ?? new Date().toISOString();
        this.reconnectAttempts = 0;
        this.sm.transition('ONLINE');
        resolve();
      };

      if (this.config.signal) {
        if (this.config.signal.aborted) {
          finishErr(new LocalShareError('USER_CANCELLED', 'Tunnel startup was cancelled.'));
          return;
        }
        this.config.signal.addEventListener(
          'abort',
          () => finishErr(new LocalShareError('USER_CANCELLED', 'Tunnel startup was cancelled.')),
          { once: true },
        );
      }

      const tryComplete = async () => {
        if (settled || !this.publicUrl) return;
        const readyFn = this.deps.checkReady;
        const ready = readyFn
          ? await readyFn(metricsPort, this.publicUrl)
          : registeredSeen || (await checkMetricsReady(metricsPort));
        if (ready && !settled) {
          finishOk();
        }
      };

      const handleLine = (line: string) => {
        this.deps.logger?.debug(`[cloudflared:${this.id}] ${line}`);
        if (recentStderr.length >= 15) recentStderr.shift();
        recentStderr.push(line);

        if (this.config.kind === 'QUICK' && !this.publicUrl) {
          const parsed = parseQuickTunnelUrl(line);
          if (parsed) {
            this.publicUrl = parsed;
            this.emitStatus();
            void tryComplete();
          }
        }
        if (REGISTERED_CONN_RE.test(line)) {
          registeredSeen = true;
          void tryComplete();
        }
      };

      const attachStream = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) return;
        let buf = '';
        stream.on('data', (chunk: Buffer | string) => {
          buf += chunk.toString();
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? '';
          for (const l of lines) {
            if (l.trim().length > 0) handleLine(l);
          }
        });
      };

      attachStream(child.stdout);
      attachStream(child.stderr);

      const readyPoll = setInterval(() => {
        void tryComplete();
      }, 350);

      const timeoutTimer = setTimeout(() => {
        finishErr(
          new LocalShareError(
            'TUNNEL_STARTUP_TIMEOUT',
            `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for tunnel to come online.`,
            'Check your internet connection and verify that cloudflared can reach Cloudflare.',
          ),
        );
      }, timeoutMs);

      child.once('error', (err) => {
        finishErr(
          new LocalShareError(
            'TUNNEL_PROCESS_FAILED',
            `Failed to launch cloudflared: ${err.message}`,
          ),
        );
      });

      child.once('exit', (code, signal) => {
        this.deps.onProcessExited?.(this.id, child.pid);
        if (!settled) {
          const tail = recentStderr.slice(-3).join(' | ');
          finishErr(
            new LocalShareError(
              'TUNNEL_PROCESS_FAILED',
              `cloudflared exited before tunnel became ready (code ${code ?? signal ?? 'unknown'})${tail ? `: ${tail}` : ''}`,
            ),
          );
          return;
        }
        this.onUnexpectedExit(code, signal);
      });
    });
  }

  private onUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stoppingIntentionally || this.sm.state === 'STOPPING' || this.sm.state === 'STOPPED') {
      return;
    }
    const maxAttempts = 3;
    if (this.config.autoReconnect !== false && this.reconnectAttempts < maxAttempts) {
      this.reconnectAttempts += 1;
      this.lastError = `Connector exited (${code ?? signal ?? 'unknown'}); reconnecting (attempt ${this.reconnectAttempts}/${maxAttempts})…`;
      this.sm.transition('RECONNECTING');
      const delayMs = Math.min(4000, 750 * this.reconnectAttempts);
      this.reconnectTimer = setTimeout(() => {
        if (this.stoppingIntentionally) return;
        if (this.config.kind === 'QUICK') {
          this.publicUrl = undefined;
        }
        this. spawnAndAwaitOnline().catch((err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          if (this.sm.state !== 'STOPPED') {
            this.sm.transition('ERROR');
          }
        });
      }, delayMs);
    } else {
      this.lastError = `cloudflared exited unexpectedly (code ${code ?? signal ?? 'unknown'}).`;
      this.sm.transition('ERROR');
    }
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.killed) return;

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
        resolve();
      }, 2500);

      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  private emitStatus(): void {
    const snap = this.getStatus();
    for (const l of this.statusListeners) {
      l(snap);
    }
  }
}

