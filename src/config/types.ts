import type { RouteRegistry } from '../routing/registry.js';
import type { RouteMatch } from '../routing/types.js';
import type { JWTPayload } from 'jose';
import type { CorsDecision } from '../middleware/cors/types.js';

export interface ServerConfig {
  port: number;
  host: string;
}

export interface RedisConfig {
  url: string;
  onFailure?: 'open' | 'closed';
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
}

export interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
}

export interface RouteTimeoutConfig {
  connect?: number;
  headers?: number;
  body?: number;
}

export interface JwtAuthConfig {
  enabled: boolean;
  secret: string;
  algorithm: 'HS256' | 'HS384' | 'HS512';
  forwardClaims: string[];
}

export interface MetricsConfig {
  enabled: boolean;
  path: string;
  defaultLabels: Record<string, string>;
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  errorThreshold: number;
  requestCount: number;
  recoveryTimeMs: number;
  halfOpenRequests: number;
  maxRetries: number;
  retryDelayMs: number;
  retryMaxDelayMs: number;
}

export interface CorsConfig {
  enabled?: boolean;
  origins?: string[];
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

export interface CorsOverrideConfig {
  path: string;
  cors: CorsConfig;
}

export interface RouteConfig {
  prefix: string;
  target: string;
  stripPrefix?: boolean;
  rateLimit?: RateLimitConfig;
  timeout?: RouteTimeoutConfig;
  jwt?: JwtAuthConfig;
  metricsLabel?: string;
  backendName?: string;
  retryableMethods?: string[];
  circuitBreaker?: CircuitBreakerConfig;
  cors?: CorsConfig;
}

export interface OverrideConfig {
  path: string;
  rateLimit: RateLimitConfig;
}

export interface GatewayConfig {
  server: ServerConfig;
  redis: RedisConfig;
  logging: LoggingConfig;
  metrics: MetricsConfig;
  routes: RouteConfig[];
  overrides?: OverrideConfig[];
  cors?: CorsConfig;
  corsOverrides?: CorsOverrideConfig[];
}

export interface GatewayContext {
  routeMatch: RouteMatch;
  jwtClaims?: JWTPayload;
  corsDecision?: CorsDecision;
}

export interface ConfigSnapshot {
  config: Readonly<GatewayConfig>;
  registry: RouteRegistry;
  createdAt: string;
}

export interface ReloadResult {
  success: boolean;
  applied: string[];
  ignored: string[];
  error?: string;
}
