import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  ExternalLink,
  FolderGit2,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Moon,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Shield,
  Sun,
  Trash2,
  Users,
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

export type DashboardTab =
  | 'overview'
  | 'projects'
  | 'tunnels'
  | 'domains'
  | 'teams'
  | 'security'
  | 'activity'
  | 'settings';

const NAV_ITEMS: ReadonlyArray<{ id: DashboardTab; label: string; icon: React.FC<{ className?: string }> }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'tunnels', label: 'Tunnels', icon: Radio },
  { id: 'domains', label: 'Domains', icon: Globe },
  { id: 'teams', label: 'Teams', icon: Users },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={label}
      className="inline-flex items-center gap-1.5 rounded border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

export function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('ls_theme') : null;
    return saved === 'light' ? 'light' : 'dark';
  });
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
  const [domains, setDomains] = useState<DomainDto[]>([]);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [policies, setPolicies] = useState<AccessPolicyDto[]>([]);
  const [providers, setProviders] = useState<ProviderConnectionItem[]>([]);
  const [apiTokens, setApiTokens] = useState<ApiTokenItem[]>([]);
  const [createdTokenModal, setCreatedTokenModal] = useState<CreatedApiToken | null>(null);
  const [auditPage, setAuditPage] = useState<Paginated<AuditEventDto> | null>(null);

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

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    window.localStorage.setItem('ls_theme', theme);
  }, [theme]);

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
        setOverview(await apiClient.getOverview(activeOrgId));
      } else if (activeTab === 'projects') {
        setWorkspaces(await apiClient.listWorkspaces(activeOrgId));
      } else if (activeTab === 'tunnels') {
        setTunnelsPage(
          await apiClient.listTunnels(activeOrgId, {
            page: 1,
            pageSize: 20,
            state: tunnelStateFilter || undefined,
          }),
        );
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
        setAuditPage(await apiClient.listAuditEvents(activeOrgId, { page: 1, pageSize: 25 }));
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

  if (bootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <p className="text-sm text-slate-400">Loading LocalShare control plane…</p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Unauthenticated View (Login / Register)
  // ---------------------------------------------------------------------------
  if (!user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-md rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-sm">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Radio className="h-5 w-5 text-sky-500" />
              <h1 className="text-lg font-semibold tracking-tight">LocalShare Cloud</h1>
            </div>
            <button
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle color theme"
              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>

          <p className="mb-5 text-xs text-slate-500 dark:text-slate-400">
            Optional team control plane for managing preview domains, access policies, and share metadata.
          </p>

          {errorBanner && (
            <div
              role="alert"
              className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300"
            >
              {errorBanner}
            </div>
          )}

          <form onSubmit={(e) => void handleAuthSubmit(e)} className="space-y-4">
            {authMode === 'register' && (
              <div>
                <label htmlFor="auth-name" className="block text-xs font-medium mb-1">
                  Full Name
                </label>
                <input
                  id="auth-name"
                  type="text"
                  required
                  value={authName}
                  onChange={(e) => setAuthName(e.target.value)}
                  placeholder="Ada Lovelace"
                  className="w-full rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
            )}

            <div>
              <label htmlFor="auth-email" className="block text-xs font-medium mb-1">
                Email Address
              </label>
              <input
                id="auth-email"
                type="email"
                required
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="developer@company.com"
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            <div>
              <label htmlFor="auth-password" className="block text-xs font-medium mb-1">
                Password (min 10 chars)
              </label>
              <input
                id="auth-password"
                type="password"
                required
                minLength={10}
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-sky-400"
            >
              {authMode === 'register' ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => {
                setErrorBanner(null);
                setAuthMode(authMode === 'login' ? 'register' : 'login');
              }}
              className="text-xs text-sky-600 dark:text-sky-400 hover:underline"
            >
              {authMode === 'login'
                ? 'Need an account? Register'
                : 'Already have an account? Sign in'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const canWriteMember = activeOrg ? roleAtLeast(activeOrg.role, 'MEMBER') : false;
  const canWriteAdmin = activeOrg ? roleAtLeast(activeOrg.role, 'ADMIN') : false;
  const isOwner = activeOrg ? activeOrg.role === 'OWNER' : false;

  // ---------------------------------------------------------------------------
  // Authenticated Shell
  // ---------------------------------------------------------------------------
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="w-full md:w-64 shrink-0 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Radio className="h-5 w-5 text-sky-500" />
              <span className="font-semibold tracking-tight text-sm">LocalShare</span>
            </div>
            <button
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle color theme"
              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>

          {/* Organization Selector */}
          <div className="mb-4">
            <label htmlFor="org-switcher" className="block text-[11px] uppercase tracking-wider text-slate-400 mb-1">
              Organization
            </label>
            {organizations.length > 0 ? (
              <select
                id="org-switcher"
                value={activeOrgId}
                onChange={(e) => setActiveOrgId(e.target.value)}
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2.5 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                {organizations.map((org) => (
                  <option key={org.id} value={org.id} className="bg-white dark:bg-slate-900">
                    {org.name} ({org.role})
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-slate-400">No organization yet</p>
            )}
          </div>

          {/* Navigation */}
          <nav aria-label="Main navigation" className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex w-full items-center gap-2.5 rounded px-3 py-2 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* User Footer */}
        <div className="mt-6 border-t border-slate-200 dark:border-slate-800 pt-3 flex items-center justify-between">
          <div className="truncate pr-2">
            <div className="text-xs font-medium truncate">{user.name}</div>
            <div className="text-[11px] text-slate-400 truncate">{user.email}</div>
          </div>
          <button
            type="button"
            onClick={() => void apiClient.logout().then(() => setUser(null))}
            aria-label="Sign out"
            className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-6 max-w-6xl">
        {errorBanner && (
          <div
            role="alert"
            className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-600 dark:text-red-300"
          >
            {errorBanner}
          </div>
        )}
        {infoBanner && (
          <div
            role="status"
            className="mb-4 rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-300"
          >
            {infoBanner}
          </div>
        )}

        {/* Create Organization Onboarding if user has none */}
        {organizations.length === 0 ? (
          <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <h2 className="text-base font-semibold mb-1">Create Your Organization</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Organizations isolate workspaces, tunnel metadata, custom domains, and team access policies.
            </p>
            <form onSubmit={(e) => void handleCreateOrganization(e)} className="flex gap-2 max-w-md">
              <input
                type="text"
                required
                aria-label="New organization name"
                placeholder="Acme Engineering"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 text-xs font-medium text-white"
              >
                <Plus className="h-4 w-4" />
                <span>Create</span>
              </button>
            </form>
          </section>
        ) : (
          <>
            {/* 1. OVERVIEW TAB */}
            {activeTab === 'overview' && (
              <section className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">{activeOrg?.name} — Overview</h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Live inventory computed directly from your organization records.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshActiveTabData()}
                    className="inline-flex items-center gap-1.5 rounded border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Refresh</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  {[
                    { label: 'Active Tunnels', value: overview?.activeTunnels ?? 0 },
                    { label: 'Total Tunnels', value: overview?.totalTunnels ?? 0 },
                    { label: 'Workspaces', value: overview?.workspaces ?? 0 },
                    { label: 'Verified Domains', value: overview?.verifiedDomains ?? 0 },
                    { label: 'Pending Domains', value: overview?.pendingDomains ?? 0 },
                    { label: 'Team Members', value: overview?.members ?? 0 },
                  ].map((stat) => (
                    <div
                      key={stat.label}
                      className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4"
                    >
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">{stat.label}</div>
                      <div className="mt-1 text-2xl font-semibold">{stat.value}</div>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                  <h3 className="text-sm font-semibold mb-3">Recent Security & Activity Events</h3>
                  {overview?.recentEvents.length ? (
                    <ul className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                      {overview.recentEvents.map((ev) => (
                        <li key={ev.id} className="py-2 flex items-center justify-between gap-4">
                          <div>
                            <span className="font-mono font-medium text-sky-600 dark:text-sky-400">
                              {ev.action}
                            </span>
                            <span className="ml-2 text-slate-500">
                              by {ev.actorEmail ?? 'system'}
                            </span>
                          </div>
                          <time className="text-slate-400 shrink-0">
                            {new Date(ev.createdAt).toLocaleString()}
                          </time>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-400">No events recorded yet.</p>
                  )}
                </div>
              </section>
            )}

            {/* 2. PROJECTS (WORKSPACES) TAB */}
            {activeTab === 'projects' && (
              <section className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Projects & Workspaces</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Register repositories shared from the LocalShare VS Code extension.
                  </p>
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
                    className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col md:flex-row gap-3"
                  >
                    <input
                      type="text"
                      required
                      aria-label="Workspace name"
                      placeholder="Workspace name (e.g. storefront-web)"
                      value={wsName}
                      onChange={(e) => setWsName(e.target.value)}
                      className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                    />
                    <input
                      type="text"
                      aria-label="Workspace description"
                      placeholder="Optional description"
                      value={wsDesc}
                      onChange={(e) => setWsDesc(e.target.value)}
                      className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center justify-center gap-1.5 rounded bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-medium text-white"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Create Project</span>
                    </button>
                  </form>
                )}

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-200 dark:divide-slate-800">
                  {workspaces.length === 0 ? (
                    <p className="p-6 text-xs text-slate-400">No workspaces created yet.</p>
                  ) : (
                    workspaces.map((ws) => (
                      <div key={ws.id} className="p-4 flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium">{ws.name}</div>
                          {ws.description && (
                            <div className="text-xs text-slate-500">{ws.description}</div>
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
                            className="rounded p-1.5 text-slate-400 hover:text-red-500"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>
            )}

            {/* 3. TUNNELS TAB */}
            {activeTab === 'tunnels' && (
              <section className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Tunnel Inventory</h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Metadata synced from the VS Code extension. Application traffic never passes through this server.
                    </p>
                  </div>
                  <select
                    aria-label="Filter tunnels by state"
                    value={tunnelStateFilter}
                    onChange={(e) => setTunnelStateFilter(e.target.value)}
                    className="rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2.5 py-1.5 text-xs"
                  >
                    <option value="" className="bg-white dark:bg-slate-900">All States</option>
                    {TUNNEL_STATES.map((st) => (
                      <option key={st} value={st} className="bg-white dark:bg-slate-900">
                        {st}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase">
                      <tr>
                        <th className="px-4 py-3">Name</th>
                        <th className="px-4 py-3">Target</th>
                        <th className="px-4 py-3">State</th>
                        <th className="px-4 py-3">Access</th>
                        <th className="px-4 py-3">Public URL</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {!tunnelsPage || tunnelsPage.items.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                            No tunnel records found.
                          </td>
                        </tr>
                      ) : (
                        tunnelsPage.items.map((t) => (
                          <tr key={t.id}>
                            <td className="px-4 py-3 font-medium">
                              {t.name}
                              {t.framework && (
                                <span className="ml-2 text-[11px] text-slate-400">
                                  ({t.framework})
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 font-mono">{t.localTarget}</td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${
                                  t.state === 'ONLINE'
                                    ? 'bg-emerald-500/15 text-emerald-500'
                                    : 'bg-slate-500/15 text-slate-400'
                                }`}
                              >
                                {t.state}
                              </span>
                            </td>
                            <td className="px-4 py-3">{t.accessMode}</td>
                            <td className="px-4 py-3 font-mono">
                              {t.publicUrl ? (
                                <a
                                  href={t.publicUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-sky-500 hover:underline"
                                >
                                  <span>{t.publicUrl}</span>
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-3 text-right space-x-2">
                              {t.publicUrl && <CopyButton value={t.publicUrl} label="Copy URL" />}
                              {canWriteMember && (
                                <button
                                  type="button"
                                  aria-label={`Delete tunnel ${t.name}`}
                                  onClick={() =>
                                    void apiClient
                                      .deleteTunnel(activeOrgId, t.id)
                                      .then(() => refreshActiveTabData())
                                  }
                                  className="inline-flex items-center rounded p-1 text-slate-400 hover:text-red-500"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
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
              <section className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Custom Preview Domains</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Authorize customer or team hostnames via DNS TXT ownership verification. LocalShare never marks a domain verified before the live DNS check succeeds.
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
                    className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex gap-3"
                  >
                    <input
                      type="text"
                      required
                      aria-label="Custom domain hostname"
                      placeholder="preview.customer.com"
                      value={domainHost}
                      onChange={(e) => setDomainHost(e.target.value)}
                      className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1.5 rounded bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-medium text-white"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Add Domain</span>
                    </button>
                  </form>
                )}

                <div className="space-y-3">
                  {domains.length === 0 ? (
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-xs text-slate-400">
                      No custom domains registered yet.
                    </div>
                  ) : (
                    domains.map((d) => (
                      <div
                        key={d.id}
                        className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <span className="font-mono text-sm font-semibold">{d.hostname}</span>
                            <span
                              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                                d.status === 'VERIFIED'
                                  ? 'bg-emerald-500/15 text-emerald-500'
                                  : d.status === 'FAILED'
                                    ? 'bg-red-500/15 text-red-400'
                                    : 'bg-amber-500/15 text-amber-400'
                              }`}
                            >
                              {d.status}
                            </span>
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
                                className="rounded bg-sky-600 hover:bg-sky-500 px-3 py-1 text-xs font-medium text-white"
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
                                className="rounded p-1 text-slate-400 hover:text-red-500"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="rounded bg-slate-100 dark:bg-slate-950 p-3 text-xs space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-400">TXT Record Name:</span>
                            <div className="flex items-center gap-2">
                              <code className="font-mono">{d.verification.recordName}</code>
                              <CopyButton value={d.verification.recordName} label="Copy Name" />
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-400">TXT Record Value:</span>
                            <div className="flex items-center gap-2">
                              <code className="font-mono">{d.verification.recordValue}</code>
                              <CopyButton value={d.verification.recordValue} label="Copy Value" />
                            </div>
                          </div>
                          {d.verification.lastError && (
                            <div className="text-amber-500 pt-1">
                              Last check: {d.verification.lastError}
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
              <section className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Team Members</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
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
                    className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col sm:flex-row gap-3"
                  >
                    <input
                      type="email"
                      required
                      aria-label="Member email address"
                      placeholder="teammate@company.com"
                      value={memberEmail}
                      onChange={(e) => setMemberEmail(e.target.value)}
                      className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                    />
                    <select
                      aria-label="Member role"
                      value={memberRole}
                      onChange={(e) => setMemberRole(e.target.value as OrgRole)}
                      className="rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2.5 py-1.5 text-xs"
                    >
                      {ORG_ROLES.map((r) => (
                        <option key={r} value={r} className="bg-white dark:bg-slate-900">
                          {r}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="inline-flex items-center justify-center gap-1.5 rounded bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-medium text-white"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Add Member</span>
                    </button>
                  </form>
                )}

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-200 dark:divide-slate-800">
                  {members.map((m) => (
                    <div key={m.id} className="p-4 flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">{m.name}</div>
                        <div className="text-xs text-slate-400">{m.email}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-slate-500/15 px-2 py-0.5 text-xs font-medium">
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
                            className="rounded p-1 text-slate-400 hover:text-red-500"
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
              <section className="space-y-8">
                {/* Access Policies */}
                <div className="space-y-3">
                  <h2 className="text-lg font-semibold">Access Policies</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Define identity rules (allowed emails and email domains) for protected preview hostnames.
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
                      className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
                    >
                      <input
                        type="text"
                        required
                        aria-label="Policy name"
                        placeholder="Customer Reviewers"
                        value={policyName}
                        onChange={(e) => setPolicyName(e.target.value)}
                        className="rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                      />
                      <select
                        aria-label="Policy access mode"
                        value={policyMode}
                        onChange={(e) => setPolicyMode(e.target.value as AccessMode)}
                        className="rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2.5 py-1.5 text-xs"
                      >
                        <option value="CLOUDFLARE_ACCESS" className="bg-white dark:bg-slate-900">
                          CLOUDFLARE_ACCESS
                        </option>
                        <option value="PASSWORD" className="bg-white dark:bg-slate-900">
                          PASSWORD
                        </option>
                        <option value="PUBLIC" className="bg-white dark:bg-slate-900">
                          PUBLIC
                        </option>
                      </select>
                      <input
                        type="text"
                        aria-label="Allowed emails or domains"
                        placeholder="alice@customer.com, @customer.com"
                        value={policyTargets}
                        onChange={(e) => setPolicyTargets(e.target.value)}
                        className="rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                      />
                      <button
                        type="submit"
                        className="inline-flex items-center justify-center gap-1.5 rounded bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-medium text-white"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>Create Policy</span>
                      </button>
                    </form>
                  )}

                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-200 dark:divide-slate-800">
                    {policies.length === 0 ? (
                      <p className="p-4 text-xs text-slate-400">No access policies defined.</p>
                    ) : (
                      policies.map((p) => (
                        <div key={p.id} className="p-4 flex items-center justify-between">
                          <div>
                            <div className="text-sm font-medium">
                              {p.name}{' '}
                              <span className="ml-2 rounded bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-400">
                                {p.mode}
                              </span>
                            </div>
                            <div className="text-xs text-slate-400 mt-1">
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
                              className="rounded p-1 text-slate-400 hover:text-red-500"
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
                    <KeyRound className="h-4 w-4 text-sky-500" />
                    <h3 className="text-base font-semibold">Personal API Tokens (VS Code Extension)</h3>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Generate an <code className="font-mono">lsk_</code> token to sync your VS Code extension shares with LocalShare Cloud. Plaintext tokens are shown only once.
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
                    className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex gap-3"
                  >
                    <input
                      type="text"
                      required
                      aria-label="Personal API token name"
                      placeholder="Workstation VS Code"
                      value={tokenName}
                      onChange={(e) => setTokenName(e.target.value)}
                      className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1.5 rounded bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-medium text-white"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Generate Token</span>
                    </button>
                  </form>

                  {createdTokenModal && (
                    <div
                      role="dialog"
                      aria-label="New API token generated"
                      className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-4 space-y-2"
                    >
                      <div className="text-xs font-semibold text-emerald-400">
                        Copy your new API token now — it will never be displayed again:
                      </div>
                      <div className="flex items-center justify-between gap-2 rounded bg-slate-950 p-2.5">
                        <code className="font-mono text-xs text-emerald-300 break-all">
                          {createdTokenModal.token}
                        </code>
                        <CopyButton value={createdTokenModal.token} label="Copy Token" />
                      </div>
                      <button
                        type="button"
                        onClick={() => setCreatedTokenModal(null)}
                        className="text-xs text-slate-400 hover:underline"
                      >
                        I have saved this token
                      </button>
                    </div>
                  )}

                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-200 dark:divide-slate-800">
                    {apiTokens.length === 0 ? (
                      <p className="p-4 text-xs text-slate-400">No personal API tokens active.</p>
                    ) : (
                      apiTokens.map((tok) => (
                        <div key={tok.id} className="p-4 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-medium">{tok.name}</span>
                            <code className="ml-2 font-mono text-slate-400">{tok.prefix}…</code>
                          </div>
                          <button
                            type="button"
                            aria-label={`Revoke token ${tok.name}`}
                            onClick={() =>
                              void apiClient
                                .revokeApiToken(tok.id)
                                .then(() => refreshActiveTabData())
                            }
                            className="rounded p-1 text-slate-400 hover:text-red-500"
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
                  <h3 className="text-base font-semibold">Encrypted Provider Connections</h3>
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
                      className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
                    >
                      <input
                        type="text"
                        required
                        aria-label="Provider connection label"
                        placeholder="Cloudflare Production"
                        value={cfLabel}
                        onChange={(e) => setCfLabel(e.target.value)}
                        className="rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                      />
                      <input
                        type="text"
                        aria-label="Cloudflare Account ID"
                        placeholder="Account ID (optional)"
                        value={cfAccountId}
                        onChange={(e) => setCfAccountId(e.target.value)}
                        className="rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                      />
                      <input
                        type="password"
                        required
                        minLength={16}
                        aria-label="Cloudflare API Token"
                        placeholder="API Token (encrypted with AES-256-GCM)"
                        value={cfToken}
                        onChange={(e) => setCfToken(e.target.value)}
                        className="rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                      />
                      <button
                        type="submit"
                        className="inline-flex items-center justify-center gap-1.5 rounded bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-medium text-white"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>Save Connection</span>
                      </button>
                    </form>
                  )}

                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-200 dark:divide-slate-800">
                    {providers.length === 0 ? (
                      <p className="p-4 text-xs text-slate-400">No provider tokens stored.</p>
                    ) : (
                      providers.map((prov) => (
                        <div key={prov.id} className="p-4 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-medium">{prov.label}</span>
                            <span className="ml-2 text-slate-400">
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
                              className="rounded p-1 text-slate-400 hover:text-red-500"
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
              <section className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Security Audit Log</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Immutable record of authentication, membership, domain verification, and policy changes.
                  </p>
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase">
                      <tr>
                        <th className="px-4 py-3">Action</th>
                        <th className="px-4 py-3">Actor</th>
                        <th className="px-4 py-3">Target</th>
                        <th className="px-4 py-3">Timestamp</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {!auditPage || auditPage.items.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                            No audit events found.
                          </td>
                        </tr>
                      ) : (
                        auditPage.items.map((ev) => (
                          <tr key={ev.id}>
                            <td className="px-4 py-3 font-mono text-sky-500">{ev.action}</td>
                            <td className="px-4 py-3">{ev.actorEmail ?? 'system'}</td>
                            <td className="px-4 py-3 font-mono text-slate-400">
                              {ev.targetType ? `${ev.targetType}:${ev.targetId ?? ''}` : '—'}
                            </td>
                            <td className="px-4 py-3 text-slate-400">
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
              <section className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Organization Settings</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Manage organization profile, appearance, and lifecycle.
                  </p>
                </div>

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
                    className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
                  >
                    <label htmlFor="rename-org-input" className="block text-xs font-medium">
                      Organization Display Name
                    </label>
                    <div className="flex gap-3 max-w-md">
                      <input
                        id="rename-org-input"
                        type="text"
                        required
                        value={renameOrgValue}
                        onChange={(e) => setRenameOrgValue(e.target.value)}
                        className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-1.5 text-xs"
                      />
                      <button
                        type="submit"
                        className="rounded bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-medium text-white"
                      >
                        Save Name
                      </button>
                    </div>
                  </form>
                )}

                {isOwner && (
                  <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-red-500">Danger Zone</h3>
                    <p className="text-xs text-slate-400">
                      Type the organization slug (<code className="font-mono">{activeOrg.slug}</code>) to confirm deletion.
                    </p>
                    <div className="flex gap-3 max-w-md">
                      <input
                        type="text"
                        aria-label="Confirm organization slug to delete"
                        placeholder={activeOrg.slug}
                        value={deleteSlugConfirm}
                        onChange={(e) => setDeleteSlugConfirm(e.target.value)}
                        className="flex-1 rounded border border-red-500/40 bg-transparent px-3 py-1.5 text-xs"
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
                        className="rounded bg-red-600 disabled:opacity-40 hover:bg-red-500 px-3 py-1.5 text-xs font-medium text-white"
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
  );
}

