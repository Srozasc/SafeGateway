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

export interface RouteConfig {
  prefix: string;
  target: string;
  stripPrefix?: boolean;
  rateLimit?: RateLimitConfig;
  timeout?: RouteTimeoutConfig;
}

export interface OverrideConfig {
  path: string;
  rateLimit: RateLimitConfig;
}

export interface GatewayConfig {
  server: ServerConfig;
  redis: RedisConfig;
  logging: LoggingConfig;
  routes: RouteConfig[];
  overrides?: OverrideConfig[];
}
