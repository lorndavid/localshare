/**
 * Multi-tunnel lifecycle manager, share metadata, customer preview message builder,
 * share history and orphan process recovery.
 */
import { randomUUID } from 'node:crypto';
import type { AccessMode, TunnelKind, TunnelProviderId, TunnelState } from '@localshare/shared-types';
import {
  formatHostPort,
  validateDescription,
  validateLabel,
} from '@localshare/validation';
import type { LocalAuditLog } from './audit';
import { probeLocalPort, type FrameworkId } from './detection';
import { LocalShareError } from './errors';
import type { Logger } from './logger';
import { LocalPasswordGateway } from './passwordGateway';
import type { TunnelConnectionHandle, TunnelProvider, TunnelStatusSnapshot } from './providers/types';
import { evaluateTargetSecurity } from './securityPolicy';

export interface ActiveShare {
  id: string;
  name: string;
  description: string;
  group: string;
  host: string;
  port: number;
  framework: FrameworkId;
  frameworkLabel: string;
  kind: TunnelKind;
  provider: TunnelProviderId;
  accessMode: AccessMode;
  state: TunnelState;
  publicUrl?: string;
  hostname?: string;
  namedTunnelId?: string;
  pid?: number;
  startedAt?: string;
  lastError?: string;
  localTargetHealthy: boolean;
  warnings: string[];
}

export interface ShareHistoryEntry {
  id: string;
  name: string;
  description: string;
  group: string;
  host: string;
  port: number;
  framework: FrameworkId;
  frameworkLabel: string;
  kind: TunnelKind;
  accessMode: AccessMode;
  lastPublicUrl?: string;
  hostname?: string;
  namedTunnelId?: string;
  lastSharedAt: string;
}

export interface StartShareInput {
  name?: string;
  description?: string;
  group?: string;
  host: string;
  port: number;
  framework?: FrameworkId;
  frameworkLabel?: string;
  processName?: string;
  kind?: TunnelKind;
  accessMode?: AccessMode;
  hostname?: string;
  tunnelToken?: string;
  namedTunnelId?: string;
  signal?: AbortSignal;
}

export interface PersistedSessionRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  pid?: number;
  startedAt?: string;
}

export interface TunnelManagerDeps {
  provider: TunnelProvider;
  logger: Logger;
  audit: LocalAuditLog;
  getSecurityConfig: () => {
    allowLanTargets: boolean;
    allowedSensitivePorts: number[];
    rewriteHostHeader: boolean;
    startupTimeoutSeconds: number;
    autoReconnect: boolean;
    passwordSessionHours: number;
  };
  getGatewayCredentials: () => Promise<{ username: string; password: string } | undefined>;
  loadHistory: () => ShareHistoryEntry[];
  saveHistory: (entries: ShareHistoryEntry[]) => Promise<void>;
  loadActiveSessionRecords: () => PersistedSessionRecord[];
  saveActiveSessionRecords: (records: PersistedSessionRecord[]) => Promise<void>;
  onShareChanged?: (share: ActiveShare) => void;
}

interface InternalShareRecord {
  share: ActiveShare;
  handle?: TunnelConnectionHandle;
  gateway?: LocalPasswordGateway;
  unsubscribe?: () => void;
}

