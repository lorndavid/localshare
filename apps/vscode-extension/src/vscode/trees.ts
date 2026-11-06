/**
 * Native VS Code TreeView providers for the 6 LocalShare sidebar sections:
 *   1. WORKSPACE
 *   2. LOCAL SERVERS
 *   3. ACTIVE SHARES
 *   4. CUSTOM DOMAINS
 *   5. SECURITY
 *   6. SETTINGS
 */
import * as vscode from 'vscode';
import { formatHostPort } from '@localshare/validation';
import type { SavedCustomDomain } from '../core/customDomains';
import type { DetectedProject, DetectedServer } from '../core/detection';
import type { CloudflareAccount, CloudflareNamedTunnel } from '../core/providers/cloudflareApi';
import {
  formatUptime,
  type ActiveShare,
  type ShareHistoryEntry,
} from '../core/tunnelManager';

export interface ExtensionViewState {
  workspaceTrusted: boolean;
  workspaceFolders: readonly string[];
  projects: readonly DetectedProject[];
  servers: readonly DetectedServer[];
  shares: readonly ActiveShare[];
  history: readonly ShareHistoryEntry[];
  customDomains: readonly SavedCustomDomain[];
  namedTunnels: readonly CloudflareNamedTunnel[];
  cloudflareAccount?: CloudflareAccount;
  binaryInfo?: { binaryPath: string; version: string; source: string };
  hasPreviewPassword: boolean;
  gatewayUsername?: string;
  confirmBeforeSharing: boolean;
  allowLanTargets: boolean;
  cloudConnected: boolean;
}

abstract class BaseTreeProvider<T extends vscode.TreeItem> implements vscode.TreeDataProvider<T> {
  private readonly emitter = new vscode.EventEmitter<T | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: T): vscode.TreeItem {
    return element;
  }

  abstract getChildren(element?: T): vscode.ProviderResult<T[]>;
}

// ---------------------------------------------------------------------------
// 1. WORKSPACE VIEW
// ---------------------------------------------------------------------------

export class WorkspaceTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
  constructor(private readonly getState: () => ExtensionViewState) {
    super();
  }

  getChildren(): vscode.TreeItem[] {
    const st = this.getState();
    const items: vscode.TreeItem[] = [];

    const primaryAction = new vscode.TreeItem('+ Start Sharing', vscode.TreeItemCollapsibleState.None);
    primaryAction.iconPath = new vscode.ThemeIcon('broadcast', new vscode.ThemeColor('charts.green'));
    primaryAction.description = 'Expose a local server via HTTPS';
    primaryAction.tooltip = 'Select a detected server or enter a port to start sharing';
    primaryAction.command = {
      command: 'localshare.startSharing',
      title: 'Start Sharing',
    };
    items.push(primaryAction);

    const projectName =
      st.projects[0]?.name ??
      (st.workspaceFolders[0] ? st.workspaceFolders[0].split(/[\\/]/).pop() : 'No Folder Open');
    const frameworks = [...new Set(st.projects.map((p) => p.frameworkLabel))].join(', ') || 'Generic';

    const projItem = new vscode.TreeItem(
      `Project: ${projectName}`,
      vscode.TreeItemCollapsibleState.None,
    );
    projItem.description = frameworks;
    projItem.iconPath = new vscode.ThemeIcon('folder-active');
    projItem.tooltip = st.workspaceFolders.join('\n') || 'Open a folder to enable automatic framework detection.';
    items.push(projItem);

    const activeCount = st.shares.filter((s) => s.state === 'ONLINE').length;
    const shareableCount = st.servers.filter((s) => s.shareable).length;
    const statusItem = new vscode.TreeItem(
      `Status: ${activeCount > 0 ? `${activeCount} Active Share${activeCount === 1 ? '' : 's'}` : 'Idle'}`,
      vscode.TreeItemCollapsibleState.None,
    );
    statusItem.description = `${shareableCount} server${shareableCount === 1 ? '' : 's'} ready`;
    statusItem.iconPath = new vscode.ThemeIcon(
      activeCount > 0 ? 'pass-filled' : 'circle-large-outline',
      activeCount > 0 ? new vscode.ThemeColor('charts.green') : undefined,
    );
    items.push(statusItem);

    if (!st.workspaceTrusted) {
      const warn = new vscode.TreeItem(
        'Untrusted Workspace (Manual Ports Only)',
        vscode.TreeItemCollapsibleState.None,
      );
      warn.iconPath = new vscode.ThemeIcon('shield', new vscode.ThemeColor('charts.yellow'));
      items.push(warn);
    }

    return items;
  }
}

