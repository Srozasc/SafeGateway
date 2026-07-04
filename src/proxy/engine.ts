import { URL } from 'url';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'undici';
import { Logger } from 'pino';
import type { RouteMatch } from '../routing/types.js';
import { ConnectionPoolManager } from './pool.js';
import type { ProxyLifecycleHooks, ProxyContext, ProxyError, ProxyTimeoutConfig } from './types.js';
import {
  buildProxyContext,
  createProxyError,
  buildErrorResponse,
} from './hooks.js';
import { buildForwardingHeaders } from './headers.js';

/**
 * Core proxy engine that forwards requests to backends using undici.
 * Supports streaming, timeouts, and lifecycle hooks.
 */
export class ProxyEngine {
  private readonly poolManager: ConnectionPoolManager;
  private readonly hooks: ProxyLifecycleHooks;
  private readonly logger: Logger;
  private readonly defaultTimeout = {
    connect: 5000,
    headers: 30000,
    body: 60000,
  };

  constructor(
    poolManager: ConnectionPoolManager,
    hooks: ProxyLifecycleHooks,
    logger: Logger
  ) {
    this.poolManager = poolManager;
    this.hooks = hooks;
    this.logger = logger;
  }

  /**
   * Forwards the request to the configured backend.
   * Supports streaming of response directly to client.
   */
  async forward(
    request: FastifyRequest,
    reply: FastifyReply,
    routeMatch: RouteMatch
  ): Promise<void> {
    const context = buildProxyContext(request, routeMatch);
    const { route } = routeMatch;
    const backend = route.target;
    const stripPrefix = route.stripPrefix ?? false;

    // Build the target path
    // Use a dummy base since request.url may be relative (e.g., '/api/users')
    const url = new URL(request.url, 'http://localhost');
    let targetPath = url.pathname;

    if (stripPrefix && targetPath.startsWith(route.prefix)) {
      targetPath = targetPath.slice(route.prefix.length) || '/';
    }

    // Build headers
    const forwardingHeaders = buildForwardingHeaders(request);
    const requestId = this.generateRequestId();
    (forwardingHeaders as Record<string, string>)['x-request-id'] = requestId;

    // Get timeout config
    const routeTimeout = route.timeout;
    const timeout: ProxyTimeoutConfig = {
      connect: routeTimeout?.connect ?? this.defaultTimeout.connect,
      headers: routeTimeout?.headers ?? this.defaultTimeout.headers,
      body: routeTimeout?.body ?? this.defaultTimeout.body,
    };

    // Build proxy headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers as Record<string, string | string[] | undefined>)) {
      if (value === undefined || key.toLowerCase() === 'host') {continue;}
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }

    // Add forwarding headers
    for (const [key, value] of Object.entries(forwardingHeaders)) {
      if (value !== undefined) {
        headers[key] = value;
      }
    }

    // Call onBeforeRequest hook
    if (this.hooks.onBeforeRequest) {
      try {
        await this.hooks.onBeforeRequest(
          {
            backend,
            method: request.method,
            path: targetPath,
            query: url.search || undefined,
            headers,
            timeout,
          },
          context
        );
      } catch (error) {
        this.logger.error(
          { error, backend, path: targetPath },
          'onBeforeRequest hook failed'
        );
      }
    }

    // Get pool for this backend
    const pool = this.poolManager.getPool(backend);

    // Build the request path
    const requestPath = `${targetPath}${url.search}`;

    // Execute the request
    try {
      const response = await this.executeRequest(pool, {
        method: request.method,
        path: requestPath,
        headers,
        timeout,
      }, request.body);

      // Call onBeforeResponse hook
      if (this.hooks.onBeforeResponse) {
        try {
          await this.hooks.onBeforeResponse(
            {
              statusCode: response.statusCode,
              headers: response.headers as Record<string, string | string[]>,
              backend,
            },
            context
          );
        } catch (error) {
          this.logger.error({ error, backend }, 'onBeforeResponse hook failed');
        }
      }

      // Send response to client
      await this.sendResponse(response, reply);
    } catch (error) {
      const proxyError = createProxyError(error, backend);
      await this.handleError(proxyError, reply, context);
    }
  }

  /**
   * Executes the request through the pool using request() with Promise.
   */
  private executeRequest(
    pool: Pool,
    options: {
      method: string;
      path: string;
      headers: Record<string, string>;
      timeout: { connect?: number; headers?: number; body?: number };
    },
    requestBody?: unknown
  ): Promise<{ statusCode: number; headers: Record<string, string | string[]>; body: Buffer | string | null }> {
    const maxTimeout = Math.max(
      options.timeout.connect ?? 5000,
      options.timeout.headers ?? 30000,
      options.timeout.body ?? 60000
    );

    // Include body if present and this is not a GET/HEAD request
    const isBodyRequest = requestBody !== undefined && !['GET', 'HEAD'].includes(options.method);
    const bodyStr = isBodyRequest
      ? (typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody))
      : undefined;

    return pool.request({
      method: options.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD',
      path: options.path,
      headers: options.headers,
      bodyTimeout: maxTimeout,
      headersTimeout: maxTimeout,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
    }).then(async ({ statusCode, headers, body }) => {
      // Collect body into buffer
      const chunks: Buffer[] = [];
      if (body) {
        // Use for...of instead of for await...of for compatibility
        for await (const chunk of (body as AsyncIterable<Buffer | string>)) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      }
      const bodyBuffer = chunks.length > 0 ? Buffer.concat(chunks) : null;
      return { statusCode, headers: headers as Record<string, string | string[]>, body: bodyBuffer };
    });
  }

  /**
   * Sends the backend response to the client.
   */
  private async sendResponse(
    response: { statusCode: number; headers: Record<string, string | string[]>; body: Buffer | string | null },
    reply: FastifyReply
  ): Promise<void> {
    const { statusCode, headers, body } = response;

    // Set response headers
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) {
        const headerValue = Array.isArray(value) ? value.join(', ') : String(value);
        reply.header(key, headerValue);
      }
    }

    reply.status(statusCode);

    if (body !== null) {
      if (Buffer.isBuffer(body)) {
        reply.send(body);
      } else if (typeof body === 'string') {
        reply.send(Buffer.from(body));
      } else {
        reply.send(body);
      }
    } else {
      reply.send();
    }
  }

  /**
   * Handles proxy errors.
   */
  private async handleError(
    error: ProxyError,
    reply: FastifyReply,
    context: ProxyContext
  ): Promise<void> {
    // Call onError hook
    if (this.hooks.onError) {
      try {
        await this.hooks.onError(error, context);
      } catch (hookError) {
        this.logger.error({ err: hookError }, 'onError hook failed');
      }
    }

    this.logger.error(
      { code: error.code, message: error.message, backend: error.backend },
      'Proxy request failed'
    );

    buildErrorResponse(
      reply,
      error.statusCode ?? 502,
      this.getErrorName(error.code),
      error.message
    );
  }

  /**
   * Generates a unique request ID.
   */
  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Maps error codes to human-readable error names.
   */
  private getErrorName(code: string): string {
    switch (code) {
      case 'ECONNREFUSED':
        return 'Bad Gateway';
      case 'ETIMEDOUT':
        return 'Gateway Timeout';
      case 'ECONNRESET':
        return 'Bad Gateway';
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return 'Bad Gateway';
      default:
        return 'Proxy Error';
    }
  }
}
