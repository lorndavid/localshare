import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import {
  Activity,
  ArrowUpRight,
  ExternalLink,
  FolderGit2,
  Globe,
  HelpCircle,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Square,
  Terminal,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  ORG_ROLES,
  TUNNEL_STATES,
  roleAtLeast,
  type AccessMode,
  type AccessPolicyDto,
  type AuditEventDto,
  type DomainDto,
  type MemberDto,
  type OrgRole,
  type OrganizationDto,
  type OrganizationOverviewDto,
  type Paginated,
  type TunnelDto,
  type UserDto,
  type WorkspaceDto,
} from '@localshare/shared-types';
import {
  validateEmail,
  validateEmailDomain,
  validateHostname,
  validateLabel,
} from '@localshare/validation';
import {
  apiClient,
  type ApiTokenItem,
  type CreatedApiToken,
  type ProviderConnectionItem,
} from './api/client';
import {
  CopyButton,
  EmptyState,
  StatusBadge,
  prefersReducedMotion,
} from './components/common/Primitives';
import {
  AppearanceSelector,
  ThemeProvider,
  ThemeToggle,
} from './components/theme/ThemeProvider';
import { CreateShareDialog } from './components/tunnels/CreateShareDialog';

export type DashboardTab =
  | 'overview'
  | 'projects'
  | 'tunnels'
  | 'domains'
  | 'teams'
  | 'security'
  | 'activity'
  | 'settings';

const WORKSPACE_NAV: ReadonlyArray<{
  id: DashboardTab;
  label: string;
  icon: React.FC<{ className?: string }>;
}> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'tunnels', label: 'Tunnels', icon: Radio },
  { id: 'domains', label: 'Domains', icon: Globe },
];