// ---------------------------------------------------------------------------
// 2. LOCAL SERVERS VIEW
// ---------------------------------------------------------------------------

export class ServerTreeItem extends vscode.TreeItem {
  constructor(readonly server: DetectedServer, readonly isAlreadyShared: boolean) {
    super(server.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${server.frameworkLabel} • :${server.port}`;

    if (server.health === 'blocked-sensitive') {
      this.iconPath = new vscode.ThemeIcon('shield', new vscode.ThemeColor('charts.red'));
      this.description += ` • Blocked (${server.sensitiveReason ?? 'Sensitive'})`;
      this.contextValue = 'server.blocked';
    } else if (isAlreadyShared) {
      this.iconPath = new vscode.ThemeIcon('broadcast', new vscode.ThemeColor('charts.green'));
      this.description += ' • Sharing';
      this.contextValue = 'server.shared';
    } else if (server.shareable) {
      this.iconPath = new vscode.ThemeIcon(
        server.health === 'healthy-http' ? 'globe' : 'plug',
        new vscode.ThemeColor('charts.green'),
      );
      this.description += server.health === 'healthy-http' ? ' • HTTP Ready' : ' • TCP Ready';
      this.contextValue = 'server.shareable';
      this.command = {
        command: 'localshare.startSharingServer',
        title: 'Start Sharing',
        arguments: [this],
      };
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
      this.description += ' • Offline';
      this.contextValue = 'server.offline';
    }

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${server.name}** (${server.frameworkLabel})\n\n`);
    md.appendMarkdown(`- **Local Target:** \`localhost:${server.port}\`\n`);
    md.appendMarkdown(`- **Listeners:** \`${server.addresses.join(', ')}\`\n`);
    if (server.processName) {
      md.appendMarkdown(`- **Process:** \`${server.processName}\` (PID ${server.pid ?? '—'})\n`);
    }
    if (server.sensitiveReason) {
      md.appendMarkdown(`\n$(shield) Blocked by default: **${server.sensitiveReason}**`);
    }
    this.tooltip = md;
  }
}

export class ServersTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
  constructor(private readonly getState: () => ExtensionViewState) {
    super();
  }

  getChildren(): vscode.TreeItem[] {
    const st = this.getState();
    const sharedPorts = new Set(
      st.shares.filter((s) => s.state !== 'STOPPED').map((s) => s.port),
    );
    return st.servers.map((srv) => new ServerTreeItem(srv, sharedPorts.has(srv.port)));
  }
}

// ---------------------------------------------------------------------------
// 3. ACTIVE SHARES (+ HISTORY) VIEW
// ---------------------------------------------------------------------------

