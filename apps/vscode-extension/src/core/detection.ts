/**
 * Smart workspace, framework, port, TCP listener and Docker Compose detection.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  detectNonHttpBanner,
  getSensitiveProcess,
  getSensitiveService,
  validatePort,
} from '@localshare/validation';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

export type FrameworkId =
  | 'nextjs'
  | 'nuxt'
  | 'vite'
  | 'react'
  | 'vue'
  | 'angular'
  | 'svelte'
  | 'nestjs'
  | 'express'
  | 'fastapi'
  | 'flask'
  | 'laravel'
  | 'docker'
  | 'node'
  | 'generic';

export interface DetectedProject {
  name: string;
  folderPath: string;
  framework: FrameworkId;
  frameworkLabel: string;
  candidatePorts: number[];
  scripts: Record<string, string>;
}

export interface TcpListenerInfo {
  port: number;
  addresses: string[];
  pid?: number;
  processName?: string;
}

export type ServerHealth = 'healthy-http' | 'healthy-tcp' | 'unreachable' | 'blocked-sensitive';

export interface DetectedServer {
  id: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  framework: FrameworkId;
  frameworkLabel: string;
  projectPath?: string;
  pid?: number;
  processName?: string;
  source: 'workspace' | 'listener' | 'docker' | 'extra';
  health: ServerHealth;
  httpStatus?: number;
  sensitiveReason?: string;
  shareable: boolean;
}

interface FrameworkRule {
  id: FrameworkId;
  label: string;
  defaultPort: number;
  deps: string[];
}

const NODE_FRAMEWORK_RULES: readonly FrameworkRule[] = [
  { id: 'nextjs', label: 'Next.js', defaultPort: 3000, deps: ['next'] },
  { id: 'nuxt', label: 'Nuxt', defaultPort: 3000, deps: ['nuxt', 'nuxt3'] },
  { id: 'angular', label: 'Angular', defaultPort: 4200, deps: ['@angular/core', '@angular/cli'] },
  { id: 'svelte', label: 'SvelteKit / Svelte', defaultPort: 5173, deps: ['@sveltejs/kit', 'svelte'] },
  { id: 'nestjs', label: 'NestJS', defaultPort: 3000, deps: ['@nestjs/core'] },
  { id: 'vite', label: 'Vite', defaultPort: 5173, deps: ['vite'] },
  { id: 'vue', label: 'Vue', defaultPort: 5173, deps: ['vue', '@vue/cli-service'] },
  { id: 'react', label: 'React', defaultPort: 3000, deps: ['react-scripts', 'react'] },
  { id: 'express', label: 'Express', defaultPort: 3000, deps: ['express'] },
];

export const COMMON_DEV_PORTS: readonly number[] = [
  3000, 3001, 4000, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8787, 8888, 9000,
];

/** Extract explicit port numbers from npm script commands or compose port strings. */
export function extractPortsFromScript(script: string): number[] {
  const ports = new Set<number>();
  const patterns = [
    /(?:--port|-p)\s*[= ]?\s*(\d{2,5})\b/gi,
    /\bPORT\s*=\s*(\d{2,5})\b/g,
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi,
    /--listen\s+(?:\S+:)?(\d{2,5})\b/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) {
      const v = validatePort(m[1]);
      if (v.ok) ports.add(v.value);
    }
  }
  return [...ports];
}

