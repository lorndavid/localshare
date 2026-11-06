/**
 * Request ID and structured JSON access logging middleware.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { redactSecrets } from '@localshare/validation';

const SAFE_REQ_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export function requestIdMiddleware(
  req: Request & { requestId?: string },
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && SAFE_REQ_ID_RE.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const started = Date.now();
  res.on('finish', () => {
    if (process.env.NODE_ENV === 'test') return;
    const entry = {
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      requestId,
      method: req.method,
      path: redactSecrets(req.originalUrl || req.url),
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
  });

  next();
}