const MANAGEMENT_NAV: ReadonlyArray<{
  id: DashboardTab;
  label: string;
  icon: React.FC<{ className?: string }>;
}> = [
  { id: 'teams', label: 'Teams', icon: Users },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export { CopyButton };

function categorizeAuditAction(action: string): string {
  const lower = action.toLowerCase();
  if (lower.startsWith('tunnel.')) return 'Tunnel';
  if (lower.startsWith('workspace.')) return 'Project';
  if (lower.startsWith('domain.')) return 'Domain';
  if (lower.startsWith('policy.') || lower.startsWith('token.') || lower.startsWith('provider.'))
    return 'Security';
  if (lower.startsWith('member.') || lower.startsWith('org.')) return 'Team';
  return 'Account';
}

function DashboardShell() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [createShareOpen, setCreateShareOpen] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [user, setUser] = useState<UserDto | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [infoBanner, setInfoBanner] = useState<string | null>(null);

  const [organizations, setOrganizations] = useState<OrganizationDto[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string>('');
  const [newOrgName, setNewOrgName] = useState('');
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');

  // Active organization data states
  const [overview, setOverview] = useState<OrganizationOverviewDto | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [tunnelsPage, setTunnelsPage] = useState<Paginated<TunnelDto> | null>(null);
  const [tunnelStateFilter, setTunnelStateFilter] = useState<string>('');
  const [tunnelSearch, setTunnelSearch] = useState<string>('');
  const [tunnelProjectFilter, setTunnelProjectFilter] = useState<string>('');
  const [tunnelSort, setTunnelSort] = useState<'newest' | 'name' | 'status'>('newest');
  const [projectSearch, setProjectSearch] = useState<string>('');
  const [domains, setDomains] = useState<DomainDto[]>([]);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [policies, setPolicies] = useState<AccessPolicyDto[]>([]);
  const [providers, setProviders] = useState<ProviderConnectionItem[]>([]);
  const [apiTokens, setApiTokens] = useState<ApiTokenItem[]>([]);
  const [createdTokenModal, setCreatedTokenModal] = useState<CreatedApiToken | null>(null);
  const [auditPage, setAuditPage] = useState<Paginated<AuditEventDto> | null>(null);
  const [activitySearch, setActivitySearch] = useState<string>('');
  const [activityCategory, setActivityCategory] = useState<string>('ALL');

  // Form states
  const [wsName, setWsName] = useState('');
  const [wsDesc, setWsDesc] = useState('');
  const [domainHost, setDomainHost] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<OrgRole>('MEMBER');
  const [policyName, setPolicyName] = useState('');
  const [policyMode, setPolicyMode] = useState<AccessMode>('CLOUDFLARE_ACCESS');
  const [policyTargets, setPolicyTargets] = useState('');
  const [cfLabel, setCfLabel] = useState('');
  const [cfAccountId, setCfAccountId] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [tokenName, setTokenName] = useState('');
  const [renameOrgValue, setRenameOrgValue] = useState('');
  const [deleteSlugConfirm, setDeleteSlugConfirm] = useState('');
  const [notifyTunnelAlerts, setNotifyTunnelAlerts] = useState(true);
  const [notifyDomainExpiry, setNotifyDomainExpiry] = useState(true);

  // GSAP refs
  const authContainerRef = useRef<HTMLDivElement | null>(null);
  const mainContentRef = useRef<HTMLElement | null>(null);

  const activeOrg = organizations.find((o) => o.id === activeOrgId) ?? null;

  const loadOrganizations = useCallback(async () => {
    const list = await apiClient.listOrganizations();
    setOrganizations(list);
    if (list.length > 0 && (!activeOrgId || !list.some((o) => o.id === activeOrgId))) {
      setActiveOrgId(list[0]!.id);
      setRenameOrgValue(list[0]!.name);
    }
  }, [activeOrgId]);

  useEffect(() => {
    void (async () => {
      try {
        const session = await apiClient.tryRestoreSession();
        if (session) {
          setUser(session.user);
          await loadOrganizations();
        }
      } finally {
        setBootstrapping(false);
      }
    })();
  }, [loadOrganizations]);

  const refreshActiveTabData = useCallback(async () => {
    if (!user || !activeOrgId) return;
    setErrorBanner(null);
    try {
      if (activeTab === 'overview') {
        const [ov, tPage, dList, pList, wsList] = await Promise.all([
          apiClient.getOverview(activeOrgId),
          apiClient.listTunnels(activeOrgId, { page: 1, pageSize: 10 }).catch(() => null),
          apiClient.listDomains(activeOrgId).catch(() => []),
          apiClient.listAccessPolicies(activeOrgId).catch(() => []),
          apiClient.listWorkspaces(activeOrgId).catch(() => []),
        ]);
        setOverview(ov);
        if (tPage) setTunnelsPage(tPage);
        setDomains(dList);
        setPolicies(pList);
        setWorkspaces(wsList);
      } else if (activeTab === 'projects') {
        const [wsList, tPage] = await Promise.all([
          apiClient.listWorkspaces(activeOrgId),
          apiClient.listTunnels(activeOrgId, { page: 1, pageSize: 50 }).catch(() => null),
        ]);
        setWorkspaces(wsList);
        if (tPage) setTunnelsPage(tPage);
      } else if (activeTab === 'tunnels') {
        const [tPage, wsList] = await Promise.all([
          apiClient.listTunnels(activeOrgId, {
            page: 1,
            pageSize: 50,
            state: tunnelStateFilter || undefined,
          }),
          apiClient.listWorkspaces(activeOrgId).catch(() => []),
        ]);
        setTunnelsPage(tPage);
        setWorkspaces(wsList);
      } else if (activeTab === 'domains') {
        setDomains(await apiClient.listDomains(activeOrgId));
      } else if (activeTab === 'teams') {
        setMembers(await apiClient.listMembers(activeOrgId));
      } else if (activeTab === 'security') {
        const [pList, provList, tokList] = await Promise.all([
          apiClient.listAccessPolicies(activeOrgId),
          apiClient.listProviderConnections(activeOrgId),
          apiClient.listApiTokens(),
        ]);
        setPolicies(pList);
        setProviders(provList);
        setApiTokens(tokList);
      } else if (activeTab === 'activity') {
        setAuditPage(await apiClient.listAuditEvents(activeOrgId, { page: 1, pageSize: 50 }));
      } else if (activeTab === 'settings' && activeOrg) {
        setRenameOrgValue(activeOrg.name);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  }, [user, activeOrgId, activeTab, tunnelStateFilter, activeOrg]);

  useEffect(() => {
    void refreshActiveTabData();
  }, [refreshActiveTabData]);

  // GSAP Animation for Auth View
  useEffect(() => {
    if (bootstrapping || user || !authContainerRef.current || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.gsap-auth-card',
        { y: 14, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.4, ease: 'power2.out' },
      );
      gsap.fromTo(
        '.gsap-field',
        { y: 8, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.3, stagger: 0.04, ease: 'power2.out', delay: 0.05 },
      );
    }, authContainerRef);
    return () => ctx.revert();
  }, [bootstrapping, user, authMode]);

  // GSAP Animation for Dashboard Content
  useEffect(() => {
    if (!user || !mainContentRef.current || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.gsap-section',
        { y: 10, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.32, ease: 'power2.out' },
      );
      gsap.fromTo(
        '.gsap-card',
        { y: 8, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.28, stagger: 0.04, ease: 'power2.out', delay: 0.03 },
      );
    }, mainContentRef);
    return () => ctx.revert();
  }, [user, activeTab, activeOrgId, organizations.length]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    const emailCheck = validateEmail(authEmail);
    if (!emailCheck.ok) {
      setErrorBanner(emailCheck.error);
      return;
    }
    try {
      const res =
        authMode === 'register'
          ? await apiClient.register({
              email: emailCheck.value,
              password: authPassword,
              name: authName,
            })
          : await apiClient.login({
              email: emailCheck.value,
              password: authPassword,
            });
      setUser(res.user);
      setAuthPassword('');
      await loadOrganizations();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateOrganization = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    const valid = validateLabel(newOrgName, 'Organization name', 64);
    if (!valid.ok) {
      setErrorBanner(valid.error);
      return;
    }
    try {
      const created = await apiClient.createOrganization({ name: valid.value });
      const next = [...organizations, created];
      setOrganizations(next);
      setActiveOrgId(created.id);
      setRenameOrgValue(created.name);
      setNewOrgName('');
      setInfoBanner(`Created organization "${created.name}".`);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleTunnelState = async (tunnel: TunnelDto, nextState: 'ONLINE' | 'STOPPED') => {
    if (!activeOrgId) return;
    try {
      await apiClient.upsertTunnel(activeOrgId, {
        clientId: `web-${tunnel.id}`,
        workspaceId: tunnel.workspaceId ?? undefined,
        name: tunnel.name,
        kind: tunnel.kind,
        provider: tunnel.provider,
        state: nextState,
        accessMode: tunnel.accessMode,
        localTarget: tunnel.localTarget,
        publicUrl: tunnel.publicUrl,
        framework: tunnel.framework,
        startedAt: nextState === 'ONLINE' ? new Date().toISOString() : tunnel.startedAt,
        stoppedAt: nextState === 'STOPPED' ? new Date().toISOString() : null,
      });
      await refreshActiveTabData();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const filteredTunnels = useMemo(() => {
    const items = tunnelsPage?.items ?? [];
    const q = tunnelSearch.trim().toLowerCase();
    const filtered = items.filter((t) => {
      if (tunnelProjectFilter && t.workspaceId !== tunnelProjectFilter) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.localTarget.toLowerCase().includes(q) ||
        (t.publicUrl ?? '').toLowerCase().includes(q) ||
        (t.framework ?? '').toLowerCase().includes(q)
      );
    });
    return [...filtered].sort((a, b) => {
      if (tunnelSort === 'name') return a.name.localeCompare(b.name);
      if (tunnelSort === 'status') return a.state.localeCompare(b.state);
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [tunnelsPage, tunnelSearch, tunnelProjectFilter, tunnelSort]);

  const filteredWorkspaces = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter(
      (ws) =>
        ws.name.toLowerCase().includes(q) ||
        (ws.description ?? '').toLowerCase().includes(q),
    );
  }, [workspaces, projectSearch]);

  const filteredAuditEvents = useMemo(() => {
    const items = auditPage?.items ?? [];
    const q = activitySearch.trim().toLowerCase();
    return items.filter((ev) => {
      const cat = categorizeAuditAction(ev.action);
      if (activityCategory !== 'ALL' && cat !== activityCategory) return false;
      if (!q) return true;
      return (
        ev.action.toLowerCase().includes(q) ||
        (ev.actorEmail ?? '').toLowerCase().includes(q) ||
        (ev.targetId ?? '').toLowerCase().includes(q)
      );
    });
  }, [auditPage, activitySearch, activityCategory]);

  if (bootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="ls-surface flex items-center gap-3 px-5 py-3">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--ls-text)]" />
          <p className="text-xs font-medium text-[var(--ls-text-secondary)]">
            Loading LocalShare control plane…
          </p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Unauthenticated View (Login / Register)
  // ---------------------------------------------------------------------------
  if (!user) {
    return (
      <div ref={authContainerRef} className="flex min-h-screen flex-col justify-between">
        <header className="border-b border-[var(--ls-border)] bg-[var(--ls-surface)]">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 sm:px-8">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-[var(--ls-btn-bg)] text-[var(--ls-btn-text)]">
                <Radio className="h-3.5 w-3.5" />
              </div>
              <span className="font-heading text-sm font-bold tracking-tight">LocalShare</span>
            </div>
            <ThemeToggle showLabel />
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-4xl flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <div className="gsap-auth-card ls-surface grid w-full grid-cols-1 overflow-hidden lg:grid-cols-12 shadow-sm">
            {/* Left Product Intro Column */}
            <div className="flex flex-col justify-between border-b border-[var(--ls-border)] bg-[var(--ls-surface-secondary)] p-6 sm:p-9 lg:col-span-6 lg:border-b-0 lg:border-r">
              <div>
                <div className="mb-4 inline-flex items-center gap-1.5 rounded-[5px] border border-[var(--ls-border-strong)] bg-[var(--ls-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--ls-text-secondary)]">
                  <Terminal className="h-3.5 w-3.5" />
                  <span>Developer Preview Platform</span>
                </div>
                <h1 className="font-heading text-2xl font-bold tracking-tight sm:text-[28px]">
                  LocalShare Cloud
                </h1>
                <p className="mt-2.5 text-xs leading-relaxed text-[var(--ls-text-secondary)] sm:text-[13.5px]">
                  Share local development servers through secure HTTPS URLs, verify custom customer
                  domains, and manage workspace security policies in one minimalist control plane.
                </p>
              </div>

              <div className="mt-8 space-y-2.5 border-t border-[var(--ls-border)] pt-5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--ls-muted)]">Instant HTTPS Relay</span>
                  <span className="font-mono font-medium">*.lorndavid.online</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--ls-muted)]">Domain Ownership</span>
                  <span className="font-medium">RFC DNS TXT Verification</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--ls-muted)]">Security Architecture</span>
                  <span className="font-medium">AES-256-GCM + RBAC</span>
                </div>
              </div>
            </div>

            {/* Right Auth Form Column */}
            <div className="p-6 sm:p-9 lg:col-span-6">
              <div className="mb-5">
                <h2 className="font-heading text-base font-semibold">
                  {authMode === 'register' ? 'Create your account' : 'Sign in to your workspace'}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--ls-text-secondary)]">
                  {authMode === 'register'
                    ? 'Start managing tunnels, custom domains, and team access.'
                    : 'Enter your credentials to access the control plane.'}
                </p>
              </div>

              {errorBanner && (
                <div
                  role="alert"
                  className="mb-4 rounded-[7px] border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300"
                >
                  {errorBanner}
                </div>
              )}

              <form onSubmit={(e) => void handleAuthSubmit(e)} className="space-y-3.5">
                {authMode === 'register' && (
                  <div className="gsap-field">
                    <label htmlFor="auth-name" className="mb-1 block text-xs font-medium">
                      Full Name
                    </label>
                    <input
                      id="auth-name"
                      type="text"
                      required
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      placeholder="Ada Lovelace"
                      className="ls-input w-full"
                    />
                  </div>
                )}

                <div className="gsap-field">
                  <label htmlFor="auth-email" className="mb-1 block text-xs font-medium">
                    Email Address
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="developer@company.com"
                    className="ls-input w-full"
                  />
                </div>

                <div className="gsap-field">
                  <label htmlFor="auth-password" className="mb-1 block text-xs font-medium">
                    Password (min 10 chars)
                  </label>
                  <input
                    id="auth-password"
                    type="password"
                    required
                    minLength={10}
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="ls-input w-full"
                  />
                </div>

                <div className="gsap-field pt-1">
                  <button type="submit" className="ls-btn-primary w-full py-2.5">
                    <span>{authMode === 'register' ? 'Create Account' : 'Sign In'}</span>
                    <ArrowUpRight className="h-4 w-4" />
                  </button>
                </div>
              </form>

              <div className="mt-5 border-t border-[var(--ls-border)] pt-4 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setErrorBanner(null);
                    setAuthMode(authMode === 'login' ? 'register' : 'login');
                  }}
                  className="text-xs font-medium text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] hover:underline"
                >
                  {authMode === 'login'
                    ? 'Need an account? Register'
                    : 'Already have an account? Sign in'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <footer className="border-t border-[var(--ls-border)] bg-[var(--ls-surface)] px-4 py-3 text-center text-[11px] text-[var(--ls-muted)]">
          LocalShare Developer Platform • Minimalist HTTPS Tunnel Control Plane
        </footer>
      </div>
    );
  }

  const canWriteMember = activeOrg ? roleAtLeast(activeOrg.role, 'MEMBER') : false;
  const canWriteAdmin = activeOrg ? roleAtLeast(activeOrg.role, 'ADMIN') : false;
  const isOwner = activeOrg ? activeOrg.role === 'OWNER' : false;

  // ---------------------------------------------------------------------------
  // Authenticated Application Shell
  // ---------------------------------------------------------------------------
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Mobile Header Bar (< 768px) */}
      <div className="flex items-center justify-between border-b border-[var(--ls-border)] bg-[var(--ls-surface)] px-4 py-3 md:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-[5px] bg-[var(--ls-btn-bg)] text-[var(--ls-btn-text)]">
            <Radio className="h-3.5 w-3.5" />
          </div>
          <span className="font-heading text-sm font-bold tracking-tight">LocalShare</span>
        </div>
        <div className="flex items-center gap-2">
          {activeOrg && canWriteMember && (
            <button
              type="button"
              onClick={() => setCreateShareOpen(true)}
              className="ls-btn-primary px-2.5 py-1 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Share</span>
            </button>
          )}
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle navigation menu"
            className="ls-btn-secondary p-1.5"
          >
            {mobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Left Sidebar (Fixed on Desktop, Slide-Out Drawer on Mobile) */}
      <aside
        className={`${
          mobileMenuOpen ? 'flex' : 'hidden'
        } md:flex w-full md:w-60 lg:w-64 shrink-0 flex-col justify-between border-b md:border-b-0 md:border-r border-[var(--ls-border)] bg-[var(--ls-surface)] p-4`}
      >
        <div className="space-y-5">
          {/* Desktop Brand Header */}
          <div className="hidden items-center justify-between md:flex">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-[var(--ls-btn-bg)] text-[var(--ls-btn-text)]">
                <Radio className="h-3.5 w-3.5" />
              </div>
              <div>
                <span className="font-heading text-sm font-bold tracking-tight block leading-none">
                  LocalShare
                </span>
                <span className="text-[11px] text-[var(--ls-muted)]">Control Plane</span>
              </div>
            </div>
            <ThemeToggle />
          </div>

          {/* Workspace / Organization Selector */}
          <div>
            <label
              htmlFor="org-switcher"
              className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--ls-muted)]"
            >
              Workspace
            </label>
            {organizations.length > 0 ? (
              <select
                id="org-switcher"
                value={activeOrgId}
                onChange={(e) => setActiveOrgId(e.target.value)}
                className="ls-input w-full text-xs font-medium"
              >
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name} ({org.role})
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-[var(--ls-muted)]">No workspace yet</p>
            )}
          </div>

          {/* Grouped Navigation */}
          <nav aria-label="Main navigation" className="space-y-4">
            <div>
              <div
                aria-hidden="true"
                className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ls-muted)]"
              >
                Workspace
              </div>
              <div className="space-y-0.5">
                {WORKSPACE_NAV.map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-xs font-medium transition-colors ${
                        active
                          ? 'bg-[var(--ls-btn-bg)] text-[var(--ls-btn-text)]'
                          : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-hover)] hover:text-[var(--ls-text)]'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div
                aria-hidden="true"
                className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ls-muted)]"
              >
                Management
              </div>
              <div className="space-y-0.5">
                {MANAGEMENT_NAV.map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-xs font-medium transition-colors ${
                        active
                          ? 'bg-[var(--ls-btn-bg)] text-[var(--ls-btn-text)]'
                          : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-hover)] hover:text-[var(--ls-text)]'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </nav>
        </div>

        {/* Sidebar Footer: Usage, Plan, Help & User Profile */}
        <div className="mt-6 space-y-3 border-t border-[var(--ls-border)] pt-3.5">
          <div className="ls-surface-secondary p-2.5 text-[11px]">
            <div className="flex items-center justify-between font-medium">
              <span>Self-Hosted Plan</span>
              <span className="tabular-nums text-[var(--ls-muted)]">
                {overview?.activeTunnels ?? 0} active
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[var(--ls-muted)]">
              <span>Relay: *.lorndavid.online</span>
              <span className="inline-flex items-center gap-1">
                <HelpCircle className="h-3 w-3" />
                <span>Docs</span>
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="truncate">
              <div className="truncate text-xs font-semibold">{user.name}</div>
              <div className="truncate text-[11px] text-[var(--ls-muted)]">{user.email}</div>
            </div>
            <button
              type="button"
              onClick={() => void apiClient.logout().then(() => setUser(null))}
              aria-label="Sign out"
              className="ls-btn-secondary p-1.5"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Desktop Top Navigation Bar */}
        <header className="hidden md:flex items-center justify-between border-b border-[var(--ls-border)] bg-[var(--ls-surface)] px-8 py-3.5">
          <div className="flex items-center gap-2 text-xs text-[var(--ls-text-secondary)]">
            <span className="font-medium text-[var(--ls-text)]">
              {activeOrg?.name ?? 'Onboarding'}
            </span>
            <span>/</span>
            <span className="capitalize">{activeTab}</span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void refreshActiveTabData()}
              className="ls-btn-secondary"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Refresh</span>
            </button>
            {activeOrg && canWriteMember && (
              <button
                type="button"
                onClick={() => setCreateShareOpen(true)}
                className="ls-btn-primary"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New Share</span>
              </button>
            )}
          </div>
        </header>

        <main ref={mainContentRef} className="flex-1 p-4 sm:p-6 lg:p-8 max-w-6xl w-full mx-auto">
          {errorBanner && (
            <div
              role="alert"
              className="mb-5 flex items-center justify-between rounded-[8px] border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-700 dark:text-red-300"
            >
              <span>{errorBanner}</span>
              <button
                type="button"
                onClick={() => setErrorBanner(null)}
                className="ml-4 font-medium underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {infoBanner && (
            <div
              role="status"
              className="mb-5 flex items-center justify-between rounded-[8px] border border-[var(--ls-border-strong)] bg-[var(--ls-surface)] px-4 py-2.5 text-xs text-[var(--ls-text)] shadow-xs"
            >
              <span>{infoBanner}</span>
              <button
                type="button"
                onClick={() => setInfoBanner(null)}
                className="ml-4 text-[var(--ls-muted)] hover:text-[var(--ls-text)]"
              >
                Close
              </button>
            </div>
          )}

          {/* Create Organization Onboarding if user has none */}
          {organizations.length === 0 ? (
            <section className="gsap-section ls-surface p-6 sm:p-8 max-w-xl">
              <h2 className="font-heading text-lg font-bold">Create Your Organization</h2>
              <p className="mt-1 text-xs text-[var(--ls-text-secondary)] mb-5">
                Organizations isolate workspaces, tunnel metadata, custom domains, and team access
                policies.
              </p>
              <form
                onSubmit={(e) => void handleCreateOrganization(e)}
                className="flex flex-col sm:flex-row gap-2.5"
              >
                <input
                  type="text"
                  required
                  aria-label="New organization name"
                  placeholder="Acme Engineering"
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  className="ls-input flex-1"
                />
                <button type="submit" className="ls-btn-primary">
                  <Plus className="h-4 w-4" />
                  <span>Create</span>
                </button>
              </form>
            </section>
          ) : (
            <>
              {/* 1. OVERVIEW TAB */}
              {activeTab === 'overview' && (
                <section className="gsap-section space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="font-heading text-xl sm:text-2xl font-bold tracking-tight">
                        {activeOrg?.name} — Overview
                      </h2>
                      <p className="mt-0.5 text-xs text-[var(--ls-text-secondary)]">
                        Live workspace telemetry, active shares, custom domains, and security posture.
                      </p>
                    </div>
                  </div>

                  {/* 4 Required Metric Cards */}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
                    {[
                      {
                        label: 'Active Tunnels',
                        value: overview?.activeTunnels ?? 0,
                        desc: 'Currently online HTTPS endpoints',
                        icon: Radio,
                      },
                      {
                        label: 'Online Tunnels',
                        value: overview?.activeTunnels ?? 0,
                        desc: `${overview?.totalTunnels ?? 0} total registered`,
                        icon: Play,
                      },
                      {
                        label: 'Custom Domains',
                        value: overview?.verifiedDomains ?? 0,
                        desc: `${overview?.pendingDomains ?? 0} pending verification`,
                        icon: Globe,
                      },
                      {
                        label: 'Shares This Month',
                        value: overview?.totalTunnels ?? 0,
                        desc: `Across ${overview?.workspaces ?? 0} project workspaces`,
                        icon: FolderGit2,
                      },
                    ].map((stat) => {
                      const Icon = stat.icon;
                      return (
                        <div key={stat.label} className="gsap-card ls-surface p-4">
                          <div className="flex items-center justify-between text-xs text-[var(--ls-text-secondary)]">
                            <span className="font-medium">{stat.label}</span>
                            <Icon className="h-4 w-4 text-[var(--ls-muted)]" />
                          </div>
                          <div className="mt-2 font-heading text-2xl font-bold tabular-nums">
                            {stat.value}
                          </div>
                          <div className="mt-1 text-[11px] text-[var(--ls-muted)]">{stat.desc}</div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Active Shares + Quick Start Grid */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                    <div className="gsap-card ls-surface p-5 lg:col-span-8 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-heading text-sm font-semibold">Active Shares</h3>
                          <p className="text-xs text-[var(--ls-text-secondary)]">
                            Public HTTPS links currently routing to local development ports.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setActiveTab('tunnels')}
                          className="ls-btn-secondary text-xs"
                        >
                          View All
                        </button>
                      </div>

                      {!tunnelsPage?.items?.length ? (
                        <div className="ls-surface-secondary p-6 text-center">
                          <p className="text-xs text-[var(--ls-text-secondary)]">
                            No active shares yet. Start a tunnel from VS Code or click New Share.
                          </p>
                        </div>
                      ) : (
                        <div className="divide-y divide-[var(--ls-border)]">
                          {tunnelsPage.items.slice(0, 5).map((t) => (
                            <div
                              key={t.id}
                              className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs"
                            >
                              <div className="space-y-0.5">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold">{t.name}</span>
                                  <StatusBadge status={t.state} />
                                </div>
                                <div className="font-mono text-[11px] text-[var(--ls-text-secondary)]">
                                  {t.localTarget} → {t.publicUrl ?? 'pending'}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {t.publicUrl && (
                                  <>
                                    <CopyButton value={t.publicUrl} label="Copy URL" />
                                    <a
                                      href={t.publicUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="ls-btn-secondary px-2.5 py-1 text-xs"
                                    >
                                      <span>Open</span>
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  </>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Quick Start Card */}
                    <div className="gsap-card ls-surface p-5 lg:col-span-4 space-y-3.5">
                      <h3 className="font-heading text-sm font-semibold">Quick Start</h3>
                      <ol className="space-y-2.5 text-xs text-[var(--ls-text-secondary)]">
                        <li className="flex gap-2.5">
                          <span className="font-mono font-semibold text-[var(--ls-text)]">1.</span>
                          <span>Run your local development server (e.g. port 5173 or 3000).</span>
                        </li>
                        <li className="flex gap-2.5">
                          <span className="font-mono font-semibold text-[var(--ls-text)]">2.</span>
                          <span>Select the local port in VS Code or click New Share.</span>
                        </li>
                        <li className="flex gap-2.5">
                          <span className="font-mono font-semibold text-[var(--ls-text)]">3.</span>
                          <span>Confirm exposure and start sharing over HTTPS.</span>
                        </li>
                        <li className="flex gap-2.5">
                          <span className="font-mono font-semibold text-[var(--ls-text)]">4.</span>
                          <span>Copy the public *.lorndavid.online URL.</span>
                        </li>
                        <li className="flex gap-2.5">
                          <span className="font-mono font-semibold text-[var(--ls-text)]">5.</span>
                          <span>Send the preview link to your customer or teammate.</span>
                        </li>
                      </ol>
                    </div>
                  </div>

                  {/* Custom Domains Summary + Security Summary + Recent Activity */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div className="gsap-card ls-surface p-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="font-heading text-sm font-semibold">Custom Domains</h3>
                        <button
                          type="button"
                          onClick={() => setActiveTab('domains')}
                          className="text-xs font-medium underline"
                        >
                          Manage Domains
                        </button>
                      </div>
                      {domains.length === 0 ? (
                        <p className="text-xs text-[var(--ls-muted)]">
                          No custom domains configured yet.
                        </p>
                      ) : (
                        <ul className="divide-y divide-[var(--ls-border)] text-xs">
                          {domains.slice(0, 3).map((d) => (
                            <li key={d.id} className="py-2 flex items-center justify-between">
                              <span className="font-mono font-medium">{d.hostname}</span>
                              <StatusBadge status={d.status} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="gsap-card ls-surface p-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="font-heading text-sm font-semibold">Security Summary</h3>
                        <button
                          type="button"
                          onClick={() => setActiveTab('security')}
                          className="text-xs font-medium underline"
                        >
                          Security Settings
                        </button>
                      </div>
                      <div className="space-y-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-[var(--ls-text-secondary)]">
                            Public Exposure Confirmation
                          </span>
                          <StatusBadge status="ACTIVE" />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[var(--ls-text-secondary)]">
                            Sensitive Port Guard (DB / SSH / Redis)
                          </span>
                          <StatusBadge status="ACTIVE" />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[var(--ls-text-secondary)]">
                            Configured Access Policies
                          </span>
                          <span className="font-mono font-semibold tabular-nums">
                            {policies.length}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Recent Activity */}
                  <div className="gsap-card ls-surface p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-heading text-sm font-semibold">
                        Recent Security &amp; Activity Events
                      </h3>
                      <button
                        type="button"
                        onClick={() => setActiveTab('activity')}
                        className="text-xs font-medium underline"
                      >
                        Full Activity Log
                      </button>
                    </div>
                    {overview?.recentEvents.length ? (
                      <ul className="divide-y divide-[var(--ls-border)] text-xs">
                        {overview.recentEvents.map((ev) => (
                          <li
                            key={ev.id}
                            className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                          >
                            <div>
                              <span className="font-mono font-medium text-[var(--ls-text)]">
                                {ev.action}
                              </span>
                              <span className="ml-2 text-[var(--ls-text-secondary)]">
                                by {ev.actorEmail ?? 'system'}
                              </span>
                            </div>
                            <time className="text-[11px] text-[var(--ls-muted)] tabular-nums">
                              {new Date(ev.createdAt).toLocaleString()}
                            </time>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-[var(--ls-muted)]">No events recorded yet.</p>
                    )}
                  </div>
                </section>
              )}

              {/* 2. PROJECTS (WORKSPACES) TAB */}
              {activeTab === 'projects' && (
                <section className="gsap-section space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="font-heading text-xl font-bold tracking-tight">
                        Projects &amp; Workspaces
                      </h2>
                      <p className="text-xs text-[var(--ls-text-secondary)]">
                        Register repositories shared from the LocalShare VS Code extension.
                      </p>
                    </div>
                    <div className="relative w-full sm:w-64">
                      <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-[var(--ls-muted)]" />
                      <input
                        type="search"
                        aria-label="Search projects"
                        placeholder="Search projects…"
                        value={projectSearch}
                        onChange={(e) => setProjectSearch(e.target.value)}
                        className="ls-input w-full pl-8"
                      />
                    </div>
                  </div>

                  {canWriteMember && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const v = validateLabel(wsName, 'Workspace name', 64);
                        if (!v.ok) {
                          setErrorBanner(v.error);
                          return;
                        }
                        void apiClient
                          .createWorkspace(activeOrgId, {
                            name: v.value,
                            description: wsDesc || undefined,
                          })
                          .then(() => {
                            setWsName('');
                            setWsDesc('');
                            return refreshActiveTabData();
                          })
                          .catch((err: unknown) =>
                            setErrorBanner(err instanceof Error ? err.message : String(err)),
                          );
                      }}
                      className="gsap-card ls-surface p-4 flex flex-col md:flex-row gap-3"
                    >
                      <input
                        type="text"
                        required
                        aria-label="Workspace name"
                        placeholder="Workspace name (e.g. storefront-web)"
                        value={wsName}
                        onChange={(e) => setWsName(e.target.value)}
                        className="ls-input flex-1"
                      />
                      <input
                        type="text"
                        aria-label="Workspace description"
                        placeholder="Optional description"
                        value={wsDesc}
                        onChange={(e) => setWsDesc(e.target.value)}
                        className="ls-input flex-1"
                      />
                      <button type="submit" className="ls-btn-primary shrink-0">
                        <Plus className="h-3.5 w-3.5" />
                        <span>Create Project</span>
                      </button>
                    </form>
                  )}

                  <div className="gsap-card ls-surface divide-y divide-[var(--ls-border)]">
                    {filteredWorkspaces.length === 0 ? (
                      <p className="p-6 text-xs text-[var(--ls-muted)]">
                        No workspaces created yet.
                      </p>
                    ) : (
                      filteredWorkspaces.map((ws) => {
                        const relatedCount = (tunnelsPage?.items ?? []).filter(
                          (t) => t.workspaceId === ws.id,
                        ).length;
                        return (
                          <div
                            key={ws.id}
                            className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                          >
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold">{ws.name}</span>
                                <span className="rounded-[5px] border border-[var(--ls-border-strong)] bg-[var(--ls-surface-secondary)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--ls-text-secondary)]">
                                  {relatedCount} {relatedCount === 1 ? 'share' : 'shares'}
                                </span>
                              </div>
                              {ws.description && (
                                <div className="mt-0.5 text-xs text-[var(--ls-text-secondary)]">
                                  {ws.description}
                                </div>
                              )}
                            </div>
                            {canWriteMember && (
                              <button
                                type="button"
                                aria-label={`Delete workspace ${ws.name}`}
                                onClick={() =>
                                  void apiClient
                                    .deleteWorkspace(activeOrgId, ws.id)
                                    .then(() => refreshActiveTabData())
                                }
                                className="ls-btn-secondary p-1.5 text-[var(--ls-muted)] hover:text-red-600"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>
              )}

              {/* 3. TUNNELS TAB */}
              {activeTab === 'tunnels' && (
                <section className="gsap-section space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="font-heading text-xl font-bold tracking-tight">
                        Tunnel Inventory
                      </h2>
                      <p className="text-xs text-[var(--ls-text-secondary)]">
                        Manage active and historical HTTPS shares across your workspaces.
                      </p>
                    </div>
                    {canWriteMember && (
                      <button
                        type="button"
                        onClick={() => setCreateShareOpen(true)}
                        className="ls-btn-primary"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>New Share</span>
                      </button>
                    )}
                  </div>

                  {/* Search, Status Filter, Project Filter, Sort */}
                  <div className="gsap-card ls-surface p-3.5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-[var(--ls-muted)]" />
                      <input
                        type="search"
                        aria-label="Search tunnels"
                        placeholder="Search name, port, URL…"
                        value={tunnelSearch}
                        onChange={(e) => setTunnelSearch(e.target.value)}
                        className="ls-input w-full pl-8"
                      />
                    </div>
                    <select
                      aria-label="Filter tunnels by state"
                      value={tunnelStateFilter}
                      onChange={(e) => setTunnelStateFilter(e.target.value)}
                      className="ls-input w-full"
                    >
                      <option value="">All States</option>
                      {TUNNEL_STATES.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Filter tunnels by project"
                      value={tunnelProjectFilter}
                      onChange={(e) => setTunnelProjectFilter(e.target.value)}
                      className="ls-input w-full"
                    >
                      <option value="">All Projects</option>
                      {workspaces.map((ws) => (
                        <option key={ws.id} value={ws.id}>
                          {ws.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Sort tunnels"
                      value={tunnelSort}
                      onChange={(e) =>
                        setTunnelSort(e.target.value as 'newest' | 'name' | 'status')
                      }
                      className="ls-input w-full"
                    >
                      <option value="newest">Sort: Last Activity</option>
                      <option value="name">Sort: Name (A–Z)</option>
                      <option value="status">Sort: Status</option>
                    </select>
                  </div>

                  {/* Responsive Table / Mobile Cards */}
                  <div className="gsap-card ls-surface overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-[var(--ls-border)] bg-[var(--ls-surface-secondary)] text-[11px] font-semibold uppercase text-[var(--ls-muted)]">
                        <tr>
                          <th className="px-4 py-3">Name</th>
                          <th className="px-4 py-3">Target</th>
                          <th className="px-4 py-3">State</th>
                          <th className="px-4 py-3">Access</th>
                          <th className="px-4 py-3">Public URL</th>
                          <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--ls-border)]">
                        {filteredTunnels.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-4 py-8 text-center text-[var(--ls-muted)]">
                              No tunnel records found.
                            </td>
                          </tr>
                        ) : (
                          filteredTunnels.map((t) => (
                            <tr key={t.id} className="hover:bg-[var(--ls-surface-secondary)]">
                              <td className="px-4 py-3 font-medium">
                                {t.name}
                                {t.framework && (
                                  <span className="ml-1.5 text-[11px] text-[var(--ls-muted)]">
                                    ({t.framework})
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3 font-mono">{t.localTarget}</td>
                              <td className="px-4 py-3">
                                <StatusBadge status={t.state} />
                              </td>
                              <td className="px-4 py-3">{t.accessMode}</td>
                              <td className="px-4 py-3 font-mono">
                                {t.publicUrl ? (
                                  <a
                                    href={t.publicUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 underline hover:opacity-75"
                                  >
                                    <span>{t.publicUrl}</span>
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td className="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
                                {t.publicUrl && <CopyButton value={t.publicUrl} label="Copy URL" />}
                                {canWriteMember && (
                                  <>
                                    {t.state === 'ONLINE' ? (
                                      <button
                                        type="button"
                                        aria-label={`Stop tunnel ${t.name}`}
                                        onClick={() => void handleToggleTunnelState(t, 'STOPPED')}
                                        className="ls-btn-secondary px-2 py-1 text-xs"
                                      >
                                        <Square className="h-3 w-3" />
                                        <span>Stop</span>
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        aria-label={`Restart tunnel ${t.name}`}
                                        onClick={() => void handleToggleTunnelState(t, 'ONLINE')}
                                        className="ls-btn-secondary px-2 py-1 text-xs"
                                      >
                                        <Play className="h-3 w-3" />
                                        <span>Restart</span>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      aria-label={`Delete tunnel ${t.name}`}
                                      onClick={() =>
                                        void apiClient
                                          .deleteTunnel(activeOrgId, t.id)
                                          .then(() => refreshActiveTabData())
                                      }
                                      className="ls-btn-secondary p-1 text-[var(--ls-muted)] hover:text-red-600"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* 4. CUSTOM DOMAINS TAB */}
              {activeTab === 'domains' && (
                <section className="gsap-section space-y-6">
                  <div>
                    <h2 className="font-heading text-xl font-bold tracking-tight">
                      Custom Preview Domains
                    </h2>
                    <p className="text-xs text-[var(--ls-text-secondary)]">
                      Authorize customer or team hostnames via DNS TXT ownership verification.
                      LocalShare never marks a domain verified before the live DNS check succeeds.
                    </p>
                  </div>

                  {canWriteAdmin && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const valid = validateHostname(domainHost);
                        if (!valid.ok) {
                          setErrorBanner(valid.error);
                          return;
                        }
                        void apiClient
                          .createDomain(activeOrgId, valid.value)
                          .then(() => {
                            setDomainHost('');
                            return refreshActiveTabData();
                          })
                          .catch((err: unknown) =>
                            setErrorBanner(err instanceof Error ? err.message : String(err)),
                          );
                      }}
                      className="gsap-card ls-surface p-4 flex flex-col sm:flex-row gap-3"
                    >
                      <input
                        type="text"
                        required
                        aria-label="Custom domain hostname"
                        placeholder="preview.customer.com"
                        value={domainHost}
                        onChange={(e) => setDomainHost(e.target.value)}
                        className="ls-input flex-1"
                      />
                      <button type="submit" className="ls-btn-primary shrink-0">
                        <Plus className="h-3.5 w-3.5" />
                        <span>Add Domain</span>
                      </button>
                    </form>
                  )}

                  <div className="space-y-3.5">
                    {domains.length === 0 ? (
                      <EmptyState
                        title="No custom domains registered yet"
                        description="Add a customer or team hostname above to generate a DNS TXT verification record."
                      />
                    ) : (
                      domains.map((d) => (
                        <div key={d.id} className="gsap-card ls-surface p-5 space-y-3.5">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                              <span className="font-mono text-sm font-semibold">{d.hostname}</span>
                              <StatusBadge status={d.status} />
                            </div>
                            {canWriteAdmin && (
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void apiClient
                                      .verifyDomain(activeOrgId, d.id)
                                      .then(() => refreshActiveTabData())
                                      .catch((err: unknown) =>
                                        setErrorBanner(
                                          err instanceof Error ? err.message : String(err),
                                        ),
                                      )
                                  }
                                  className="ls-btn-primary text-xs"
                                >
                                  Verify DNS TXT
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Delete domain ${d.hostname}`}
                                  onClick={() =>
                                    void apiClient
                                      .deleteDomain(activeOrgId, d.id)
                                      .then(() => refreshActiveTabData())
                                  }
                                  className="ls-btn-secondary p-1.5 text-[var(--ls-muted)] hover:text-red-600"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            )}
                          </div>

                          <div className="ls-surface-secondary p-3.5 text-xs space-y-2">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                              <span className="text-[var(--ls-muted)]">TXT Record Name:</span>
                              <div className="flex items-center gap-2">
                                <code className="font-mono break-all">
                                  {d.verification.recordName}
                                </code>
                                <CopyButton value={d.verification.recordName} label="Copy Name" />
                              </div>
                            </div>
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                              <span className="text-[var(--ls-muted)]">TXT Record Value:</span>
                              <div className="flex items-center gap-2">
                                <code className="font-mono break-all">
                                  {d.verification.recordValue}
                                </code>
                                <CopyButton value={d.verification.recordValue} label="Copy Value" />
                              </div>
                            </div>
                            {d.status !== 'VERIFIED' && (
                              <div className="pt-1 text-[var(--ls-text-secondary)]">
                                {d.verification.lastError
                                  ? `Your DNS record hasn't been detected yet (${d.verification.lastError}). Check the record above or try verification again.`
                                  : 'Publish the DNS TXT record above at your DNS provider, then click Verify DNS TXT.'}
                              </div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              )}

              {/* 5. TEAMS TAB */}
              {activeTab === 'teams' && (
                <section className="gsap-section space-y-6">
                  <div>
                    <h2 className="font-heading text-xl font-bold tracking-tight">Team Members</h2>
                    <p className="text-xs text-[var(--ls-text-secondary)]">
                      Manage role-based access (OWNER, ADMIN, MEMBER, VIEWER) for {activeOrg?.name}.
                    </p>
                  </div>

                  {canWriteAdmin && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const valid = validateEmail(memberEmail);
                        if (!valid.ok) {
                          setErrorBanner(valid.error);
                          return;
                        }
                        void apiClient
                          .addMember(activeOrgId, { email: valid.value, role: memberRole })
                          .then(() => {
                            setMemberEmail('');
                            return refreshActiveTabData();
                          })
                          .catch((err: unknown) =>
                            setErrorBanner(err instanceof Error ? err.message : String(err)),
                          );
                      }}
                      className="gsap-card ls-surface p-4 flex flex-col sm:flex-row gap-3"
                    >
                      <input
                        type="email"
                        required
                        aria-label="Member email address"
                        placeholder="teammate@company.com"
                        value={memberEmail}
                        onChange={(e) => setMemberEmail(e.target.value)}
                        className="ls-input flex-1"
                      />
                      <select
                        aria-label="Member role"
                        value={memberRole}
                        onChange={(e) => setMemberRole(e.target.value as OrgRole)}
                        className="ls-input"
                      >
                        {ORG_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button type="submit" className="ls-btn-primary shrink-0">
                        <Plus className="h-3.5 w-3.5" />
                        <span>Add Member</span>
                      </button>
                    </form>
                  )}

                  <div className="gsap-card ls-surface divide-y divide-[var(--ls-border)]">
                    {members.map((m) => (
                      <div key={m.id} className="p-4 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium">{m.name}</div>
                          <div className="text-xs text-[var(--ls-muted)]">{m.email}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="rounded-[5px] border border-[var(--ls-border-strong)] bg-[var(--ls-surface-secondary)] px-2.5 py-0.5 text-xs font-medium">
                            {m.role}
                          </span>
                          {canWriteAdmin && m.userId !== user.id && (
                            <button
                              type="button"
                              aria-label={`Remove member ${m.email}`}
                              onClick={() =>
                                void apiClient
                                  .removeMember(activeOrgId, m.id)
                                  .then(() => refreshActiveTabData())
                                  .catch((err: unknown) =>
                                    setErrorBanner(
                                      err instanceof Error ? err.message : String(err),
                                    ),
                                  )
                              }
                              className="ls-btn-secondary p-1.5 text-[var(--ls-muted)] hover:text-red-600"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* 6. SECURITY TAB */}
              {activeTab === 'security' && (
                <section className="gsap-section space-y-8">
                  {/* Built-In Security Guardrails Summary */}
                  <div className="gsap-card ls-surface p-5 space-y-3">
                    <div className="flex items-center gap-2">
                      <Lock className="h-4 w-4" />
                      <h2 className="font-heading text-base font-semibold">
                        Default Security Guardrails
                      </h2>
                    </div>
                    <p className="text-xs text-[var(--ls-text-secondary)]">
                      LocalShare blocks accidental public exposure of databases and internal
                      daemons by default (PostgreSQL :5432, MySQL :3306, Redis :6379, MongoDB
                      :27017, SSH :22, Docker :2375) and requires explicit developer confirmation
                      before opening any public tunnel.
                    </p>
                  </div>

                  {/* Access Policies */}
                  <div className="space-y-3">
                    <h2 className="font-heading text-lg font-bold">Access Policies</h2>
                    <p className="text-xs text-[var(--ls-text-secondary)]">
                      Define identity rules (allowed emails and email domains) for protected preview
                      hostnames.
                    </p>

                    {canWriteAdmin && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const nameOk = validateLabel(policyName, 'Policy name', 64);
                          if (!nameOk.ok) {
                            setErrorBanner(nameOk.error);
                            return;
                          }
                          const emails: string[] = [];
                          const emailDomains: string[] = [];
                          for (const item of policyTargets
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean)) {
                            if (item.startsWith('@') || !item.includes('@')) {
                              const d = validateEmailDomain(item);
                              if (!d.ok) {
                                setErrorBanner(d.error);
                                return;
                              }
                              emailDomains.push(d.value);
                            } else {
                              const em = validateEmail(item);
                              if (!em.ok) {
                                setErrorBanner(em.error);
                                return;
                              }
                              emails.push(em.value);
                            }
                          }
                          void apiClient
                            .createAccessPolicy(activeOrgId, {
                              name: nameOk.value,
                              mode: policyMode,
                              rules: {
                                allowedEmails: emails,
                                allowedEmailDomains: emailDomains,
                                sessionDurationHours: 12,
                              },
                            })
                            .then(() => {
                              setPolicyName('');
                              setPolicyTargets('');
                              return refreshActiveTabData();
                            })
                            .catch((err: unknown) =>
                              setErrorBanner(err instanceof Error ? err.message : String(err)),
                            );
                        }}
                        className="gsap-card ls-surface p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
                      >
                        <input
                          type="text"
                          required
                          aria-label="Policy name"
                          placeholder="Customer Reviewers"
                          value={policyName}
                          onChange={(e) => setPolicyName(e.target.value)}
                          className="ls-input"
                        />
                        <select
                          aria-label="Policy access mode"
                          value={policyMode}
                          onChange={(e) => setPolicyMode(e.target.value as AccessMode)}
                          className="ls-input"
                        >
                          <option value="CLOUDFLARE_ACCESS">CLOUDFLARE_ACCESS</option>
                          <option value="PASSWORD">PASSWORD</option>
                          <option value="PUBLIC">PUBLIC</option>
                        </select>
                        <input
                          type="text"
                          aria-label="Allowed emails or domains"
                          placeholder="alice@customer.com, @customer.com"
                          value={policyTargets}
                          onChange={(e) => setPolicyTargets(e.target.value)}
                          className="ls-input"
                        />
                        <button type="submit" className="ls-btn-primary">
                          <Plus className="h-3.5 w-3.5" />
                          <span>Create Policy</span>
                        </button>
                      </form>
                    )}

                    <div className="gsap-card ls-surface divide-y divide-[var(--ls-border)]">
                      {policies.length === 0 ? (
                        <p className="p-4 text-xs text-[var(--ls-muted)]">
                          No access policies defined.
                        </p>
                      ) : (
                        policies.map((p) => (
                          <div key={p.id} className="p-4 flex items-center justify-between">
                            <div>
                              <div className="text-sm font-medium">
                                {p.name}{' '}
                                <span className="ml-2 rounded-[5px] border border-[var(--ls-border-strong)] bg-[var(--ls-surface-secondary)] px-2 py-0.5 text-[11px]">
                                  {p.mode}
                                </span>
                              </div>
                              <div className="text-xs text-[var(--ls-muted)] mt-1">
                                {[
                                  ...p.rules.allowedEmails,
                                  ...p.rules.allowedEmailDomains.map((d) => `@${d}`),
                                ].join(', ') || 'No identity restrictions'}
                              </div>
                            </div>
                            {canWriteAdmin && (
                              <button
                                type="button"
                                aria-label={`Delete policy ${p.name}`}
                                onClick={() =>
                                  void apiClient
                                    .deleteAccessPolicy(activeOrgId, p.id)
                                    .then(() => refreshActiveTabData())
                                }
                                className="ls-btn-secondary p-1.5 text-[var(--ls-muted)] hover:text-red-600"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Personal API Tokens for VS Code Extension */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4" />
                      <h3 className="font-heading text-base font-semibold">
                        Personal API Tokens (VS Code Extension)
                      </h3>
                    </div>
                    <p className="text-xs text-[var(--ls-text-secondary)]">
                      Generate an <code className="font-mono">lsk_</code> token to sync your VS Code
                      extension shares with LocalShare Cloud. Plaintext tokens are shown only once.
                    </p>

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void apiClient
                          .createApiToken({ name: tokenName, expiresInDays: 90 })
                          .then((created) => {
                            setTokenName('');
                            setCreatedTokenModal(created);
                            return refreshActiveTabData();
                          })
                          .catch((err: unknown) =>
                            setErrorBanner(err instanceof Error ? err.message : String(err)),
                          );
                      }}
                      className="gsap-card ls-surface p-4 flex flex-col sm:flex-row gap-3"
                    >
                      <input
                        type="text"
                        required
                        aria-label="Personal API token name"
                        placeholder="Workstation VS Code"
                        value={tokenName}
                        onChange={(e) => setTokenName(e.target.value)}
                        className="ls-input flex-1"
                      />
                      <button type="submit" className="ls-btn-primary shrink-0">
                        <Plus className="h-3.5 w-3.5" />
                        <span>Generate Token</span>
                      </button>
                    </form>

                    {createdTokenModal && (
                      <div
                        role="dialog"
                        aria-label="New API token generated"
                        className="ls-surface border-emerald-600/40 bg-emerald-500/5 p-4 space-y-2.5"
                      >
                        <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                          Copy your new API token now — it will never be displayed again:
                        </div>
                        <div className="flex items-center justify-between gap-2 rounded-[7px] border border-[var(--ls-border-strong)] bg-[var(--ls-surface)] p-2.5">
                          <code className="font-mono text-xs break-all">
                            {createdTokenModal.token}
                          </code>
                          <CopyButton value={createdTokenModal.token} label="Copy Token" />
                        </div>
                        <button
                          type="button"
                          onClick={() => setCreatedTokenModal(null)}
                          className="text-xs font-medium underline"
                        >
                          I have saved this token
                        </button>
                      </div>
                    )}

                    <div className="gsap-card ls-surface divide-y divide-[var(--ls-border)]">
                      {apiTokens.length === 0 ? (
                        <p className="p-4 text-xs text-[var(--ls-muted)]">
                          No personal API tokens active.
                        </p>
                      ) : (
                        apiTokens.map((tok) => (
                          <div
                            key={tok.id}
                            className="p-4 flex items-center justify-between text-xs"
                          >
                            <div>
                              <span className="font-medium">{tok.name}</span>
                              <code className="ml-2 font-mono text-[var(--ls-muted)]">
                                {tok.prefix}…
                              </code>
                            </div>
                            <button
                              type="button"
                              aria-label={`Revoke token ${tok.name}`}
                              onClick={() =>
                                void apiClient
                                  .revokeApiToken(tok.id)
                                  .then(() => refreshActiveTabData())
                              }
                              className="ls-btn-secondary p-1.5 text-[var(--ls-muted)] hover:text-red-600"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Cloudflare Provider Connections */}
                  <div className="space-y-3">
                    <h3 className="font-heading text-base font-semibold">
                      Encrypted Provider Connections
                    </h3>
                    {canWriteAdmin && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void apiClient
                            .createProviderConnection(activeOrgId, {
                              provider: 'cloudflare',
                              label: cfLabel,
                              accountId: cfAccountId || undefined,
                              token: cfToken,
                            })
                            .then(() => {
                              setCfLabel('');
                              setCfAccountId('');
                              setCfToken('');
                              return refreshActiveTabData();
                            })
                            .catch((err: unknown) =>
                              setErrorBanner(err instanceof Error ? err.message : String(err)),
                            );
                        }}
                        className="gsap-card ls-surface p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
                      >
                        <input
                          type="text"
                          required
                          aria-label="Provider connection label"
                          placeholder="Cloudflare Production"
                          value={cfLabel}
                          onChange={(e) => setCfLabel(e.target.value)}
                          className="ls-input"
                        />
                        <input
                          type="text"
                          aria-label="Cloudflare Account ID"
                          placeholder="Account ID (optional)"
                          value={cfAccountId}
                          onChange={(e) => setCfAccountId(e.target.value)}
                          className="ls-input"
                        />
                        <input
                          type="password"
                          required
                          minLength={16}
                          aria-label="Cloudflare API Token"
                          placeholder="API Token (encrypted with AES-256-GCM)"
                          value={cfToken}
                          onChange={(e) => setCfToken(e.target.value)}
                          className="ls-input"
                        />
                        <button type="submit" className="ls-btn-primary">
                          <Plus className="h-3.5 w-3.5" />
                          <span>Save Connection</span>
                        </button>
                      </form>
                    )}

                    <div className="gsap-card ls-surface divide-y divide-[var(--ls-border)]">
                      {providers.length === 0 ? (
                        <p className="p-4 text-xs text-[var(--ls-muted)]">
                          No provider tokens stored.
                        </p>
                      ) : (
                        providers.map((prov) => (
                          <div
                            key={prov.id}
                            className="p-4 flex items-center justify-between text-xs"
                          >
                            <div>
                              <span className="font-medium">{prov.label}</span>
                              <span className="ml-2 text-[var(--ls-muted)]">
                                ({prov.provider} • ends in ****{prov.tokenLast4})
                              </span>
                            </div>
                            {canWriteAdmin && (
                              <button
                                type="button"
                                aria-label={`Delete provider connection ${prov.label}`}
                                onClick={() =>
                                  void apiClient
                                    .deleteProviderConnection(activeOrgId, prov.id)
                                    .then(() => refreshActiveTabData())
                                }
                                className="ls-btn-secondary p-1.5 text-[var(--ls-muted)] hover:text-red-600"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </section>
              )}

              {/* 7. ACTIVITY (AUDIT LOGS) TAB */}
              {activeTab === 'activity' && (
                <section className="gsap-section space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="font-heading text-xl font-bold tracking-tight">
                        Security Audit Log
                      </h2>
                      <p className="text-xs text-[var(--ls-text-secondary)]">
                        Immutable record of authentication, membership, domain verification, and
                        policy changes.
                      </p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2.5">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-[var(--ls-muted)]" />
                        <input
                          type="search"
                          aria-label="Search audit events"
                          placeholder="Search events…"
                          value={activitySearch}
                          onChange={(e) => setActivitySearch(e.target.value)}
                          className="ls-input pl-8"
                        />
                      </div>
                      <select
                        aria-label="Filter events by category"
                        value={activityCategory}
                        onChange={(e) => setActivityCategory(e.target.value)}
                        className="ls-input"
                      >
                        <option value="ALL">All Categories</option>
                        <option value="Tunnel">Tunnel</option>
                        <option value="Project">Project</option>
                        <option value="Domain">Domain</option>
                        <option value="Security">Security</option>
                        <option value="Team">Team</option>
                        <option value="Account">Account</option>
                      </select>
                    </div>
                  </div>

                  <div className="gsap-card ls-surface overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-[var(--ls-border)] bg-[var(--ls-surface-secondary)] text-[11px] font-semibold uppercase text-[var(--ls-muted)]">
                        <tr>
                          <th className="px-4 py-3">Action</th>
                          <th className="px-4 py-3">Category</th>
                          <th className="px-4 py-3">Actor</th>
                          <th className="px-4 py-3">Target</th>
                          <th className="px-4 py-3">Timestamp</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--ls-border)]">
                        {filteredAuditEvents.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-[var(--ls-muted)]">
                              No audit events found.
                            </td>
                          </tr>
                        ) : (
                          filteredAuditEvents.map((ev) => (
                            <tr key={ev.id} className="hover:bg-[var(--ls-surface-secondary)]">
                              <td className="px-4 py-3 font-mono font-medium">{ev.action}</td>
                              <td className="px-4 py-3">
                                <span className="rounded-[5px] border border-[var(--ls-border-strong)] bg-[var(--ls-surface-secondary)] px-2 py-0.5 text-[11px]">
                                  {categorizeAuditAction(ev.action)}
                                </span>
                              </td>
                              <td className="px-4 py-3">{ev.actorEmail ?? 'system'}</td>
                              <td className="px-4 py-3 font-mono text-[var(--ls-muted)]">
                                {ev.targetType ? `${ev.targetType}:${ev.targetId ?? ''}` : '—'}
                              </td>
                              <td className="px-4 py-3 text-[var(--ls-muted)] tabular-nums">
                                {new Date(ev.createdAt).toLocaleString()}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* 8. SETTINGS TAB */}
              {activeTab === 'settings' && activeOrg && (
                <section className="gsap-section space-y-6">
                  <div>
                    <h2 className="font-heading text-xl font-bold tracking-tight">
                      Organization Settings
                    </h2>
                    <p className="text-xs text-[var(--ls-text-secondary)]">
                      Manage profile, workspace display name, appearance, and notifications.
                    </p>
                  </div>

                  {/* Appearance Section (Light / Dark / System) */}
                  <div className="gsap-card ls-surface p-5 space-y-3">
                    <h3 className="font-heading text-sm font-semibold">Appearance</h3>
                    <p className="text-xs text-[var(--ls-text-secondary)]">
                      Select Light, Dark, or follow your operating system color scheme.
                    </p>
                    <AppearanceSelector />
                  </div>

                  {/* Profile Section */}
                  <div className="gsap-card ls-surface p-5 space-y-2">
                    <h3 className="font-heading text-sm font-semibold">Operator Profile</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
                      <div>
                        <span className="text-[var(--ls-muted)] block">Name</span>
                        <span className="font-medium">{user.name}</span>
                      </div>
                      <div>
                        <span className="text-[var(--ls-muted)] block">Email</span>
                        <span className="font-mono">{user.email}</span>
                      </div>
                    </div>
                  </div>

                  {/* Workspace Rename Section */}
                  {canWriteAdmin && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void apiClient
                          .updateOrganization(activeOrg.id, { name: renameOrgValue })
                          .then((updated) => {
                            setOrganizations(
                              organizations.map((o) => (o.id === updated.id ? updated : o)),
                            );
                            setInfoBanner(`Renamed organization to "${updated.name}".`);
                          })
                          .catch((err: unknown) =>
                            setErrorBanner(err instanceof Error ? err.message : String(err)),
                          );
                      }}
                      className="gsap-card ls-surface p-5 space-y-3"
                    >
                      <label htmlFor="rename-org-input" className="block text-xs font-semibold">
                        Organization Display Name
                      </label>
                      <div className="flex flex-col sm:flex-row gap-3 max-w-md">
                        <input
                          id="rename-org-input"
                          type="text"
                          required
                          value={renameOrgValue}
                          onChange={(e) => setRenameOrgValue(e.target.value)}
                          className="ls-input flex-1"
                        />
                        <button type="submit" className="ls-btn-primary">
                          Save Name
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Notifications Section */}
                  <div className="gsap-card ls-surface p-5 space-y-3">
                    <h3 className="font-heading text-sm font-semibold">Notifications</h3>
                    <label className="flex items-center justify-between text-xs cursor-pointer">
                      <span>Notify on unexpected tunnel disconnects</span>
                      <input
                        type="checkbox"
                        checked={notifyTunnelAlerts}
                        onChange={(e) => setNotifyTunnelAlerts(e.target.checked)}
                      />
                    </label>
                    <label className="flex items-center justify-between text-xs cursor-pointer">
                      <span>Notify when custom domain DNS verification changes</span>
                      <input
                        type="checkbox"
                        checked={notifyDomainExpiry}
                        onChange={(e) => setNotifyDomainExpiry(e.target.checked)}
                      />
                    </label>
                  </div>

                  {/* Danger Zone */}
                  {isOwner && (
                    <div className="gsap-card ls-surface border-red-500/40 bg-red-500/5 p-5 space-y-3">
                      <h3 className="font-heading text-sm font-semibold text-red-600 dark:text-red-400">
                        Danger Zone
                      </h3>
                      <p className="text-xs text-[var(--ls-text-secondary)]">
                        Type the organization slug (
                        <code className="font-mono font-semibold">{activeOrg.slug}</code>) to
                        confirm deletion.
                      </p>
                      <div className="flex flex-col sm:flex-row gap-3 max-w-md">
                        <input
                          type="text"
                          aria-label="Confirm organization slug to delete"
                          placeholder={activeOrg.slug}
                          value={deleteSlugConfirm}
                          onChange={(e) => setDeleteSlugConfirm(e.target.value)}
                          className="ls-input flex-1"
                        />
                        <button
                          type="button"
                          disabled={deleteSlugConfirm !== activeOrg.slug}
                          onClick={() =>
                            void apiClient.deleteOrganization(activeOrg.id).then(async () => {
                              setDeleteSlugConfirm('');
                              await loadOrganizations();
                            })
                          }
                          className="ls-btn-primary bg-red-600 border-red-600 text-white"
                        >
                          Delete Organization
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      </div>

      {/* Create Share Modal Dialog */}
      {activeOrg && (
        <CreateShareDialog
          open={createShareOpen}
          orgId={activeOrg.id}
          workspaces={workspaces}
          onClose={() => setCreateShareOpen(false)}
          onCreated={() => void refreshActiveTabData()}
        />
      )}
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <DashboardShell />
    </ThemeProvider>
  );
}