export class ShareTreeItem extends vscode.TreeItem {
  constructor(readonly share: ActiveShare) {
    super(share.name, vscode.TreeItemCollapsibleState.None);

    const target = formatHostPort(share.host, share.port);
    const uptime = formatUptime(share.startedAt);
    const accessBadge =
      share.accessMode === 'PASSWORD'
        ? '🔒 Password'
        : share.accessMode === 'CLOUDFLARE_ACCESS'
          ? '🛡️ Access'
          : '🌐 Public';
    const kindBadge = share.kind === 'QUICK' ? 'Temp' : 'Custom Domain';

    this.description = `${target} → ${share.publicUrl ?? share.state} • ${accessBadge} (${kindBadge})`;

    if (share.state === 'ONLINE') {
      this.iconPath = new vscode.ThemeIcon(
        share.localTargetHealthy ? 'radio-tower' : 'warning',
        new vscode.ThemeColor(share.localTargetHealthy ? 'charts.green' : 'charts.yellow'),
      );
    } else if (share.state === 'STARTING' || share.state === 'CONNECTING' || share.state === 'RECONNECTING') {
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    } else if (share.state === 'ERROR') {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    }

    const tags = ['share', share.state.toLowerCase()];
    if (share.publicUrl) tags.push('hasUrl');
    if (share.state !== 'STOPPED') tags.push('running');
    this.contextValue = tags.join('.');

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${share.name}** (${share.frameworkLabel})\n\n`);
    if (share.description) md.appendMarkdown(`${share.description}\n\n`);
    md.appendMarkdown(`- **Local Target:** \`${target}\` (${share.localTargetHealthy ? 'Healthy' : 'Local server unreachable!'})\n`);
    md.appendMarkdown(`- **Public URL:** ${share.publicUrl ? `[${share.publicUrl}](${share.publicUrl})` : '_Connecting…_'}\n`);
    md.appendMarkdown(`- **State:** \`${share.state}\` • **Uptime:** ${uptime}\n`);
    md.appendMarkdown(`- **Type:** ${share.kind === 'QUICK' ? 'Temporary Quick Tunnel (expires when stopped)' : 'Persistent Named Tunnel'}\n`);
    md.appendMarkdown(`- **Access:** ${accessBadge}\n`);
    if (share.group) md.appendMarkdown(`- **Group:** \`${share.group}\`\n`);
    if (share.lastError) md.appendMarkdown(`\n**Last Error:** ${share.lastError}\n`);
    this.tooltip = md;
  }
}

