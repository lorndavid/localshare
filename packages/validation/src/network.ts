/**
 * Network-level validation: ports, IP classification and local target validation.
 *
 * These functions are pure and environment-agnostic (Node and browser) so they can be
 * shared by the VS Code extension, the API and the dashboard.
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/** Strictly parse and validate a TCP port. Rejects signs, decimals, whitespace tricks and out-of-range values. */
export function validatePort(input: unknown): ValidationResult<number> {
  let value: number;
  if (typeof input === 'number') {
    value = input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!/^\d{1,5}$/.test(trimmed)) {
      return { ok: false, error: 'Port must be a whole number between 1 and 65535.' };
    }
    value = Number(trimmed);
  } else {
    return { ok: false, error: 'Port must be a number.' };
  }
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    return { ok: false, error: 'Port must be a whole number between 1 and 65535.' };
  }
  return { ok: true, value };
}

export type IpClass =
  | 'loopback'
  | 'private'
  | 'linkLocal'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'public';

/** Parse a dotted IPv4 string into 4 octets, or undefined if not a canonical IPv4 literal. */
export function parseIPv4(ip: string): [number, number, number, number] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const parts = m.slice(1).map((p) => {
    // Reject octal-looking octets like "010" which some resolvers treat differently.
    if (p.length > 1 && p.startsWith('0')) return NaN;
    return Number(p);
  });
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return parts as [number, number, number, number];
}

/** Expand an IPv6 literal (without brackets/zone) into 8 hextets, or undefined if invalid. */
export function parseIPv6(input: string): number[] | undefined {
  let ip = input.toLowerCase();
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx >= 0) ip = ip.slice(0, zoneIdx);
  if (!/^[0-9a-f:.]+$/.test(ip) || !ip.includes(':')) return undefined;

  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) is rewritten into two hex groups.
  const lastColon = ip.lastIndexOf(':');
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return undefined;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const tail: number[] = [];

  const doubleColon = ip.split('::');
  if (doubleColon.length > 2) return undefined;
  const parseGroup = (s: string): number[] | undefined => {
    if (s === '') return [];
    const groups = s.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroup(doubleColon[0] ?? '');
  const rest = doubleColon.length === 2 ? parseGroup(doubleColon[1] ?? '') : [];
  if (!head || !rest) return undefined;
  const total = head.length + rest.length + tail.length;
  if (doubleColon.length === 2) {
    if (total > 7) return undefined;
    return [...head, ...new Array<number>(8 - total).fill(0), ...rest, ...tail];
  }
  if (total !== 8) return undefined;
  return [...head, ...tail];
}

/** Classify an IP literal. Returns undefined when the input is not an IP literal. */
export function classifyIp(input: string): IpClass | undefined {
  const ip = stripBrackets(input);
  const v4 = parseIPv4(ip);
  if (v4) return classifyV4(v4);
  const v6 = parseIPv6(ip);
  if (!v6) return undefined;
  const isZero = (from: number, to: number) => v6.slice(from, to).every((h) => h === 0);
  if (isZero(0, 8)) return 'unspecified';
  if (isZero(0, 7) && v6[7] === 1) return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d
  if (isZero(0, 5) && v6[5] === 0xffff) {
    const a = v6[6] ?? 0;
    const b = v6[7] ?? 0;
    return classifyV4([a >> 8, a & 0xff, b >> 8, b & 0xff]);
  }
  const first = v6[0] ?? 0;
  if ((first & 0xffc0) === 0xfe80) return 'linkLocal';
  if ((first & 0xfe00) === 0xfc00) return 'private';
  if ((first & 0xff00) === 0xff00) return 'multicast';
  if (first === 0x2001 && v6[1] === 0x0db8) return 'reserved';
  return 'public';
}

function classifyV4([a, b]: [number, number, number, number]): IpClass {
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'linkLocal';
  if (a === 100 && b >= 64 && b <= 127) return 'reserved'; // CGNAT
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function isIpLiteral(host: string): boolean {
  return classifyIp(host) !== undefined;
}

export interface LocalTargetOptions {
  /** Allow RFC1918 / ULA LAN addresses as tunnel targets (off by default). */
  allowLanTargets?: boolean;
}

export interface LocalTarget {
  /** Normalised host used to connect (`127.0.0.1`, `::1`, `localhost`, or an allowed LAN IP). */
  host: string;
  port: number;
  scope: 'loopback' | 'lan';
}

/**
 * Validate a host that LocalShare may forward public traffic to.
 *
 * SSRF protection: only loopback targets are allowed by default. LAN IP literals are allowed
 * only when explicitly enabled. Arbitrary hostnames (DNS rebinding risk), link-local
 * (cloud metadata endpoints such as 169.254.169.254), multicast, reserved and public
 * addresses are always rejected — LocalShare is not a general-purpose proxy.
 */
export function validateLocalHost(input: unknown, options: LocalTargetOptions = {}): ValidationResult<Omit<LocalTarget, 'port'>> {
  if (typeof input !== 'string') return { ok: false, error: 'Host must be a string.' };
  const raw = input.trim().toLowerCase();
  if (raw.length === 0) return { ok: false, error: 'Host is required.' };
  if (raw.length > 64 || /[\s/\\?#@]/.test(raw)) {
    return { ok: false, error: 'Host must be a bare hostname or IP address without scheme, path or credentials.' };
  }
  if (raw === 'localhost') return { ok: true, value: { host: 'localhost', scope: 'loopback' } };
  const host = stripBrackets(raw);
  const cls = classifyIp(host);
  if (cls === undefined) {
    return {
      ok: false,
      error: 'Only "localhost" or an IP address can be shared. Hostnames are rejected to prevent DNS-rebinding and SSRF.',
    };
  }
  switch (cls) {
    case 'loopback':
      return { ok: true, value: { host: host.includes(':') ? '::1' : host, scope: 'loopback' } };
    case 'unspecified':
      // 0.0.0.0 / :: are bind addresses, not destinations. Normalise to loopback.
      return { ok: true, value: { host: host.includes(':') ? '::1' : '127.0.0.1', scope: 'loopback' } };
    case 'private':
      if (options.allowLanTargets) return { ok: true, value: { host, scope: 'lan' } };
      return {
        ok: false,
        error: 'LAN addresses are disabled. Enable "localshare.security.allowLanTargets" to share another device on your network.',
      };
    case 'linkLocal':
      return { ok: false, error: 'Link-local addresses (e.g. cloud metadata endpoints) can never be shared.' };
    default:
      return { ok: false, error: `Address class "${cls}" cannot be shared. LocalShare only forwards to local services.` };
  }
}

export function validateLocalTarget(host: unknown, port: unknown, options: LocalTargetOptions = {}): ValidationResult<LocalTarget> {
  const h = validateLocalHost(host, options);
  if (!h.ok) return h;
  const p = validatePort(port);
  if (!p.ok) return p;
  return { ok: true, value: { ...h.value, port: p.value } };
}

/** Format host:port for URLs, bracketing IPv6. */
export function formatHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}
