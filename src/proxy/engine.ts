import { URL } from 'url';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'undici';
import { Logger } from 'pino';
import type { RouteMatch } from '../routing/types.js';
import { ConnectionPoolManager } from './pool.js';
import type {
  ProxyLifecycleHooks,
  ProxyContext,
  ProxyError,
  ProxyRequestBody,
  ProxyTimeoutConfig,
} from './types.js';
import { buildProxyContext, createProxyError, buildErrorResponse } from './hooks.js';
import { buildForwardingHeaders } from './headers.js';

/**
 * Builds the request body for forwarding through Undici, preserving the
 * original type instead of coercing binary payloads to JSON.
 *
 * Behavior:
 *   - GET/HEAD always yield `undefined` regardless of input.
 *   - `undefined` / `null` input yields `undefined`.
 *   - `string` → returned as-is.
 *   - `Buffer` → returned as-is (NOT JSON-stringified; this is the bug fix for
 *     binary uploads to backends like catalog-service).
 *   - Async iterables (streams) → returned as-is for streaming passthrough.
 *   - Plain objects / arrays / other `unknown` → `JSON.stringify`. This is the
 *     legacy fallback used for parsed JSON bodies coming from Fastify's default
 *     `application/json` parser.
 *
 * Exported for unit testing; the rest of the engine uses this helper to keep
 * the dispatch logic in a single place.
 */
export function buildRequestBody(requestBody: unknown, method: string): ProxyRequestBody {
  if (method === 'GET' || method === 'HEAD') {
    return null;
  }
  if (requestBody === undefined || requestBody === null) {
    return null;
  }

  if (typeof requestBody === 'string') {
    return requestBody;
  }
  if (Buffer.isBuffer(requestBody)) {
    return requestBody;
  }

  if (
    typeof requestBody === 'object' &&
    requestBody !== null &&
    (Symbol.asyncIterator in (requestBody as object) ||
      typeof (requestBody as { getReader?: () => unknown }).getReader === 'function')
  ) {
    return requestBody as AsyncIterable<unknown>;
  }

  // Fallback for parsed JSON objects (the Fastify default JSON parser produces
  // these). Preserves the legacy behavior where `request.body === { foo: 'bar' }`
  // gets forwarded as the string `'{"foo":"bar"}'`.
  return JSON.stringify(requestBody);
}

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

  constructor(poolManager: ConnectionPoolManager, hooks: ProxyLifecycleHooks, logger: Logger) {
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
    routeMatch: RouteMatch,
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
    for (const [key, value] of Object.entries(
      request.headers as Record<string, string | string[] | undefined>,
    )) {
      if (value === undefined || key.toLowerCase() === 'host') {
        continue;
      }
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
          context,
        );
      } catch (error) {
        this.logger.error({ error, backend, path: targetPath }, 'onBeforeRequest hook failed');
      }
    }

    // Get pool for this backend
    const pool = this.poolManager.getPool(backend);

    // Build the request path
    const requestPath = `${targetPath}${url.search}`;

    // Execute the request
    try {
      const response = await this.executeRequest(
        pool,
        {
          method: request.method,
          path: requestPath,
          headers,
          timeout,
        },
        request.body,
      );

      // Call onBeforeResponse hook
      if (this.hooks.onBeforeResponse) {
        try {
          await this.hooks.onBeforeResponse(
            {
              statusCode: response.statusCode,
              headers: response.headers as Record<string, string | string[]>,
              backend,
            },
            context,
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
    requestBody?: unknown,
  ): Promise<{
    statusCode: number;
    headers: Record<string, string | string[]>;
    body: Buffer | string | null;
  }> {
    const maxTimeout = Math.max(
      options.timeout.connect ?? 5000,
      options.timeout.headers ?? 30000,
      options.timeout.body ?? 60000,
    );

    // Pick the right body representation for Undici: Buffer for binary,
    // string for text, AsyncIterable for streams, or fall back to JSON.stringify
    // for parsed JSON objects from Fastify's default parser. Never coerce
    // blindly — this was the cause of binary-upload corruption.
    const body = buildRequestBody(requestBody, options.method);

    return pool
      .request({
        method: options.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD',
        path: options.path,
        headers: options.headers,
        bodyTimeout: maxTimeout,
        headersTimeout: maxTimeout,
        // Type bridge at the engine boundary: undici 6.26.0 exposes
        // `RequestOptions.body` as a strict union (string | Buffer | Uint8Array
        // | Readable | FormData | null) but at runtime the dispatcher also
        // accepts AsyncIterable / Node Readable streams. `ProxyRequestBody` is
        // the broader union (includes streams); the cast here keeps TypeScript
        // happy without changing runtime behavior. Narrow this when streaming
        // support is added.
        ...(body !== undefined ? { body: body as never } : {}),
      })
      .then(async ({ statusCode, headers, body }) => {
        // Collect body into buffer
        const chunks: Buffer[] = [];
        if (body) {
          // Use for...of instead of for await...of for compatibility
          for await (const chunk of body as AsyncIterable<Buffer | string>) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        }
        const bodyBuffer = chunks.length > 0 ? Buffer.concat(chunks) : null;
        return {
          statusCode,
          headers: headers as Record<string, string | string[]>,
          body: bodyBuffer,
        };
      });
  }

  /**
   * Sends the backend response to the client.
   */
  private async sendResponse(
    response: {
      statusCode: number;
      headers: Record<string, string | string[]>;
      body: Buffer | string | null;
    },
    reply: FastifyReply,
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
    context: ProxyContext,
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
      'Proxy request failed',
    );

    buildErrorResponse(
      reply,
      error.statusCode ?? 502,
      this.getErrorName(error.code),
      error.message,
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