/** Detect framework and candidate ports from a parsed package.json object. */
export function detectFromPackageJson(
  pkg: Record<string, unknown>,
  folderPath: string,
): DetectedProject {
  const name =
    typeof pkg.name === 'string' && pkg.name.trim().length > 0
      ? pkg.name.trim()
      : path.basename(folderPath);
  const deps = {
    ...(typeof pkg.dependencies === 'object' && pkg.dependencies ? pkg.dependencies : {}),
    ...(typeof pkg.devDependencies === 'object' && pkg.devDependencies ? pkg.devDependencies : {}),
  } as Record<string, unknown>;
  const rawScripts =
    typeof pkg.scripts === 'object' && pkg.scripts ? (pkg.scripts as Record<string, unknown>) : {};
  const scripts: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawScripts)) {
    if (typeof v === 'string') scripts[k] = v;
  }

  let matched: FrameworkRule | undefined;
  // Refine Vite + React/Vue combinations so the label is informative.
  const hasVite = 'vite' in deps;
  const hasReact = 'react' in deps;
  const hasVue = 'vue' in deps;

  for (const rule of NODE_FRAMEWORK_RULES) {
    if (rule.deps.some((d) => d in deps)) {
      matched = rule;
      break;
    }
  }

  let framework: FrameworkId = matched?.id ?? 'node';
  let frameworkLabel = matched?.label ?? 'Node.js';
  let defaultPort = matched?.defaultPort ?? 3000;

  if (hasVite && hasReact && framework === 'vite') {
    framework = 'react';
    frameworkLabel = 'React (Vite)';
    defaultPort = 5173;
  } else if (hasVite && hasVue && framework === 'vite') {
    framework = 'vue';
    frameworkLabel = 'Vue (Vite)';
    defaultPort = 5173;
  } else if (framework === 'vue' && '@vue/cli-service' in deps && !hasVite) {
    defaultPort = 8080;
  }

  const candidatePorts = new Set<number>();
  for (const script of Object.values(scripts)) {
    for (const p of extractPortsFromScript(script)) candidatePorts.add(p);
  }
  candidatePorts.add(defaultPort);

  return {
    name,
    folderPath,
    framework,
    frameworkLabel,
    candidatePorts: [...candidatePorts],
    scripts,
  };
}

/** Parse host ports from a docker-compose.yml / compose.yaml text. */
export function parseDockerComposePorts(yamlText: string): Array<{ service: string; hostPort: number; containerPort: number }> {
  const results: Array<{ service: string; hostPort: number; containerPort: number }> = [];
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return results;
  }
  if (!doc || typeof doc !== 'object') return results;
  const services = (doc as Record<string, unknown>).services;
  if (!services || typeof services !== 'object') return results;

  for (const [serviceName, svc] of Object.entries(services as Record<string, unknown>)) {
    if (!svc || typeof svc !== 'object') continue;
    const ports = (svc as Record<string, unknown>).ports;
    if (!Array.isArray(ports)) continue;
    for (const entry of ports) {
      if (typeof entry === 'number') {
        const v = validatePort(entry);
        if (v.ok) results.push({ service: serviceName, hostPort: v.value, containerPort: v.value });
      } else if (typeof entry === 'string') {
        // Formats: "8080:80", "127.0.0.1:8080:80/tcp", "8080"
        const cleaned = entry.split('/')[0]?.trim() ?? '';
        const parts = cleaned.split(':');
        if (parts.length === 1) {
          const v = validatePort(parts[0]);
          if (v.ok) results.push({ service: serviceName, hostPort: v.value, containerPort: v.value });
        } else if (parts.length >= 2) {
          const hostPart = parts[parts.length - 2] ?? '';
          const containerPart = parts[parts.length - 1] ?? '';
          const hp = validatePort(hostPart);
          const cp = validatePort(containerPart);
          if (hp.ok && cp.ok) {
            results.push({ service: serviceName, hostPort: hp.value, containerPort: cp.value });
          }
        }
      } else if (entry && typeof entry === 'object') {
        const published = (entry as Record<string, unknown>).published;
        const target = (entry as Record<string, unknown>).target;
        const hp = validatePort(published);
        const cp = validatePort(target ?? published);
        if (hp.ok && cp.ok) {
          results.push({ service: serviceName, hostPort: hp.value, containerPort: cp.value });
        }
      }
    }
  }
  return results;
}

