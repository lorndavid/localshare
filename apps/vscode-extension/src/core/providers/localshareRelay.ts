/**
 * Layer B — Self-Hosted LocalShare Native WebSocket Tunnel Provider (`*.lorndavid.online`).
 *
 * Connects directly from the VS Code extension to the user's Ubuntu server
 * (`wss://cloud.lorndavid.online/_tunnel/connect`) over WebSocket and proxies
 * incoming visitor HTTP requests to `localhost:<port>`.
 *
 * Requires ZERO `cloudflared` binary and ZERO Cloudflare account on developer machines.
 */
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Duplex } from 'node:stream';
import { validateLocalTarget, type ValidationResult } from '@localshare/validation';
import { LocalShareError } from '../errors';
import type { Logger } from '../logger';
import { TunnelStateMachine } from '../stateMachine';
import type {
  TunnelConnectConfig,
  TunnelConnectionHandle,
  TunnelProvider,
  TunnelStatusSnapshot,
} from './types';

interface RelayRegisteredMsg {
  type: 'registered';
  sessionId: string;
  subdomain: string;
  publicUrl: string;
}

interface RelayHttpRequestMsg {
  type: 'http_request';
  reqId: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  bodyBase64: string;
}

/** Encode a Client-to-Server masked RFC 6455 WebSocket frame. */
function encodeClientWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const maskKey = randomBytes(4);
  let header: Buffer;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  const maskedPayload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = payload[i]! ^ maskKey[i & 3]!;
  }

  return Buffer.concat([header, maskKey, maskedPayload]);
}

/** Parse one Server-to-Client RFC 6455 WebSocket frame from a buffer. */
function tryReadServerWsFrame(buf: Buffer): {
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
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + payloadLen) return null;

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

  return { opcode, fin, payload, bytesConsumed: offset + payloadLen };
}

