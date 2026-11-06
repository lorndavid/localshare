/**
 * Safe management of the `cloudflared` binary:
 * - Resolves user-configured path, managed verified binary, or system PATH.
 * - Downloads official GitHub release assets for Windows, macOS (raw binary inside tgz or direct) and Linux.
 * - Strictly verifies SHA-256 against the official release asset `digest` and/or checksum block in release notes.
 * - Never executes an unverified downloaded binary.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { LocalShareError } from './errors';
import type { Logger } from './logger';

const execFileAsync = promisify(execFile);

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

export interface GithubReleaseMetadata {
  tag_name: string;
  body?: string | null;
  assets: GithubReleaseAsset[];
}

export interface ManagedBinaryMeta {
  version: string;
  sha256: string;
  installedAt: string;
  binaryPath: string;
}

export interface BinaryResolverOptions {
  storageDir: string;
  configuredPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/** Determine the expected cloudflared release asset name for a given platform/arch. */
export function getCloudflaredAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') {
    return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return 'cloudflared-linux-arm64';
    if (arch === 'arm') return 'cloudflared-linux-arm';
    if (arch === 'ia32') return 'cloudflared-linux-386';
    return 'cloudflared-linux-amd64';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  }
  throw new LocalShareError('BINARY_MISSING', `Unsupported operating system: ${platform}`);
}