/** Inspect a workspace directory (and immediate child directories in monorepos) for projects. */
export async function scanWorkspaceProjects(workspaceFolders: readonly string[]): Promise<{
  projects: DetectedProject[];
  composePorts: Array<{ service: string; hostPort: number; folderPath: string }>;
}> {
  const projects: DetectedProject[] = [];
  const composePorts: Array<{ service: string; hostPort: number; folderPath: string }> = [];

  const candidateDirs = new Set<string>();
  for (const root of workspaceFolders) {
    if (!existsSync(root)) continue;
    candidateDirs.add(root);
    for (const sub of ['apps', 'packages', 'services', 'frontend', 'backend', 'web', 'api', 'server', 'client']) {
      const subPath = path.join(root, sub);
      if (!existsSync(subPath)) continue;
      candidateDirs.add(subPath);
      try {
        const entries = await readdir(subPath, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
            candidateDirs.add(path.join(subPath, e.name));
          }
        }
      } catch {
        // Ignore unreadable directories.
      }
    }
  }

  for (const dir of candidateDirs) {
    // 1. Node / package.json
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const raw = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>;
        // Skip pure library/config packages without runnable dev/start/serve scripts unless root.
        const scripts = (raw.scripts ?? {}) as Record<string, unknown>;
        const hasServerScript = ['dev', 'start', 'serve', 'preview', 'develop'].some((s) => s in scripts);
        if (hasServerScript || workspaceFolders.includes(dir)) {
          projects.push(detectFromPackageJson(raw, dir));
        }
      } catch {
        // Ignore malformed package.json
      }
    }

    // 2. Python (FastAPI / Flask)
    const pyFiles = ['pyproject.toml', 'requirements.txt'];
    for (const pyf of pyFiles) {
      const p = path.join(dir, pyf);
      if (existsSync(p)) {
        try {
          const text = (await readFile(p, 'utf8')).toLowerCase();
          if (text.includes('fastapi') || text.includes('uvicorn')) {
            projects.push({
              name: path.basename(dir),
              folderPath: dir,
              framework: 'fastapi',
              frameworkLabel: 'FastAPI',
              candidatePorts: [8000],
              scripts: {},
            });
            break;
          }
          if (text.includes('flask')) {
            projects.push({
              name: path.basename(dir),
              folderPath: dir,
              framework: 'flask',
              frameworkLabel: 'Flask',
              candidatePorts: [5000],
              scripts: {},
            });
            break;
          }
        } catch {
          // Ignore
        }
      }
    }

    // 3. Laravel / PHP
    const composerPath = path.join(dir, 'composer.json');
    if (existsSync(composerPath) || existsSync(path.join(dir, 'artisan'))) {
      try {
        const text = existsSync(composerPath) ? (await readFile(composerPath, 'utf8')).toLowerCase() : 'laravel';
        if (text.includes('laravel')) {
          projects.push({
            name: path.basename(dir),
            folderPath: dir,
            framework: 'laravel',
            frameworkLabel: 'Laravel',
            candidatePorts: [8000],
            scripts: {},
          });
        }
      } catch {
        // Ignore
      }
    }

    // 4. Docker Compose
    for (const composeFile of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      const cp = path.join(dir, composeFile);
      if (existsSync(cp)) {
        try {
          const text = await readFile(cp, 'utf8');
          for (const item of parseDockerComposePorts(text)) {
            composePorts.push({ service: item.service, hostPort: item.hostPort, folderPath: dir });
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  return { projects, composePorts };
}

/** Parse Windows `netstat -ano` output into deduplicated TCP listeners. */
export function parseNetstatOutput(output: string): TcpListenerInfo[] {
  const byPort = new Map<number, { addresses: Set<string>; pid?: number }>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('TCP')) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const localAddr = cols[1] ?? '';
    const state = cols[3] ?? '';
    const pidStr = cols[4];
    if (state.toUpperCase() !== 'LISTENING') continue;

    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon < 0) continue;
    const addr = localAddr.slice(0, lastColon).replace(/^\[|\]$/g, '');
    const portRes = validatePort(localAddr.slice(lastColon + 1));
    if (!portRes.ok) continue;

    const existing = byPort.get(portRes.value) ?? { addresses: new Set<string>() };
    existing.addresses.add(addr);
    const pid = pidStr ? Number(pidStr) : NaN;
    if (Number.isInteger(pid) && pid > 0 && existing.pid === undefined) {
      existing.pid = pid;
    }
    byPort.set(portRes.value, existing);
  }

  return [...byPort.entries()]
    .map(([port, v]) => ({
      port,
      addresses: [...v.addresses],
      ...(v.pid !== undefined ? { pid: v.pid } : {}),
    }))
    .sort((a, b) => a.port - b.port);
}

