/**
 * Typed API client for the LocalShare Web Dashboard.
 *
 * Security design:
 * - Access tokens are kept strictly in memory (never written to localStorage or sessionStorage).
 * - Refresh tokens are managed via an HttpOnly, SameSite=Strict cookie (`ls_refresh`).
 * - Automatic single-flight refresh on 401 responses.
 */
import type {
  AccessMode,
  AccessPolicyDto,
  AccessPolicyRules,
  ApiErrorBody,
   AuditEventDto,
  AuthResponse,
  DomainDto,
  MemberDto,
  OrgRole,
  OrganizationDto,
  OrganizationOverviewDto,
  Paginated,
  TunnelDto,
  UpsertTunnelRequest,
  UserDto,
  WorkspaceDto,
} from '@localshare/shared-types';

let inMemoryAccessToken: string | null = null;
let refreshPromise: Promise<AuthResponse | null> | null = null;
const SESSION_HINT_KEY = 'ls_has_session';

function setSessionHint(active: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (active) {
      window.localStorage.setItem(SESSION_HINT_KEY, '1');
    } else {
      window.localStorage.removeItem(SESSION_HINT_KEY);
    }
  } catch {
    // Ignore storage access errors in restricted contexts
  }
}

function hasSessionHint(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return window.localStorage.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
  setSessionHint(Boolean(token));
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export class DashboardApiError extends Error {
  readonly statusCode: number;
  readonly requestId?: string;

  constructor(message: string, statusCode: number, requestId?: string) {
    super(message);
    this.name = 'DashboardApiError';
    this.statusCode = statusCode;
    this.requestId = requestId;
  }
}

export interface ApiTokenItem {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CreatedApiToken extends ApiTokenItem {
  token: string;
}

export interface ProviderConnectionItem {
  id: string;
  provider: string;
  label: string;
  accountId: string | null;
  tokenLast4: string;
  createdAt: string;
}

async function performRefresh(baseUrl = '/api/v1'): Promise<AuthResponse | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        inMemoryAccessToken = null;
        setSessionHint(false);
        return null;
      }
      const data = (await res.json()) as AuthResponse;
      inMemoryAccessToken = data.accessToken;
      setSessionHint(true);
      return data;
    } catch {
      inMemoryAccessToken = null;
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { skipAuthRefresh?: boolean; baseUrl?: string } = {},
): Promise<T> {
  const baseUrl = options.baseUrl ?? '/api/v1';
  const doFetch = async (token: string | null): Promise<Response> => {
    const headers = new Headers(options.headers);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });
  };

  let res = await doFetch(inMemoryAccessToken);
  if (res.status === 401 && !options.skipAuthRefresh && !path.startsWith('/auth/')) {
    const refreshed = await performRefresh(baseUrl);
    if (refreshed) {
      res = await doFetch(refreshed.accessToken);
    }
  }

  if (res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    let errBody: Partial<ApiErrorBody> = {};
    try {
      errBody = (await res.json()) as Partial<ApiErrorBody>;
    } catch {
      // Ignore non-JSON error
    }
    throw new DashboardApiError(
      errBody.message ?? `Request failed with status ${res.status}`,
      res.status,
      errBody.requestId,
    );
  }

  return (await res.json()) as T;
}

