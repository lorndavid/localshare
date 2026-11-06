/**
 * Redacting logger used across all extension modules. The concrete sink (VS Code OutputChannel or
 * an in-memory buffer in tests) is injected.
 */
import { redactSecrets } from '@localshare/validation';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LogSink {
  appendLine(line: string): void;
  show?(preserveFocus?: boolean): void;
}

export class Logger {
  private level: LogLevel;
  private readonly knownSecrets = new Set<string>();
  private readonly recent: string[] = [];
  private readonly maxRecent = 400;

  constructor(
    private readonly sink: LogSink,
    level: LogLevel = 'info',
  ) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Register a secret value so it is always scrubbed if it ever reaches a log call. */
  registerSecret(secret: string | undefined): void {
    if (secret && secret.length >= 4) this.knownSecrets.add(secret);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }
  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  show(): void {
    this.sink.show?.(true);
  }

  getRecentLines(): readonly string[] {
    return this.recent;
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (RANK[level] > RANK[this.level]) return;
    const secrets = [...this.knownSecrets];
    const extra = meta ? ` ${redactSecrets(JSON.stringify(meta), secrets)}` : '';
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${redactSecrets(message, secrets)}${extra}`;
    this.recent.push(line);
    if (this.recent.length > this.maxRecent) this.recent.shift();
    this.sink.appendLine(line);
  }
}

export function createMemoryLogger(level: LogLevel = 'debug'): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new Logger({ appendLine: (l) => lines.push(l) }, level), lines };
}
