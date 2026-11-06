/**
 * Generic text validation helpers.
 */
import type { ValidationResult } from './network';

/** Validate a human-readable label (share name, group name). */
export function validateLabel(input: unknown, field = 'Name', max = 64): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: `${field} must be text.` };
  const v = input.trim().replace(/\s+/g, ' ');
  if (v.length === 0) return { ok: false, error: `${field} is required.` };
  if (v.length > max) return { ok: false, error: `${field} must be ${max} characters or fewer.` };
  if (/[\u0000-\u001f\u007f<>]/.test(v)) return { ok: false, error: `${field} contains unsupported characters.` };
  return { ok: true, value: v };
}

/** Validate optional free-text description. Empty string is allowed and returns ''. */
export function validateDescription(input: unknown, max = 500): ValidationResult<string> {
  if (input === undefined || input === null) return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, error: 'Description must be text.' };
  const v = input.trim();
  if (v.length > max) return { ok: false, error: `Description must be ${max} characters or fewer.` };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return { ok: false, error: 'Description contains control characters.' };
  return { ok: true, value: v };
}

/** Cloudflare tunnel names: 1-63 chars, letters, digits, dot, dash, underscore. */
export function validateTunnelName(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: 'Tunnel name must be text.' };
  const v = input.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(v)) {
    return { ok: false, error: 'Tunnel name must be 1–63 characters: letters, digits, ".", "-" or "_", starting with a letter or digit.' };
  }
  return { ok: true, value: v };
}

/** Basic HTTP password policy for the local auth gateway. */
export function validateGatewayPassword(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: 'Password must be text.' };
  if (input.length < 10) return { ok: false, error: 'Password must be at least 10 characters.' };
  if (input.length > 128) return { ok: false, error: 'Password must be 128 characters or fewer.' };
  if (/[\u0000-\u001f\u007f]/.test(input)) return { ok: false, error: 'Password contains control characters.' };
  return { ok: true, value: input };
}

/** Basic auth username: no colon (RFC 7617), printable. */
export function validateGatewayUsername(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: 'Username must be text.' };
  const v = input.trim();
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(v)) return { ok: false, error: 'Username must be 1–64 characters: letters, digits, ".", "_", "@" or "-".' };
  return { ok: true, value: v };
}