export const apiClient = {
  // Auth
  async register(body: { email: string; password: string; name: string }): Promise<AuthResponse> {
    const res = await apiRequest<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
      skipAuthRefresh: true,
    });
    setAccessToken(res.accessToken);
    return res;
  },
  async login(body: { email: string; password: string }): Promise<AuthResponse> {
    const res = await apiRequest<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
      skipAuthRefresh: true,
    });
    setAccessToken(res.accessToken);
    return res;
  },
  async tryRestoreSession(): Promise<AuthResponse | null> {
    if (!hasSessionHint()) {
      return null;
    }
    return performRefresh();
  },
  async logout(): Promise<void> {
    await apiRequest<void>('/auth/logout', { method: 'POST', skipAuthRefresh: true });
    setAccessToken(null);
  },
  me(): Promise<UserDto> {
    return apiRequest<UserDto>('/auth/me');
  },
  listApiTokens(): Promise<ApiTokenItem[]> {
    return apiRequest<ApiTokenItem[]>('/auth/tokens');
  },
  createApiToken(body: { name: string; expiresInDays?: number }): Promise<CreatedApiToken> {
    return apiRequest<CreatedApiToken>('/auth/tokens', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  revokeApiToken(id: string): Promise<void> {
    return apiRequest<void>(`/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  // Organizations
  listOrganizations(): Promise<OrganizationDto[]> {
    return apiRequest<OrganizationDto[]>('/organizations');
  },
  createOrganization(body: { name: string; slug?: string }): Promise<OrganizationDto> {
    return apiRequest<OrganizationDto>('/organizations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  updateOrganization(orgId: string, body: { name: string }): Promise<OrganizationDto> {
    return apiRequest<OrganizationDto>(`/organizations/${encodeURIComponent(orgId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },
  deleteOrganization(orgId: string): Promise<void> {
    return apiRequest<void>(`/organizations/${encodeURIComponent(orgId)}`, {
      method: 'DELETE',
    });
  },
  getOverview(orgId: string): Promise<OrganizationOverviewDto> {
    return apiRequest<OrganizationOverviewDto>(
      `/organizations/${encodeURIComponent(orgId)}/overview`,
    );
  },

  // Members
  listMembers(orgId: string): Promise<MemberDto[]> {
    return apiRequest<MemberDto[]>(`/organizations/${encodeURIComponent(orgId)}/members`);
  },
  addMember(orgId: string, body: { email: string; role: OrgRole }): Promise<MemberDto> {
    return apiRequest<MemberDto>(`/organizations/${encodeURIComponent(orgId)}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  updateMemberRole(orgId: string, memberId: string, role: OrgRole): Promise<MemberDto> {
    return apiRequest<MemberDto>(
      `/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      },
    );
  },
  removeMember(orgId: string, memberId: string): Promise<void> {
    return apiRequest<void>(
      `/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' },
    );
  },

  // Workspaces
  listWorkspaces(orgId: string): Promise<WorkspaceDto[]> {
    return apiRequest<WorkspaceDto[]>(`/organizations/${encodeURIComponent(orgId)}/workspaces`);
  },
  createWorkspace(
    orgId: string,
    body: { name: string; description?: string },
  ): Promise<WorkspaceDto> {
    return apiRequest<WorkspaceDto>(`/organizations/${encodeURIComponent(orgId)}/workspaces`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  updateWorkspace(
    orgId: string,
    workspaceId: string,
    body: { name?: string; description?: string },
  ): Promise<WorkspaceDto> {
    return apiRequest<WorkspaceDto>(
      `/organizations/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    );
  },
  deleteWorkspace(orgId: string, workspaceId: string): Promise<void> {
    return apiRequest<void>(
      `/organizations/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`,
      { method: 'DELETE' },
    );
  },

  // Tunnels
  listTunnels(
    orgId: string,
    params: { page?: number; pageSize?: number; state?: string; workspaceId?: string } = {},
  ): Promise<Paginated<TunnelDto>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    if (params.state) q.set('state', params.state);
    if (params.workspaceId) q.set('workspaceId', params.workspaceId);
    const qs = q.toString();
    return apiRequest<Paginated<TunnelDto>>(
      `/organizations/${encodeURIComponent(orgId)}/tunnels${qs ? `?${qs}` : ''}`,
    );
  },
  upsertTunnel(orgId: string, body: UpsertTunnelRequest): Promise<TunnelDto> {
    return apiRequest<TunnelDto>(`/organizations/${encodeURIComponent(orgId)}/tunnels`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },
  deleteTunnel(orgId: string, tunnelId: string): Promise<void> {
    return apiRequest<void>(
      `/organizations/${encodeURIComponent(orgId)}/tunnels/${encodeURIComponent(tunnelId)}`,
      { method: 'DELETE' },
    );
  },

  // Domains
  listDomains(orgId: string): Promise<DomainDto[]> {
    return apiRequest<DomainDto[]>(`/organizations/${encodeURIComponent(orgId)}/domains`);
  },
  createDomain(orgId: string, hostname: string): Promise<DomainDto> {
    return apiRequest<DomainDto>(`/organizations/${encodeURIComponent(orgId)}/domains`, {
      method: 'POST',
      body: JSON.stringify({ hostname }),
    });
  },
  verifyDomain(orgId: string, domainId: string): Promise<DomainDto> {
    return apiRequest<DomainDto>(
      `/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/verify`,
      { method: 'POST' },
    );
  },
  deleteDomain(orgId: string, domainId: string): Promise<void> {
    return apiRequest<void>(
      `/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`,
      { method: 'DELETE' },
    );
  },

  // Access Policies
  listAccessPolicies(orgId: string): Promise<AccessPolicyDto[]> {
    return apiRequest<AccessPolicyDto[]>(
      `/organizations/${encodeURIComponent(orgId)}/access-policies`,
    );
  },
  createAccessPolicy(
    orgId: string,
    body: { name: string; mode: AccessMode; rules: AccessPolicyRules },
  ): Promise<AccessPolicyDto> {
    return apiRequest<AccessPolicyDto>(
      `/organizations/${encodeURIComponent(orgId)}/access-policies`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  },
  deleteAccessPolicy(orgId: string, policyId: string): Promise<void> {
    return apiRequest<void>(
      `/organizations/${encodeURIComponent(orgId)}/access-policies/${encodeURIComponent(policyId)}`,
      { method: 'DELETE' },
    );
  },

  // Provider Connections
  listProviderConnections(orgId: string): Promise<ProviderConnectionItem[]> {
    return apiRequest<ProviderConnectionItem[]>(
      `/organizations/${encodeURIComponent(orgId)}/provider-connections`,
    );
  },
  createProviderConnection(
    orgId: string,
    body: { provider: 'cloudflare'; label: string; accountId?: string; token: string },
  ): Promise<ProviderConnectionItem> {
    return apiRequest<ProviderConnectionItem>(
      `/organizations/${encodeURIComponent(orgId)}/provider-connections`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  },
  deleteProviderConnection(orgId: string, id: string): Promise<void> {
    return apiRequest<void>(
      `/organizations/${encodeURIComponent(orgId)}/provider-connections/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  },

  // Audit Events
  listAuditEvents(
    orgId: string,
    params: { page?: number; pageSize?: number; action?: string } = {},
  ): Promise<Paginated<AuditEventDto>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    if (params.action) q.set('action', params.action);
    const qs = q.toString();
    return apiRequest<Paginated<AuditEventDto>>(
      `/organizations/${encodeURIComponent(orgId)}/audit-events${qs ? `?${qs}` : ''}`,
    );
  },
};

