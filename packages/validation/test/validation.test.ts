import { describe, expect, it } from 'vitest';
import {
  candidateZones,
  classifyIp,
  detectNonHttpBanner,
  formatHostPort,
  getSensitiveProcess,
  getSensitiveService,
  isHostnameInZone,
  parseIPv6,
  redactSecrets,
  validateDescription,
  validateEmail,
  validateGatewayPassword,
  validateHostname,
  validateLabel,
  validateLocalHost,
  validateLocalTarget,
  validatePort,
  validateTunnelName,
} from '../src';

describe('validatePort', () => {
  it.each([1, 80, 3000, 65535, '5173', ' 8080 '])('accepts %s', (p) => {
    expect(validatePort(p).ok).toBe(true);
  });
  it.each([0, -1, 65536, 3.5, NaN, '', 'abc', '80a', '+80', '0x50', '1e3', '99999', '80; rm -rf /', null, undefined, {}])(
    'rejects %s',
    (p) => {
      expect(validatePort(p).ok).toBe(false);
    },
  );
});

describe('classifyIp', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.10.20.30', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.10', 'private'],
    ['169.254.169.254', 'linkLocal'],
    ['fe80::1', 'linkLocal'],
    ['fd00::1', 'private'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'linkLocal'],
    ['8.8.8.8', 'public'],
    ['2606:4700::1111', 'public'],
    ['224.0.0.1', 'multicast'],
    ['100.64.0.1', 'reserved'],
  ])('%s → %s', (ip, cls) => {
    expect(classifyIp(ip)).toBe(cls);
  });
  it.each(['localhost', '127.1', '0177.0.0.1', '256.0.0.1', '1.2.3', 'example.com', ':::1', '1::2::3'])('%s is not an IP literal', (ip) => {
    expect(classifyIp(ip)).toBeUndefined();
  });
  it('expands IPv6', () => {
    expect(parseIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });
});

describe('validateLocalHost (SSRF protection)', () => {
  it('accepts loopback hosts', () => {
    expect(validateLocalHost('localhost')).toEqual({ ok: true, value: { host: 'localhost', scope: 'loopback' } });
    expect(validateLocalHost('127.0.0.1')).toMatchObject({ ok: true });
    expect(validateLocalHost('[::1]')).toEqual({ ok: true, value: { host: '::1', scope: 'loopback' } });
  });
  it('normalises bind-any addresses to loopback', () => {
    expect(validateLocalHost('0.0.0.0')).toEqual({ ok: true, value: { host: '127.0.0.1', scope: 'loopback' } });
  });
  it('rejects metadata endpoints and public addresses', () => {
    expect(validateLocalHost('169.254.169.254').ok).toBe(false);
    expect(validateLocalHost('8.8.8.8').ok).toBe(false);
    expect(validateLocalHost('::ffff:169.254.169.254').ok).toBe(false);
  });
  it('rejects arbitrary hostnames (DNS rebinding)', () => {
    expect(validateLocalHost('evil.example.com').ok).toBe(false);
    expect(validateLocalHost('localtest.me').ok).toBe(false);
  });
  it('rejects URL-ish and injected input', () => {
    for (const bad of ['http://localhost', 'localhost/admin', 'user@localhost', 'localhost?x', '127.0.0.1 && calc', '', '   ', 42]) {
      expect(validateLocalHost(bad).ok).toBe(false);
    }
  });
  it('only allows LAN when enabled', () => {
    expect(validateLocalHost('192.168.1.5').ok).toBe(false);
    expect(validateLocalHost('192.168.1.5', { allowLanTargets: true })).toEqual({ ok: true, value: { host: '192.168.1.5', scope: 'lan' } });
  });
  it('validates full targets', () => {
    expect(validateLocalTarget('localhost', '3000')).toEqual({ ok: true, value: { host: 'localhost', port: 3000, scope: 'loopback' } });
    expect(validateLocalTarget('localhost', 0).ok).toBe(false);
  });
  it('formats IPv6 host:port', () => {
    expect(formatHostPort('::1', 80)).toBe('[::1]:80');
    expect(formatHostPort('127.0.0.1', 80)).toBe('127.0.0.1:80');
  });
});

