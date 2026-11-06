/**
 * Cloudflare REST API v4 client for:
 * - Token verification & account discovery
 * - Zone ownership lookup
 * - Named Tunnel creation, listing, token retrieval, ingress configuration & deletion
 * - DNS CNAME management (with explicit confirmation and manual fallback)
 * - Cloudflare Access application & policy creation for identity-protected custom domains
 * - Real DNS resolution & HTTPS reachability verification
 */
import { Resolver } from 'node:dns/promises';
import {
  candidateZones,
  formatHostPort,
  isHostnameInZone,
  validateHostname,
  validateTunnelName,
} from '@localshare/validation';
import { LocalShareError } from '../errors';
import type { Logger } from '../logger';

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  account: CloudflareAccount;
}

export interface CloudflareNamedTunnel {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

export interface DnsInstruction {
  type: 'CNAME';
  name: string;
  target: string;
  proxied: boolean;
  zoneId?: string;
  zoneName?: string;
}

export interface DomainVerificationReport {
  hostname: string;
  expectedTarget: string;
  dnsResolved: boolean;
  dnsRecords: string[];
  httpsReady: boolean;
  httpsStatus?: number;
  error?: string;
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

export interface DnsLookupAdapter {
  resolveCname(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

const defaultDnsAdapter: DnsLookupAdapter = (() => {
  const r = new Resolver();
  return {
    resolveCname: (h) => r.resolveCname(h).catch(() => []),
    resolve4: (h) => r.resolve4(h).catch(() => []),
    resolve6: (h) => r.resolve6(h).catch(() => []),
  };
})();

export class CloudflareApiClient {
  private readonly baseUrl = 'https://api.cloudflare.com/client/v4';
  private readonly fetchFn: typeof fetch;
  private readonly dns: DnsLookupAdapter;

  constructor(
    private readonly getToken: () => Promise<string | undefined>,
    options: {
      fetchImpl?: typeof fetch;
      dnsAdapter?: DnsLookupAdapter;
      logger?: Logger;
    } = {},
  ) {
    this.fetchFn = options.fetchImpl ?? fetch;
    this.dns = options.dnsAdapter ?? defaultDnsAdapter;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = (await this.getToken())?.trim();
    if (!token) {
      throw new LocalShareError(
        'CLOUDFLARE_AUTH_FAILED',
        'No Cloudflare API token is connected.',
        'Run "LocalShare: Connect Cloudflare Account" first.',
      );
    }

    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'LocalShare-VSCode-Extension/1.0',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    let payload: CfEnvelope<T>;
    try {
      payload = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new LocalShareError(
        'CLOUDFLARE_API_ERROR',
        `Cloudflare API returned non-JSON response (HTTP ${res.status}).`,
      );
    }

    if (!res.ok || !payload.success) {
      const msg = payload.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new LocalShareError(
          'CLOUDFLARE_PERMISSION_DENIED',
          `Cloudflare rejected the request: ${msg}`,
          'Ensure your API token has Account:Cloudflare Tunnel:Edit and Zone:DNS:Edit permissions.',
        );
      }
      throw new LocalShareError('CLOUDFLARE_API_ERROR', `Cloudflare API error: ${msg}`);
    }

    return payload.result;
  }

  /** Verify the stored token and return accessible Cloudflare accounts. */
  async verifyTokenAndListAccounts(): Promise<{
    tokenStatus: string;
    accounts: CloudflareAccount[];
  }> {
    const verify = await this.request<{ id: string; status: string }>('GET', '/user/tokens/verify');
    if (verify.status !== 'active') {
      throw new LocalShareError(
        'CLOUDFLARE_AUTH_FAILED',
        `Cloudflare API token is not active (status: ${verify.status}).`,
      );
    }
    const accounts = await this.request<CloudflareAccount[]>('GET', '/accounts?per_page=50');
    return { tokenStatus: verify.status, accounts };
  }

  /** Find the authoritative Cloudflare zone for a hostname when accessible by the token. */
  async findZoneForHostname(hostname: string): Promise<CloudflareZone | undefined> {
    const valid = validateHostname(hostname);
    if (!valid.ok) {
      throw new LocalShareError('INVALID_HOSTNAME', valid.error);
    }
    for (const candidate of candidateZones(valid.value)) {
      const zones = await this.request<CloudflareZone[]>(
        'GET',
        `/zones?name=${encodeURIComponent(candidate)}&status=active`,
      );
      const match = zones.find((z) => isHostnameInZone(valid.value, z.name));
      if (match) return match;
    }
    return undefined;
  }

  /** List active named tunnels in a Cloudflare account. */
  async listNamedTunnels(accountId: string): Promise<CloudflareNamedTunnel[]> {
    return this.request<CloudflareNamedTunnel[]>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?is_deleted=false&per_page=100`,
    );
  }

  /** Create a remotely-managed Cloudflare Named Tunnel (`config_src: 'cloudflare'`). */
  async createNamedTunnel(accountId: string, name: string): Promise<CloudflareNamedTunnel> {
    const valid = validateTunnelName(name);
    if (!valid.ok) {
      throw new LocalShareError('INVALID_HOSTNAME', valid.error);
    }
    return this.request<CloudflareNamedTunnel>(
      'POST',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
      {
        name: valid.value,
        config_src: 'cloudflare',
      },
    );
  }

  /** Retrieve the connector token used by `cloudflared tunnel run --token <token>`. */
  async getNamedTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    return this.request<string>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
    );
  }

  /** Configure the tunnel's ingress rules to route `hostname` to `http://localHost:localPort`. */
  async configureTunnelIngress(
    accountId: string,
    tunnelId: string,
    hostname: string,
    localHost: string,
    localPort: number,
  ): Promise<void> {
    const validHost = validateHostname(hostname);
    if (!validHost.ok) throw new LocalShareError('INVALID_HOSTNAME', validHost.error);

    const serviceUrl = `http://${formatHostPort(localHost, localPort)}`;
    await this.request(
      'PUT',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      {
        config: {
          ingress: [
            {
              hostname: validHost.value,
              service: serviceUrl,
              originRequest: {
                httpHostHeader: `localhost:${localPort}`,
              },
            },
            {
              service: 'http_status:404',
            },
          ],
        },
      },
    );
  }

  /** Delete a named tunnel from the Cloudflare account. */
  async deleteNamedTunnel(accountId: string, tunnelId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
    );
  }

  /** Build the required CNAME record specification for a named tunnel hostname. */
  buildDnsInstruction(
    hostname: string,
    tunnelId: string,
    zone?: CloudflareZone,
  ): DnsInstruction {
    const valid = validateHostname(hostname);
    if (!valid.ok) throw new LocalShareError('INVALID_HOSTNAME', valid.error);
    return {
      type: 'CNAME',
      name: valid.value,
      target: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ...(zone ? { zoneId: zone.id, zoneName: zone.name } : {}),
    };
  }

  /** Create or update the proxied CNAME record in Cloudflare DNS (requires explicit user confirmation first). */
  async upsertTunnelCnameRecord(
    zoneId: string,
    hostname: string,
    tunnelId: string,
  ): Promise<CloudflareDnsRecord> {
    const valid = validateHostname(hostname);
    if (!valid.ok) throw new LocalShareError('INVALID_HOSTNAME', valid.error);
    const target = `${tunnelId}.cfargotunnel.com`;

    const existing = await this.request<CloudflareDnsRecord[]>(
      'GET',
      `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(valid.value)}`,
    );
    const body = {
      type: 'CNAME',
      name: valid.value,
      content: target,
      proxied: true,
      ttl: 1,
      comment: 'Managed by LocalShare',
    };

    if (existing[0]) {
      return this.request<CloudflareDnsRecord>(
        'PUT',
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing[0].id)}`,
        body,
      );
    }
    return this.request<CloudflareDnsRecord>(
      'POST',
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      body,
    );
  }

  /** Remove a LocalShare-managed CNAME record when removing a custom domain. */
  async deleteTunnelCnameRecord(zoneId: string, hostname: string, tunnelId: string): Promise<boolean> {
    const valid = validateHostname(hostname);
    if (!valid.ok) return false;
    const target = `${tunnelId}.cfargotunnel.com`;
    const existing = await this.request<CloudflareDnsRecord[]>(
      'GET',
      `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(valid.value)}`,
    );
    const record = existing.find((r) => r.content.toLowerCase() === target.toLowerCase());
    if (!record) return false;
    await this.request(
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
    );
    return true;
  }

  /**
   * Create or update a Cloudflare Access application & allow policy protecting `hostname`
   * with identity rules (emails / email domains).
   */
  async configureAccessPolicy(
    accountId: string,
    hostname: string,
    options: {
      allowedEmails: string[];
      allowedEmailDomains: string[];
      sessionDurationHours?: number;
    },
  ): Promise<{ appId: string; policyId: string }> {
    const valid = validateHostname(hostname);
    if (!valid.ok) throw new LocalShareError('INVALID_HOSTNAME', valid.error);

    const includeRules: Array<Record<string, unknown>> = [
      ...options.allowedEmails.map((email) => ({ email: { email } })),
      ...options.allowedEmailDomains.map((domain) => ({ email_domain: { domain } })),
    ];
    if (includeRules.length === 0) {
      throw new LocalShareError(
        'CLOUDFLARE_API_ERROR',
        'Cloudflare Access policy requires at least one allowed email or email domain.',
      );
    }

    const sessionDuration = `${Math.max(1, options.sessionDurationHours ?? 12)}h`;
    const apps = await this.request<Array<{ id: string; domain: string }>>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/access/apps`,
    );
    const existingApp = apps.find((a) => a.domain.toLowerCase() === valid.value);