/** Parse SHA-256 checksum for a given asset name from the GitHub release metadata. */
export function extractExpectedSha256(
  release: GithubReleaseMetadata,
  assetName: string,
): string | undefined {
  const asset = release.assets.find((a) => a.name === assetName);
  if (asset?.digest && /^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
    return asset.digest.slice('sha256:'.length).toLowerCase();
  }
  const body = release.body ?? '';
  const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*:\\s*([0-9a-f]{64})`, 'i').exec(body);
  return match?.[1]?.toLowerCase();
}

/** Compute hex SHA-256 of a Buffer or file on disk. */
export function computeBufferSha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex').toLowerCase();
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return computeBufferSha256(data);
}

/** Verify `cloudflared --version` runs cleanly and return the version string. */
export async function checkBinaryExecutable(binaryPath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], {
      timeout: 5000,
      windowsHide: true,
    });
    const out = `${stdout}\n${stderr}`.trim();
    const m = /cloudflared\s+version\s+([^\s(]+)/i.exec(out);
    return m?.[1] ?? (out.length > 0 ? out.split(/\r?\n/)[0] : undefined);
  } catch {
    return undefined;
  }
}

export class CloudflaredBinaryManager {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: BinaryResolverOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetchFn = options.fetchImpl ?? fetch;
  }

  get managedBinaryPath(): string {
    const exe = this.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    return path.join(this.options.storageDir, 'bin', exe);
  }

  private get metaFilePath(): string {
    return path.join(this.options.storageDir, 'bin', 'cloudflared.meta.json');
  }

  /**
   * Resolve a usable, verified `cloudflared` path:
   * 1. Explicit `localshare.cloudflared.path` setting (validated for existence & execution).
   * 2. Managed binary in extension storage (re-verified against its stored SHA-256 before every use).
   * 3. System `cloudflared` on PATH.
   */
  async resolveExistingBinary(): Promise<{ binaryPath: string; version: string; source: 'configured' | 'managed' | 'path' } | undefined> {
    const configured = this.options.configuredPath?.trim();
    if (configured) {
      if (!existsSync(configured)) {
        throw new LocalShareError(
          'BINARY_MISSING',
          `Configured cloudflared path does not exist: ${configured}`,
          'Clear "localshare.cloudflared.path" in settings or point it to a valid cloudflared executable.',
        );
      }
      const ver = await checkBinaryExecutable(configured);
      if (!ver) {
        throw new LocalShareError(
          'BINARY_MISSING',
          `Configured cloudflared executable failed to run: ${configured}`,
        );
      }
      return { binaryPath: configured, version: ver, source: 'configured' };
    }

    if (existsSync(this.managedBinaryPath) && existsSync(this.metaFilePath)) {
      try {
        const meta = JSON.parse(await readFile(this.metaFilePath, 'utf8')) as ManagedBinaryMeta;
        const actualSha = await computeFileSha256(this.managedBinaryPath);
        if (actualSha !== meta.sha256.toLowerCase()) {
          this.options.logger?.error('Managed cloudflared binary failed integrity check; removing it.', {
            expected: meta.sha256,
            actual: actualSha,
          });
          await rm(this.managedBinaryPath, { force: true });
          throw new LocalShareError(
            'BINARY_CHECKSUM_MISMATCH',
            'Managed cloudflared binary failed SHA-256 integrity verification and was removed.',
          );
        }
        const ver = await checkBinaryExecutable(this.managedBinaryPath);
        if (ver) {
          return { binaryPath: this.managedBinaryPath, version: ver, source: 'managed' };
        }
      } catch (err) {
        if (err instanceof LocalShareError) throw err;
      }
    }

    const pathCmd = this.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const pathVer = await checkBinaryExecutable(pathCmd);
    if (pathVer) {
      return { binaryPath: pathCmd, version: pathVer, source: 'path' };
    }

    return undefined;
  }

  /**
   * Download the latest official `cloudflared` release, verify its SHA-256 checksum against the
   * official release metadata BEFORE moving it into place or executing it, and persist metadata.
   */
  async installOrUpdate(onProgress?: (step: string) => void): Promise<ManagedBinaryMeta> {
    const assetName = getCloudflaredAssetName(this.platform, this.arch);
    onProgress?.('Fetching official Cloudflare release metadata…');

    let release: GithubReleaseMetadata;
    try {
      const res = await this.fetchFn(
        'https://api.github.com/repos/cloudflare/cloudflared/releases/latest',
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'LocalShare-VSCode-Extension/1.0',
          },
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from GitHub releases API`);
      }
      release = (await res.json()) as GithubReleaseMetadata;
    } catch (err) {
      throw new LocalShareError(
        'BINARY_DOWNLOAD_FAILED',
        'Could not fetch official cloudflared release metadata from GitHub.',
        'Check your internet connection or install cloudflared manually and set "localshare.cloudflared.path".',
        { cause: err },
      );
    }

    const asset = release.assets.find((a) => a.name === assetName);
    const expectedSha = extractExpectedSha256(release, assetName);
    if (!asset || !expectedSha) {
      throw new LocalShareError(
        'BINARY_CHECKSUM_MISMATCH',
        `Official release ${release.tag_name} is missing asset or SHA-256 digest for ${assetName}. Refusing to install unverified binary.`,
      );
    }

    onProgress?.(`Downloading ${assetName} (${release.tag_name})…`);
    let bytes: Uint8Array;
    try {
      const dl = await this.fetchFn(asset.browser_download_url, {
        headers: { 'User-Agent': 'LocalShare-VSCode-Extension/1.0' },
      });
      if (!dl.ok) {
        throw new Error(`HTTP ${dl.status} downloading ${asset.browser_download_url}`);
      }
      bytes = new Uint8Array(await dl.arrayBuffer());
    } catch (err) {
      throw new LocalShareError(
        'BINARY_DOWNLOAD_FAILED',
        `Failed to download ${assetName}.`,
        'Check your network connection or firewall settings.',
        { cause: err },
      );
    }

    onProgress?.('Verifying SHA-256 checksum…');
    const actualSha = computeBufferSha256(bytes);
    if (actualSha !== expectedSha) {
      throw new LocalShareError(
        'BINARY_CHECKSUM_MISMATCH',
        `SHA-256 checksum mismatch for ${assetName}: expected ${expectedSha}, got ${actualSha}. Refusing to execute binary.`,
      );
    }

    const binDir = path.dirname(this.managedBinaryPath);
    await mkdir(binDir, { recursive: true });
    const tempPath = `${this.managedBinaryPath}.download-${ process.pid }-${Date.now()}`;

    if (assetName.endsWith('.tgz')) {
      // macOS archive: verify archive checksum first (done above), then extract `cloudflared` safely.
      const archivePath = `${tempPath}.tgz`;
      await writeFile(archivePath, bytes);
      try {
        await execFileAsync('tar', ['-xzf', archivePath, '-C', binDir, 'cloudflared'], {
          timeout: 15000,
        });
      } finally {
        await rm(archivePath, { force: true });
      }
    } else {
      await writeFile(tempPath, bytes);
      if (this.platform !== 'win32') {
        await chmod(tempPath, 0o755);
      }
      await rename(tempPath, this.managedBinaryPath);
    }

    const finalSha = await computeFileSha256(this.managedBinaryPath);
    const ver = await checkBinaryExecutable(this.managedBinaryPath);
    if (!ver) {
      await rm(this.managedBinaryPath, { force: true });
      throw new LocalShareError(
        'BINARY_MISSING',
        'Downloaded cloudflared binary did not pass execution self-check.',
      );
    }

    const meta: ManagedBinaryMeta = {
      version: release.tag_name || ver,
      sha256: finalSha,
      installedAt: new Date().toISOString(),
      binaryPath: this.managedBinaryPath,
    };
    await writeFile(this.metaFilePath, JSON.stringify(meta, null, 2), 'utf8');
    this.options.logger?.info(`Installed verified cloudflared ${meta.version}`, {
      sha256: meta.sha256,
      path: meta.binaryPath,
    });
    return meta;
  }
}