class ActiveRelayTunnel implements TunnelConnectionHandle {
  readonly id: string;
  private readonly sm = new TunnelStateMachine('STOPPED');
  private readonly listeners = new Set<(s: TunnelStatusSnapshot) => void>();
  private socket: Duplex | undefined;
  private publicUrl: string | undefined;
  private startedAt: string | undefined;
  private lastError: string | undefined;
  private reconnectAttempts = 0;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: TunnelConnectConfig,
    private readonly getRelayEndpoint: () => string,
    private readonly logger: Logger,
    private readonly onRemoved: (id: string) => void,
  ) {
    this.id = config.id;
  }

  getStatus(): TunnelStatusSnapshot {
    return {
      id: this.id,
      provider: 'localshare',
      kind: this.config.kind,
      state: this.sm.state,
      publicUrl: this.publicUrl,
      pid: process.pid,
      startedAt: this.startedAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  getPublicUrl(): string | undefined {
    return this.publicUrl;
  }

  onStatusChange(listener: (snapshot: TunnelStatusSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snap = this.getStatus();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        // Ignore listener errors
      }
    }
  }

  async start(): Promise<void> {
    this.sm.transition('STARTING');
    this.emit();
    this.sm.transition('CONNECTING');
    this.emit();
    await this.openWebSocket(true);
  }

  private openWebSocket(isInitial: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const endpointBase = this.getRelayEndpoint().replace(/\/+$/, '');
      let parsed: URL;
      try {
        parsed = new URL(endpointBase);
      } catch {
        parsed = new URL('https://cloud.lorndavid.online');
      }

      const isSecure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
      const connectUrl = new URL('/_tunnel/connect', isSecure ? `https://${parsed.host}` : `http://${parsed.host}`);
      if (this.config.hostname) {
        connectUrl.searchParams.set('subdomain', this.config.hostname);
      }

      const wsKey = randomBytes(16).toString('base64');
      const requestFn = isSecure ? https.request : http.request;
      const timeoutMs = this.config.startupTimeoutMs ?? 30_000;

      let settled = false;
      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy();
        const err = new LocalShareError(
          'TUNNEL_STARTUP_TIMEOUT',
          `Timed out connecting to LocalShare Relay (${connectUrl.host}).`,
        );
        if (isInitial) {
          this.lastError = err.message;
          this.sm.forceState('ERROR');
          this.emit();
          reject(err);
        }
      }, timeoutMs);

      const req = requestFn(
        connectUrl,
        {
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': wsKey,
          },
        },
        (res) => {
          clearTimeout(startupTimer);
          if (settled) return;
          settled = true;
          const err = new LocalShareError(
            'PROVIDER_ERROR',
            `LocalShare Relay rejected WebSocket upgrade with HTTP ${res.statusCode ?? 500}.`,
          );
          this.lastError = err.message;
          this.sm.forceState('ERROR');
          this.emit();
          reject(err);
        },
      );

      req.on('upgrade', (_res, socket, head) => {
        this.socket = socket;
        let recvBuf: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
        let fragChunks: Buffer[] = [];

        socket.on('data', (chunk: Buffer) => {
          recvBuf = Buffer.concat([recvBuf, chunk]);
          try {
            while (true) {
              const frame = tryReadServerWsFrame(recvBuf);
              if (!frame) break;
              recvBuf = recvBuf.subarray(frame.bytesConsumed);

              if (frame.opcode === 0x8) {
                socket.end();
                return;
              }
              if (frame.opcode === 0x9) {
                socket.write(encodeClientWsFrame(0x0a, frame.payload));
                continue;
              }
              if (frame.opcode === 0x0a) {
                continue;
              }
              if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
                fragChunks.push(frame.payload);
                if (frame.fin) {
                  const full = Buffer.concat(fragChunks);
                  fragChunks = [];
                  const text = full.toString('utf8');
                  this.handleServerMessage(text, () => {
                    if (!settled) {
                      settled = true;
                      clearTimeout(startupTimer);
                      resolve();
                    }
                  });
                }
              }
            }
          } catch (e) {
            this.logger.warn('LocalShare Relay WebSocket frame error', { error: String(e) });
            socket.destroy();
          }
        });

        socket.on('close', () => {
          if (this.stopping) return;
          if (this.config.autoReconnect !== false && this.publicUrl) {
            this.reconnectAttempts += 1;
            this.sm.forceState('RECONNECTING');
            this.emit();
            this.reconnectTimer = setTimeout(() => {
              void this.openWebSocket(false).catch(() => undefined);
            }, 2500);
          } else if (!settled) {
            settled = true;
            clearTimeout(startupTimer);
            const err = new LocalShareError(
              'TUNNEL_PROCESS_EXITED',
              'Connection to LocalShare Relay closed before registration completed.',
            );
            this.lastError = err.message;
            this.sm.forceState('ERROR');
            this.emit();
            reject(err);
          }
        });

        socket.on('error', (err) => {
          this.logger.warn('LocalShare Relay socket error', { error: err.message });
        });
      });

      req.on('error', (err) => {
        clearTimeout(startupTimer);
        if (settled) return;
        settled = true;
        this.lastError = err.message;
        if (isInitial) {
          this.sm.forceState('ERROR');
          this.emit();
          reject(
            new LocalShareError(
              'PROVIDER_ERROR',
              `Could not reach LocalShare Relay (${connectUrl.host}): ${err.message}`,
            ),
          );
        }
      });

      req.end();
    });
  }

  private handleServerMessage(rawJson: string, onRegistered: () => void): void {
    try {
      const parsed = JSON.parse(rawJson) as RelayRegisteredMsg | RelayHttpRequestMsg;
      if (parsed.type === 'registered') {
        this.publicUrl = parsed.publicUrl;
        // Preserve requested subdomain on reconnect so the URL never changes during the session
        this.config.hostname = parsed.subdomain;
        if (!this.startedAt) {
          this.startedAt = new Date().toISOString();
        }
        this.lastError = undefined;
        this.sm.forceState('ONLINE');
        this.emit();
        onRegistered();
        return;
      }

      if (parsed.type === 'http_request') {
        void this.forwardToLocalhost(parsed);
      }
    } catch {
      // Ignore invalid JSON
    }
  }

  private async forwardToLocalhost(msg: RelayHttpRequestMsg): Promise<void> {
    const targetPort = this.config.localPort;
    const originPort = this.config.originPort ?? targetPort;
    const headers: Record<string, string | string[]> = {};

    for (const [k, v] of Object.entries(msg.headers || {})) {
      if (v === undefined) continue;
      const lower = k.toLowerCase();
      if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') {
        continue;
      }
      headers[k] = v;
    }

    if (this.config.rewriteHostHeader !== false) {
      headers['host'] = `localhost:${originPort}`;
    }

    const reqBody = msg.bodyBase64 ? Buffer.from(msg.bodyBase64, 'base64') : Buffer.alloc(0);
    if (reqBody.length > 0) {
      headers['content-length'] = String(reqBody.length);
    }

    const sendResponse = (
      statusCode: number,
      resHeaders: Record<string, string | string[]>,
      body: Buffer,
    ) => {
      if (!this.socket || this.socket.destroyed) return;
      const reply = JSON.stringify({
        type: 'http_response',
        reqId: msg.reqId,
        statusCode,
        headers: resHeaders,
        bodyBase64: body.toString('base64'),
      });
      try {
        this.socket.write(encodeClientWsFrame(0x1, Buffer.from(reply, 'utf8')));
      } catch {
        // Socket closed
      }
    };

    const proxyReq = http.request(
      {
        hostname: this.config.localHost || '127.0.0.1',
        port: targetPort,
        path: msg.url || '/',
        method: msg.method || 'GET',
        headers,
        timeout: 25_000,
      },
      (proxyRes) => {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        proxyRes.on('end', () => {
          const cleanHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (v !== undefined) cleanHeaders[k] = v;
          }
          sendResponse(proxyRes.statusCode ?? 200, cleanHeaders, Buffer.concat(chunks));
        });
      },
    );

    proxyReq.on('error', (err) => {
      sendResponse(
        502,
        { 'content-type': 'text/plain; charset=utf-8' },
        Buffer.from(`LocalShare could not reach local server on port ${targetPort}: ${err.message}`),
      );
    });

    if (reqBody.length > 0) {
      proxyReq.write(reqBody);
    }
    proxyReq.end();
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.sm.forceState('STOPPING');
    this.emit();
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.end(encodeClientWsFrame(0x8, Buffer.alloc(0)));
        this.socket.destroy();
      } catch {
        // Ignore
      }
    }
    this.sm.forceState('STOPPED');
    this.emit();
    this.onRemoved(this.id);
  }
}