/** Discover local TCP listeners using OS tools (safe execFile with fixed arguments). */
export async function listSystemTcpListeners(): Promise<TcpListenerInfo[]> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat.exe', ['-ano'], {
        timeout: 4000,
        windowsHide: true,
      });
      const listeners = parseNetstatOutput(stdout);
      // Enrich process names via tasklist in a single fast call.
      try {
        const { stdout: tl } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
          timeout: 4000,
          windowsHide: true,
        });
        const pidMap = new Map<number, string>();
        for (const line of tl.split(/\r?\n/)) {
          const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
          if (m) pidMap.set(Number(m[2]), m[1] ?? '');
        }
        for (const l of listeners) {
          if (l.pid !== undefined) {
            const proc = pidMap.get(l.pid);
            if (proc) l.processName = proc;
          }
        }
      } catch {
        // Process names are optional enrichment.
      }
      return listeners;
    } catch {
      return [];
    }
  }

  // macOS / Linux fallback via lsof
  try {
    const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], {
      timeout: 4000,
    });
    const byPort = new Map<number, TcpListenerInfo>();
    for (const line of stdout.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 9) continue;
      const proc = cols[0];
      const pid = Number(cols[1]);
      const nameCol = cols[8] ?? '';
      const lastColon = nameCol.lastIndexOf(':');
      if (lastColon < 0) continue;
      const addr = nameCol.slice(0, lastColon).replace(/^\[|\]$/g, '');
      const portRes = validatePort(nameCol.slice(lastColon + 1));
      if (!portRes.ok) continue;
      const existing = byPort.get(portRes.value);
      if (existing) {
        if (!existing.addresses.includes(addr)) existing.addresses.push(addr);
      } else {
        byPort.set(portRes.value, {
          port: portRes.value,
          addresses: [addr],
          ...(Number.isInteger(pid) ? { pid } : {}),
          ...(proc ? { processName: proc } : {}),
        });
      }
    }
    return [...byPort.values()].sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

export interface HealthProbeResult {
  reachable: boolean;
  isHttp: boolean;
  httpStatus?: number;
  bannerService?: string;
  resolvedHost: string;
}

/**
 * Probe a local port over IPv4 (`127.0.0.1`) and IPv6 (`::1`) to verify reachability,
 * check whether it speaks HTTP, and inspect any initial banner for non-HTTP services.
 */
export async function probeLocalPort(port: number, timeoutMs = 1200): Promise<HealthProbeResult> {
  const hosts = ['127.0.0.1', '::1'];
  for (const host of hosts) {
    const tcp = await probeTcpAndBanner(host, port, timeoutMs);
    if (!tcp.connected) continue;
    if (tcp.bannerService) {
      return {
        reachable: true,
        isHttp: false,
        bannerService: tcp.bannerService,
        resolvedHost: host === '::1' ? 'localhost' : '127.0.0.1',
      };
    }
    const httpRes = await probeHttp(host, port, timeoutMs);
    return {
      reachable: true,
      isHttp: httpRes.isHttp,
      ...(httpRes.status !== undefined ? { httpStatus: httpRes.status } : {}),
      resolvedHost: host === '::1' ? 'localhost' : '127.0.0.1',
    };
  }
  return { reachable: false, isHttp: false, resolvedHost: 'localhost' };
}

function probeTcpAndBanner(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ connected: boolean; bannerService?: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (res: { connected: boolean; bannerService?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(res);
    };
    const timer = setTimeout(() => finish({ connected: false }), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      // Wait briefly (60ms) to see if the server sends a greeting banner (SSH, MySQL, SMTP).
      const bannerTimer = setTimeout(() => finish({ connected: true }), 60);
      socket.once('data', (chunk: Buffer) => {
        clearTimeout(bannerTimer);
        const bannerService = detectNonHttpBanner(chunk);
        finish({ connected: true, ...(bannerService ? { bannerService } : {}) });
      });
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish({ connected: false });
    });
  });
}

function probeHttp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ isHttp: boolean; status?: number }> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path: '/',
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          Host: `localhost:${port}`,
          'User-Agent': 'LocalShare-HealthCheck/1.0',
          Accept: '*/*',
        },
      },
      (res) => {
        res.resume();
        resolve({ isHttp: true, ...(res.statusCode !== undefined ? { status: res.statusCode } : {}) });
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolve({ isHttp: false });
    });
    req.once('error', () => {
      resolve({ isHttp: false });
    });
    req.end();
  });
}

export interface DetectionOptions {
  workspaceFolders: readonly string[];
  extraPorts?: readonly number[];
  showAllListeners?: boolean;
  allowedSensitivePorts?: readonly number[];
}

/**
 * Full detection pipeline combining workspace project analysis, Docker Compose mappings,
 * live OS TCP listeners and lightweight health probes. Deduplicates ports across IPv4/IPv6.
 */
