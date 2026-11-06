/**
 * LocalShare shared types — the contract between the VS Code extension, the API and the dashboard.
 * Keep this package free of runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Tunnel domain (shared by extension and cloud)
// ---------------------------------------------------------------------------

export const TUNNEL_STATES = ['STOPPED', 'STARTING', 'CONNECTING', 'ONLINE', 'RECONNECTING', 'STOPPING', 'ERROR'] as const;
export type TunnelState = (typeof TUNNEL_STATES)[number];

export const TUNNEL_KINDS = ['QUICK', 'NAMED'] as const;
export type TunnelKind = (typeof TUNNEL_KINDS)[number];

export const TUNNEL_PROVIDERS = ['cloudflare'] as const;
export type TunnelProviderId = (typeof TUNNEL_PROVIDERS)[number];

export const ACCESS_MODES = ['PUBLIC', 'PASSWORD', 'CLOUDFLARE_ACCESS'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

// ---------------------------------------------------------------------------
// Roles & organisations
// ---------------------------------------------------------------------------

export const ORG_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Permissions are derived from roles; the API enforces them server-side. */
export const ROLE_RANK: Record<OrgRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function roleAtLeast(role: OrgRole, required: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

// ---------------------------------------------------------------------------
// API envelope types
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  requestId: string;
  details?: Array<{ field?: string; message: string }>;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: UserDto;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Organisations & membership
// ---------------------------------------------------------------------------

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  createdAt: string;
}

export interface CreateOrganizationRequest {
  name: string;
  slug?: string;
}

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: OrgRole;
  createdAt: string;
}

export interface AddMemberRequest {
  email: string;
  role: OrgRole;
}

export interface UpdateMemberRequest {
  role: OrgRole;
}

// ---------------------------------------------------------------------------
// Workspaces (a developer project registered from the extension)
// ---------------------------------------------------------------------------

export interface WorkspaceDto {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceRequest {
  name: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Tunnel metadata (never application traffic)
// ---------------------------------------------------------------------------

export interface TunnelDto {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  name: string;
  kind: TunnelKind;
  provider: TunnelProviderId;
  state: TunnelState;
  accessMode: AccessMode;
  /** Local target description, e.g. "localhost:5173" — metadata only. */
  localTarget: string;
  publicUrl: string | null;
  framework: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertTunnelRequest {
  /** Client-generated stable identifier so repeated syncs do not duplicate records. */
  clientId: string;
  workspaceId?: string;
  name: string;
  kind: TunnelKind;
  provider: TunnelProviderId;
  state: TunnelState;
  accessMode: AccessMode;
  localTarget: string;
  publicUrl?: string | null;
  framework?: string | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export const DOMAIN_STATUSES = ['PENDING_VERIFICATION', 'VERIFIED', 'FAILED', 'REVOKED'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const VERIFICATION_METHODS = ['DNS_TXT'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export interface DomainDto {
  id: string;
  organizationId: string;
  hostname: string;
  status: DomainStatus;
  /** The TXT record the owner must publish to prove control of the hostname. */
  verification: {
    method: VerificationMethod;
    recordName: string;
    recordValue: string;
    lastCheckedAt: string | null;
    lastError: string | null;
  };
  verifiedAt: string | null;
  createdAt: string;
}

export interface CreateDomainRequest {
  hostname: string;
}

// ---------------------------------------------------------------------------
// Access policies
// ---------------------------------------------------------------------------

export interface AccessPolicyRules {
  allowedEmails: string[];
  allowedEmailDomains: string[];
  /** Session lifetime in hours for identity-based access. */
  sessionDurationHours: number;
}

export interface AccessPolicyDto {
  id: string;
  organizationId: string;
  name: string;
  mode: AccessMode;
  rules: AccessPolicyRules;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccessPolicyRequest {
  name: string;
  mode: AccessMode;
  rules: AccessPolicyRules;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEventDto {
  id: string;
  organizationId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Overview / usage (computed from real records only)
// ---------------------------------------------------------------------------

export interface OrganizationOverviewDto {
  workspaces: number;
  activeTunnels: number;
  totalTunnels: number;
  verifiedDomains: number;
  pendingDomains: number;
  members: number;
  recentEvents: AuditEventDto[];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthDto {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  checks: Record<string, { status: 'up' | 'down'; latencyMs?: number; error?: string }>;
}

