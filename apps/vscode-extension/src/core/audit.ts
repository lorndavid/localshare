/**
 * Local security audit log (persisted in a small ring buffer + JSONL file when a path is supplied).
 * Never stores unredacted secrets.
 */
import { appendFile } from 'node:fs/promises';
import { redactSecrets } from '@localshare/validation';

export type AuditAction =
  | 'share.confirm.accepted'
  | 'share.confirm.cancelled'
  | 'share.sensitive.blocked'
  | 'share.sensitive.overridden'
  | 'share.started'
  | 'share.stopped'
  | 'share.error'
  | 'security.password.set'
  | 'security.password.cleared'
  | 'security.auth.failed'
  | 'binary.verified'
  | 'binary.mismatch'
  | 'cloudflare.connected'
  | 'cloudflare.token.rotated'
  | 'cloudflare.disconnected'
  | 'domain.dns.configured'
  | 'domain.verified'
  | 'domain.removed'
  | 'namedTunnel.created'
  | 'namedTunnel.deleted';

export interface LocalAuditEntry {
  timestamp: string;
  action: AuditAction;
  summary: string;
  details?: Record<string, unknown>;
}

export class LocalAuditLog {
  private readonly entries: LocalAuditEntry[] = [];
  private readonly maxEntries = 200;

  constructor(private readonly filePath?: string) {}

  record(action: AuditAction, summary: string, details?: Record<string, unknown>, secrets: readonly string[] = []): LocalAuditEntry {
    const cleanDetails = details ? (JSON.parse(redactSecrets(JSON.stringify(details), secrets)) as Record<string, unknown>) : undefined;
    const entry: LocalAuditEntry = {
      timestamp: new Date().toISOString(),
      action,
      summary: redactSecrets(summary, secrets),
      ...(cleanDetails ? { details: cleanDetails } : {}),
    };
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) this.entries.pop();
    if (this.filePath) {
      void appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8').catch(() => undefined);
    }
    return entry;
  }

  list(): readonly LocalAuditEntry[] {
    return this.entries;
  }
}
