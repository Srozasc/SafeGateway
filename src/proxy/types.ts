import type { IncomingHttpHeaders } from 'http';
import type { FastifyRequest } from 'fastify';
import type { RouteConfig } from '../config/types.js';
import type { RouteMatch } from '../routing/types.js';

// ============================================
// Forwarding Headers
// ============================================

export interface ProxyForwardingHeaders {
  'x-forwarded-for': string;
  'x-forwarded-host': string;
  'x-forwarded-proto': string;
  'x-real-ip': string;
  [key: string]: string | undefined;
}

// ============================================
// Proxy Request/Response Types
// ============================================

export interface ProxyTimeoutConfig {
  connect?: number; // Timeout for establishing connection (ms)
  headers?: number; // Timeout for receiving headers (ms)
  body?: number; // Timeout for receiving body (ms)
}

export interface ProxyRequestOptions {
  backend: string; // Full backend URL
  method: string; // Original HTTP method
  path: string; // Path without query string
  query?: string; // Query string
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer | null;
  timeout?: ProxyTimeoutConfig;
}

export interface ProxyResponseData {
  statusCode: number;
  headers: IncomingHttpHeaders;
  backend: string;
  body?: Buffer;
}

// ============================================
// Lifecycle Hooks
// ============================================

export interface ProxyLifecycleHooks {
  /**
   * Hook executed BEFORE sending request to backend.
   * Allows modifying options or rejecting the request.
   */
  onBeforeRequest?: (
    options: ProxyRequestOptions,
    context: ProxyContext
  ) => void | Promise<void>;

  /**
   * Hook executed AFTER receiving headers from backend.
   * Allows inspecting or modifying response headers.
   */
  onBeforeResponse?: (
    response: ProxyResponseData,
    context: ProxyContext
  ) => void | Promise<void>;

  /**
   * Hook executed when an error occurs in the proxy.
   * Receives the error and context for logging or metrics.
   */
  onError?: (error: ProxyError, context: ProxyContext) => void | Promise<void>;
}

export interface ProxyError {
  code: string; // 'ECONNREFUSED' | 'ETIMEDOUT' | 'RESPONSE_TIMEOUT' | etc
  message: string;
  backend: string;
  statusCode?: number;
}

export interface ProxyContext {
  request: FastifyRequest;
  routeMatch: RouteMatch;
  startTime: bigint;
}

// ============================================
// Pool Types
// ============================================

export interface PoolConfig {
  connections?: number; // Max connections per pool (default: 100)
  keepAliveTimeout?: number; // Keep-alive timeout (ms)
  connectTimeout?: number; // Connect timeout (ms)
  headersTimeout?: number; // Headers timeout (ms)
  bodyTimeout?: number; // Body timeout (ms)
}

export interface PoolStats {
  backend: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
}

// ============================================
// Route Config Extension
// ============================================

export interface RouteConfigExtension {
  timeout?: ProxyTimeoutConfig;
  retryableMethods?: string[];
  poolConfig?: PoolConfig;
}

export type ExtendedRouteConfig = RouteConfig & RouteConfigExtension;