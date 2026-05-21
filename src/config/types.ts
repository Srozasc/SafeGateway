import type { RouteRegistry } from '../routing/registry.js';
import type { RouteMatch } from '../routing/types.js';
import type { JWTPayload } from 'jose';

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
  response?: number;
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

export interface RouteConfig {
  prefix: string;
  target: string;
  stripPrefix?: boolean;
  rateLimit?: RateLimitConfig;
  timeout?: RouteTimeoutConfig;
  jwt?: JwtAuthConfig;
  metricsLabel?: string;
  backendName?: string;
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
}

export interface GatewayContext {
  routeMatch: RouteMatch;
  jwtClaims?: JWTPayload;
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