describe('validateHostname', () => {
  it.each(['preview.customer.com', 'Dev.Customer.COM', 'project-a.customer.co.uk', 'a.io', 'preview.customer.com.', 'xn--bcher-kva.de'])('accepts %s', (h) => {
    expect(validateHostname(h).ok).toBe(true);
  });
  it('normalises case, trailing dot and IDN', () => {
    expect(validateHostname('Preview.Customer.com.')).toEqual({ ok: true, value: 'preview.customer.com' });
    expect(validateHostname('bücher.de')).toEqual({ ok: true, value: 'xn--bcher-kva.de' });
  });
  it.each([
    'localhost',
    'com',
    '*.customer.com',
    'https://preview.customer.com',
    'preview.customer.com:443',
    'preview.customer.com/path',
    '-bad.customer.com',
    'bad-.customer.com',
    'a..b.com',
    '127.0.0.1',
    'app.local',
    'app.internal',
    'preview.customer.com; rm -rf /',
    'preview.customer.com\nHost: evil',
    '$(whoami).customer.com',
    'a'.repeat(64) + '.com',
    `${'a.'.repeat(130)}com`,
    'user@customer.com',
    '',
  ])('rejects %s', (h) => {
    expect(validateHostname(h).ok).toBe(false);
  });
  it('checks zone membership label-wise', () => {
    expect(isHostnameInZone('preview.customer.com', 'customer.com')).toBe(true);
    expect(isHostnameInZone('customer.com', 'customer.com')).toBe(true);
    expect(isHostnameInZone('evilcustomer.com', 'customer.com')).toBe(false);
  });
  it('lists candidate zones', () => {
    expect(candidateZones('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com']);
  });
});

describe('validateEmail', () => {
  it('accepts and normalises', () => {
    expect(validateEmail(' Jane@Customer.com ')).toEqual({ ok: true, value: 'jane@customer.com' });
  });
  it.each(['jane', 'jane@', '@customer.com', 'jane@customer', 'jane@cust omer.com'])('rejects %s', (e) => {
    expect(validateEmail(e).ok).toBe(false);
  });
});

describe('sensitive services', () => {
  it.each([22, 3306, 5432, 6379, 27017, 2375, 1433])('flags port %i', (p) => {
    expect(getSensitiveService(p)).toBeDefined();
  });
  it.each([3000, 5173, 8080, 4200, 8000])('does not flag dev port %i', (p) => {
    expect(getSensitiveService(p)).toBeUndefined();
  });
  it('flags sensitive processes', () => {
    expect(getSensitiveProcess('postgres.exe')).toBe('PostgreSQL');
    expect(getSensitiveProcess('node.exe')).toBeUndefined();
  });
  it('detects protocol banners', () => {
    expect(detectNonHttpBanner('SSH-2.0-OpenSSH_9.6')).toBe('SSH');
    expect(detectNonHttpBanner('-NOAUTH Authentication required.')).toBe('Redis');
    expect(detectNonHttpBanner(new Uint8Array([0x4a, 0, 0, 0, 10, 0x38, 0x2e]))).toBe('MySQL/MariaDB');
    expect(detectNonHttpBanner('HTTP/1.1 200 OK')).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('redacts bearer tokens and headers', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });
  it('redacts tunnel tokens', () => {
    const token = 'eyJhIjoiYWJjZGVmIiwidCI6IjEyMzQ1Njc4OTAiLCJzIjoic2VjcmV0c2VjcmV0In0=';
    expect(redactSecrets(`cloudflared tunnel run --token ${token}`)).not.toContain(token);
  });
  it('redacts key=value secrets and URL credentials', () => {
    const out = redactSecrets('password=hunter22 api_key: XYZ123 https://bob:s3cret@host/');
    expect(out).not.toContain('hunter22');
    expect(out).not.toContain('XYZ123');
    expect(out).not.toContain('s3cret');
  });
  it('redacts 40-char API tokens and known secrets', () => {
    const cfToken = 'Ab3dEfGhIjKlMnOpQrStUvWxYz0123456789_-Ab';
    expect(redactSecrets(`token ${cfToken}`)).not.toContain(cfToken);
    expect(redactSecrets('the value is pizza-pie', ['pizza-pie'])).toBe('the value is [REDACTED]');
  });
  it('leaves URLs and normal text intact', () => {
    const s = 'Tunnel ready at https://quiet-river-abc.trycloudflare.com for localhost:5173';
    expect(redactSecrets(s)).toBe(s);
  });
});

describe('text validation', () => {
  it('validates labels', () => {
    expect(validateLabel('  My   App ')).toEqual({ ok: true, value: 'My App' });
    expect(validateLabel('').ok).toBe(false);
    expect(validateLabel('<script>').ok).toBe(false);
    expect(validateLabel('x'.repeat(65)).ok).toBe(false);
  });
  it('validates descriptions', () => {
    expect(validateDescription(undefined)).toEqual({ ok: true, value: '' });
    expect(validateDescription('x'.repeat(501)).ok).toBe(false);
  });
  it('validates tunnel names', () => {
    expect(validateTunnelName('localshare-dev_1').ok).toBe(true);
    expect(validateTunnelName('-bad').ok).toBe(false);
    expect(validateTunnelName('a b').ok).toBe(false);
  });
  it('validates gateway passwords', () => {
    expect(validateGatewayPassword('short').ok).toBe(false);
    expect(validateGatewayPassword('long-enough-pass').ok).toBe(true);
  });
});
