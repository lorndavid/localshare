/**
 * Credential redaction for logs, error messages and diagnostics.
 */

const REDACTED = '[REDACTED]';

const PATTERNS: ReadonlyArray<[RegExp, string | ((...m: string[]) => string)]> = [
  // Authorization headers / bearer tokens.
  [/(authorization\s*[:=]\s*)(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, (_m, p1, p2) => `${p1}${p2} ${REDACTED}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, p1) => `${p1} ${REDACTED}`],
  // Cloudflare tunnel tokens are base64-encoded JSON starting with {"a": → eyJh
  [/\beyJ[A-Za-z0-9_-]{20,}={0,2}(?:\.[A-Za-z0-9_-]+){0,2}/g, REDACTED],
  // key=value style secrets.
  [/((?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret|credentials?)["']?\s*[:=]\s*["']?)([^\s"'&,;]+)/gi, (_m, p1) => `${p1}${REDACTED}`],
  // --token <value> style CLI args.
  [/(--(?:token|password|secret|cred-file|credentials-contents)[= ])(\S+)/gi, (_m, p1) => `${p1}${REDACTED}`],
  // URL credentials http://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, (_m, p1, p2) => `${p1}${p2}:${REDACTED}@`],
  // Long opaque API tokens (Cloudflare API tokens are 40 chars of [A-Za-z0-9_-]).
  [/\b(?=[A-Za-z0-9_-]{40,}\b)(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, REDACTED],
];

/**
 * Redact credentials from arbitrary text. Additional known secret values can be passed explicitly
 * and are replaced verbatim wherever they appear.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const [re, replacement] of PATTERNS) {
    out = typeof replacement === 'string' ? out.replace(re, replacement) : out.replace(re, replacement as (...args: string[]) => string);
  }
  return out;
}

export { REDACTED };