    const appBody = {
      name: `LocalShare (${valid.value})`,
      domain: valid.value,
      type: 'self_hosted',
      session_duration: sessionDuration,
    };

    const app = existingApp
      ? await this.request<{ id: string }>(
          'PUT',
          `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(existingApp.id)}`,
          appBody,
        )
      : await this.request<{ id: string }>(
          'POST',
          `/accounts/${encodeURIComponent(accountId)}/access/apps`,
          appBody,
        );

    const policy = await this.request<{ id: string }>(
      'POST',
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(app.id)}/policies`,
      {
        name: 'LocalShare Authorized Viewers',
        decision: 'allow',
        include: includeRules,
        precedence: 1,
      },
    );

    return { appId: app.id, policyId: policy.id };
  }

  /**
   * Verify DNS resolution AND HTTPS reachability for a custom domain.
   * Never reports ready unless both DNS resolves and an HTTPS response is received.
   */
  async verifyCustomDomainReadiness(
    hostname: string,
    tunnelId: string,
  ): Promise<DomainVerificationReport> {
    const valid = validateHostname(hostname);
    if (!valid.ok) throw new LocalShareError('INVALID_HOSTNAME', valid.error);

    const expectedTarget = `${tunnelId}.cfargotunnel.com`;
    const [cnames, v4, v6] = await Promise.all([
      this.dns.resolveCname(valid.value),
      this.dns.resolve4(valid.value),
      this.dns.resolve6(valid.value),
    ]);
    const records = [...cnames, ...v4, ...v6];
    const dnsResolved = records.length > 0;

    if (!dnsResolved) {
      return {
        hostname: valid.value,
        expectedTarget,
        dnsResolved: false,
        dnsRecords: [],
        httpsReady: false,
        error: `DNS record for ${valid.value} does not resolve yet. Ensure CNAME ${valid.value} -> ${expectedTarget} is published.`,
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await this.fetchFn(`https://${valid.value}/`, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'LocalShare-DomainVerifier/1.0' },
      });
      clearTimeout(timer);
      // Cloudflare error 530 / 502 / 521 / 522 / 523 / 525 / 526 indicates tunnel/SSL not ready.
      const cfUnready = res.status >= 520 && res.status <= 530;
      return {
        hostname: valid.value,
        expectedTarget,
        dnsResolved: true,
        dnsRecords: records,
        httpsReady: !cfUnready,
        httpsStatus: res.status,
        ...(cfUnready
          ? {
              error: `HTTPS responded with Cloudflare status ${res.status} (tunnel connector or SSL certificate is not ready yet).`,
            }
          : {}),
      };
    } catch (err) {
      return {
        hostname: valid.value,
        expectedTarget,
        dnsResolved: true,
        dnsRecords: records,
        httpsReady: false,
        error: `HTTPS handshake or connection to https://${valid.value} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