export class HistoryTreeItem extends vscode.TreeItem {
  constructor(readonly entry: ShareHistoryEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${entry.host}:${entry.port} • Recent (${entry.frameworkLabel})`;
    this.iconPath = new vscode.ThemeIcon('history');
    this.contextValue = 'history';
    this.tooltip = `Click to re-share ${entry.host}:${entry.port} (${entry.name})`;
    this.command = {
      command: 'localshare.reshareFromHistory',
      title: 'Share Again',
      arguments: [this],
    };
  }
}

class ShareGroupHeaderItem extends vscode.TreeItem {
  constructor(
    readonly groupName: string,
    readonly children: vscode.TreeItem[],
  ) {
    super(groupName, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('layers');
    this.description = `${children.length}`;
  }
}

export class SharesTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
  constructor(private readonly getState: () => ExtensionViewState) {
    super();
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof ShareGroupHeaderItem) {
      return element.children;
    }

    const st = this.getState();
    const items: vscode.TreeItem[] = [];

    const grouped = new Map<string, ShareTreeItem[]>();
    const ungrouped: ShareTreeItem[] = [];

    for (const s of st.shares) {
      const item = new ShareTreeItem(s);
      if (s.group) {
        const list = grouped.get(s.group) ?? [];
        list.push(item);
        grouped.set(s.group, list);
      } else {
        ungrouped.push(item);
      }
    }

    for (const [grp, list] of grouped.entries()) {
      items.push(new ShareGroupHeaderItem(`Group: ${grp}`, list));
    }
    items.push(...ungrouped);

    const activePorts = new Set(st.shares.map((s) => s.port));
    const inactiveHistory = st.history
      .filter((h) => !activePorts.has(h.port))
      .slice(0, 6)
      .map((h) => new HistoryTreeItem(h));

    if (inactiveHistory.length > 0 && st.shares.length > 0) {
      items.push(new ShareGroupHeaderItem('Recent Shares', inactiveHistory));
    } else if (inactiveHistory.length > 0 && st.shares.length === 0) {
      items.push(...inactiveHistory);
    }

    return items;
  }
}

// ---------------------------------------------------------------------------
// 4. CUSTOM DOMAINS & NAMED TUNNELS VIEW
// ---------------------------------------------------------------------------

export class CustomDomainTreeItem extends vscode.TreeItem {
  constructor(readonly domain: SavedCustomDomain) {
    super(domain.hostname, vscode.TreeItemCollapsibleState.None);
    const statusLabel =
      domain.status === 'VERIFIED_HTTPS'
        ? 'Verified HTTPS'
        : domain.status === 'DNS_RESOLVED'
          ? 'DNS Resolved (Await HTTPS)'
          : domain.status === 'ERROR'
            ? 'Verification Failed'
            : 'Pending DNS Verification';

    this.description = `→ ${domain.localHost}:${domain.localPort} • ${statusLabel}`;
    this.iconPath = new vscode.ThemeIcon(
      domain.status === 'VERIFIED_HTTPS'
        ? 'verified-filled'
        : domain.status === 'DNS_RESOLVED'
          ? 'clock'
          : 'warning',
      new vscode.ThemeColor(
        domain.status === 'VERIFIED_HTTPS'
          ? 'charts.green'
          : domain.status === 'DNS_RESOLVED'
            ? 'charts.yellow'
            : 'charts.orange',
      ),
    );
    this.contextValue = `domain.${domain.status.toLowerCase()}`;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**https://${domain.hostname}**\n\n`);
    md.appendMarkdown(`- **Tunnel:** \`${domain.tunnelName}\` (\`${domain.tunnelId}\`)\n`);
    md.appendMarkdown(`- **Required DNS:** \`CNAME ${domain.hostname} → ${domain.cnameTarget}\` (Proxied)\n`);
    md.appendMarkdown(`- **Local Target:** \`${domain.localHost}:${domain.localPort}\`\n`);
    md.appendMarkdown(`- **Access Mode:** \`${domain.accessMode}\`\n`);
    md.appendMarkdown(`- **Status:** ${statusLabel}\n`);
    if (domain.lastError) md.appendMarkdown(`\n**Note:** ${domain.lastError}\n`);
    this.tooltip = md;
  }
}

export class NamedTunnelTreeItem extends vscode.TreeItem {
  constructor(
    readonly tunnel: CloudflareNamedTunnel,
    readonly isRunningLocally: boolean,
  ) {
    super(`Tunnel: ${tunnel.name}`, vscode.TreeItemCollapsibleState.None);
    this.description = isRunningLocally ? 'Running locally' : `Cloudflare (${tunnel.status})`;
    this.iconPath = new vscode.ThemeIcon(
      isRunningLocally ? 'plug' : 'cloud',
      isRunningLocally ? new vscode.ThemeColor('charts.green') : undefined,
    );
    this.contextValue = isRunningLocally ? 'namedTunnel.running' : 'namedTunnel.stopped';
    this.tooltip = `Named Tunnel ID: ${tunnel.id}\nCreated: ${tunnel.created_at}`;
  }
}

