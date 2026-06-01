import type { FastifyRequest } from 'fastify';
import type { ProxyLifecycleHooks, ProxyError, ProxyContext } from './types.js';
import type { RouteMatch } from '../routing/types.js';

/**
 * Context builder for proxy hooks.
 */
export function buildProxyContext(
  request: FastifyRequest,
  routeMatch: RouteMatch,
  startTime?: bigint
): ProxyContext {
  return {
    request,
    routeMatch,
    startTime: startTime ?? process.hrtime.bigint(),
  };
}

/**
 * Creates a proxy error from an exception.
 */
export function createProxyError(
  error: unknown,
  backend: string,
  statusCode?: number
): ProxyError {
  if (error instanceof Error) {
    const code = mapErrorToCode(error);
    return {
      code,
      message: error.message,
      backend,
      statusCode: statusCode ?? mapCodeToStatusCode(code),
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: String(error),
    backend,
    statusCode: statusCode ?? 502,
  };
}

/**
 * Maps Node.js error codes to proxy error codes.
 */
export function mapErrorToCode(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;

  switch (code) {
    case 'ECONNREFUSED':
      return 'ECONNREFUSED';
    case 'ETIMEDOUT':
      return 'ETIMEDOUT';
    case 'ECONNRESET':
      return 'ECONNRESET';
    case 'ENOTFOUND':
      return 'ENOTFOUND';
    case 'EAI_AGAIN':
      return 'EAI_AGAIN';
    case 'EPIPE':
      return 'EPIPE';
    case 'EINVAL':
      return 'EINVAL';
    default:
      return 'PROXY_ERROR';
  }
}

/**
 * Maps error codes to HTTP status codes.
 */
export function mapCodeToStatusCode(code: string): number {
  switch (code) {
    case 'ECONNREFUSED':
      return 502;
    case 'ETIMEDOUT':
      return 504;
    case 'ECONNRESET':
      return 502;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 502;
    case 'EPIPE':
    case 'EINVAL':
      return 400;
    default:
      return 502;
  }
}

/**
 * Builds error response for the client.
 */
export function buildErrorResponse(
  reply: { status: (code: number) => { send: (body: object) => void } },
  statusCode: number,
  error: string,
  message: string
): void {
  reply.status(statusCode).send({
    error,
    message,
    statusCode,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Default no-op hooks for convenience.
 */
export const NOOP_HOOKS: ProxyLifecycleHooks = {};