/** Format elapsed uptime in a concise developer-friendly string (`42s`, `14m 08s`, `2h 15m`). */
export function formatUptime(startedAtIso: string | undefined, nowMs = Date.now()): string {
  if (!startedAtIso) return '—';
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return '—';
  const totalSec = Math.max(0, Math.floor((nowMs - started) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins.toString().padStart(2, '0')}m`;
}

/** Build a clear, honest customer preview snippet with expiration and access details. */
export function buildCustomerPreviewMessage(
  share: Pick<
    ActiveShare,
    'name' | 'description' | 'publicUrl' | 'kind' | 'accessMode'
  >,
  gatewayUsername?: string,
): string {
  const lines: string[] = [
    `Preview: ${share.name}`,
    ...(share.description ? [`Description: ${share.description}`] : []),
    `URL: ${share.publicUrl ?? '(pending)'}`,
  ];
  if (share.kind === 'QUICK') {
    lines.push(
      'Availability: Temporary preview link — stays online only while the developer session is running.',
    );
  } else {
    lines.push('Availability: Persistent custom domain route.');
  }

  if (share.accessMode === 'PASSWORD') {
    lines.push(
      `Access: Password-protected preview${gatewayUsername ? ` (username: ${gatewayUsername})` : ''}. Ask the sender for the password via a separate channel.`,
    );
  } else if (share.accessMode === 'CLOUDFLARE_ACCESS') {
    lines.push('Access: Protected by Cloudflare Access identity policy.');
  } else {
    lines.push('Access: Public link (anyone with the URL can view while active).');
  }
  return lines.join('\n');
}

/** Safely check whether a PID is still alive and is a `cloudflared` process before killing it. */
export async function cleanupOrphanedCloudflaredPids(
  records: readonly PersistedSessionRecord[],
  logger: Logger,
): Promise<PersistedSessionRecord[]> {
  const recovered: PersistedSessionRecord[] = [];
  for (const rec of records) {
    if (!rec.pid || rec.pid <= 0) continue;
    try {
      // Signal 0 checks existence without killing.
      process.kill(rec.pid, 0);
      recovered.push(rec);
      try {
        process.kill(rec.pid, 'SIGTERM');
        logger.info(`Cleaned up orphaned cloudflared process from previous session`, {
          pid: rec.pid,
          port: rec.port,
        });
      } catch {
        // Ignore if already exited.
      }
    } catch {
      // Process no longer exists.
    }
  }
  return recovered;
}

export class TunnelManager {
  private readonly records = new Map<string, InternalShareRecord>();
  private readonly startingTargets = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private healthTimer: NodeJS.Timeout | undefined;
  private history: ShareHistoryEntry[];

  constructor(private readonly deps: TunnelManagerDeps) {
    this.history = deps.loadHistory();
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Recover / clean up any orphaned connector processes recorded before a VS Code reload. */
  async initializeSessionRecovery(): Promise<PersistedSessionRecord[]> {
    const prev = this.deps.loadActiveSessionRecords();
    if (prev.length === 0) return [];
    const cleaned = await cleanupOrphanedCloudflaredPids(prev, this.deps.logger);
    await this.deps.saveActiveSessionRecords([]);
    return prev.length > 0 ? prev : cleaned;
  }

  listShares(): ActiveShare[] {
    return [...this.records.values()].map((r) => ({ ...r.share }));
  }

  getShare(id: string): ActiveShare | undefined {
    const r = this.records.get(id);
    return r ? { ...r.share } : undefined;
  }

  findShareByPort(port: number, host = 'localhost'): ActiveShare | undefined {
    for (const { share } of this.records.values()) {
      if (share.port === port && (share.host === host || share.host === 'localhost')) {
        return { ...share };
      }
    }
    return undefined;
  }

  getHistory(): readonly ShareHistoryEntry[] {
    return this.history;
  }

  getRecentPorts(limit = 6): number[] {
    const seen = new Set<number>();
    for (const h of this.history) {
      seen.add(h.port);
      if (seen.size >= limit) break;
    }
    return [...seen];
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.deps.saveHistory([]);
    this.notify();
  }

  /** Start a new tunnel share for a validated local target. */
  async startShare(input: StartShareInput): Promise<ActiveShare> {
    const cfg = this.deps.getSecurityConfig();
    const probe = await probeLocalPort(input.port);

    const security = evaluateTargetSecurity({
      host: input.host,
      port: input.port,
      processName: input.processName,
      banner: probe.bannerService,
      allowLanTargets: cfg.allowLanTargets,
      allowedSensitivePorts: cfg.allowedSensitivePorts,
    });

    if (security.overriddenSensitiveService) {
      this.deps.audit.record(
        'share.sensitive.overridden',
        `Overrode sensitive service block on port ${security.target.port} (${security.overriddenSensitiveService})`,
      );
    }

    const targetKey = `${security.target.host}:${security.target.port}`;
    const existing = this.findShareByPort(security.target.port, security.target.host);
    if (existing && existing.state !== 'STOPPED' && existing.state !== 'ERROR') {
      throw new LocalShareError(
        'DUPLICATE_SHARE',
        `${formatHostPort(security.target.host, security.target.port)} is already being shared as "${existing.name}".`,
      );
    }
    if (this.startingTargets.has(targetKey)) {
      throw new LocalShareError(
        'DUPLICATE_SHARE',
        `A tunnel for ${targetKey} is already starting.`,
      );
    }

    if (!probe.reachable && security.target.scope === 'loopback') {
      throw new LocalShareError(
        'TARGET_UNREACHABLE',
        `Nothing is listening on ${formatHostPort(security.target.host, security.target.port)}.`,
        'Start your local dev server first, then try sharing again.',
      );
    }

    const id = existing?.id ?? randomUUID();
    const labelRes = validateLabel(
      input.name?.trim() || `${input.frameworkLabel ?? 'Server'} (${security.target.port})`,
    );
    if (!labelRes.ok) throw new LocalShareError('INVALID_HOST', labelRes.error);
    const descRes = validateDescription(input.description);
    if (!descRes.ok) throw new LocalShareError('INVALID_HOST', descRes.error);
    const groupName = input.group?.trim() ?? '';

    const kind: TunnelKind = input.kind ?? 'QUICK';
    let accessMode: AccessMode = input.accessMode ?? 'PUBLIC';
    let gateway: LocalPasswordGateway | undefined;
    let connectHost = security.target.host === 'localhost' ? probe.resolvedHost : security.target.host;
    let connectPort = security.target.port;

    const creds = await this.deps.getGatewayCredentials();
    if (accessMode === 'PASSWORD' || (accessMode === 'PUBLIC' && creds && kind === 'QUICK')) {
      if (!creds) {
        throw new LocalShareError(
          'INVALID_HOST',
          'Password protection was requested, but no preview password is set.',
          'Run "LocalShare: Set Preview Password" first.',
        );
      }
      accessMode = 'PASSWORD';
      gateway = new LocalPasswordGateway({
        targetHost: connectHost,
        targetPort: security.target.port,
        username: creds.username,
        password: creds.password,
        sessionHours: cfg.passwordSessionHours,
        rewriteHostHeader: cfg.rewriteHostHeader,
        onAuthFailure: (ip) => {
          this.deps.audit.record(
            'security.auth.failed',
            `Rejected unauthenticated preview request on port ${security.target.port}`,
            { remoteAddress: ip ?? 'unknown' },
          );
        },
      });
      connectPort = await gateway.start();
      connectHost = '127.0.0.1';
    }

    const share: ActiveShare = {
      id,
      name: labelRes.value,
      description: descRes.value,
      group: groupName,
      host: security.target.host,
      port: security.target.port,
      framework: input.framework ?? 'generic',
      frameworkLabel: input.frameworkLabel ?? 'Local Server',
      kind,
      provider: this.deps.provider.id,
      accessMode,
      state: 'STARTING',
      ...(input.hostname ? { hostname: input.hostname } : {}),
      ...(input.namedTunnelId ? { namedTunnelId: input.namedTunnelId } : {}),
      localTargetHealthy: true,
      warnings: security.warnings,
    };

    const internal: InternalShareRecord = { share, gateway };
    this.records.set(id, internal);
    this.startingTargets.add(targetKey);
    this.notify();

    try {
      const handle = await this.deps.provider.connect({
        id,
        kind,
        localHost: connectHost,
        localPort: connectPort,
        originPort: security.target.port,
        rewriteHostHeader: cfg.rewriteHostHeader,
        startupTimeoutMs: cfg.startupTimeoutSeconds * 1000,
        autoReconnect: cfg.autoReconnect,
        signal: input.signal,
        hostname: input.hostname,
        tunnelToken: input.tunnelToken,
        namedTunnelId: input.namedTunnelId,
      });

      internal.handle = handle;
      this.applySnapshot(internal, handle.getStatus());
      internal.unsubscribe = handle.onStatusChange((snap) => {
        this.applySnapshot(internal, snap);
        this.notify();
        this.deps.onShareChanged?.({ ...internal.share });
      });

      await this.recordHistory(internal.share);
      await this.persistActiveSessions();
      this.ensureHealthLoop();

      this.deps.audit.record(
        'share.started',
        `Started ${kind} share "${share.name}" for ${share.host}:${share.port}`,
        {
          id: share.id,
          publicUrl: internal.share.publicUrl,
          accessMode: share.accessMode,
        },
      );
      this.notify();
      this.deps.onShareChanged?.({ ...internal.share });
      return { ...internal.share };
    } catch (err) {
      if (gateway) {
        await gateway.stop().catch(() => undefined);
      }
      internal.share.state = 'ERROR';
      internal.share.lastError = err instanceof Error ? err.message : String(err);
      this.records.delete(id);
      this.deps.audit.record(
        'share.error',
        `Failed to start share for ${share.host}:${share.port}: ${internal.share.lastError}`,
      );
      this.notify();
      throw err;
    } finally {
      this.startingTargets.delete(targetKey);
    }
  }

  /** Stop an individual tunnel without ever terminating the developer's local application. */
  async stopShare(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.unsubscribe?.();
    rec.share.state = 'STOPPING';
    this.notify();

    await Promise.allSettled([
      rec.handle ? rec.handle.disconnect() : this.deps.provider.disconnect(id),
      rec.gateway ? rec.gateway.stop() : Promise.resolve(),
    ]);

    rec.share.state = 'STOPPED';
    this.records.delete(id);
    await this.persistActiveSessions();
    if (this.records.size === 0 && this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    this.deps.audit.record(
      'share.stopped',
      `Stopped share "${rec.share.name}" (${rec.share.host}:${rec.share.port})`,
    );
    this.notify();
    this.deps.onShareChanged?.({ ...rec.share });
  }

  /** Stop all active tunnels cleanly. */
  async stopAllShares(): Promise<void> {
    const ids = [...this.records.keys()];
    await Promise.allSettled(ids.map((id) => this.stopShare(id)));
  }

  /** Restart an individual tunnel preserving its name, description, group and settings. */
  async restartShare(id: string, tunnelToken?: string): Promise<ActiveShare> {
    const rec = this.records.get(id);
    if (!rec) {
      throw new LocalShareError('INVALID_HOST', 'Share not found.');
    }
    const prev = { ...rec.share };
    await this.stopShare(id);
    return this.startShare({
      name: prev.name,
      description: prev.description,
      group: prev.group,
      host: prev.host,
      port: prev.port,
      framework: prev.framework,
      frameworkLabel: prev.frameworkLabel,
      kind: prev.kind,
      accessMode: prev.accessMode,
      hostname: prev.hostname,
      namedTunnelId: prev.namedTunnelId,
      tunnelToken,
    });
  }

  async renameShare(id: string, newName: string): Promise<ActiveShare> {
    const rec = this.records.get(id);
    if (!rec) throw new LocalShareError('INVALID_HOST', 'Share not found.');
    const v = validateLabel(newName);
    if (!v.ok) throw new LocalShareError('INVALID_HOST', v.error);
    rec.share.name = v.value;
    await this.recordHistory(rec.share);
    this.notify();
    this.deps.onShareChanged?.({ ...rec.share });
    return { ...rec.share };
  }

  async updateShareDescription(id: string, description: string): Promise<ActiveShare> {
    const rec = this.records.get(id);
    if (!rec) throw new LocalShareError('INVALID_HOST', 'Share not found.');
    const v = validateDescription(description);
    if (!v.ok) throw new LocalShareError('INVALID_HOST', v.error);
    rec.share.description = v.value;
    await this.recordHistory(rec.share);
    this.notify();
    this.deps.onShareChanged?.({ ...rec.share });
    return { ...rec.share };
  }

  async setShareGroup(id: string, group: string): Promise<ActiveShare> {
    const rec = this.records.get(id);
    if (!rec) throw new LocalShareError('INVALID_HOST', 'Share not found.');
    const trimmed = group.trim();
    if (trimmed.length > 0) {
      const v = validateLabel(trimmed, 'Group name', 48);
      if (!v.ok) throw new LocalShareError('INVALID_HOST', v.error);
      rec.share.group = v.value;
    } else {
      rec.share.group = '';
    }
    await this.recordHistory(rec.share);
    this.notify();
    return { ...rec.share };
  }

  private applySnapshot(rec: InternalShareRecord, snap: TunnelStatusSnapshot): void {
    rec.share.state = snap.state;
    if (snap.publicUrl) rec.share.publicUrl = snap.publicUrl;
    rec.share.pid = snap.pid;
    if (snap.startedAt) rec.share.startedAt = snap.startedAt;
    rec.share.lastError = snap.lastError;
  }

  private async recordHistory(share: ActiveShare): Promise<void> {
    const entry: ShareHistoryEntry = {
      id: share.id,
      name: share.name,
      description: share.description,
      group: share.group,
      host: share.host,
      port: share.port,
      framework: share.framework,
      frameworkLabel: share.frameworkLabel,
      kind: share.kind,
      accessMode: share.accessMode,
      ...(share.publicUrl ? { lastPublicUrl: share.publicUrl } : {}),
      ...(share.hostname ? { hostname: share.hostname } : {}),
      ...(share.namedTunnelId ? { namedTunnelId: share.namedTunnelId } : {}),
      lastSharedAt: new Date().toISOString(),
    };
    this.history = [
      entry,
      ...this.history.filter((h) => !(h.host === share.host && h.port === share.port)),
    ].slice(0, 25);
    await this.deps.saveHistory(this.history);
  }

  private async persistActiveSessions(): Promise<void> {
    const active: PersistedSessionRecord[] = [];
    for (const { share } of this.records.values()) {
      if (share.state === 'ONLINE' || share.state === 'CONNECTING' || share.state === 'RECONNECTING') {
        active.push({
          id: share.id,
          name: share.name,
          host: share.host,
          port: share.port,
          ...(share.pid !== undefined ? { pid: share.pid } : {}),
          ...(share.startedAt ? { startedAt: share.startedAt } : {}),
        });
      }
    }
    await this.deps.saveActiveSessionRecords(active);
  }

  private ensureHealthLoop(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      void this.checkLocalTargetsHealth();
    }, 10_000);
  }

  private async checkLocalTargetsHealth(): Promise<void> {
    let changed = false;
    for (const { share } of this.records.values()) {
      const probe = await probeLocalPort(share.port, 800);
      if (share.localTargetHealthy !== probe.reachable) {
        share.localTargetHealthy = probe.reachable;
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) {
      l();
    }
  }
}

