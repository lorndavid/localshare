/**
 * LocalShare Self-Hosted WebSocket Tunnel Relay Engine.
 *
 * Allows developers using the LocalShare VS Code extension to expose local ports
 * over `https://<subdomain>.lorndavid.online` directly through the Ubuntu server
 * without requiring `cloudflared` or a Cloudflare account on the developer machine.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const RESERVED_SUBDOMAINS = new Set([
  'cloud',
  'api',
  'www',
  'mail',
  'smtp',
  'imap',
  'admin',
  'dashboard',
  'ns1',
  'ns2',
  'ftp',
  'ssh',
]);

export interface RelayHttpRequestMsg {
  type: 'http_request';
  reqId: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  bodyBase64: string;
}

export interface RelayHttpResponseMsg {
  type: 'http_response';
  reqId: string;
  statusCode: number;
  headers: Record<string, string | string[]>;
  bodyBase64: string;
}

interface PendingHttpRequest {
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

interface ConnectedTunnelSession {
  id: string;
  subdomain: string;
  socket: Duplex;
  createdAt: number;
  pingTimer: NodeJS.Timeout;
  pending: Map<string, PendingHttpRequest>;
}

/** Encode a UTF-8 string or Buffer into an unmasked Server-to-Client RFC 6455 frame. */
export function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Parse one RFC 6455 WebSocket frame from a buffer if complete. */
export function tryReadWsFrame(buf: Buffer): {
  opcode: number;
  fin: boolean;
  payload: Buffer;
  bytesConsumed: number;
} | null {
  if (buf.length < 2) return null;
  const byte0 = buf[0]!;
  const byte1 = buf[1]!;
  const fin = (byte0 & 0x80) !== 0;
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    const bigLen = buf.readBigUInt64BE(2);
    if (bigLen > BigInt(25 * 1024 * 1024)) {
      throw new Error('WebSocket frame exceeds 25MB limit');
    }
    payloadLen = Number(bigLen);
    offset = 10;
  }

  const maskKeyLen = masked ? 4 : 0;
  if (buf.length < offset + maskKeyLen + payloadLen) {
    return null;
  }

  let maskKey: Buffer | undefined;
  if (masked) {
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
  if (masked && maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i]! ^ maskKey[i & 3]!;
    }
  }

  return {
    opcode,
    fin,
    payload,
    bytesConsumed: offset + payloadLen,
  };
}

export class LocalShareTunnelRelay {
  private readonly sessionsBySubdomain = new Map<string, ConnectedTunnelSession>();
  private readonly baseDomain: string;

  constructor(baseDomain = process.env.TUNNEL_BASE_DOMAIN || 'lorndavid.online') {
    this.baseDomain = baseDomain.toLowerCase().replace(/^\.+/, '');
  }