export class DomainsTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
  constructor(private readonly getState: () => ExtensionViewState) {
    super();
  }

  getChildren(): vscode.TreeItem[] {
    const st = this.getState();
    const items: vscode.TreeItem[] = [];

    const relaySubdomain = new vscode.TreeItem(
      'Share on *.lorndavid.online Subdomain…',
      vscode.TreeItemCollapsibleState.None,
    );
    relaySubdomain.iconPath = new vscode.ThemeIcon(
      'globe',
      new vscode.ThemeColor('charts.green'),
    );
    relaySubdomain.description = 'No token required';
    relaySubdomain.command = {
      command: 'localshare.addCustomDomain',
      title: 'Share on *.lorndavid.online Subdomain',
    };
    items.push(relaySubdomain);

    if (!st.cloudflareAccount) {
      const connect = new vscode.TreeItem(
        'Connect Cloudflare Account…',
        vscode.TreeItemCollapsibleState.None,
      );
      connect.iconPath = new vscode.ThemeIcon('plug');
      connect.description = 'Optional: for external custom domains';
      connect.command = {
        command: 'localshare.connectCloudflare',
        title: 'Connect Cloudflare Account',
      };
      items.push(connect);
    } else {
      const acct = new vscode.TreeItem(
        `Cloudflare: ${st.cloudflareAccount.name}`,
        vscode.TreeItemCollapsibleState.None,
      );
      acct.iconPath = new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.green'));
      acct.description = 'Connected';
      items.push(acct);
    }

    for (const d of st.customDomains) {
      items.push(new CustomDomainTreeItem(d));
    }

    const activeNamedIds = new Set(st.shares.map((s) => s.namedTunnelId).filter(Boolean));
    for (const t of st.namedTunnels) {
      items.push(new NamedTunnelTreeItem(t, activeNamedIds.has(t.id)));
    }

    return items;
  }
}

// ---------------------------------------------------------------------------
// 5. SECURITY VIEW
// ---------------------------------------------------------------------------

export class SecurityTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
  constructor(private readonly getState: () => ExtensionViewState) {
    super();
  }

  getChildren(): vscode.TreeItem[] {
    const st = this.getState();
    const items: vscode.TreeItem[] = [];

    const publicShares = st.shares.filter(
      (s) => s.state === 'ONLINE' && s.accessMode === 'PUBLIC',
    );
    const protectedShares = st.shares.filter(
      (s) => s.state === 'ONLINE' && s.accessMode !== 'PUBLIC',
    );

    const exposureItem = new vscode.TreeItem(
      publicShares.length > 0
        ? `Public Exposure: ${publicShares.length} Unauthenticated URL${publicShares.length === 1 ? '' : 's'}`
        : protectedShares.length > 0
          ? `Exposure: ${protectedShares.length} Protected Share${protectedShares.length === 1 ? '' : 's'}`
          : 'Public Exposure: None (Offline)',
      vscode.TreeItemCollapsibleState.None,
    );
    exposureItem.iconPath = new vscode.ThemeIcon(
      publicShares.length > 0 ? 'globe' : 'shield',
      new vscode.ThemeColor(
        publicShares.length > 0
          ? 'charts.orange'
          : protectedShares.length > 0
            ? 'charts.green'
            : 'disabledForeground',
      ),
    );
    exposureItem.tooltip =
      'Quick Tunnel URLs are random but public: anyone with the link can access them while active unless a preview password is set.';
    items.push(exposureItem);

    const pwdItem = new vscode.TreeItem(
      st.hasPreviewPassword
        ? `Preview Password: Enabled (user: ${st.gatewayUsername ?? 'preview'})`
        : 'Preview Password: Not Set (Public Links)',
      vscode.TreeItemCollapsibleState.None,
    );
    pwdItem.iconPath = new vscode.ThemeIcon(
      st.hasPreviewPassword ? 'lock' : 'unlock',
      st.hasPreviewPassword ? new vscode.ThemeColor('charts.green') : undefined,
    );
    pwdItem.description = st.hasPreviewPassword ? 'Click to change' : 'Click to enable';
    pwdItem.command = {
      command: 'localshare.setPassword',
      title: 'Set Preview Password',
    };
    items.push(pwdItem);

    if (st.hasPreviewPassword) {
      const clearPwd = new vscode.TreeItem(
        'Remove Preview Password',
        vscode.TreeItemCollapsibleState.None,
      );
      clearPwd.iconPath = new vscode.ThemeIcon('close');
      clearPwd.command = {
        command: 'localshare.clearPassword',
        title: 'Remove Preview Password',
      };
      items.push(clearPwd);
    }

    const confirmItem = new vscode.TreeItem(
      `Confirm Before Sharing: ${st.confirmBeforeSharing ? 'On' : 'Off'}`,
      vscode.TreeItemCollapsibleState.None,
    );
    confirmItem.iconPath = new vscode.ThemeIcon('check');
    items.push(confirmItem);

    const guardItem = new vscode.TreeItem(
      'Database & SSH Protection: Active',
      vscode.TreeItemCollapsibleState.None,
    );
    guardItem.description = 'Blocks Postgres, MySQL, Redis, Mongo, SSH, Docker';
    guardItem.iconPath = new vscode.ThemeIcon('shield', new vscode.ThemeColor('charts.green'));
    items.push(guardItem);

    if (st.allowLanTargets) {
      const lanWarn = new vscode.TreeItem(
        'Warning: LAN Target Sharing Enabled',
        vscode.TreeItemCollapsibleState.None,
      );
      lanWarn.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      items.push(lanWarn);
    }

    const auditItem = new vscode.TreeItem(
      'View Security Audit Log',
      vscode.TreeItemCollapsibleState.None,
    );
    auditItem.iconPath = new vscode.ThemeIcon('output');
    auditItem.command = {
      command: 'localshare.showAuditLog',
      title: 'Show Security Audit Log',
    };
    items.push(auditItem);

    return items;
  }
}

