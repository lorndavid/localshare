/**
 * Global exception filter returning consistent `ApiErrorBody` responses with request IDs and
 * automatic secret redaction.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { ApiErrorBody } from '@localshare/shared-types';
import { redactSecrets } from '@localshare/validation';
import type { Request, Response } from 'express';

@Catch()
export class GlobalApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = req.requestId ?? 'unknown';

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message = 'An unexpected error occurred.';
    let details: Array<{ field?: string; message: string }> | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        message = resp;
        error = HttpStatus[statusCode] ?? 'Error';
      } else if (resp && typeof resp === 'object') {
        const obj = resp as Record<string, unknown>;
        error = typeof obj.error === 'string' ? obj.error : (HttpStatus[statusCode] ?? 'Error');
        if (Array.isArray(obj.message)) {
          details = obj.message.map((m) => ({ message: redactSecrets(String(m)) }));
          message = details.map((d) => d.message).join('; ');
        } else if (typeof obj.message === 'string') {
          message = obj.message;
        }
        if (Array.isArray(obj.details)) {
          details = obj.details as Array<{ field?: string; message: string }>;
        }
      }
    }

    const body: ApiErrorBody = {
      statusCode,
      error: redactSecrets(error),
      message: redactSecrets(message),
      requestId,
      ...(details ? { details } : {}),
    };

    res.setHeader('X-Request-Id', requestId);
    res.status(statusCode).json(body);
  }
}

