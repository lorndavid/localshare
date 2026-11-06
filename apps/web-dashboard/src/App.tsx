import React, { useCallback, useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import {
  Activity,
  ArrowUpRight,
  Check,
  Copy,
  ExternalLink,
  FolderGit2,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Shield,
  Sun,
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

export type DashboardTab =
  | 'overview'
  | 'projects'
  | 'tunnels'
  | 'domains'
  | 'teams'
  | 'security'
  | 'activity'
  | 'settings';

const NAV_ITEMS: ReadonlyArray<{
  id: DashboardTab;
  label: string;
  index: string;
  icon: React.FC<{ className?: string }>;
}> = [
  { id: 'overview', label: 'Overview', index: '01', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', index: '02', icon: FolderGit2 },
  { id: 'tunnels', label: 'Tunnels', index: '03', icon: Radio },
  { id: 'domains', label: 'Domains', index: '04', icon: Globe },
  { id: 'teams', label: 'Teams', index: '05', icon: Users },
  { id: 'security', label: 'Security', index: '06', icon: Shield },
  { id: 'activity', label: 'Activity', index: '07', icon: Activity },
  { id: 'settings', label: 'Settings', index: '08', icon: Settings },
];

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const handleCopy = async () => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    if (btnRef.current) {
      gsap.fromTo(
        btnRef.current,
        { scale: 0.94 },
        { scale: 1, duration: 0.25, ease: 'back.out(2)' },
      );
    }
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={() => void handleCopy()}
      aria-label={label}
      className="inline-flex items-center gap-1.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black px-2.5 py-1 text-xs font-medium text-black dark:text-white transition-colors hover:border-black dark:hover:border-white hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:outline-none focus:ring-1 focus:ring-black dark:focus:ring-white"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

const INPUT_CLASS =
  'w-full border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-3.5 py-2 text-xs text-black dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-600 transition-colors focus:border-black dark:focus:border-white focus:outline-none';

const PRIMARY_BTN_CLASS =
  'inline-flex items-center justify-center gap-2 border border-black dark:border-white bg-black dark:bg-white px-4 py-2 text-xs font-medium tracking-wide text-white dark:text-black transition-all hover:bg-neutral-800 dark:hover:bg-neutral-200 active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-neutral-500';

const SECONDARY_BTN_CLASS =
  'inline-flex items-center justify-center gap-1.5 border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-3 py-1.5 text-xs font-medium text-black dark:text-white transition-colors hover:border-black dark:hover:border-white hover:bg-neutral-50 dark:hover:bg-neutral-950 focus:outline-none';

export function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('ls_theme') : null;
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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

  // GSAP refs
  const authContainerRef = useRef<HTMLDivElement | null>(null);
  const mainContentRef = useRef<HTMLElement | null>(null);

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

  // GSAP Animation for Auth View
  useEffect(() => {
    if (bootstrapping || user || !authContainerRef.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.gsap-auth-card',
        { y: 18, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.45, ease: 'power3.out' },
      );
      gsap.fromTo(
        '.gsap-field',
        { y: 10, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.35, stagger: 0.05, ease: 'power2.out', delay: 0.08 },
      );
    }, authContainerRef);
    return () => ctx.revert();
  }, [bootstrapping, user, authMode]);

  // GSAP Animation for Dashboard Tab & Content Transitions
  useEffect(() => {
    if (!user || !mainContentRef.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.gsap-section',
        { y: 12, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.35, ease: 'power3.out' },
      );
      gsap.fromTo(
        '.gsap-card',
        { y: 10, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.32, stagger: 0.04, ease: 'power2.out', delay: 0.04 },
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

  if (bootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-black p-6 text-black dark:text-white">
        <div className="flex items-center gap-3 border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-5 py-3">
          <span className="h-2 w-2 animate-ping bg-black dark:bg-white" />
          <p className="font-mono text-xs uppercase tracking-widest">
            Loading LocalShare Control Plane…
          </p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Unauthenticated View (Login / Register) — Classic Monochrome Line Style
  // ---------------------------------------------------------------------------
  if (!user) {
    return (
      <div
        ref={authContainerRef}
        className="flex min-h-screen flex-col justify-between bg-white dark:bg-black text-black dark:text-white transition-colors duration-200"
      >
        {/* Top Architectural Bar */}
        <header className="border-b border-neutral-200 dark:border-neutral-800 bg-white/90 dark:bg-black/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-8">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center border border-black dark:border-white bg-black dark:bg-white text-white dark:text-black">
                <Radio className="h-4 w-4" />
              </div>
              <div>
                <span className="font-mono text-xs font-bold uppercase tracking-widest">
                  LocalShare
                </span>
                <span className="ml-2 hidden border border-neutral-300 dark:border-neutral-700 px-1.5 py-0.5 font-mono text-[10px] uppercase text-neutral-600 dark:text-neutral-400 sm:inline-block">
                  v1.0 Control Plane
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle color theme"
              className={SECONDARY_BTN_CLASS}
            >
              {theme === 'dark' ? (
                <>
                  <Sun className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Light Mode</span>
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Dark Mode</span>
                </>
              )}
            </button>
          </div>
        </header>

        {/* Center Split / Classic Line Auth Card */}
        <div className="mx-auto flex w-full max-w-5xl flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <div className="gsap-auth-card grid w-full grid-cols-1 border border-black dark:border-white bg-white dark:bg-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] dark:shadow-[6px_6px_0px_0px_rgba(255,255,255,1)] lg:grid-cols-12">
            {/* Left Editorial Column */}
            <div className="flex flex-col justify-between border-b border-neutral-200 dark:border-neutral-800 p-6 sm:p-10 lg:col-span-6 lg:border-b-0 lg:border-r">
              <div>
                <div className="mb-6 inline-flex items-center gap-2 border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider">
                  <Terminal className="h-3.5 w-3.5" />
                  <span>Zero-Config HTTPS Tunnels</span>
                </div>
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  LocalShare Cloud
                </h1>
                <p className="mt-3 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400 sm:text-sm">
                  Expose local development servers over instant{' '}
                  <code className="border border-neutral-300 dark:border-neutral-700 px-1 py-0.5 font-mono text-xs">
                    *.lorndavid.online
                  </code>{' '}
                  HTTPS links. Manage team workspaces, DNS TXT domain verification, and security
                  audit trails from one minimalist control plane.
                </p>
              </div>

              <div className="mt-8 space-y-3 border-t border-neutral-200 dark:border-neutral-800 pt-6 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-500">01 / VS Code Extension</span>
                  <span className="font-semibold">One-Click Share</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-500">02 / Wildcard Relay</span>
                  <span className="font-semibold">*.lorndavid.online</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-500">03 / Security</span>
                  <span className="font-semibold">AES-256-GCM + RBAC</span>
                </div>
              </div>
            </div>

            {/* Right Auth Form Column */}
            <div className="p-6 sm:p-10 lg:col-span-6">
              <div className="mb-6 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-4">
                <div>
                  <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
                    {authMode === 'register' ? 'New Operator' : 'Authentication'}
                  </span>
                  <h2 className="text-lg font-bold tracking-tight">
                    {authMode === 'register' ? 'Create Account' : 'Sign In to Dashboard'}
                  </h2>
                </div>
                <span className="border border-black dark:border-white px-2 py-0.5 font-mono text-[10px] uppercase">
                  {authMode === 'register' ? 'Register' : 'Login'}
                </span>
              </div>

              {errorBanner && (
                <div
                  role="alert"
                  className="mb-5 border border-black dark:border-white bg-neutral-100 dark:bg-neutral-900 px-3.5 py-2.5 font-mono text-xs text-black dark:text-white"
                >
                  [ERROR] {errorBanner}
                </div>
              )}

              <form onSubmit={(e) => void handleAuthSubmit(e)} className="space-y-4">
                {authMode === 'register' && (
                  <div className="gsap-field">
                    <label
                      htmlFor="auth-name"
                      className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-neutral-600 dark:text-neutral-400"
                    >
                      Full Name
                    </label>
                    <input
                      id="auth-name"
                      type="text"
                      required
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      placeholder="Ada Lovelace"
                      className={INPUT_CLASS}
                    />
                  </div>
                )}

                <div className="gsap-field">
                  <label
                    htmlFor="auth-email"
                    className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-neutral-600 dark:text-neutral-400"
                  >
                    Email Address
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="developer@company.com"
                    className={INPUT_CLASS}
                  />
                </div>

                <div className="gsap-field">
                  <label
                    htmlFor="auth-password"
                    className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-neutral-600 dark:text-neutral-400"
                  >
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
                    className={INPUT_CLASS}
                  />
                </div>

                <div className="gsap-field pt-2">
                  <button type="submit" className={`${PRIMARY_BTN_CLASS} w-full py-2.5`}>
                    <span>{authMode === 'register' ? 'Create Account' : 'Sign In'}</span>
                    <ArrowUpRight className="h-4 w-4" />
                  </button>
                </div>
              </form>

              <div className="mt-6 border-t border-neutral-200 dark:border-neutral-800 pt-4 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setErrorBanner(null);
                    setAuthMode(authMode === 'login' ? 'register' : 'login');
                  }}
                  className="font-mono text-xs text-neutral-600 dark:text-neutral-400 underline underline-offset-4 hover:text-black dark:hover:text-white"
                >
                  {authMode === 'login'
                    ? 'Need an account? Register'
                    : 'Already have an account? Sign in'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Architectural Footer */}
        <footer className="border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black px-4 py-3 text-center font-mono text-[11px] text-neutral-500">
          LOCALSHARE PLATFORM • DIRECT HTTPS TUNNEL CONTROL PLANE
        </footer>
      </div>
    );
  }

  const canWriteMember = activeOrg ? roleAtLeast(activeOrg.role, 'MEMBER') : false;
  const canWriteAdmin = activeOrg ? roleAtLeast(activeOrg.role, 'ADMIN') : false;
  const isOwner = activeOrg ? activeOrg.role === 'OWNER' : false;

  // ---------------------------------------------------------------------------
  // Authenticated Shell — Responsive Classic Monochrome Line Layout
  // ---------------------------------------------------------------------------
  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-black text-black dark:text-white md:flex-row">
      {/* Mobile Top Header Bar */}
      <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black px-4 py-3 md:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center border border-black dark:border-white bg-black dark:bg-white text-white dark:text-black">
            <Radio className="h-3.5 w-3.5" />
          </div>
          <span className="font-mono text-xs font-bold uppercase tracking-widest">
            LocalShare
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle color theme"
            className="border border-neutral-300 dark:border-neutral-800 p-1.5"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle navigation menu"
            className="border border-black dark:border-white p-1.5"
          >
            {mobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Sidebar (Desktop Permanent + Mobile Responsive Drawer) */}
      <aside
        className={`${
          mobileMenuOpen ? 'flex' : 'hidden'
        } md:flex w-full md:w-64 lg:w-72 shrink-0 flex-col justify-between border-b md:border-b-0 md:border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black p-5`}
      >
        <div>
          {/* Desktop Brand Bar */}
          <div className="mb-6 hidden items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-4 md:flex">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center border border-black dark:border-white bg-black dark:bg-white text-white dark:text-black">
                <Radio className="h-3.5 w-3.5" />
              </div>
              <div>
                <span className="font-mono text-xs font-bold uppercase tracking-widest block">
                  LocalShare
                </span>
                <span className="font-mono text-[10px] text-neutral-500 block">
                  Control Plane
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle color theme"
              className="border border-neutral-300 dark:border-neutral-800 p-1.5 transition-colors hover:border-black dark:hover:border-white"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>

          {/* Organization Selector */}
          <div className="mb-6">
            <label
              htmlFor="org-switcher"
              className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-neutral-500"
            >
              Organization
            </label>
            {organizations.length > 0 ? (
              <select
                id="org-switcher"
                value={activeOrgId}
                onChange={(e) => setActiveOrgId(e.target.value)}
                className="w-full border border-black dark:border-white bg-white dark:bg-black px-3 py-2 font-mono text-xs font-medium text-black dark:text-white focus:outline-none"
              >
                {organizations.map((org) => (
                  <option key={org.id} value={org.id} className="bg-white dark:bg-black">
                    {org.name} ({org.role})
                  </option>
                ))}
              </select>
            ) : (
              <p className="border border-dashed border-neutral-300 dark:border-neutral-800 px-3 py-2 font-mono text-xs text-neutral-500">
                No organization yet
              </p>
            )}
          </div>

          {/* Navigation */}
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
            Navigation
          </div>
          <nav aria-label="Main navigation" className="space-y-1">
            {NAV_ITEMS.map((item) => {
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
                  className={`flex w-full items-center justify-between border px-3 py-2 text-xs font-medium transition-all ${
                    active
                      ? 'border-black dark:border-white bg-black dark:bg-white text-white dark:text-black shadow-[3px_3px_0px_0px_rgba(0,0,0,0.25)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,0.25)]'
                      : 'border-transparent text-neutral-600 dark:text-neutral-400 hover:border-neutral-300 dark:hover:border-neutral-800 hover:text-black dark:hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </span>
                  <span aria-hidden="true" className="font-mono text-[10px] opacity-60">
                    {item.index}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* User Footer */}
        <div className="mt-8 border-t border-neutral-200 dark:border-neutral-800 pt-4 flex items-center justify-between">
          <div className="truncate pr-2">
            <div className="text-xs font-semibold truncate">{user.name}</div>
            <div className="font-mono text-[11px] text-neutral-500 truncate">{user.email}</div>
          </div>
          <button
            type="button"
            onClick={() => void apiClient.logout().then(() => setUser(null))}
            aria-label="Sign out"
            className="border border-neutral-300 dark:border-neutral-800 p-2 transition-colors hover:border-black dark:hover:border-white"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main ref={mainContentRef} className="flex-1 overflow-x-hidden p-4 sm:p-8 lg:p-10 max-w-6xl">
        {errorBanner && (
          <div
            role="alert"
            className="mb-6 border border-black dark:border-white bg-neutral-100 dark:bg-neutral-900 px-4 py-3 font-mono text-xs text-black dark:text-white flex items-center justify-between"
          >
            <span>[ERROR] {errorBanner}</span>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="ml-4 underline text-[11px]"
            >
              Dismiss
            </button>
          </div>
        )}
        {infoBanner && (
          <div
            role="status"
            className="mb-6 border border-black dark:border-white bg-white dark:bg-black px-4 py-3 font-mono text-xs text-black dark:text-white flex items-center justify-between shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)]"
          >
            <span>[OK] {infoBanner}</span>
            <button
              type="button"
              onClick={() => setInfoBanner(null)}
              className="ml-4 underline text-[11px]"
            >
              Close
            </button>
          </div>
        )}

        {/* Create Organization Onboarding if user has none */}
        {organizations.length === 0 ? (
          <section className="gsap-section border border-black dark:border-white bg-white dark:bg-black p-6 sm:p-10 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] dark:shadow-[6px_6px_0px_0px_rgba(255,255,255,1)]">
            <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
              Step 01 / Initialization
            </span>
            <h2 className="mt-1 text-xl font-bold tracking-tight">Create Your Organization</h2>
            <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400 max-w-xl">
              Organizations isolate workspaces, tunnel metadata, custom domains, and team access
              policies.
            </p>
            <form
              onSubmit={(e) => void handleCreateOrganization(e)}
              className="mt-6 flex flex-col sm:flex-row gap-3 max-w-lg"
            >
              <input
                type="text"
                required
                aria-label="New organization name"
                placeholder="Acme Engineering"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                className={INPUT_CLASS}
              />
              <button type="submit" className={`${PRIMARY_BTN_CLASS} shrink-0`}>
                <Plus className="h-4 w-4" />
                <span>Create</span>
              </button>
            </form>
          </section>
        ) : (
          <>
            {/* 1. OVERVIEW TAB */}
            {activeTab === 'overview' && (
              <section className="gsap-section space-y-8">
                <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-neutral-200 dark:border-neutral-800 pb-5">
                  <div>
                    <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
                      01 / Control Plane Telemetry
                    </span>
                    <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight">
                      {activeOrg?.name} — Overview
                    </h2>
                    <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                      Live inventory computed directly from your organization records.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshActiveTabData()}
                    className={SECONDARY_BTN_CLASS}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Refresh</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                  {[
                    { code: 'M-01', label: 'Active Tunnels', value: overview?.activeTunnels ?? 0 },
                    { code: 'M-02', label: 'Total Tunnels', value: overview?.totalTunnels ?? 0 },
                    { code: 'M-03', label: 'Workspaces', value: overview?.workspaces ?? 0 },
                    { code: 'M-04', label: 'Verified Domains', value: overview?.verifiedDomains ?? 0 },
                    { code: 'M-05', label: 'Pending Domains', value: overview?.pendingDomains ?? 0 },
                    { code: 'M-06', label: 'Team Members', value: overview?.members ?? 0 },
                  ].map((stat) => (
                    <div
                      key={stat.label}
                      className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-4 transition-all hover:border-black dark:hover:border-white"
                    >
                      <div className="flex items-center justify-between font-mono text-[10px] text-neutral-400">
                        <span>{stat.code}</span>
                        <span>LIVE</span>
                      </div>
                      <div className="mt-3 font-mono text-2xl sm:text-3xl font-bold tracking-tight">
                        {stat.value}
                      </div>
                      <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                        {stat.label}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black">
                  <div className="border-b border-neutral-200 dark:border-neutral-800 px-5 py-3.5 flex items-center justify-between">
                    <h3 className="font-mono text-xs font-bold uppercase tracking-wider">
                      Recent Security &amp; Activity Events
                    </h3>
                    <span className="font-mono text-[11px] text-neutral-500">AUDIT STREAM</span>
                  </div>
                  <div className="p-5">
                    {overview?.recentEvents.length ? (
                      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800 text-xs">
                        {overview.recentEvents.map((ev) => (
                          <li
                            key={ev.id}
                            className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                          >
                            <div className="flex items-center gap-2.5 flex-wrap">
                              <span className="border border-black dark:border-white px-2 py-0.5 font-mono text-[11px] font-semibold">
                                {ev.action}
                              </span>
                              <span className="text-neutral-600 dark:text-neutral-400">
                                by {ev.actorEmail ?? 'system'}
                              </span>
                            </div>
                            <time className="font-mono text-[11px] text-neutral-500 shrink-0">
                              {new Date(ev.createdAt).toLocaleString()}
                            </time>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="font-mono text-xs text-neutral-500">No events recorded yet.</p>
                    )}
                  </div>
                </div>
              </section>
            )}

            {/* 2. PROJECTS (WORKSPACES) TAB */}
            {activeTab === 'projects' && (
              <section className="gsap-section space-y-6">
                <div className="border-b border-neutral-200 dark:border-neutral-800 pb-5">
                  <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
                    02 / Repository Registry
                  </span>
                  <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight">
                    Projects &amp; Workspaces
                  </h2>
                  <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
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
                    className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-4 flex flex-col md:flex-row gap-3"
                  >
                    <input
                      type="text"
                      required
                      aria-label="Workspace name"
                      placeholder="Workspace name (e.g. storefront-web)"
                      value={wsName}
                      onChange={(e) => setWsName(e.target.value)}
                      className={INPUT_CLASS}
                    />
                    <input
                      type="text"
                      aria-label="Workspace description"
                      placeholder="Optional description"
                      value={wsDesc}
                      onChange={(e) => setWsDesc(e.target.value)}
                      className={INPUT_CLASS}
                    />
                    <button type="submit" className={`${PRIMARY_BTN_CLASS} shrink-0`}>
                      <Plus className="h-3.5 w-3.5" />
                      <span>Create Project</span>
                    </button>
                  </form>
                )}

                <div className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black divide-y divide-neutral-200 dark:divide-neutral-800">
                  {workspaces.length === 0 ? (
                    <p className="p-6 font-mono text-xs text-neutral-500">
                      No workspaces created yet.
                    </p>
                  ) : (
                    workspaces.map((ws) => (
                      <div key={ws.id} className="p-4 flex items-center justify-between gap-4">
                        <div>
                          <div className="font-mono text-sm font-semibold">{ws.name}</div>
                          {ws.description && (
                            <div className="mt-0.5 text-xs text-neutral-500">{ws.description}</div>
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
                            className="border border-transparent p-1.5 text-neutral-500 hover:border-black dark:hover:border-white hover:text-black dark:hover:text-white"
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
              <section className="gsap-section space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 pb-5">
                  <div>
                    <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
                      03 / Live Endpoints
                    </span>
                    <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight">
                      Tunnel Inventory
                    </h2>
                    <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                      Active and historical tunnels synced from the LocalShare VS Code extension.
                    </p>
                  </div>
                  <select
                    aria-label="Filter tunnels by state"
                    value={tunnelStateFilter}
                    onChange={(e) => setTunnelStateFilter(e.target.value)}
                    className="border border-black dark:border-white bg-white dark:bg-black px-3 py-1.5 font-mono text-xs"
                  >
                    <option value="" className="bg-white dark:bg-black">
                      All States
                    </option>
                    {TUNNEL_STATES.map((st) => (
                      <option key={st} value={st} className="bg-white dark:bg-black">
                        {st}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-neutral-300 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 font-mono text-[11px] uppercase text-neutral-500">
                      <tr>
                        <th className="px-4 py-3">Name</th>
                        <th className="px-4 py-3">Target</th>
                        <th className="px-4 py-3">State</th>
                        <th className="px-4 py-3">Access</th>
                        <th className="px-4 py-3">Public URL</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                      {!tunnelsPage || tunnelsPage.items.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center font-mono text-neutral-500">
                            No tunnel records found.
                          </td>
                        </tr>
                      ) : (
                        tunnelsPage.items.map((t) => (
                          <tr
                            key={t.id}
                            className="transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-950"
                          >
                            <td className="px-4 py-3 font-medium">
                              {t.name}
                              {t.framework && (
                                <span className="ml-2 font-mono text-[11px] text-neutral-500">
                                  ({t.framework})
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 font-mono">{t.localTarget}</td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-block border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                                  t.state === 'ONLINE'
                                    ? 'border-black dark:border-white bg-black dark:bg-white text-white dark:text-black'
                                    : 'border-neutral-300 dark:border-neutral-700 text-neutral-500'
                                }`}
                              >
                                {t.state}
                              </span>
                            </td>
                            <td className="px-4 py-3 font-mono text-[11px]">{t.accessMode}</td>
                            <td className="px-4 py-3 font-mono">
                              {t.publicUrl ? (
                                <a
                                  href={t.publicUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 underline underline-offset-4 hover:opacity-70"
                                >
                                  <span>{t.publicUrl}</span>
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
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
                                  className="inline-flex items-center border border-transparent p-1 text-neutral-500 hover:border-black dark:hover:border-white hover:text-black dark:hover:text-white"
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
              <section className="gsap-section space-y-6">
                <div className="border-b border-neutral-200 dark:border-neutral-800 pb-5">
                  <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
                    04 / Hostname Authority
                  </span>
                  <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight">
                    Custom Preview Domains
                  </h2>
                  <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                    Authorize customer or team hostnames via DNS TXT ownership verification.
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
                    className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-4 flex flex-col sm:flex-row gap-3"
                  >
                    <input
                      type="text"
                      required
                      aria-label="Custom domain hostname"
                      placeholder="preview.customer.com"
                      value={domainHost}
                      onChange={(e) => setDomainHost(e.target.value)}
                      className={INPUT_CLASS}
                    />
                    <button type="submit" className={`${PRIMARY_BTN_CLASS} shrink-0`}>
                      <Plus className="h-3.5 w-3.5" />
                      <span>Add Domain</span>
                    </button>
                  </form>
                )}

                <div className="space-y-4">
                  {domains.length === 0 ? (
                    <div className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-6 font-mono text-xs text-neutral-500">
                      No custom domains registered yet.
                    </div>
                  ) : (
                    domains.map((d) => (
                      <div
                        key={d.id}
                        className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-5 space-y-4"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-sm font-bold">{d.hostname}</span>
                            <span
                              className={`border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                                d.status === 'VERIFIED'
                                  ? 'border-black dark:border-white bg-black dark:bg-white text-white dark:text-black'
                                  : 'border-neutral-400 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300'
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
                                className={PRIMARY_BTN_CLASS}
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
                                className="border border-neutral-300 dark:border-neutral-800 p-2 text-neutral-500 hover:border-black dark:hover:border-white hover:text-black dark:hover:text-white"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-3.5 text-xs space-y-2.5">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <span className="font-mono text-[11px] uppercase text-neutral-500">
                              TXT Record Name:
                            </span>
                            <div className="flex items-center gap-2">
                              <code className="font-mono text-xs break-all">
                                {d.verification.recordName}
                              </code>
                              <CopyButton value={d.verification.recordName} label="Copy Name" />
                            </div>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-neutral-200 dark:border-neutral-800 pt-2.5">
                            <span className="font-mono text-[11px] uppercase text-neutral-500">
                              TXT Record Value:
                            </span>
                            <div className="flex items-center gap-2">
                              <code className="font-mono text-xs break-all">
                                {d.verification.recordValue}
                              </code>
                              <CopyButton value={d.verification.recordValue} label="Copy Value" />
                            </div>
                          </div>
                          {d.verification.lastError && (
                            <div className="border-t border-neutral-200 dark:border-neutral-800 pt-2 font-mono text-[11px] text-neutral-600 dark:text-neutral-400">
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
              <section className="gsap-section space-y-6">
                <div className="border-b border-neutral-200 dark:border-neutral-800 pb-5">
                  <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
                    05 / Access Control Matrix
                  </span>
                  <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight">
                    Team Members
                  </h2>
                  <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
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
                    className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-4 flex flex-col sm:flex-row gap-3"
                  >
                    <input
                      type="email"
                      required
                      aria-label="Member email address"
                      placeholder="teammate@company.com"
                      value={memberEmail}
                      onChange={(e) => setMemberEmail(e.target.value)}
                      className={INPUT_CLASS}
                    />
                    <select
                      aria-label="Member role"
                      value={memberRole}
                      onChange={(e) => setMemberRole(e.target.value as OrgRole)}
                      className="border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-3 py-2 font-mono text-xs"
                    >
                      {ORG_ROLES.map((r) => (
                        <option key={r} value={r} className="bg-white dark:bg-black">
                          {r}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className={`${PRIMARY_BTN_CLASS} shrink-0`}>
                      <Plus className="h-3.5 w-3.5" />
                      <span>Add Member</span>
                    </button>
                  </form>
                )}

                <div className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black divide-y divide-neutral-200 dark:divide-neutral-800">
                  {members.map((m) => (
                    <div key={m.id} className="p-4 flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold">{m.name}</div>
                        <div className="font-mono text-xs text-neutral-500">{m.email}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="border border-black dark:border-white px-2.5 py-0.5 font-mono text-[11px] font-semibold">
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
                            className="border border-transparent p-1.5 text-neutral-500 hover:border-black dark:hover:border-white hover:text-black dark:hover:text-white"
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
              <section className="gsap-section space-y-10">
                {/* Access Policies */}
                <div className="space-y-4">
                  <div className="border-b border-neutral-200 dark:border-neutral-800 pb-4">
                    <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
                      06 / Zero-Trust &amp; Credentials
                    </span>
                    <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight">
                      Access Policies
                    </h2>
                    <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                      Define identity rules (allowed emails and email domains) for protected preview
                      hostnames.
                    </p>
                  </div>

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
                      className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
                    >
                      <input
                        type="text"
                        required
                        aria-label="Policy name"
                        placeholder="Customer Reviewers"
                        value={policyName}
                        onChange={(e) => setPolicyName(e.target.value)}
                        className={INPUT_CLASS}
                      />
                      <select
                        aria-label="Policy access mode"
                        value={policyMode}
                        onChange={(e) => setPolicyMode(e.target.value as AccessMode)}
                        className="border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-3 py-2 font-mono text-xs"
                      >
                        <option value="CLOUDFLARE_ACCESS" className="bg-white dark:bg-black">
                          CLOUDFLARE_ACCESS
                        </option>
                        <option value="PASSWORD" className="bg-white dark:bg-black">
                          PASSWORD
                        </option>
                        <option value="PUBLIC" className="bg-white dark:bg-black">
                          PUBLIC
                        </option>
                      </select>
                      <input
                        type="text"
                        aria-label="Allowed emails or domains"
                        placeholder="alice@customer.com, @customer.com"
                        value={policyTargets}
                        onChange={(e) => setPolicyTargets(e.target.value)}
                        className={INPUT_CLASS}
                      />
                      <button type="submit" className={PRIMARY_BTN_CLASS}>
                        <Plus className="h-3.5 w-3.5" />
                        <span>Create Policy</span>
                      </button>
                    </form>
                  )}

                  <div className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black divide-y divide-neutral-200 dark:divide-neutral-800">
                    {policies.length === 0 ? (
                      <p className="p-5 font-mono text-xs text-neutral-500">
                        No access policies defined.
                      </p>
                    ) : (
                      policies.map((p) => (
                        <div key={p.id} className="p-4 flex items-center justify-between gap-4">
                          <div>
                            <div className="text-sm font-semibold">
                              {p.name}{' '}
                              <span className="ml-2 border border-black dark:border-white px-2 py-0.5 font-mono text-[10px]">
                                {p.mode}
                              </span>
                            </div>
                            <div className="font-mono text-xs text-neutral-500 mt-1">
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
                              className="border border-transparent p-1.5 text-neutral-500 hover:border-black dark:hover:border-white hover:text-black dark:hover:text-white"
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
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4" />
                    <h3 className="text-base font-bold tracking-tight">
                      Personal API Tokens (VS Code Extension)
                    </h3>
                  </div>
                  <p className="text-xs text-neutral-600 dark:text-neutral-400">
                    Generate an API token to sync your VS Code extension shares with LocalShare
                    Cloud. Plaintext tokens are shown only once.
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
                    className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-4 flex flex-col sm:flex-row gap-3"
                  >
                    <input
                      type="text"
                      required
                      aria-label="Personal API token name"
                      placeholder="Workstation VS Code"
                      value={tokenName}
                      onChange={(e) => setTokenName(e.target.value)}
                      className={INPUT_CLASS}
                    />
                    <button type="submit" className={`${PRIMARY_BTN_CLASS} shrink-0`}>
                      <Plus className="h-3.5 w-3.5" />
                      <span>Generate Token</span>
                    </button>
                  </form>

                  {createdTokenModal && (
                    <div
                      role="dialog"
                      aria-label="New API token generated"
                      className="border-2 border-black dark:border-white bg-neutral-50 dark:bg-neutral-950 p-5 space-y-3 shadow-[5px_5px_0px_0px_rgba(0,0,0,1)] dark:shadow-[5px_5px_0px_0px_rgba(255,255,255,1)]"
                    >
                      <div className="font-mono text-xs font-bold uppercase">
                        Copy your new API token now — it will never be displayed again:
                      </div>
                      <div className="flex items-center justify-between gap-2 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black p-3">
                        <code className="font-mono text-xs font-semibold break-all">
                          {createdTokenModal.token}
                        </code>
                        <CopyButton value={createdTokenModal.token} label="Copy Token" />
                      </div>
                      <button
                        type="button"
                        onClick={() => setCreatedTokenModal(null)}
                        className="font-mono text-xs underline underline-offset-4"
                      >
                        I have saved this token
                      </button>
                    </div>
                  )}

                  <div className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black divide-y divide-neutral-200 dark:divide-neutral-800">
                    {apiTokens.length === 0 ? (
                      <p className="p-5 font-mono text-xs text-neutral-500">
                        No personal API tokens active.
                      </p>
                    ) : (
                      apiTokens.map((tok) => (
                        <div key={tok.id} className="p-4 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-semibold">{tok.name}</span>
                            <code className="ml-3 border border-neutral-300 dark:border-neutral-700 px-1.5 py-0.5 font-mono text-neutral-500">
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
                            className="border border-transparent p-1.5 text-neutral-500 hover:border-black dark:hover:border-white hover:text-black dark:hover:text-white"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Cloudflare Provider Connections */}
                <div className="space-y-4">
                  <h3 className="text-base font-bold tracking-tight">
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
                      className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
                    >
                      <input
                        type="text"
                        required
                        aria-label="Provider connection label"
                        placeholder="Cloudflare Production"
                        value={cfLabel}
                        onChange={(e) => setCfLabel(e.target.value)}
                        className={INPUT_CLASS}
                      />
                      <input
                        type="text"
                        aria-label="Cloudflare Account ID"
                        placeholder="Account ID (optional)"
                        value={cfAccountId}
                        onChange={(e) => setCfAccountId(e.target.value)}
                        className={INPUT_CLASS}
                      />
                      <input
                        type="password"
                        required
                        minLength={16}
                        aria-label="Cloudflare API Token"
                        placeholder="API Token (AES-256-GCM)"
                        value={cfToken}
                        onChange={(e) => setCfToken(e.target.value)}
                        className={INPUT_CLASS}
                      />
                      <button type="submit" className={PRIMARY_BTN_CLASS}>
                        <Plus className="h-3.5 w-3.5" />
                        <span>Save Connection</span>
                      </button>
                    </form>
                  )}

                  <div className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black divide-y divide-neutral-200 dark:divide-neutral-800">
                    {providers.length === 0 ? (
                      <p className="p-5 font-mono text-xs text-neutral-500">
                        No provider tokens stored.
                      </p>
                    ) : (
                      providers.map((prov) => (
                        <div key={prov.id} className="p-4 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-semibold">{prov.label}</span>
                            <span className="ml-2 font-mono text-neutral-500">
                              ({prov.provider} • ****{prov.tokenLast4})
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
                              className="border border-transparent p-1.5 text-neutral-500 hover:border-black dark:hover:border-white hover:text-black dark:hover:text-white"
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
                <div className="border-b border-neutral-200 dark:border-neutral-800 pb-5">
                  <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
                    07 / Immutable Ledger
                  </span>
                  <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight">
                    Security Audit Log
                  </h2>
                  <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                    Immutable record of authentication, membership, domain verification, and policy
                    changes.
                  </p>
                </div>

                <div className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-neutral-300 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 font-mono text-[11px] uppercase text-neutral-500">
                      <tr>
                        <th className="px-4 py-3">Action</th>
                        <th className="px-4 py-3">Actor</th>
                        <th className="px-4 py-3">Target</th>
                        <th className="px-4 py-3">Timestamp</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                      {!auditPage || auditPage.items.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-8 text-center font-mono text-neutral-500">
                            No audit events found.
                          </td>
                        </tr>
                      ) : (
                        auditPage.items.map((ev) => (
                          <tr
                            key={ev.id}
                            className="transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-950"
                          >
                            <td className="px-4 py-3 font-mono font-semibold">{ev.action}</td>
                            <td className="px-4 py-3">{ev.actorEmail ?? 'system'}</td>
                            <td className="px-4 py-3 font-mono text-neutral-500">
                              {ev.targetType ? `${ev.targetType}:${ev.targetId ?? ''}` : '—'}
                            </td>
                            <td className="px-4 py-3 font-mono text-neutral-500">
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
                <div className="border-b border-neutral-200 dark:border-neutral-800 pb-5">
                  <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
                    08 / Preferences
                  </span>
                  <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight">
                    Organization Settings
                  </h2>
                  <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
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
                    className="gsap-card border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black p-5 space-y-3"
                  >
                    <label
                      htmlFor="rename-org-input"
                      className="block font-mono text-xs font-semibold uppercase"
                    >
                      Organization Display Name
                    </label>
                    <div className="flex flex-col sm:flex-row gap-3 max-w-md">
                      <input
                        id="rename-org-input"
                        type="text"
                        required
                        value={renameOrgValue}
                        onChange={(e) => setRenameOrgValue(e.target.value)}
                        className={INPUT_CLASS}
                      />
                      <button type="submit" className={`${PRIMARY_BTN_CLASS} shrink-0`}>
                        Save Name
                      </button>
                    </div>
                  </form>
                )}

                {isOwner && (
                  <div className="gsap-card border-2 border-black dark:border-white bg-neutral-50 dark:bg-neutral-950 p-5 space-y-3">
                    <h3 className="font-mono text-xs font-bold uppercase tracking-wider">
                      Danger Zone
                    </h3>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">
                      Type the organization slug (
                      <code className="font-mono font-bold">{activeOrg.slug}</code>) to confirm
                      permanent deletion.
                    </p>
                    <div className="flex flex-col sm:flex-row gap-3 max-w-md">
                      <input
                        type="text"
                        aria-label="Confirm organization slug to delete"
                        placeholder={activeOrg.slug}
                        value={deleteSlugConfirm}
                        onChange={(e) => setDeleteSlugConfirm(e.target.value)}
                        className={INPUT_CLASS}
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
                        className={`${PRIMARY_BTN_CLASS} shrink-0 disabled:opacity-30`}
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
