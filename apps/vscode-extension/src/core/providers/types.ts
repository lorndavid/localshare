/**
 * Layer B — Provider-agnostic tunnel abstraction.
 *
 * Exposes the required interface:
 *   - connect()
 *   - disconnect()
 *   - getStatus()
 *   - getPublicUrl()
 *   - listTunnels()
 *   - validateConfiguration()
 */
import type { TunnelKind, TunnelProviderId, TunnelState } from '@localshare/shared-types';
import type { ValidationResult } from '@localshare/validation';

export interface TunnelConnectConfig {
  id: string;
  kind: TunnelKind;
  localHost: string;
  localPort: number;
  /** The original port before any local password gateway, used for Host-header rewriting. */
  originPort?: number;
  rewriteHostHeader?: boolean;
  startupTimeoutMs?: number;
  autoReconnect?: boolean;
  signal?: AbortSignal;
  /** For named tunnels: the public hostname and connector token. */
  hostname?: string;
  tunnelToken?: string;
  namedTunnelId?: string;
}

export interface TunnelStatusSnapshot {
  id: string;
  provider: TunnelProviderId;
  kind: TunnelKind;
  state: TunnelState;
  publicUrl: string | undefined;
  pid: number | undefined;
  startedAt: string | undefined;
  lastError: string | undefined;
  reconnectAttempts: number;
}

export interface TunnelConnectionHandle {
  readonly id: string;
  getStatus(): TunnelStatusSnapshot;
  getPublicUrl(): string | undefined;
  onStatusChange(listener: (snapshot: TunnelStatusSnapshot) => void): () => void;
  disconnect(): Promise<void>;
}

export interface TunnelProvider {
  readonly id: TunnelProviderId;
  validateConfiguration(config: TunnelConnectConfig): ValidationResult<TunnelConnectConfig>;
  connect(config: TunnelConnectConfig): Promise<TunnelConnectionHandle>;
  disconnect(tunnelId: string): Promise<void>;
  getStatus(tunnelId: string): TunnelStatusSnapshot | undefined;
  getPublicUrl(tunnelId: string): string | undefined;
  listTunnels(): TunnelStatusSnapshot[];
}

