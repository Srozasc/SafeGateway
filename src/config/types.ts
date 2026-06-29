import type { RouteRegistry } from '../routing/registry.js';
import type { RouteMatch } from '../routing/types.js';
import type { JWTPayload } from 'jose';
import type { CorsDecision } from '../middleware/cors/types.js';
import type { JwtAuthRegistry } from '../middleware/jwt-auth/registry.js';

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

// ----- JWT Auth -----

/** Modo shared-secret (HS256/HS384/HS512 con secreto local). No requiere sección global `jwt`. */
export interface JwtSharedSecretConfig {
  enabled: boolean;
  secret: string;
  algorithm: 'HS256' | 'HS384' | 'HS512';
  forwardClaims: string[];
  issuer?: string;
  audience?: string;
}

/** Modo JWKS — valida contra un endpoint remoto declarado en `jwt.issuers[]`. */
export interface JwtJwksConfig {
  enabled: boolean;
  mode: 'jwks';
  /** Nombre del issuer (declarado en jwt.issuers[].name) o "any" para aceptar cualquier issuer. */
  issuer: string;
  forwardClaims: string[];
}

/** Discriminated union resuelto por Zod desde JwtAuthConfigSchema. */
export type JwtAuthConfig = JwtSharedSecretConfig | JwtJwksConfig;

export interface JwtIssuerConfig {
  name: string;
  jwksUri: string;
  issuer: string;
  audience?: string;
  cacheTtlSeconds: number;
  staleGracePeriodSeconds: number;
  refreshCooldownSeconds: number;
  refreshOnMiss: boolean;
  timeoutMs: number;
}

export interface JwtGlobalConfig {
  enabled: boolean;
  mode: 'shared-secret' | 'jwks';
  issuers: JwtIssuerConfig[];
}

export interface JwtOverrideConfig {
  path: string;
  jwt: JwtAuthConfig;
}

// ----- Métricas -----

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

export interface HealthConfig {
  enabled: boolean;
  path: string;
  backendPath: string;
  timeoutMs: number;
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
  jwt?: JwtGlobalConfig;
  jwtOverrides?: JwtOverrideConfig[];
  health?: HealthConfig;
}

export interface GatewayContext {
  routeMatch: RouteMatch;
  jwtClaims?: JWTPayload;
  corsDecision?: CorsDecision;
}

export interface ConfigSnapshot {
  config: Readonly<GatewayConfig>;
  registry: RouteRegistry;
  jwtRegistry: JwtAuthRegistry;
  createdAt: string;
}

export interface ReloadResult {
  success: boolean;
  applied: string[];
  ignored: string[];
  error?: string;
}

