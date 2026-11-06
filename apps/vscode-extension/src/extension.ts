/**
 * LocalShare VS Code Extension — main entry point.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  formatHostPort,
  validateEmail,
  validateEmailDomain,
  validateGatewayPassword,
  validateGatewayUsername,
  validateHostname,
  validateLocalTarget,
  validatePort,
  validateTunnelName,
} from '@localshare/validation';
import { LocalAuditLog } from './core/audit';
import { CloudflaredBinaryManager } from './core/binaryManager';
import { LocalShareCloudClient } from './core/cloudSync';
import type { SavedCustomDomain } from './core/customDomains';
import {
  detectLocalServers,
  type DetectedProject,
  type DetectedServer,
} from './core/detection';
import { LocalShareError, toErrorMessage } from './core/errors';
import { Logger, type LogLevel } from './core/logger';
import {
  CloudflareApiClient,
  type CloudflareAccount,
  type CloudflareNamedTunnel,
} from './core/providers/cloudflareApi';
import { CloudflareTunnelProvider } from './core/providers/cloudflareQuick';
import { LocalShareRelayProvider } from './core/providers/localshareRelay';
import type { TunnelConnectConfig, TunnelProvider } from './core/providers/types';
import {
  TunnelManager,
  buildCustomerPreviewMessage,
  type ActiveShare,
  type PersistedSessionRecord,
  type ShareHistoryEntry,
} from './core/tunnelManager';
import {
  CustomDomainTreeItem,
  DomainsTreeProvider,
  HistoryTreeItem,
  NamedTunnelTreeItem,
  SecurityTreeProvider,
  ServerTreeItem,
  ServersTreeProvider,
  SettingsTreeProvider,
  ShareTreeItem,
  SharesTreeProvider,
  WorkspaceTreeProvider,
  type ExtensionViewState,
} from './vscode/trees';

const SECRET_CF_API_TOKEN = 'localshare.cloudflare.apiToken';
const SECRET_GATEWAY_PASSWORD = 'localshare.security.gatewayPassword';
const SECRET_CLOUD_API_TOKEN = 'localshare.cloud.apiToken';
const STATE_HISTORY = 'localshare.shareHistory';
const STATE_ACTIVE_SESSIONS = 'localshare.activeSessions';
const STATE_CUSTOM_DOMAINS = 'localshare.customDomains';
const STATE_CF_ACCOUNT = 'localshare.cloudflare.account';
const STATE_GATEWAY_USERNAME = 'localshare.security.gatewayUsername';

export interface LocalShareExtensionApi {
  readonly tunnelManager: TunnelManager;
  readonly auditLog: LocalAuditLog;
  readonly logger: Logger;
  refreshDetection(): Promise<{ projects: DetectedProject[]; servers: DetectedServer[] }>;
  getViewState(): ExtensionViewState;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<LocalShareExtensionApi> {
  const outputChannel = vscode.window.createOutputChannel('LocalShare');
  context.subscriptions.push(outputChannel);

  const getCfg = () => vscode.workspace.getConfiguration('localshare');
  const logger = new Logger(
    outputChannel,
    getCfg().get<LogLevel>('logLevel', 'info'),
  );
  const auditFilePath = context.globalStorageUri
    ? path.join(context.globalStorageUri.fsPath, 'security-audit.jsonl')
    : undefined;
  const auditLog = new LocalAuditLog(auditFilePath);

  let projects: DetectedProject[] = [];
  let servers: DetectedServer[] = [];
  let binaryInfo: { binaryPath: string; version: string; source: string } | undefined;
  let namedTunnels: CloudflareNamedTunnel[] = [];
  let hasPreviewPassword = Boolean(await context.secrets.get(SECRET_GATEWAY_PASSWORD));
  let cloudConnected = Boolean(await context.secrets.get(SECRET_CLOUD_API_TOKEN));

  const createBinaryManager = () =>
    new CloudflaredBinaryManager({
      storageDir: context.globalStorageUri.fsPath,
      configuredPath: getCfg().get<string>('cloudflared.path', ''),
      logger,
    });

  const ensureBinaryPath = async (): Promise<string> => {
    const mgr = createBinaryManager();
    const existing = await mgr.resolveExistingBinary();
    if (existing) {
      binaryInfo = existing;
      return existing.binaryPath;
    }

    const choice = await vscode.window.showInformationMessage(
      'LocalShare needs the official Cloudflare Tunnel client (cloudflared) to create HTTPS links. Download and verify it now?',
      { modal: true },
      'Download & Verify',
    );
    if (choice !== 'Download & Verify') {
      throw new LocalShareError(
        'USER_CANCELLED',
        'cloudflared installation was cancelled.',
      );
    }

    const meta = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'LocalShare: Installing cloudflared',
      },
      async (progress) => {
        return mgr.installOrUpdate((step) => progress.report({ message: step }));
      },
    );
    auditLog.record(
      'binary.verified',
      `Downloaded and verified cloudflared ${meta.version} (SHA-256 ${meta.sha256})`,
    );
    binaryInfo = {
      binaryPath: meta.binaryPath,
      version: meta.version,
      source: 'managed',
    };
    return meta.binaryPath;
  };

  const cfProvider = new CloudflareTunnelProvider({
    resolveBinaryPath: ensureBinaryPath,
    logger,
  });

  const relayProvider = new LocalShareRelayProvider(
    () => {
      const raw = getCfg().get<string>('cloud.apiUrl', '') || 'https://cloud.lorndavid.online/api/v1';
      return raw.replace(/\/api\/v1\/?$/, '');
    },
    logger,
    () => getCfg().get<boolean>('security.allowLanTargets', false),
  );

  const getActiveProvider = (): TunnelProvider =>
    getCfg().get<string>('provider', 'localshare') === 'cloudflare' ? cfProvider : relayProvider;

  const provider: TunnelProvider = {
    get id() {
      return getActiveProvider().id;
    },
    validateConfiguration(config: TunnelConnectConfig) {
      return getActiveProvider().validateConfiguration(config);
    },
    connect(config: TunnelConnectConfig) {
      if (config.tunnelToken) {
        return cfProvider.connect(config);
      }
      return getActiveProvider().connect(config);
    },
    disconnect(tunnelId: string) {
      if (cfProvider.getStatus(tunnelId)) return cfProvider.disconnect(tunnelId);
      return relayProvider.disconnect(tunnelId);
    },
    getStatus(tunnelId: string) {
      return relayProvider.getStatus(tunnelId) ?? cfProvider.getStatus(tunnelId);
    },
    getPublicUrl(tunnelId: string) {
      return relayProvider.getPublicUrl(tunnelId) ?? cfProvider.getPublicUrl(tunnelId);
    },
    listTunnels() {
      return [...relayProvider.listTunnels(), ...cfProvider.listTunnels()];
    },
  };

  const createCloudClient = () =>
    new LocalShareCloudClient({
      apiUrl: getCfg().get<string>('cloud.apiUrl', ''),
      organizationId: getCfg().get<string>('cloud.organizationId', ''),
      getApiToken: async () => context.secrets.get(SECRET_CLOUD_API_TOKEN),
      logger,
    });

  const tunnelManager = new TunnelManager({
    provider,
    logger,
    audit: auditLog,
    getSecurityConfig: () => {
      const c = getCfg();
      return {
        allowLanTargets: c.get<boolean>('security.allowLanTargets', false),
        allowedSensitivePorts: c.get<number[]>('security.allowedSensitivePorts', []),
        rewriteHostHeader: c.get<boolean>('sharing.rewriteHostHeader', true),
        startupTimeoutSeconds: c.get<number>('sharing.startupTimeoutSeconds', 45),
        autoReconnect: c.get<boolean>('sharing.autoReconnect', true),
        passwordSessionHours: c.get<number>('security.passwordSessionHours', 12),
      };
    },
    getGatewayCredentials: async () => {
      const password = await context.secrets.get(SECRET_GATEWAY_PASSWORD);
      if (!password) return undefined;
      logger.registerSecret(password);
      const username = context.globalState.get<string>(STATE_GATEWAY_USERNAME, 'preview');
      return { username, password };
    },
    loadHistory: () => context.workspaceState.get<ShareHistoryEntry[]>(STATE_HISTORY, []),
    saveHistory: async (entries) => {
      await context.workspaceState.update(STATE_HISTORY, entries);
    },
    loadActiveSessionRecords: () =>
      context.workspaceState.get<PersistedSessionRecord[]>(STATE_ACTIVE_SESSIONS, []),
    saveActiveSessionRecords: async (records) => {
      await context.workspaceState.update(STATE_ACTIVE_SESSIONS, records);
    },
    onShareChanged: (share) => {
      void createCloudClient().syncShare(share);
    },
  });

  const cfApi = new CloudflareApiClient(
    async () => {
      const tok = await context.secrets.get(SECRET_CF_API_TOKEN);
      if (tok) logger.registerSecret(tok);
      return tok;
    },
    { logger },
  );

  const loadCustomDomains = (): SavedCustomDomain[] =>
    context.workspaceState.get<SavedCustomDomain[]>(STATE_CUSTOM_DOMAINS, []);
  const saveCustomDomains = async (domains: SavedCustomDomain[]) => {
    await context.workspaceState.update(STATE_CUSTOM_DOMAINS, domains);
  };
  const getSavedAccount = (): CloudflareAccount | undefined =>
    context.globalState.get<CloudflareAccount>(STATE_CF_ACCOUNT);

  const getViewState = (): ExtensionViewState => ({
    workspaceTrusted: vscode.workspace.isTrusted,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    projects,
    servers,
    shares: tunnelManager.listShares(),
    history: tunnelManager.getHistory(),
    customDomains: loadCustomDomains(),
    namedTunnels,
    cloudflareAccount: getSavedAccount(),
    binaryInfo,
    hasPreviewPassword,
    gatewayUsername: context.globalState.get<string>(STATE_GATEWAY_USERNAME, 'preview'),
    confirmBeforeSharing: getCfg().get<boolean>('security.confirmBeforeSharing', true),
    allowLanTargets: getCfg().get<boolean>('security.allowLanTargets', false),
    cloudConnected: cloudConnected && createCloudClient().isConfigured(),
  });

  // Tree providers
  const workspaceTree = new WorkspaceTreeProvider(getViewState);
  const serversTree = new ServersTreeProvider(getViewState);
  const sharesTree = new SharesTreeProvider(getViewState);
  const domainsTree = new DomainsTreeProvider(getViewState);
  const securityTree = new SecurityTreeProvider(getViewState);
  const settingsTree = new SettingsTreeProvider(getViewState);

  const views = [
    vscode.window.createTreeView('localshare.workspace', { treeDataProvider: workspaceTree }),
    vscode.window.createTreeView('localshare.servers', { treeDataProvider: serversTree }),
    vscode.window.createTreeView('localshare.shares', { treeDataProvider: sharesTree }),
    vscode.window.createTreeView('localshare.domains', { treeDataProvider: domainsTree }),
    vscode.window.createTreeView('localshare.security', { treeDataProvider: securityTree }),
    vscode.window.createTreeView('localshare.settings', { treeDataProvider: settingsTree }),
  ];
  context.subscriptions.push(...views);

  // Status bar item
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'localshare.startSharing';
  context.subscriptions.push(statusBar);

  const refreshAllTrees = () => {
    const shares = tunnelManager.listShares();
    const online = shares.filter((s) => s.state === 'ONLINE');
    void vscode.commands.executeCommand(
      'setContext',
      'localshare.hasActiveShares',
      shares.length > 0,
    );

    if (online.length > 0) {
      statusBar.text = `$(broadcast) LocalShare: ${online.length} Live`;
      statusBar.tooltip = online
        .map((s) => `${s.name} (${s.host}:${s.port}) → ${s.publicUrl ?? ''}`)
        .join('\n');
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      statusBar.text = '$(broadcast) LocalShare';
      statusBar.tooltip = 'Click to share a local development server';
      statusBar.backgroundColor = undefined;
    }
    statusBar.show();

    workspaceTree.refresh();
    serversTree.refresh();
    sharesTree.refresh();
    domainsTree.refresh();
    securityTree.refresh();
    settingsTree.refresh();
  };

  tunnelManager.onDidChange(refreshAllTrees);

  // Detection runner
  let detecting = false;
  const refreshDetection = async (): Promise<{
    projects: DetectedProject[];
    servers: DetectedServer[];
  }> => {
    if (detecting) return { projects, servers };
    detecting = true;
    try {
      const c = getCfg();
      const folderPaths = vscode.workspace.isTrusted
        ? (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
        : [];
      const res = await detectLocalServers({
        workspaceFolders: folderPaths,
        extraPorts: c.get<number[]>('detection.extraPorts', []),
        showAllListeners: c.get<boolean>('detection.showAllListeners', false),
        allowedSensitivePorts: c.get<number[]>('security.allowedSensitivePorts', []),
      });
      projects = res.projects;
      servers = res.servers;
      refreshAllTrees();
      return res;
    } finally {
      detecting = false;
    }
  };

  // Ask explicit public exposure confirmation before sharing
  const confirmExposure = async (
    host: string,
    port: number,
    label: string,
    isNamed = false,
  ): Promise<boolean> => {
    if (!getCfg().get<boolean>('security.confirmBeforeSharing', true)) {
      return true;
    }
    const modeNote = hasPreviewPassword
      ? `Password protection IS enabled (username: ${context.globalState.get<string>(STATE_GATEWAY_USERNAME, 'preview')}).`
      : isNamed
        ? 'This hostname will route internet traffic to your local server.'
        : 'Anyone with the generated random URL will be able to access your local server while the tunnel is running (a hard-to-guess URL is NOT authentication). Tip: use "LocalShare: Set Preview Password" to require a password.';

    const choice = await vscode.window.showWarningMessage(
      `Expose ${label} (${formatHostPort(host, port)}) to the internet over HTTPS?\n\n${modeNote}`,
      { modal: true },
      'Start Sharing',
    );
    if (choice === 'Start Sharing') {
      auditLog.record(
        'share.confirm.accepted',
        `Developer confirmed public exposure of ${host}:${port}`,
      );
      return true;
    }
    auditLog.record(
      'share.confirm.cancelled',
      `Developer cancelled public exposure of ${host}:${port}`,
    );
    return false;
  };

  // Start share with progress + post-share actions
  const runStartShareFlow = async (params: {
    name: string;
    host: string;
    port: number;
    framework?: DetectedServer['framework'];
    frameworkLabel?: string;
    processName?: string;
    group?: string;
    hostname?: string;
  }): Promise<ActiveShare | undefined> => {
    let chosenHostname = params.hostname;
    if (!chosenHostname && getActiveProvider().id === 'localshare') {
      const subInput = await vscode.window.showInputBox({
        prompt:
          'Optional: Enter a custom subdomain for *.lorndavid.online (or press Enter for an automatic link)',
        placeHolder: 'e.g. myapp  →  https://myapp.lorndavid.online',
      });
      if (subInput === undefined) return undefined;
      if (subInput.trim()) {
        chosenHostname = subInput.trim().toLowerCase();
      }
    }

    const confirmed = await confirmExposure(
      params.host,
      params.port,
      params.name,
      Boolean(chosenHostname),
    );
    if (!confirmed) return undefined;

    try {
      const share = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `LocalShare: Starting HTTPS tunnel for ${params.name} (${params.host}:${params.port})…`,
          cancellable: true,
        },
        async (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          return tunnelManager.startShare({
            name: params.name,
            host: params.host,
            port: params.port,
            framework: params.framework,
            frameworkLabel: params.frameworkLabel,
            processName: params.processName,
            group: params.group,
            ...(chosenHostname ? { hostname: chosenHostname, kind: 'NAMED' as const } : {}),
            signal: abort.signal,
          });
        },
      );

      if (share.publicUrl && getCfg().get<boolean>('sharing.copyUrlOnStart', true)) {
        await vscode.env.clipboard.writeText(share.publicUrl);
      }

      const action = await vscode.window.showInformationMessage(
        `${share.name} is live at ${share.publicUrl ?? ''} (${share.kind === 'QUICK' ? 'Temporary URL' : 'Custom Domain'}${share.accessMode === 'PASSWORD' ? ', Password Protected' : ''}).`,
        'Copy URL',
        'Open in Browser',
        'Copy Customer Message',
      );
      if (action === 'Copy URL' && share.publicUrl) {
        await vscode.env.clipboard.writeText(share.publicUrl);
      } else if (action === 'Open in Browser' && share.publicUrl) {
        await vscode.env.openExternal(vscode.Uri.parse(share.publicUrl));
      } else if (action === 'Copy Customer Message') {
        const msg = buildCustomerPreviewMessage(
          share,
          context.globalState.get<string>(STATE_GATEWAY_USERNAME, 'preview'),
        );
        await vscode.env.clipboard.writeText(msg);
      }
      return share;
    } catch (err) {
      if (err instanceof LocalShareError && err.code === 'USER_CANCELLED') {
        return undefined;
      }
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
      return undefined;
    }
  };

  // Helper to resolve a target Share from a tree argument or QuickPick
  const pickActiveShare = async (arg?: unknown): Promise<ActiveShare | undefined> => {
    if (arg instanceof ShareTreeItem) return arg.share;
    const shares = tunnelManager.listShares();
    if (shares.length === 0) {
      vscode.window.showInformationMessage('LocalShare: No active shares.');
      return undefined;
    }
    if (shares.length === 1) return shares[0];
    const picked = await vscode.window.showQuickPick(
      shares.map((s) => ({
        label: s.name,
        description: `${s.host}:${s.port} → ${s.publicUrl ?? s.state}`,
        share: s,
      })),
      { placeHolder: 'Select an active share' },
    );
    return picked?.share;
  };

  // ---------------------------------------------------------------------------
  // Command registrations
  // ---------------------------------------------------------------------------

  const register = (id: string, fn: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  register('localshare.refreshServers', async () => {
    await refreshDetection();
  });

  register('localshare.startSharingServer', async (arg?: unknown) => {
    if (arg instanceof ServerTreeItem) {
      await runStartShareFlow({
        name: arg.server.name,
        host: arg.server.host,
        port: arg.server.port,
        framework: arg.server.framework,
        frameworkLabel: arg.server.frameworkLabel,
        processName: arg.server.processName,
      });
    }
  });

  register('localshare.startSharing', async () => {
    await refreshDetection();
    const shareable = servers.filter((s) => s.shareable);
    const recentPorts = tunnelManager.getRecentPorts();

    type PickItem = vscode.QuickPickItem & {
      server?: DetectedServer;
      customPort?: number;
      manual?: boolean;
    };
    const items: PickItem[] = shareable.map((s) => ({
      label: `$(globe) ${s.name}`,
      description: `${s.frameworkLabel} • localhost:${s.port}`,
      detail: s.health === 'healthy-http' ? 'HTTP server responding' : 'TCP listener ready',
      server: s,
    }));

    for (const rp of recentPorts) {
      if (!shareable.some((s) => s.port === rp)) {
        items.push({
          label: `$(history) Recent Port :${rp}`,
          description: `localhost:${rp}`,
          customPort: rp,
        });
      }
    }

    items.push({
      label: '$(plug) Enter a Custom Host / Port…',
      description: 'Share any local port manually',
      manual: true,
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a local server to share over HTTPS',
    });
    if (!picked) return;

    if (picked.manual) {
      await vscode.commands.executeCommand('localshare.shareCustomPort');
      return;
    }
    if (picked.server) {
      await runStartShareFlow({
        name: picked.server.name,
        host: picked.server.host,
        port: picked.server.port,
        framework: picked.server.framework,
        frameworkLabel: picked.server.frameworkLabel,
        processName: picked.server.processName,
      });
      return;
    }
    if (picked.customPort !== undefined) {
      await runStartShareFlow({
        name: `Port ${picked.customPort}`,
        host: 'localhost',
        port: picked.customPort,
      });
    }
  });

  register('localshare.shareCustomPort', async () => {
    const rawPort = await vscode.window.showInputBox({
      prompt: 'Enter the local TCP port to share (e.g. 5173 or 127.0.0.1:4000)',
      placeHolder: '5173',
      validateInput: (val) => {
        const trimmed = val.trim();
        if (trimmed.includes(':')) {
          const idx = trimmed.lastIndexOf(':');
          const h = trimmed.slice(0, idx);
          const p = trimmed.slice(idx + 1);
          const res = validateLocalTarget(h, p, {
            allowLanTargets: getCfg().get<boolean>('security.allowLanTargets', false),
          });
          return res.ok ? undefined : res.error;
        }
        const res = validatePort(trimmed);
        return res.ok ? undefined : res.error;
      },
    });
    if (!rawPort) return;

    let host = 'localhost';
    let portStr = rawPort.trim();
    if (portStr.includes(':')) {
      const idx = portStr.lastIndexOf(':');
      host = portStr.slice(0, idx);
      portStr = portStr.slice(idx + 1);
    }
    const portRes = validatePort(portStr);
    if (!portRes.ok) return;

    const customName = await vscode.window.showInputBox({
      prompt: 'Give this share a friendly name',
      value: `Port ${portRes.value}`,
    });
    if (!customName) return;

    await runStartShareFlow({
      name: customName,
      host,
      port: portRes.value,
    });
  });

  register('localshare.stopShare', async (arg?: unknown) => {
    const share = await pickActiveShare(arg);
    if (!share) return;
    await tunnelManager.stopShare(share.id);
    vscode.window.showInformationMessage(`LocalShare: Stopped "${share.name}".`);
  });

  register('localshare.stopAllShares', async () => {
    const count = tunnelManager.listShares().length;
    if (count === 0) return;
    await tunnelManager.stopAllShares();
    vscode.window.showInformationMessage(`LocalShare: Stopped all ${count} share(s).`);
  });

  register('localshare.restartShare', async (arg?: unknown) => {
    const share = await pickActiveShare(arg);
    if (!share) return;
    try {
      let token: string | undefined;
      if (share.kind === 'NAMED' && share.namedTunnelId) {
        const acct = getSavedAccount();
        if (acct) {
          token = await cfApi.getNamedTunnelToken(acct.id, share.namedTunnelId);
        }
      }
      const restarted = await tunnelManager.restartShare(share.id, token);
      vscode.window.showInformationMessage(
        `LocalShare: Restarted "${restarted.name}" → ${restarted.publicUrl ?? ''}`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  });

  register('localshare.copyUrl', async (arg?: unknown) => {
    const share = await pickActiveShare(arg);
    if (!share?.publicUrl) return;
    await vscode.env.clipboard.writeText(share.publicUrl);
    vscode.window.showInformationMessage(`Copied ${share.publicUrl} to clipboard.`);
  });

  register('localshare.openUrl', async (arg?: unknown) => {
    const share = await pickActiveShare(arg);
    if (!share?.publicUrl) return;
    await vscode.env.openExternal(vscode.Uri.parse(share.publicUrl));
  });

  register('localshare.copyCustomerMessage', async (arg?: unknown) => {
    const share = await pickActiveShare(arg);
    if (!share) return;
    const msg = buildCustomerPreviewMessage(
      share,
      context.globalState.get<string>(STATE_GATEWAY_USERNAME, 'preview'),
    );
    await vscode.env.clipboard.writeText(msg);
    vscode.window.showInformationMessage('Copied customer preview summary to clipboard.');
  });

  register('localshare.renameShare', async (arg?: unknown) => {
    const share = await pickActiveShare(arg);
    if (!share) return;
    const next = await vscode.window.showInputBox({
      prompt: 'Enter a new name for this share',
      value: share.name,
    });
    if (!next) return;
    try {
      await tunnelManager.renameShare(share.id, next);
    } catch (err) {
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  });

  register('localshare.editShareDescription', async (arg?: unknown) => {
    const share = await pickActiveShare(arg);
    if (!share) return;
    const next = await vscode.window.showInputBox({
      prompt: 'Enter an optional description for customers/teammates',
      value: share.description,
    });
    if (next === undefined) return;
    try {
      await tunnelManager.updateShareDescription(share.id, next);
    } catch (err) {
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  });

  register('localshare.setShareGroup', async (arg?: unknown) => {
    const share = await pickActiveShare(arg);
    if (!share) return;
    const next = await vscode.window.showInputBox({
      prompt: 'Enter a group name (e.g. "Full-Stack Preview") or leave empty to ungroup',
      value: share.group,
    });
    if (next === undefined) return;
    try {
      await tunnelManager.setShareGroup(share.id, next);
    } catch (err) {
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  });

  register('localshare.shareGroup', async () => {
    await refreshDetection();
    const shareable = servers.filter((s) => s.shareable);
    if (shareable.length === 0) {
      vscode.window.showInformationMessage('LocalShare: No running local servers detected to group.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      shareable.map((s) => ({
        label: s.name,
        description: `${s.frameworkLabel} • localhost:${s.port}`,
        picked: true,
        server: s,
      })),
      {
        canPickMany: true,
        placeHolder: 'Select frontend & backend servers to share together',
      },
    );
    if (!picked || picked.length === 0) return;

    const groupName = await vscode.window.showInputBox({
      prompt: 'Group name for these related shares',
      value: projects[0]?.name ? `${projects[0].name} Stack` : 'Full-Stack Preview',
    });
    if (!groupName) return;

    for (const item of picked) {
      await runStartShareFlow({
        name: item.server.name,
        host: item.server.host,
        port: item.server.port,
        framework: item.server.framework,
        frameworkLabel: item.server.frameworkLabel,
        processName: item.server.processName,
        group: groupName,
      });
    }
  });

  register('localshare.reshareFromHistory', async (arg?: unknown) => {
    if (!(arg instanceof HistoryTreeItem)) return;
    const e = arg.entry;
    await runStartShareFlow({
      name: e.name,
      host: e.host,
      port: e.port,
      framework: e.framework,
      frameworkLabel: e.frameworkLabel,
      group: e.group,
    });
  });

  register('localshare.clearHistory', async () => {
    await tunnelManager.clearHistory();
    vscode.window.showInformationMessage('LocalShare: Cleared recent share history.');
  });

  // Security & Password commands
  register('localshare.setPassword', async () => {
    const username = await vscode.window.showInputBox({
      prompt: 'Username visitors will enter when opening password-protected previews',
      value: context.globalState.get<string>(STATE_GATEWAY_USERNAME, 'preview'),
      validateInput: (v) => {
        const r = validateGatewayUsername(v);
        return r.ok ? undefined : r.error;
      },
    });
    if (!username) return;

    const password = await vscode.window.showInputBox({
      prompt: 'Preview password (minimum 10 characters, stored in OS SecretStorage)',
      password: true,
      validateInput: (v) => {
        const r = validateGatewayPassword(v);
        return r.ok ? undefined : r.error;
      },
    });
    if (!password) return;

    await context.globalState.update(STATE_GATEWAY_USERNAME, username.trim());
    await context.secrets.store(SECRET_GATEWAY_PASSWORD, password);
    logger.registerSecret(password);
    hasPreviewPassword = true;
    auditLog.record('security.password.set', `Enabled preview password protection (user: ${username.trim()})`);
    refreshAllTrees();
    vscode.window.showInformationMessage(
      `LocalShare: Preview password enabled (username: ${username.trim()}). New shares will require authentication.`,
    );
  });

  register('localshare.clearPassword', async () => {
    await context.secrets.delete(SECRET_GATEWAY_PASSWORD);
    hasPreviewPassword = false;
    auditLog.record('security.password.cleared', 'Removed preview password protection');
    refreshAllTrees();
    vscode.window.showInformationMessage('LocalShare: Preview password removed.');
  });

  // Binary & Diagnostics commands
  register('localshare.installCloudflared', async () => {
    try {
      const mgr = createBinaryManager();
      const meta = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'LocalShare: Downloading & verifying cloudflared…',
        },
        (progress) => mgr.installOrUpdate((step) => progress.report({ message: step })),
      );
      binaryInfo = { binaryPath: meta.binaryPath, version: meta.version, source: 'managed' };
      auditLog.record('binary.verified', `Verified cloudflared ${meta.version} (${meta.sha256})`);
      refreshAllTrees();
      vscode.window.showInformationMessage(
        `LocalShare: Installed verified cloudflared ${meta.version}.`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  });

  register('localshare.runDiagnostics', async () => {
    const mgr = createBinaryManager();
    const bin = await mgr.resolveExistingBinary().catch(() => undefined);
    binaryInfo = bin;
    const det = await refreshDetection();
    const acct = getSavedAccount();
    const report = [
      '=== LocalShare Diagnostics Report ===',
      `Timestamp: ${new Date().toISOString()}`,
      `Platform: ${process.platform} (${process.arch})`,
      `Workspace Trusted: ${vscode.workspace.isTrusted}`,
      `cloudflared: ${bin ? `${bin.version} (${bin.source} @ ${bin.binaryPath})` : 'Not installed'}`,
      `Detected Projects: ${det.projects.map((p) => `${p.name} [${p.frameworkLabel}]`).join(', ') || 'None'}`,
      `Detected Servers: ${det.servers.map((s) => `${s.name} (:${s.port} ${s.health})`).join(', ') || 'None'}`,
      `Active Shares: ${tunnelManager.listShares().length}`,
      `Preview Password Enabled: ${hasPreviewPassword}`,
      `Cloudflare Account: ${acct ? `${acct.name} (${acct.id})` : 'Not connected'}`,
      `LocalShare Cloud: ${cloudConnected ? 'Connected' : 'Local-only'}`,
    ].join('\n');

    logger.info(report);
    outputChannel.show(true);
    vscode.window.showInformationMessage(
      `LocalShare Diagnostics: ${det.servers.filter((s) => s.shareable).length} shareable server(s), cloudflared ${bin ? bin.version : 'not installed'}. See Output for full report.`,
    );
  });

  register('localshare.showLogs', () => {
    outputChannel.show(true);
  });

  register('localshare.showAuditLog', async () => {
    const entries = auditLog.list();
    const content =
      entries.length === 0
        ? 'No security audit events recorded in this session yet.'
        : entries
            .map(
              (e) =>
                `${e.timestamp}  [${e.action}]  ${e.summary}${e.details ? `  ${JSON.stringify(e.details)}` : ''}`,
            )
            .join('\n');
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: 'log',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  register('localshare.openSettings', () => {
    void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:localshare.localshare-vscode');
  });

  // ---------------------------------------------------------------------------
  // Phase 7: Cloudflare Account, Named Tunnels & Custom Domains
  // ---------------------------------------------------------------------------

  const connectOrRotateCloudflare = async (isRotate: boolean) => {
    const token = await vscode.window.showInputBox({
      prompt: isRotate
        ? 'Enter your new Cloudflare API Token (Account:Cloudflare Tunnel:Edit, Zone:DNS:Edit)'
        : 'Enter a Cloudflare API Token with Cloudflare Tunnel:Edit and DNS:Edit permissions',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token?.trim()) return;

    const clean = token.trim();
    logger.registerSecret(clean);
    await context.secrets.store(SECRET_CF_API_TOKEN, clean);

    try {
      const { accounts } = await cfApi.verifyTokenAndListAccounts();
      if (accounts.length === 0) {
        throw new LocalShareError(
          'CLOUDFLARE_AUTH_FAILED',
          'Token is valid, but has no accessible Cloudflare accounts.',
        );
      }
      let chosen = accounts[0]!;
      if (accounts.length > 1) {
        const picked = await vscode.window.showQuickPick(
          accounts.map((a) => ({ label: a.name, description: a.id, account: a })),
          { placeHolder: 'Select the Cloudflare account to use with LocalShare' },
        );
        if (!picked) return;
        chosen = picked.account;
      }

      await context.globalState.update(STATE_CF_ACCOUNT, chosen);
      namedTunnels = await cfApi.listNamedTunnels(chosen.id).catch(() => []);
      auditLog.record(
        isRotate ? 'cloudflare.token.rotated' : 'cloudflare.connected',
        `${isRotate ? 'Rotated token for' : 'Connected'} Cloudflare account "${chosen.name}" (${chosen.id})`,
      );
      refreshAllTrees();
      vscode.window.showInformationMessage(
        `LocalShare: Connected to Cloudflare account "${chosen.name}".`,
      );
    } catch (err) {
      await context.secrets.delete(SECRET_CF_API_TOKEN);
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  };

  register('localshare.connectCloudflare', () => connectOrRotateCloudflare(false));
  register('localshare.rotateCloudflareToken', () => connectOrRotateCloudflare(true));

  register('localshare.disconnectCloudflare', async () => {
    const confirm = await vscode.window.showWarningMessage(
      'Disconnect Cloudflare account and remove the stored API token from SecretStorage?',
      { modal: true },
      'Disconnect',
    );
    if (confirm !== 'Disconnect') return;
    await context.secrets.delete(SECRET_CF_API_TOKEN);
    await context.globalState.update(STATE_CF_ACCOUNT, undefined);
    namedTunnels = [];
    auditLog.record('cloudflare.disconnected', 'Disconnected Cloudflare account');
    refreshAllTrees();
    vscode.window.showInformationMessage('LocalShare: Disconnected Cloudflare account.');
  });

  register('localshare.addCustomDomain', async () => {
    if (getActiveProvider().id === 'localshare') {
      const subInput = await vscode.window.showInputBox({
        prompt: 'Enter your custom subdomain on lorndavid.online (no Cloudflare token needed!)',
        placeHolder: 'demo  (creates https://demo.lorndavid.online)',
        validateInput: (v) => {
          const clean = v.trim().toLowerCase().replace(/\.lorndavid\.online$/, '');
          if (!/^[a-z0-9-]{3,40}$/.test(clean)) {
            return 'Subdomain must be 3-40 lowercase letters, numbers, or hyphens.';
          }
          if (['cloud', 'api', 'www', 'admin'].includes(clean)) {
            return `"${clean}" is a reserved system subdomain.`;
          }
          return undefined;
        },
      });
      if (!subInput) return;
      const cleanSub = subInput.trim().toLowerCase().replace(/\.lorndavid\.online$/, '');
      const fullHostname = `${cleanSub}.lorndavid.online`;

      const rawPort = await vscode.window.showInputBox({
        prompt: `Local port that https://${fullHostname} should forward to`,
        value: String(servers.find((s) => s.shareable)?.port ?? 4500),
        validateInput: (v) => {
          const r = validatePort(v);
          return r.ok ? undefined : r.error;
        },
      });
      if (!rawPort) return;
      const portRes = validatePort(rawPort);
      if (!portRes.ok) return;

      await runStartShareFlow({
        name: fullHostname,
        host: 'localhost',
        port: portRes.value,
        hostname: cleanSub,
      });
      return;
    }

    let account = getSavedAccount();
    if (!account) {
      await connectOrRotateCloudflare(false);
      account = getSavedAccount();
      if (!account) return;
    }

    try {
      // Step 1: Select or create a Named Tunnel
      const existingTunnels = await cfApi.listNamedTunnels(account.id);
      namedTunnels = existingTunnels;
      const createOption = {
        label: '$(add) Create a New Named Tunnel…',
        description: 'Provision a new Cloudflare Named Tunnel',
        tunnel: undefined as CloudflareNamedTunnel | undefined,
      };
      const pickedTunnel = await vscode.window.showQuickPick(
        [
          createOption,
          ...existingTunnels.map((t) => ({
            label: t.name,
            description: `${t.id} (${t.status})`,
            tunnel: t as CloudflareNamedTunnel | undefined,
          })),
        ],
        { placeHolder: 'Step 1/4: Select or create a Cloudflare Named Tunnel' },
      );
      if (!pickedTunnel) return;

      let tunnel = pickedTunnel.tunnel;
      if (!tunnel) {
        const newName = await vscode.window.showInputBox({
          prompt: 'Enter a name for the new Named Tunnel',
          value: `localshare-${projects[0]?.name?.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'dev'}`,
          validateInput: (v) => {
            const r = validateTunnelName(v);
            return r.ok ? undefined : r.error;
          },
        });
        if (!newName) return;
        tunnel = await cfApi.createNamedTunnel(account.id, newName);
        namedTunnels = await cfApi.listNamedTunnels(account.id).catch(() => [tunnel!]);
        auditLog.record(
          'namedTunnel.created',
          `Created Cloudflare Named Tunnel "${tunnel.name}" (${tunnel.id})`,
        );
      }

      // Step 2: Enter & validate custom hostname
      const rawHostname = await vscode.window.showInputBox({
        prompt: 'Step 2/4: Enter the custom hostname you own (e.g. preview.customer.com)',
        placeHolder: 'preview.customer.com',
        validateInput: (v) => {
          const r = validateHostname(v);
          return r.ok ? undefined : r.error;
        },
      });
      if (!rawHostname) return;
      const validHost = validateHostname(rawHostname);
      if (!validHost.ok) return;
      const hostname = validHost.value;

      // Step 3: Select local port to route to
      const rawPort = await vscode.window.showInputBox({
        prompt: `Step 3/4: Local port that ${hostname} should forward to`,
        value: String(servers.find((s) => s.shareable)?.port ?? 3000),
        validateInput: (v) => {
          const r = validatePort(v);
          return r.ok ? undefined : r.error;
        },
      });
      if (!rawPort) return;
      const portRes = validatePort(rawPort);
      if (!portRes.ok) return;

      // Step 4: Optional Cloudflare Access protection
      const accessPick = await vscode.window.showQuickPick(
        [
          {
            label: 'Public HTTPS Hostname',
            description: 'Anyone who knows the hostname can view while the tunnel runs',
            mode: 'PUBLIC' as const,
          },
          {
            label: 'Cloudflare Access Policy (Identity Restricted)',
            description: 'Require visitors to sign in with an allowed email or email domain',
            mode: 'CLOUDFLARE_ACCESS' as const,
          },
          {
            label: 'Local Preview Password',
            description: 'Require the LocalShare preview password',
            mode: 'PASSWORD' as const,
          },
        ],
        { placeHolder: 'Step 4/4: Choose access control for this custom domain' },
      );
      if (!accessPick) return;

      const allowedEmails: string[] = [];
      const allowedDomains: string[] = [];
      if (accessPick.mode === 'CLOUDFLARE_ACCESS') {
        const rawList = await vscode.window.showInputBox({
          prompt:
            'Enter allowed emails or @domains separated by commas (e.g. alice@customer.com, @customer.com)',
          placeHolder: 'alice@customer.com, @customer.com',
        });
        if (!rawList) return;
        for (const item of rawList.split(',').map((s) => s.trim()).filter(Boolean)) {
          if (item.startsWith('@') || !item.includes('@')) {
            const d = validateEmailDomain(item);
            if (!d.ok) throw new LocalShareError('INVALID_HOSTNAME', d.error);
            allowedDomains.push(d.value);
          } else {
            const e = validateEmail(item);
            if (!e.ok) throw new LocalShareError('INVALID_HOSTNAME', e.error);
            allowedEmails.push(e.value);
          }
        }
      }

      // Check zone ownership & present DNS instruction
      const zone = await cfApi.findZoneForHostname(hostname).catch(() => undefined);
      const instruction = cfApi.buildDnsInstruction(hostname, tunnel.id, zone);

      await cfApi.configureTunnelIngress(
        account.id,
        tunnel.id,
        hostname,
        'localhost',
        portRes.value,
      );

      if (zone) {
        const dnsConfirm = await vscode.window.showWarningMessage(
          `Authorize DNS change in Cloudflare zone "${zone.name}"?\n\nRecord: CNAME ${instruction.name} → ${instruction.target} (Proxied)`,
          { modal: true },
          'Configure DNS Automatically',
          'I Will Configure DNS Manually',
        );
        if (!dnsConfirm) return;
        if (dnsConfirm === 'Configure DNS Automatically') {
          await cfApi.upsertTunnelCnameRecord(zone.id, hostname, tunnel.id);
          auditLog.record(
            'domain.dns.configured',
            `Configured CNAME ${hostname} -> ${instruction.target} in zone ${zone.name}`,
          );
        } else {
          await vscode.env.clipboard.writeText(`${instruction.name} CNAME ${instruction.target}`);
          vscode.window.showInformationMessage(
            `Manual DNS: Create a CNAME record "${instruction.name}" pointing to "${instruction.target}" (copied to clipboard), then click Verify Domain.`,
          );
        }
      } else {
        await vscode.env.clipboard.writeText(`${instruction.name} CNAME ${instruction.target}`);
        vscode.window.showWarningMessage(
          `Zone for "${hostname}" was not found in your Cloudflare account. Create CNAME "${instruction.name}" → "${instruction.target}" manually at your DNS provider (copied to clipboard), then run Verify Domain.`,
        );
      }

      if (accessPick.mode === 'CLOUDFLARE_ACCESS') {
        await cfApi.configureAccessPolicy(account.id, hostname, {
          allowedEmails,
          allowedEmailDomains: allowedDomains,
          sessionDurationHours: getCfg().get<number>('security.passwordSessionHours', 12),
        });
      }

      // Save domain record (never claim VERIFIED_HTTPS before actual verification!)
      const domains = loadCustomDomains().filter(
        (d) => d.hostname.toLowerCase() !== hostname.toLowerCase(),
      );
      const record: SavedCustomDomain = {
        id: randomUUID(),
        hostname,
        tunnelId: tunnel.id,
        tunnelName: tunnel.name,
        accountId: account.id,
        ...(zone ? { zoneId: zone.id, zoneName: zone.name } : {}),
        cnameTarget: instruction.target,
        localHost: 'localhost',
        localPort: portRes.value,
        accessMode: accessPick.mode,
        ...(allowedEmails.length > 0 ? { allowedEmails } : {}),
        ...(allowedDomains.length > 0 ? { allowedEmailDomains: allowedDomains } : {}),
        status: 'PENDING_DNS',
      };
      domains.push(record);
      await saveCustomDomains(domains);
      refreshAllTrees();

      // Offer to start the named tunnel and verify readiness
      const startNow = await vscode.window.showInformationMessage(
        `Configured ${hostname} → localhost:${portRes.value}. Start the Named Tunnel and verify DNS/HTTPS readiness now?`,
        'Start & Verify',
        'Verify Only',
      );
      if (startNow === 'Start & Verify') {
        const token = await cfApi.getNamedTunnelToken(account.id, tunnel.id);
        await tunnelManager.startShare({
          name: hostname,
          host: 'localhost',
          port: portRes.value,
          kind: 'NAMED',
          accessMode: accessPick.mode,
          hostname,
          tunnelToken: token,
          namedTunnelId: tunnel.id,
        });
      }
      if (startNow === 'Start & Verify' || startNow === 'Verify Only') {
        await vscode.commands.executeCommand(
          'localshare.verifyCustomDomain',
          new CustomDomainTreeItem(record),
        );
      }
    } catch (err) {
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  });

  register('localshare.verifyCustomDomain', async (arg?: unknown) => {
    const domains = loadCustomDomains();
    const target =
      arg instanceof CustomDomainTreeItem
        ? domains.find((d) => d.id === arg.domain.id)
        : domains[0];
    if (!target) return;

    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `LocalShare: Verifying DNS and HTTPS for ${target.hostname}…`,
      },
      () => cfApi.verifyCustomDomainReadiness(target.hostname, target.tunnelId),
    );

    target.lastVerifiedAt = new Date().toISOString();
    target.lastError = report.error;
    if (report.dnsResolved && report.httpsReady) {
      target.status = 'VERIFIED_HTTPS';
      auditLog.record(
        'domain.verified',
        `Verified DNS and HTTPS readiness for ${target.hostname} (HTTP ${report.httpsStatus ?? 200})`,
      );
      vscode.window.showInformationMessage(
        `LocalShare: https://${target.hostname} is verified and reachable (HTTP ${report.httpsStatus ?? 200}).`,
      );
    } else if (report.dnsResolved) {
      target.status = 'DNS_RESOLVED';
      vscode.window.showWarningMessage(
        `LocalShare: DNS for ${target.hostname} resolves (${report.dnsRecords.join(', ')}), but HTTPS is not ready yet: ${report.error ?? 'Start the tunnel connector and wait for SSL provisioning.'}`,
      );
    } else {
      target.status = 'PENDING_DNS';
      vscode.window.showWarningMessage(
        `LocalShare: ${report.error ?? `DNS for ${target.hostname} has not propagated yet.`}`,
      );
    }
    await saveCustomDomains(domains);
    refreshAllTrees();
  });

  register('localshare.removeCustomDomain', async (arg?: unknown) => {
    if (!(arg instanceof CustomDomainTreeItem)) return;
    const d = arg.domain;
    const choice = await vscode.window.showWarningMessage(
      `Remove custom domain "${d.hostname}" from LocalShare?`,
      { modal: true },
      'Remove & Delete DNS Record',
      'Remove from List Only',
    );
    if (!choice) return;
    if (choice === 'Remove & Delete DNS Record' && d.zoneId) {
      await cfApi.deleteTunnelCnameRecord(d.zoneId, d.hostname, d.tunnelId).catch(() => false);
    }
    const next = loadCustomDomains().filter((item) => item.id !== d.id);
    await saveCustomDomains(next);
    auditLog.record('domain.removed', `Removed custom domain ${d.hostname}`);
    refreshAllTrees();
  });

  register('localshare.copyDomainUrl', async (arg?: unknown) => {
    if (!(arg instanceof CustomDomainTreeItem)) return;
    const url = `https://${arg.domain.hostname}`;
    await vscode.env.clipboard.writeText(url);
    vscode.window.showInformationMessage(`Copied ${url} to clipboard.`);
  });

  register('localshare.openDomainUrl', async (arg?: unknown) => {
    if (!(arg instanceof CustomDomainTreeItem)) return;
    await vscode.env.openExternal(vscode.Uri.parse(`https://${arg.domain.hostname}`));
  });

  register('localshare.startNamedTunnel', async (arg?: unknown) => {
    if (!(arg instanceof NamedTunnelTreeItem)) return;
    const acct = getSavedAccount();
    if (!acct) return;
    const linkedDomain = loadCustomDomains().find((d) => d.tunnelId === arg.tunnel.id);
    const hostname =
      linkedDomain?.hostname ??
      (await vscode.window.showInputBox({
        prompt: `Hostname routed to tunnel "${arg.tunnel.name}"`,
        placeHolder: 'preview.customer.com',
      }));
    if (!hostname) return;
    const port = linkedDomain?.localPort ?? (servers.find((s) => s.shareable)?.port ?? 3000);
    const confirmed = await confirmExposure('localhost', port, hostname, true);
    if (!confirmed) return;

    try {
      const token = await cfApi.getNamedTunnelToken(acct.id, arg.tunnel.id);
      await tunnelManager.startShare({
        name: hostname,
        host: 'localhost',
        port,
        kind: 'NAMED',
        accessMode: linkedDomain?.accessMode ?? 'PUBLIC',
        hostname,
        tunnelToken: token,
        namedTunnelId: arg.tunnel.id,
      });
    } catch (err) {
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  });

  register('localshare.deleteNamedTunnel', async (arg?: unknown) => {
    if (!(arg instanceof NamedTunnelTreeItem)) return;
    const acct = getSavedAccount();
    if (!acct) return;
    const confirm = await vscode.window.showWarningMessage(
      `Permanently delete Named Tunnel "${arg.tunnel.name}" from your Cloudflare account?`,
      { modal: true },
      'Delete Tunnel',
    );
    if (confirm !== 'Delete Tunnel') return;
    try {
      await cfApi.deleteNamedTunnel(acct.id, arg.tunnel.id);
      namedTunnels = namedTunnels.filter((t) => t.id !== arg.tunnel.id);
      auditLog.record(
        'namedTunnel.deleted',
        `Deleted Named Tunnel "${arg.tunnel.name}" (${arg.tunnel.id})`,
      );
      refreshAllTrees();
    } catch (err) {
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Optional LocalShare Cloud commands
  // ---------------------------------------------------------------------------

  register('localshare.connectCloud', async () => {
    const apiUrl = await vscode.window.showInputBox({
      prompt: 'Enter your LocalShare Cloud API URL',
      value: getCfg().get<string>('cloud.apiUrl', '') || 'https://cloud.lorndavid.online/api/v1',
    });
    if (!apiUrl) return;

    const apiToken = await vscode.window.showInputBox({
      prompt: 'Enter your LocalShare Personal API Token (starts with lst_)',
      password: true,
    });
    if (!apiToken) return;

    await getCfg().update('cloud.apiUrl', apiUrl.trim(), vscode.ConfigurationTarget.Global);
    await context.secrets.store(SECRET_CLOUD_API_TOKEN, apiToken.trim());
    logger.registerSecret(apiToken.trim());

    try {
      const client = createCloudClient();
      const orgs = await client.verifyConnection();
      if (orgs.length > 0) {
        const chosen =
          orgs.length === 1
            ? orgs[0]!
            : (
                await vscode.window.showQuickPick(
                  orgs.map((o) => ({ label: o.name, description: `${o.slug} (${o.role})`, org: o })),
                  { placeHolder: 'Select the LocalShare Cloud organization to sync with' },
                )
              )?.org;
        if (chosen) {
          await getCfg().update(
            'cloud.organizationId',
            chosen.id,
            vscode.ConfigurationTarget.Global,
          );
        }
      }
      cloudConnected = true;
      refreshAllTrees();
      vscode.window.showInformationMessage('LocalShare: Connected to LocalShare Cloud.');
    } catch (err) {
      vscode.window.showErrorMessage(`LocalShare: ${toErrorMessage(err)}`);
    }
  });

  register('localshare.disconnectCloud', async () => {
    await context.secrets.delete(SECRET_CLOUD_API_TOKEN);
    cloudConnected = false;
    refreshAllTrees();
    vscode.window.showInformationMessage('LocalShare: Disconnected from LocalShare Cloud.');
  });

  register('localshare.syncCloud', async () => {
    const client = createCloudClient();
    const shares = tunnelManager.listShares();
    for (const s of shares) {
      await client.syncShare(s);
    }
    vscode.window.showInformationMessage(
      `LocalShare: Synced ${shares.length} active share(s) with LocalShare Cloud.`,
    );
  });

  // ---------------------------------------------------------------------------
  // Lifecycle, config watchers & background initialization
  // ---------------------------------------------------------------------------

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localshare')) {
        logger.setLevel(getCfg().get<LogLevel>('logLevel', 'info'));
        void refreshDetection();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshDetection();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void refreshDetection();
    }),
    {
      dispose: () => {
        void tunnelManager.stopAllShares();
      },
    },
  );

  // Periodic server detection when sidebar is visible
  const intervalSec = Math.max(5, getCfg().get<number>('detection.refreshIntervalSeconds', 15));
  const autoTimer = setInterval(() => {
    if (!getCfg().get<boolean>('detection.autoRefresh', true)) return;
    if (views.some((v) => v.visible)) {
      void refreshDetection();
    }
  }, intervalSec * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(autoTimer) });

  // Non-blocking startup tasks
  void (async () => {
    const recovered = await tunnelManager.initializeSessionRecovery();
    if (recovered.length > 0) {
      vscode.window.showInformationMessage(
        `LocalShare: Cleaned up ${recovered.length} tunnel session(s) from a previous VS Code window. Click Start Sharing to reconnect.`,
      );
    }
    binaryInfo = await createBinaryManager().resolveExistingBinary().catch(() => undefined);
    const savedAcct = getSavedAccount();
    if (savedAcct && (await context.secrets.get(SECRET_CF_API_TOKEN))) {
      namedTunnels = await cfApi.listNamedTunnels(savedAcct.id).catch(() => []);
    }
    await refreshDetection();
  })();

  return {
    tunnelManager,
    auditLog,
    logger,
    refreshDetection,
    getViewState,
  };
}

export async function deactivate(): Promise<void> {
  // TunnelManager disposal is registered in context.subscriptions.
}
