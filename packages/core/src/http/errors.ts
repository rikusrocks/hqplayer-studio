import type { ApiError, ApiErrorCode } from '@hqps/contracts';
import { EngineError } from '@hqps/hqplayer-adapter';
import { LibraryError } from '@hqps/library';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function toApiError(err: unknown): { status: number; body: ApiError } {
  const body = (code: ApiErrorCode, message: string, details?: unknown): ApiError => ({
    error: details === undefined ? { code, message } : { code, message, details },
  });
  if (err instanceof HttpError)
    return { status: err.status, body: body(err.code, err.message, err.details) };
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: body(
        'invalid_request',
        'Request validation failed',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
    };
  }
  if (err instanceof LibraryError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400;
    return { status, body: body(err.code, err.message, err.details) };
  }
  if (err instanceof EngineError) {
    switch (err.code) {
      case 'engine_unavailable':
        return { status: 503, body: body('engine_unavailable', err.message) };
      case 'engine_timeout':
        return {
          status: 504,
          body: body(
            'engine_timeout',
            `${err.message}. The command was not retried; check HQPlayer before trying again.`,
          ),
        };
      case 'capability_unavailable':
        return { status: 409, body: body('capability_unavailable', err.message) };
      default:
        return { status: 502, body: body('engine_error', err.message) };
    }
  }
  const fe = err as FastifyError;
  if (fe && typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
    return { status: fe.statusCode, body: body('invalid_request', fe.message) };
  }
  return { status: 500, body: body('internal_error', 'Internal error') };
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  const { status, body } = toApiError(err);
  if (status >= 500 && status !== 503 && status !== 504 && status !== 502) {
    req.log.error({ err }, 'request failed');
  }
  void reply.status(status).send(body);
}
