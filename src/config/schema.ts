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
  headers: z
    .number()
    .int()
    .positive('El timeout de headers debe ser un entero positivo')
    .optional(),
  body: z
    .number()
    .int()
    .positive('El timeout de body debe ser un entero positivo')
    .optional(),
});

// Esquema para autenticación JWT (HS256/HS384/HS512 con secreto compartido)
// Esta es la rama "shared-secret" — preserva compatibilidad hacia atrás.
// Las rutas que usan este modo no requieren la sección global `jwt`.
export const JwtSharedSecretConfigSchema = z.object({
  enabled: z.boolean().default(true),
  secret: z.string().min(1, 'El secreto JWT no puede estar vacío'),
  algorithm: z.enum(['HS256', 'HS384', 'HS512']).default('HS256'),
  forwardClaims: z
    .array(z.string().min(1, 'Cada claim debe ser un string no vacío'))
    .default(['sub', 'iss', 'aud', 'exp', 'iat', 'jti']),
  issuer: z.string().min(1, 'El claim iss debe ser un string no vacío').optional(),
  audience: z.string().min(1, 'El claim aud debe ser un string no vacío').optional(),
});

// Esquema para autenticación JWT en modo JWKS (RS256 contra endpoint remoto)
// Requiere que el issuer esté declarado en la sección global `jwt.issuers[]`
// (excepto cuando `issuer: "any"`, que acepta cualquier issuer registrado).
export const JwtJwksConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.literal('jwks'),
  issuer: z.string().min(1, 'jwt.issuer debe ser un nombre de issuer o "any"'),
  forwardClaims: z
    .array(z.string().min(1, 'Cada claim debe ser un string no vacío'))
    .default(['sub', 'iss', 'aud', 'exp', 'iat', 'jti']),
});

// Esquema unificado por ruta — se detecta el modo por la presencia de campos:
//   - `secret` presente → shared-secret
//   - `mode: 'jwks'` → JWKS
export const JwtAuthConfigSchema = z.union([JwtSharedSecretConfigSchema, JwtJwksConfigSchema]);

// Esquema para un issuer JWKS declarado globalmente
export const JwtIssuerConfigSchema = z.object({
  name: z.string().min(1, 'El nombre del issuer no puede estar vacío'),
  jwksUri: z.string().url('jwksUri debe ser una URL válida'),
  issuer: z.string().min(1, 'El claim iss esperado debe ser un string no vacío'),
  audience: z.string().min(1, 'El claim aud esperado debe ser un string no vacío').optional(),
  cacheTtlSeconds: z
    .number()
    .int()
    .positive('cacheTtlSeconds debe ser un entero positivo')
    .default(3600),
  staleGracePeriodSeconds: z
    .number()
    .int()
    .nonnegative('staleGracePeriodSeconds debe ser un entero no negativo')
    .default(1800),
  refreshCooldownSeconds: z
    .number()
    .int()
    .nonnegative('refreshCooldownSeconds debe ser un entero no negativo')
    .default(30),
  refreshOnMiss: z.boolean().default(true),
  timeoutMs: z
    .number()
    .int()
    .positive('timeoutMs debe ser un entero positivo')
    .default(3000),
});

// Esquema para la sección global `jwt` (modo JWKS + lista de issuers)
export const JwtGlobalConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(['shared-secret', 'jwks']).default('shared-secret'),
    issuers: z.array(JwtIssuerConfigSchema).default([]),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'jwks' && val.issuers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issuers'],
        message: 'jwt.mode="jwks" requiere al menos un issuer declarado en jwt.issuers[]',
      });
    }
    const seen = new Set<string>();
    for (const [i, iss] of val.issuers.entries()) {
      if (seen.has(iss.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['issuers', i, 'name'],
          message: `duplicate issuer name "${iss.name}"`,
        });
      }
      seen.add(iss.name);
    }
  });

// Esquema para los overrides por path exacto (mirror de corsOverrides)
export const JwtOverrideConfigSchema = z.object({
  path: z
    .string()
    .refine((val) => val.startsWith('/'), 'El path del override JWT debe comenzar con "/"')
    .refine(
      (val) => val === '/' || !val.endsWith('/'),
      'El path del override JWT no debe terminar con "/" (excepto si es la raíz "/")',
    ),
  jwt: JwtAuthConfigSchema,
});

