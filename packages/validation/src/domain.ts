/**
 * Domain / hostname validation for custom preview domains.
 */
import { isIpLiteral, type ValidationResult } from './network';

/** TLDs that can never be used for public preview hostnames. */
const RESERVED_TLDS = new Set(['local', 'localhost', 'test', 'invalid', 'example', 'internal', 'onion', 'lan', 'home', 'corp', 'localdomain']);

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Convert a (possibly internationalised) domain to ASCII (punycode) using the WHATWG URL parser,
 * which is available in both Node.js and browsers.
 */
export function toAsciiHostname(input: string): string | undefined {
  try {
    const url = new URL(`http://${input}`);
    return url.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Validate a fully-qualified public hostname such as `preview.customer.com`.
 * Rejects wildcards, IP literals, URLs, ports, reserved TLDs, overlong names and malformed labels.
 */
export function validateHostname(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: 'Hostname must be a string.' };
  let raw = input.trim().toLowerCase();
  if (raw.length === 0) return { ok: false, error: 'Hostname is required.' };
  if (/[\s/\\?#@:*,;'"<>`|$&(){}[\]%!=+^~]/.test(raw)) {
    return { ok: false, error: 'Enter a hostname only (for example preview.example.com) — no scheme, port, path, wildcard or special characters.' };
  }
  if (raw.endsWith('.')) raw = raw.slice(0, -1);
  // Control characters / non-printables.
  if ([...raw].some((ch) => { const c = ch.charCodeAt(0); return c < 0x20 || c === 0x7f; })) {
    return { ok: false, error: 'Hostname contains control characters.' };
  }
  const ascii = toAsciiHostname(raw);
  if (!ascii || ascii !== ascii.toLowerCase()) return { ok: false, error: 'Hostname is not valid.' };
  if (isIpLiteral(ascii)) return { ok: false, error: 'IP addresses cannot be used as custom domains.' };
  if (ascii.length > 253) return { ok: false, error: 'Hostname is longer than 253 characters.' };
  const labels = ascii.split('.');
  if (labels.length < 2) return { ok: false, error: 'Hostname must include a domain and a top-level domain (for example preview.example.com).' };
  for (const label of labels) {
    if (!LABEL_RE.test(label)) {
      return { ok: false, error: `Label "${label}" is invalid. Labels are 1–63 letters, digits or hyphens and cannot start or end with a hyphen.` };
    }
  }
  const tld = labels[labels.length - 1] ?? '';
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return { ok: false, error: 'Top-level domain is not valid.' };
  if (RESERVED_TLDS.has(tld)) return { ok: false, error: `".${tld}" is a reserved/private TLD and cannot be published.` };
  return { ok: true, value: ascii };
}

/** True when `hostname` equals `zone` or is a subdomain of it (label-aware, not substring). */
export function isHostnameInZone(hostname: string, zone: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const z = zone.toLowerCase().replace(/\.$/, '');
  return h === z || h.endsWith(`.${z}`);
}

/** Candidate zone names for a hostname, most specific first (`a.b.example.com` → `a.b.example.com`, `b.example.com`, `example.com`). */
export function candidateZones(hostname: string): string[] {
  const labels = hostname.toLowerCase().split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

export function validateEmail(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: 'Email must be a string.' };
  const v = input.trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) return { ok: false, error: `"${input}" is not a valid email address.` };
  const domain = v.split('@')[1] ?? '';
  if (!validateHostname(domain).ok) return { ok: false, error: `"${input}" has an invalid email domain.` };
  return { ok: true, value: v };
}

/** Validate an email domain used in identity policies, e.g. `customer.com`. */
export function validateEmailDomain(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: 'Domain must be a string.' };
  const v = input.trim().toLowerCase().replace(/^@/, '');
  return validateHostname(v);
}