export class LocalShareRelayProvider implements TunnelProvider {
  readonly id = 'localshare' as const;
  private readonly tunnels = new Map<string, ActiveRelayTunnel>();

  constructor(
    private readonly getRelayEndpoint: () => string,
    private readonly logger: Logger,
    private readonly allowLanTargets: () => boolean = () => false,
  ) {}

  validateConfiguration(config: TunnelConnectConfig): ValidationResult<TunnelConnectConfig> {
    const targetRes = validateLocalTarget(config.localHost, config.localPort, {
      allowLanTargets: this.allowLanTargets(),
    });
    if (!targetRes.ok) {
      return targetRes;
    }
    return { ok: true, value: config };
  }

  async connect(config: TunnelConnectConfig): Promise<TunnelConnectionHandle> {
    const valid = this.validateConfiguration(config);
    if (!valid.ok) {
      throw new LocalShareError('INVALID_TARGET', valid.error);
    }
    const existing = this.tunnels.get(config.id);
    if (existing) {
      await existing.disconnect();
    }

    const tunnel = new ActiveRelayTunnel(
      config,
      this.getRelayEndpoint,
      this.logger,
      (id) => this.tunnels.delete(id),
    );
    this.tunnels.set(config.id, tunnel);
    await tunnel.start();
    return tunnel;
  }

  async disconnect(tunnelId: string): Promise<void> {
    const t = this.tunnels.get(tunnelId);
    if (t) {
      await t.disconnect();
    }
  }

  getStatus(tunnelId: string): TunnelStatusSnapshot | undefined {
    return this.tunnels.get(tunnelId)?.getStatus();
  }

  getPublicUrl(tunnelId: string): string | undefined {
    return this.tunnels.get(tunnelId)?.getPublicUrl();
  }

  listTunnels(): TunnelStatusSnapshot[] {
    return [...this.tunnels.values()].map((t) => t.getStatus());
  }
}