// Esquema para Circuit Breaker
export const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  errorThreshold: z
    .number()
    .int()
    .min(1, 'El threshold de error debe ser al menos 1')
    .max(100, 'El threshold de error debe ser como máximo 100')
    .default(50),
  requestCount: z
    .number()
    .int()
    .positive('El conteo de requests debe ser positivo')
    .default(100),
  recoveryTimeMs: z
    .number()
    .int()
    .positive('El tiempo de recovery debe ser positivo')
    .default(30000),
  halfOpenRequests: z
    .number()
    .int()
    .positive('Las requests en half-open deben ser positivas')
    .default(3),
  maxRetries: z
    .number()
    .int()
    .nonnegative('Los reintentos no pueden ser negativos')
    .default(3),
  retryDelayMs: z
    .number()
    .int()
    .positive('El delay base debe ser positivo')
    .default(100),
  retryMaxDelayMs: z
    .number()
    .int()
    .positive('El delay máximo debe ser positivo')
    .default(5000),
});

// Esquema para CORS
// NOTA: Todos los campos son opcionales para permitir overrides parciales
// (e.g., una ruta puede especificar solo `origins: ["*"]` y heredar el resto del global).
// Los defaults se aplican en `mergeCorsConfigs` (src/middleware/cors/merge.ts)
// DESPUÉS de mergear, no a nivel de schema.
// La validación de combinaciones inválidas (credentials + *, enabled + [])
// se hace en `validateMergedCorsConfig`.
export const CorsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  origins: z.array(z.string().min(1, 'Cada origin debe ser un string no vacío')).optional(),
  methods: z.array(z.string().min(1)).optional(),
  allowedHeaders: z.array(z.string().min(1)).optional(),
  exposedHeaders: z.array(z.string().min(1)).optional(),
  credentials: z.boolean().optional(),
  maxAge: z.number().int().positive('maxAge debe ser positivo').optional(),
});

// Esquema para override de CORS por path exacto
export const CorsOverrideConfigSchema = z.object({
  path: z
    .string()
    .refine((val) => val.startsWith('/'), 'El path del override CORS debe comenzar con "/"')
    .refine(
      (val) => val === '/' || !val.endsWith('/'),
      'El path del override CORS no debe terminar con "/" (excepto si es la raíz "/")',
    ),
  cors: CorsConfigSchema,
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
  // --- Extension for proxy-undici ---
  retryableMethods: z
    .array(z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']))
    .optional(),
  // --- Circuit Breaker ---
  circuitBreaker: CircuitBreakerConfigSchema.optional(),
  // --- CORS por ruta ---
  cors: CorsConfigSchema.optional(),
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

// Esquema para el endpoint de Health Aggregation
// Permite consultar el estado de todos los backends declarados en routes[]
// y agregarlos en una única respuesta JSON.
export const HealthConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    path: z
      .string()
      .startsWith('/', 'El path de health debe comenzar con "/"')
      .default('/health'),
    backendPath: z
      .string()
      .startsWith('/', 'El backendPath de health debe comenzar con "/"')
      .default('/health'),
    timeoutMs: z
      .number()
      .int()
      .positive('El timeoutMs de health debe ser un entero positivo')
      .default(2000),
  })
  .default({
    enabled: true,
    path: '/health',
    backendPath: '/health',
    timeoutMs: 2000,
  });

// Esquema principal de configuración del Gateway
export const GatewayConfigSchema = z.object({
  server: ServerConfigSchema.default({ port: 3000, host: '0.0.0.0' }),
  redis: RedisConfigSchema,
  logging: LoggingConfigSchema.default({ level: 'info' }),
  metrics: MetricsConfigSchema,
  routes: z.array(RouteConfigSchema).min(1, 'Debe haber al menos una ruta configurada'),
  overrides: z.array(OverrideConfigSchema).optional(),
  // --- CORS global ---
  cors: CorsConfigSchema.optional(),
  // --- CORS overrides por path exacto ---
  corsOverrides: z.array(CorsOverrideConfigSchema).optional(),
  // --- JWT global (modo JWKS + lista de issuers) ---
  jwt: JwtGlobalConfigSchema.optional(),
  // --- JWT overrides por path exacto (mirror corsOverrides) ---
  jwtOverrides: z.array(JwtOverrideConfigSchema).optional(),
  // --- Health Aggregation ---
  health: HealthConfigSchema.optional(),
});