// ---------------------------------------------------------------------------
// 6. SETTINGS & DIAGNOSTICS VIEW
// ---------------------------------------------------------------------------

export class SettingsTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
  constructor(private readonly getState: () => ExtensionViewState) {
    super();
  }

  getChildren(): vscode.TreeItem[] {
    const st = this.getState();
    const items: vscode.TreeItem[] = [];

    const prov = new vscode.TreeItem('Tunnel Provider: Cloudflare', vscode.TreeItemCollapsibleState.None);
    prov.iconPath = new vscode.ThemeIcon('cloud');
    prov.description = st.binaryInfo
      ? `cloudflared ${st.binaryInfo.version} (${st.binaryInfo.source})`
      : 'cloudflared not installed yet';
    prov.command = {
      command: 'localshare.installCloudflared',
      title: 'Install or Update cloudflared',
    };
    items.push(prov);

    const cloudItem = new vscode.TreeItem(
      `LocalShare Cloud: ${st.cloudConnected ? 'Connected' : 'Local-Only Mode'}`,
      vscode.TreeItemCollapsibleState.None,
    );
    cloudItem.iconPath = new vscode.ThemeIcon(st.cloudConnected ? 'cloud-upload' : 'device-desktop');
    cloudItem.description = st.cloudConnected ? 'Syncing metadata' : 'Optional';
    cloudItem.command = {
      command: st.cloudConnected ? 'localshare.syncCloud' : 'localshare.connectCloud',
      title: st.cloudConnected ? 'Sync with LocalShare Cloud' : 'Connect LocalShare Cloud',
    };
    items.push(cloudItem);

    const diag = new vscode.TreeItem('Run Diagnostics', vscode.TreeItemCollapsibleState.None);
    diag.iconPath = new vscode.ThemeIcon('pulse');
    diag.command = {
      command: 'localshare.runDiagnostics',
      title: 'Run Diagnostics',
    };
    items.push(diag);

    const logs = new vscode.TreeItem('Open Extension Logs', vscode.TreeItemCollapsibleState.None);
    logs.iconPath = new vscode.ThemeIcon('output');
    logs.command = {
      command: 'localshare.showLogs',
      title: 'Show Logs',
    };
    items.push(logs);

    const prefs = new vscode.TreeItem('Configure Extension Settings…', vscode.TreeItemCollapsibleState.None);
    prefs.iconPath = new vscode.ThemeIcon('gear');
    prefs.command = {
      command: 'localshare.openSettings',
      title: 'Open Settings',
    };
    items.push(prefs);

    return items;
  }
}

