/**
 * Local password-protection gateway for temporary or named shares.
 *
 * Listens strictly on 127.0.0.1:0 (loopback only) and forwards authenticated HTTP and WebSocket
 * traffic (including HMR upgrades) to the developer's local server.
 *
 * Uses constant-time password comparison (crypto.timingSafeEqual) and issues an HttpOnly
 * HMAC-signed session cookie after authentication so subsequent asset/WebSocket requests work
 * smoothly across all browsers.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';

export interface PasswordGatewayOptions {
  targetHost: string;
  targetPort: number;
  username: string;
  password: string;
  sessionHours?: number;
  rewriteHostHeader?: boolean;
  onAuthFailure?: (remoteAddress?: string) => void;
}

const COOKIE_NAME = '__localshare_auth';

function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export class LocalPasswordGateway {
  private server: http.Server | undefined;
  private readonly sessionSecret = randomBytes(32);
  private readonly sockets = new Set<Duplex>();
  private boundPort = 0;

  constructor(private readonly options: PasswordGatewayOptions) {}

  get listenPort(): number {
    return this.boundPort;
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;

    const srv = http.createServer((req, res) => this.handleHttp(req, res));
    srv.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    srv.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.boundPort = addr.port;
          resolve();
        } else {
          reject(new Error('Failed to bind local password gateway'));
        }
      });
    });

    this.server = srv;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = undefined;
    if (!srv) return;
    for (const s of this.sockets) {
      s.destroy();
    }
    this.sockets.clear();
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private signToken(expiresAtMs: number): string {
    const payload = `${this.options.username}.${expiresAtMs}`;
    const sig = createHmac('sha256', this.sessionSecret).update(payload).digest('base64url');
    return `${expiresAtMs}.${sig}`;
  }

  private verifyCookie(cookieHeader: string | undefined): boolean {
    if (!cookieHeader) return false;
    for (const part of cookieHeader.split(';')) {
      const [k, v] = part.trim().split('=');
      if (k !== COOKIE_NAME || !v) continue;
      const dot = v.indexOf('.');
      if (dot < 0) continue;
      const exp = Number(v.slice(0, dot));
      if (!Number.isFinite(exp) || exp < Date.now()) continue;
      const expected = this.signToken(exp);
      if (constantTimeEquals(v, expected)) return true;
    }
    return false;
  }

  private verifyBasicHeader(authHeader: string | undefined): boolean {
    if (!authHeader || !/^basic\s+/i.test(authHeader)) return false;
    const encoded = authHeader.replace(/^basic\s+/i, '').trim();
    let decoded: string;
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return false;
    }
    const colon = decoded.indexOf(':');
    if (colon < 0) return false;
    const user = decoded.slice(0, colon);
    const pass = decoded.slice(colon + 1);
    const userOk = constantTimeEquals(user, this.options.username);
    const passOk = constantTimeEquals(pass, this.options.password);
    return userOk && passOk;
  }

  private authenticate(req: http.IncomingMessage): { ok: boolean; issueCookie: boolean } {
    if (this.verifyCookie(req.headers.cookie)) {
      return { ok: true, issueCookie: false };
    }
    if (this.verifyBasicHeader(req.headers.authorization)) {
      return { ok: true, issueCookie: true };
    }
    return { ok: false, issueCookie: false };
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const auth = this.authenticate(req);
    if (!auth.ok) {
      this.options.onAuthFailure?.(req.socket.remoteAddress);
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="LocalShare Protected Preview", charset="UTF-8"',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('Authentication required to view this LocalShare preview.');
      return;
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.authorization;
    if (this.options.rewriteHostHeader !== false) {
      headers.host = `localhost:${this.options.targetPort}`;
    }

    const upstream = http.request(
      {
        host: this.options.targetHost,
        port: this.options.targetPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (upRes) => {
        const outHeaders: http.OutgoingHttpHeaders = { ...upRes.headers };
        if (auth.issueCookie) {
          const ttlSec = Math.max(1, (this.options.sessionHours ?? 12) * 3600);
          const token = this.signToken(Date.now() + ttlSec * 1000);
          const cookie = `${COOKIE_NAME}=${token}; Max-Age=${ttlSec}; Path=/; HttpOnly; SameSite=Lax`;
          const prev = outHeaders['set-cookie'];
          outHeaders['set-cookie'] = Array.isArray(prev)
            ? [...prev, cookie]
            : prev
              ? [String(prev), cookie]
              : [cookie];
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(res);
      },
    );

    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('LocalShare: local target server is not responding.');
    });

    req.pipe(upstream);
  }

  private handleUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const auth = this.authenticate(req);
    if (!auth.ok) {
      this.options.onAuthFailure?.(req.socket.remoteAddress);
      clientSocket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(this.options.targetPort, this.options.targetHost, () => {
      const lines: string[] = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i] ?? '';
        const v = req.rawHeaders[i + 1] ?? '';
        if (k.toLowerCase() === 'authorization') continue;
        if (k.toLowerCase() === 'host' && this.options.rewriteHostHeader !== false) {
          lines.push(`Host: localhost:${this.options.targetPort}`);
        } else {
          lines.push(`${k}: ${v}`);
        }
      }
      lines.push('', '');
      upstream.write(lines.join('\r\n'));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
    upstream.once('close', () => clientSocket.destroy());
    clientSocket.once('close', () => upstream.destroy());
  }
}
