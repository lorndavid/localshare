/**
 * Optional LocalShare Cloud synchronization client.
 *
 * Syncs only share metadata (name, kind, state, accessMode, localTarget, publicUrl, framework).
 * Never proxies application traffic or uploads source code.
 * Fails gracefully when the cloud platform is unconfigured or offline.
 */
import type { OrganizationDto, TunnelDto, UpsertTunnelRequest } from '@localshare/shared-types';
import { formatHostPort } from '@localshare/validation';
import { LocalShareError } from './errors';
import type { Logger } from './logger';
import type { ActiveShare } from './tunnelManager';

export interface CloudSyncConfig {
  apiUrl: string;
  organizationId: string;
  getApiToken: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class LocalShareCloudClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: CloudSyncConfig) {
    this.fetchFn = config.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return (
      this.config.apiUrl.trim().length > 0 &&
      this.config.organizationId.trim().length > 0
    );
  }

  private normalizeBaseUrl(): string {
    return this.config.apiUrl.trim().replace(/\/+$/, '');
  }

  async verifyConnection(): Promise<OrganizationDto[]> {
    const base = this.normalizeBaseUrl();
    const token = await this.config.getApiToken();
    if (!base || !token) {
      throw new LocalShareError(
        'CLOUD_API_ERROR',
        'LocalShare Cloud API URL and personal API token are required.',
      );
    }
    const res = await this.fetchFn(`${base}/organizations`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new LocalShareError(
        'CLOUD_API_ERROR',
        `LocalShare Cloud returned HTTP ${res.status}.`,
      );
    }
    return (await res.json()) as OrganizationDto[];
  }

  /** Sync a single share's metadata to the optional cloud platform. Non-throwing in background mode. */
  async syncShare(share: ActiveShare): Promise<TunnelDto | undefined> {
    if (!this.isConfigured()) return undefined;
    const token = await this.config.getApiToken();
    if (!token) return undefined;

    const body: UpsertTunnelRequest = {
      clientId: `${share.host}:${share.port}:${share.kind}`,
      name: share.name,
      kind: share.kind,
      provider: share.provider,
      state: share.state,
      accessMode: share.accessMode,
      localTarget: formatHostPort(share.host, share.port),
      publicUrl: share.publicUrl ?? null,
      framework: share.frameworkLabel,
      startedAt: share.startedAt ?? null,
      stoppedAt: share.state === 'STOPPED' ? new Date().toISOString() : null,
    };

    try {
      const base = this.normalizeBaseUrl();
      const orgId = encodeURIComponent(this.config.organizationId.trim());
      const res = await this.fetchFn(`${base}/organizations/${orgId}/tunnels`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.config.logger?.warn(`Cloud metadata sync returned HTTP ${res.status}`);
        return undefined;
      }
      return (await res.json()) as TunnelDto;
    } catch (err) {
      this.config.logger?.debug(
        `Cloud metadata sync skipped (offline): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}

