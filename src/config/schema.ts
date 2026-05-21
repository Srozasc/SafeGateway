import { z } from 'zod';

// Esquema para el servidor
export const ServerConfigSchema = z.object({
  port: z
    .number()
    .int()
    .min(1, 'El puerto debe ser mayor o igual a 1')
    .max(65535, 'El puerto debe ser menor o igual a 65535')
    .default(3000),
  host: z.string().min(1, 'El host no puede estar vacío').default('0.0.0.0'),
});

// Esquema para Redis
export const RedisConfigSchema = z.object({
  url: z
    .string()
    .refine(
      (url) => url.startsWith('redis://') || url.startsWith('rediss://'),
      'La URL de Redis debe comenzar con "redis://" o "rediss://"',
    ),
  onFailure: z.enum(['open', 'closed']).default('open'),
});

// Esquema para Logging
export const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

// Esquema para Rate Limiting
export const RateLimitConfigSchema = z.object({
  maxRequests: z.number().int().positive('maxRequests debe ser un entero positivo'),
  windowSeconds: z.number().int().positive('windowSeconds debe ser un entero positivo'),
});

// Esquema para timeouts de las rutas
export const RouteTimeoutConfigSchema = z.object({
  connect: z
    .number()
    .int()
    .positive('El timeout de conexión debe ser un entero positivo')
    .optional(),
  response: z
    .number()
    .int()
    .positive('El timeout de respuesta debe ser un entero positivo')
    .optional(),
});

// Esquema para autenticación JWT
export const JwtAuthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  secret: z.string().min(1, 'El secreto JWT no puede estar vacío'),
  algorithm: z.enum(['HS256', 'HS384', 'HS512']).default('HS256'),
  forwardClaims: z
    .array(z.string().min(1, 'Cada claim debe ser un string no vacío'))
    .default(['sub', 'iss', 'aud', 'exp', 'iat', 'jti']),
});

// Esquema para las rutas del Gateway
export const RouteConfigSchema = z.object({
  prefix: z
    .string()
    .refine((val) => val.startsWith('/'), 'El prefijo de la ruta debe comenzar con "/"')
    .refine(
      (val) => val === '/' || !val.endsWith('/'),
      'El prefijo de la ruta no debe terminar con "/" (excepto si es la raíz "/")',
    ),
  target: z
    .string()
    .url('El target del backend debe ser una URL válida')
    .refine(
      (val) => val.startsWith('http://') || val.startsWith('https://'),
      'El target debe usar el protocolo http:// o https://',
    ),
  stripPrefix: z.boolean().default(false),
  rateLimit: RateLimitConfigSchema.optional(),
  timeout: RouteTimeoutConfigSchema.optional(),
  jwt: JwtAuthConfigSchema.optional(),
  metricsLabel: z.string().optional(),
  backendName: z.string().optional(),
});

// Esquema para los overrides
export const OverrideConfigSchema = z.object({
  path: z
    .string()
    .refine((val) => val.startsWith('/'), 'El path del override debe comenzar con "/"')
    .refine(
      (val) => val === '/' || !val.endsWith('/'),
      'El path del override no debe terminar con "/" (excepto si es la raíz "/")',
    ),
  rateLimit: RateLimitConfigSchema,
});

// Esquema para métricas de Prometheus
export const MetricsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    path: z
      .string()
      .startsWith('/', 'El endpoint de métricas debe comenzar con "/"')
      .default('/metrics'),
    defaultLabels: z.record(z.string(), z.string()).default({}),
  })
  .default({
    enabled: true,
    path: '/metrics',
    defaultLabels: {},
  });

// Esquema principal de configuración del Gateway
export const GatewayConfigSchema = z.object({
  server: ServerConfigSchema.default({ port: 3000, host: '0.0.0.0' }),
  redis: RedisConfigSchema,
  logging: LoggingConfigSchema.default({ level: 'info' }),
  metrics: MetricsConfigSchema,
  routes: z.array(RouteConfigSchema).min(1, 'Debe haber al menos una ruta configurada'),
  overrides: z.array(OverrideConfigSchema).optional(),
});