  /** Attach both the WebSocket upgrade listener and the subdomain HTTP proxy interceptor. */
  attach(server: Server): void {
    // 1. Intercept WebSocket upgrade on `/_tunnel/connect`
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/_tunnel/connect') {
        socket.destroy();
        return;
      }
      this.handleUpgrade(req, socket, head, url);
    });

    // 2. Intercept incoming HTTP requests whose Host header is `<subdomain>.<baseDomain>`
    const existingListeners = server.listeners('request') as Array<
      (req: IncomingMessage, res: ServerResponse) => void
    >;
    server.removeAllListeners('request');

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const subdomain = this.extractSubdomain(req);
      if (subdomain) {
        void this.handleVisitorRequest(subdomain, req, res);
        return;
      }
      for (const listener of existingListeners) {
        listener.call(server, req, res);
      }
    });
  }

  private extractSubdomain(req: IncomingMessage): string | null {
    const headerSub = req.headers['x-tunnel-subdomain'];
    if (typeof headerSub === 'string' && headerSub.trim()) {
      const clean = headerSub.trim().toLowerCase();
      if (!RESERVED_SUBDOMAINS.has(clean)) return clean;
    }

    const rawHost = (req.headers.host || '').split(':')[0]?.trim().toLowerCase() ?? '';
    if (!rawHost) return null;

    const suffix = `.${this.baseDomain}`;
    if (rawHost.endsWith(suffix)) {
      const sub = rawHost.slice(0, rawHost.length - suffix.length);
      if (sub && !sub.includes('.') && !RESERVED_SUBDOMAINS.has(sub)) {
        return sub;
      }
    }
    return null;
  }

  private sanitizeRequestedSubdomain(raw: string | null): string | null {
    if (!raw) return null;
    let clean = raw.trim().toLowerCase();
    const suffix = `.${this.baseDomain}`;
    if (clean.endsWith(suffix)) {
      clean = clean.slice(0, clean.length - suffix.length);
    }
    clean = clean.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (clean.length < 3 || clean.length > 42) return null;
    if (RESERVED_SUBDOMAINS.has(clean)) return null;
    return clean;
  }

  private allocateSubdomain(requested: string | null, projectHint: string | null): string {
    const cleanRequested = this.sanitizeRequestedSubdomain(requested);
    if (cleanRequested && !this.sessionsBySubdomain.has(cleanRequested)) {
      return cleanRequested;
    }

    const prefix =
      this.sanitizeRequestedSubdomain(projectHint)?.slice(0, 18) || 'preview';
    for (let i = 0; i < 10; i++) {
      const rand = randomBytes(3).toString('hex');
      const candidate = `${prefix}-${rand}`;
      if (!this.sessionsBySubdomain.has(candidate)) {
        return candidate;
      }
    }
    return `share-${randomBytes(4).toString('hex')}`;
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    const wsKey = req.headers['sec-websocket-key'];
    if (typeof wsKey !== 'string' || !wsKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const requestedSub = url.searchParams.get('subdomain');
    const projectHint = url.searchParams.get('project');
    const forceCustom = url.searchParams.get('strict') === '1';

    if (forceCustom && requestedSub) {
      const cleanReq = this.sanitizeRequestedSubdomain(requestedSub);
      if (!cleanReq) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid or reserved subdomain');
        socket.destroy();
        return;
      }
      if (this.sessionsBySubdomain.has(cleanReq)) {
        socket.write('HTTP/1.1 409 Conflict\r\n\r\nSubdomain is already in use');
        socket.destroy();
        return;
      }
    }

    const subdomain = this.allocateSubdomain(requestedSub, projectHint);
    const acceptKey = createHash('sha1')
      .update(wsKey + WS_GUID)
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n',
      ].join('\r\n'),
    );

    if ('setNoDelay' in socket && typeof (socket as Socket).setNoDelay === 'function') {
      (socket as Socket).setNoDelay(true);
    }

    const sessionId = randomUUID();
    const pingTimer = setInterval(() => {
      try {
        socket.write(encodeWsFrame(0x9, Buffer.from('ping')));
      } catch {
        // Closed socket handled in close listener
      }
    }, 20_000);

    const session: ConnectedTunnelSession = {
      id: sessionId,
      subdomain,
      socket,
      createdAt: Date.now(),
      pingTimer,
      pending: new Map(),
    };
    this.sessionsBySubdomain.set(subdomain, session);

    // Send initial registration event with assigned public URL
    const scheme =
      req.headers['x-forwarded-proto'] === 'http' &&
      (req.headers.host || '').startsWith('localhost')
        ? 'http'
        : 'https';
    const publicUrl = `${scheme}://${subdomain}.${this.baseDomain}`;
    const regMsg = JSON.stringify({
      type: 'registered',
      sessionId,
      subdomain,
      publicUrl,
    });
    socket.write(encodeWsFrame(0x1, Buffer.from(regMsg, 'utf8')));

    let recvBuffer: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let fragChunks: Buffer[] = [];

    const onData = (chunk: Buffer) => {
      recvBuffer = Buffer.concat([recvBuffer, chunk]);
      try {
        while (true) {
          const frame = tryReadWsFrame(recvBuffer);
          if (!frame) break;
          recvBuffer = recvBuffer.subarray(frame.bytesConsumed);

          if (frame.opcode === 0x8) {
            // Close frame
            socket.end(encodeWsFrame(0x8, Buffer.alloc(0)));
            return;
          }
          if (frame.opcode === 0x9) {
            // Ping -> Pong
            socket.write(encodeWsFrame(0x0a, frame.payload));
            continue;
          }
          if (frame.opcode === 0x0a) {
            // Pong
            continue;
          }
          if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
            fragChunks.push(frame.payload);
            if (frame.fin) {
              const fullPayload = Buffer.concat(fragChunks);
              fragChunks = [];
              this.handleClientMessage(session, fullPayload.toString('utf8'));
            }
          }
        }
      } catch {
        socket.destroy();
      }
    };

    const cleanup = () => {
      clearInterval(session.pingTimer);
      if (this.sessionsBySubdomain.get(subdomain)?.id === sessionId) {
        this.sessionsBySubdomain.delete(subdomain);
      }
      for (const [, pending] of session.pending) {
        clearTimeout(pending.timer);
        if (!pending.res.headersSent) {
          pending.res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          pending.res.end('LocalShare tunnel disconnected while processing request.');
        }
      }
      session.pending.clear();
    };

    socket.on('data', onData);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  private handleClientMessage(session: ConnectedTunnelSession, rawJson: string): void {
    try {
      const msg = JSON.parse(rawJson) as RelayHttpResponseMsg;
      if (msg.type !== 'http_response' || !msg.reqId) return;
      const pending = session.pending.get(msg.reqId);
      if (!pending) return;
      session.pending.delete(msg.reqId);
      clearTimeout(pending.timer);

      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(msg.headers || {})) {
        const lower = k.toLowerCase();
        if (
          lower === 'transfer-encoding' ||
          lower === 'connection' ||
          lower === 'keep-alive' ||
          lower === 'content-length'
        ) {
          continue;
        }
        outHeaders[k] = v;
      }

      const bodyBuf = msg.bodyBase64 ? Buffer.from(msg.bodyBase64, 'base64') : Buffer.alloc(0);
      outHeaders['content-length'] = String(bodyBuf.length);

      if (!pending.res.headersSent) {
        pending.res.writeHead(msg.statusCode || 200, outHeaders);
        pending.res.end(bodyBuf);
      }
    } catch {
      // Ignore malformed JSON frames
    }
  }

  private async handleVisitorRequest(
    subdomain: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const session = this.sessionsBySubdomain.get(subdomain);
    if (!session) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"/><title>Tunnel Offline — LocalShare</title>
<style>body{font-family:system-ui,sans-serif;background:#090d16;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:460px;padding:32px;background:#0f172a;border:1px solid #1e293b;border-radius:14px;text-align:center}
code{color:#818cf8;background:#1e1b4b;padding:2px 6px;border-radius:4px}</style></head>
<body><div class="box"><h2>LocalShare Tunnel Offline</h2>
<p>No active VS Code tunnel is currently connected for <code>${subdomain}.${this.baseDomain}</code>.</p>
<p style="color:#94a3b8;font-size:14px">Start sharing in the LocalShare VS Code extension to bring this preview online.</p></div></body></html>`);
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      totalBytes += buf.length;
      if (totalBytes > 15 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Payload Too Large');
        return;
      }
      chunks.push(buf);
    }

    const reqId = randomUUID();
    const timer = setTimeout(() => {
      session.pending.delete(reqId);
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('LocalShare Gateway Timeout: Local development server did not respond within 30s.');
      }
    }, 30_000);

    session.pending.set(reqId, { res, timer });

    const payload: RelayHttpRequestMsg = {
      type: 'http_request',
      reqId,
      method: req.method || 'GET',
      url: req.url || '/',
      headers: req.headers,
      bodyBase64: Buffer.concat(chunks).toString('base64'),
    };

    try {
      session.socket.write(encodeWsFrame(0x1, Buffer.from(JSON.stringify(payload), 'utf8')));
    } catch {
      clearTimeout(timer);
      session.pending.delete(reqId);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Failed to forward request to tunnel client.');
      }
    }
  }
}

