/**
 * Structured error types for LocalShare. Every user-facing error carries a short code and an
 * actionable remediation hint.
 */

export type ErrorCode =
  | 'INVALID_PORT'
  | 'INVALID_HOST'
  | 'INVALID_HOSTNAME'
  | 'SENSITIVE_SERVICE_BLOCKED'
  | 'USER_CANCELLED'
  | 'DUPLICATE_SHARE'
  | 'TARGET_UNREACHABLE'
  | 'BINARY_MISSING'
  | 'BINARY_CHECKSUM_MISMATCH'
  | 'BINARY_DOWNLOAD_FAILED'
  | 'TUNNEL_STARTUP_TIMEOUT'
  | 'TUNNEL_PROCESS_FAILED'
  | 'TUNNEL_READINESS_FAILED'
  | 'INVALID_STATE_TRANSITION'
  | 'CLOUDFLARE_AUTH_FAILED'
  | 'CLOUDFLARE_ZONE_NOT_FOUND'
  | 'CLOUDFLARE_PERMISSION_DENIED'
  | 'CLOUDFLARE_API_ERROR'
  | 'DNS_NOT_VERIFIED'
  | 'HTTPS_NOT_READY'
  | 'CLOUD_API_ERROR';

export class LocalShareError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LocalShareError';
    this.code = code;
    this.hint = hint;
  }

  /** Format a concise single-line message suitable for notifications. */
  toUserMessage(): string {
    return this.hint ? `${this.message} (${this.hint})` : this.message;
  }
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof LocalShareError) return err.toUserMessage();
  if (err instanceof Error) return err.message;
  return String(err);
}