export async function detectLocalServers(options: DetectionOptions): Promise<{
  projects: DetectedProject[];
  servers: DetectedServer[];
}> {
  const { projects, composePorts } = await scanWorkspaceProjects(options.workspaceFolders);
  const listeners = await listSystemTcpListeners();
  const listenerByPort = new Map(listeners.map((l) => [l.port, l]));
  const allowedSensitive = new Set(options.allowedSensitivePorts ?? []);

  // Build candidate port map with metadata priority: workspace > docker > extra > listener.
  const candidates = new Map<
    number,
    {
      name: string;
      framework: FrameworkId;
      frameworkLabel: string;
      projectPath?: string;
      source: DetectedServer['source'];
    }
  >();

  for (const proj of projects) {
    for (const port of proj.candidatePorts) {
      if (!candidates.has(port)) {
        candidates.set(port, {
          name: proj.name,
          framework: proj.framework,
          frameworkLabel: proj.frameworkLabel,
          projectPath: proj.folderPath,
          source: 'workspace',
        });
      }
    }
  }

  for (const cp of composePorts) {
    if (!candidates.has(cp.hostPort)) {
      candidates.set(cp.hostPort, {
        name: `${cp.service} (Docker)`,
        framework: 'docker',
        frameworkLabel: 'Docker Compose',
        projectPath: cp.folderPath,
        source: 'docker',
      });
    }
  }

  for (const port of options.extraPorts ?? []) {
    const v = validatePort(port);
    if (v.ok && !candidates.has(v.value)) {
      candidates.set(v.value, {
        name: `Port ${v.value}`,
        framework: 'generic',
        frameworkLabel: 'Configured Port',
        source: 'extra',
      });
    }
  }

  const commonDevSet = new Set(COMMON_DEV_PORTS);
  for (const l of listeners) {
    if (candidates.has(l.port)) continue;
    const isLikelyDev =
      commonDevSet.has(l.port) ||
      (l.port >= 3000 && l.port <= 9999) ||
      Boolean(l.processName && /^(node|bun|deno|python|uvicorn|php|ruby|go|java|dotnet)/i.test(l.processName));
    if (options.showAllListeners || isLikelyDev) {
      candidates.set(l.port, {
        name: l.processName ? `${l.processName.replace(/\.exe$/i, '')} (${l.port})` : `Port ${l.port}`,
        framework: 'generic',
        frameworkLabel: l.processName ? l.processName.replace(/\.exe$/i, '') : 'Local Service',
        source: 'listener',
      });
    }
  }

  // Probe ports that either have a listener or belong to a workspace/extra configuration.
  const entries = [...candidates.entries()].sort((a, b) => a[0] - b[0]);
  const servers: DetectedServer[] = [];

  await Promise.all(
    entries.map(async ([port, meta]) => {
      const listener = listenerByPort.get(port);
      const probe = await probeLocalPort(port);
      // Skip workspace default ports that are not actually running unless there is a listener.
      if (!probe.reachable && !listener) return;

      const sensitiveSvc = getSensitiveService(port);
      const sensitiveProc = getSensitiveProcess(listener?.processName);
      const sensitiveReason = probe.bannerService ?? sensitiveProc ?? sensitiveSvc?.service;
      const isBlocked = Boolean(sensitiveReason && !allowedSensitive.has(port));

      let health: ServerHealth;
      if (isBlocked) {
        health = 'blocked-sensitive';
      } else if (!probe.reachable) {
        health = 'unreachable';
      } else if (probe.isHttp) {
        health = 'healthy-http';
      } else {
        health = 'healthy-tcp';
      }

      servers.push({
        id: `localhost:${port}`,
        name: meta.name,
        host: 'localhost',
        port,
        addresses: listener?.addresses ?? [probe.resolvedHost],
        framework: meta.framework,
        frameworkLabel: meta.frameworkLabel,
        ...(meta.projectPath ? { projectPath: meta.projectPath } : {}),
        ...(listener?.pid !== undefined ? { pid: listener.pid } : {}),
        ...(listener?.processName ? { processName: listener.processName } : {}),
        source: meta.source,
        health,
        ...(probe.httpStatus !== undefined ? { httpStatus: probe.httpStatus } : {}),
        ...(sensitiveReason ? { sensitiveReason } : {}),
        shareable: !isBlocked && probe.reachable,
      });
    }),
  );

  servers.sort((a, b) => {
    if (a.shareable !== b.shareable) return a.shareable ? -1 : 1;
    if (a.source !== b.source) return a.source === 'workspace' ? -1 : 1;
    return a.port - b.port;
  });

  return { projects, servers };
}

