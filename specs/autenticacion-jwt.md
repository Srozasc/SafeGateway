# Especificación Técnica — Autenticación JWT (Validación de Tokens)

## Resumen

Agregar un plugin de autenticación JWT al pipeline de middlewares del Gateway HTTP. Esta primera versión es **minimalista y limpia**: su única responsabilidad es **validar tokens JWT** en requests entrantes antes de reenviarlos al backend, rechazando con `HTTP 401` aquellos que no presenten un token válido.

El plugin se integra como un `GatewayPlugin` más dentro del `MiddlewarePipeline` existente, siguiendo el mismo patrón arquitectónico del `RateLimitPlugin`.

---

## Contexto Arquitectónico

### Posición en el pipeline

```
Request entrante
       │
       ▼
┌──────────────────────────────────────┐
│         Middleware Pipeline          │
│                                      │
│  1. RateLimitPlugin.onRequest()      │  ← Protege contra abuso
│  2. JwtAuthPlugin.onRequest()        │  ← NUEVO: Valida token JWT
│  3. [Futuros plugins]               │
│                                      │
│         ▼ (si no hay short-circuit)  │
│     Proxy Engine → Backend           │
└──────────────────────────────────────┘
```

### Módulos afectados

| Módulo | Acción | Motivo |
|--------|--------|--------|
| `src/middleware/jwt-auth/` | **NUEVO** | Plugin de validación JWT |
| `src/config/schema.ts` | MODIFICAR | Agregar esquema Zod para config JWT |
| `src/config/types.ts` | MODIFICAR | Agregar interfaces `JwtAuthConfig` y `GatewayContext` |
| `src/middleware/pipeline.ts` | MODIFICAR | Refactorizar `routeContext` → `gatewayContext` |
| `src/server.ts` | MODIFICAR | Actualizar hook `onRequest` para usar `gatewayContext` |
| `src/index.ts` | MODIFICAR | Instanciar y registrar `JwtAuthPlugin` en el pipeline |
| `src/routing/types.ts` | MODIFICAR | Actualizar referencia a `GatewayContext` |
| `docker/gateway.yaml` | MODIFICAR | Agregar ejemplo de configuración JWT |

---

## Configuración YAML

### Formato del bloque `jwt` por ruta

```yaml
server:
  port: 3000
  host: "0.0.0.0"

redis:
  url: "${REDIS_URL}"
  onFailure: open

logging:
  level: info

routes:
  # Ruta PROTEGIDA con JWT
  - prefix: "/api"
    target: "http://backend:8080"
    stripPrefix: true
    rateLimit:
      maxRequests: 1000
      windowSeconds: 60
    jwt:
      enabled: true                # Opcional. Default: true si el bloque jwt está presente
      secret: "${JWT_SECRET}"      # Obligatorio. Secreto simétrico vía variable de entorno
      algorithm: "HS256"           # Opcional. Default: "HS256". Valores: HS256 | HS384 | HS512
      forwardClaims:               # Opcional. Default: ["sub", "iss", "aud", "exp", "iat", "jti"]
        - sub
        - role
        - tenant_id

  # Ruta PÚBLICA (sin bloque jwt → no requiere autenticación)
  - prefix: "/public"
    target: "http://static-service:9090"

  # Ruta con JWT DESACTIVADO temporalmente
  - prefix: "/admin"
    target: "http://admin-service:7070"
    jwt:
      enabled: false               # JWT desactivado explícitamente, ruta pública
      secret: "${JWT_ADMIN_SECRET}"
      algorithm: "HS256"
```

### Reglas de configuración

| Campo | Tipo | Requerido | Default | Validación |
|-------|------|-----------|---------|------------|
| `jwt` | object | No | — | Si ausente, ruta pública |
| `jwt.enabled` | boolean | No | `true` | — |
| `jwt.secret` | string | Sí (si jwt presente) | — | String no vacío (mínimo 1 carácter post-interpolación) |
| `jwt.algorithm` | enum | No | `"HS256"` | `HS256 \| HS384 \| HS512` |
| `jwt.forwardClaims` | string[] | No | `["sub", "iss", "aud", "exp", "iat", "jti"]` | Array de strings no vacíos |

### Variables de entorno nuevas

```env
JWT_SECRET=mi-secreto-super-seguro-de-al-menos-32-caracteres
JWT_ADMIN_SECRET=otro-secreto-para-admin
```

---

## Refactorización: `routeContext` → `gatewayContext`

### Motivación

Crear un contenedor genérico `gatewayContext` en el request de Fastify que agrupe el contexto de routing y los datos de autenticación. Esto prepara el sistema para que futuros plugins puedan aportar datos al contexto sin proliferar propiedades sueltas en `FastifyRequest`.

### Tipo `GatewayContext`

```typescript
// src/config/types.ts (agregar)
import { JWTPayload } from 'jose';

export interface GatewayContext {
  routeMatch: RouteMatch;
  jwtClaims?: JWTPayload;   // Presente solo si JWT validó correctamente
}
```

### Extensión de `FastifyRequest`

```typescript
// src/middleware/pipeline.ts (modificar)
declare module 'fastify' {
  interface FastifyRequest {
    gatewayContext?: GatewayContext;  // Reemplaza routeContext
  }
}
```

### Archivos a refactorizar

Todas las referencias a `request.routeContext` se reemplazan por `request.gatewayContext`:

- `src/middleware/pipeline.ts` — Declaración del tipo + `getPreHandler()` lee `request.gatewayContext?.routeMatch`
- `src/server.ts` — Hook `onRequest` escribe `request.gatewayContext = { routeMatch: match }`
- `src/middleware/rate-limit/plugin.ts` — Lee `ctx.routeMatch` (sin cambios, viene del `RequestContext`)

> **Nota:** La interfaz `RequestContext` del pipeline mantiene `routeMatch: RouteMatch` como campo directo, ya que los plugins reciben el match pre-extraído. La refactorización es solo a nivel del `FastifyRequest`.

---

## Especificación del Plugin `JwtAuthPlugin`

### Estructura de archivos

```
src/middleware/jwt-auth/
├── plugin.ts       # Clase JwtAuthPlugin que implementa GatewayPlugin
└── types.ts        # Interfaces y tipos del módulo JWT
```

### Interfaz del plugin

```typescript
// src/middleware/jwt-auth/types.ts

export interface JwtAuthConfig {
  enabled: boolean;
  secret: string;
  algorithm: 'HS256' | 'HS384' | 'HS512';
  forwardClaims: string[];
}

// Claims por defecto a inyectar como headers
export const DEFAULT_FORWARD_CLAIMS: string[] = [
  'sub', 'iss', 'aud', 'exp', 'iat', 'jti',
];

// Prefijo estándar para headers de claims
export const JWT_CLAIM_HEADER_PREFIX = 'x-jwt-claim-';
```

### Flujo de ejecución del `onRequest`

```
JwtAuthPlugin.onRequest(ctx)
│
├─ 1. Obtener JwtAuthConfig de la ruta matcheada
│     → Si la ruta no tiene config JWT → return (no-op, ruta pública)
│     → Si jwt.enabled === false → return (no-op, desactivado)
│
├─ 2. Sanitizar headers entrantes
│     → Eliminar TODOS los headers del request que empiecen con "x-jwt-claim-"
│     → Previene spoofing de claims por parte del cliente
│
├─ 3. Extraer token del header Authorization
│     → Buscar header "Authorization: Bearer <token>"
│     → Si no existe o formato inválido → reply 401 + short-circuit
│
├─ 4. Verificar firma y expiración del token
│     → Usar jose.jwtVerify(token, secret, { algorithms: [algorithm] })
│     → Si falla (firma inválida, expirado, malformado) → reply 401 + short-circuit
│
├─ 5. Almacenar claims en el contexto interno
│     → request.gatewayContext.jwtClaims = payload
│     → Disponible para otros plugins downstream
│
└─ 6. Inyectar claims como headers para el backend
      → Para cada claim en forwardClaims:
          → Si el claim existe en el payload Y es escalar (string/number/boolean):
              → Agregar header "x-jwt-claim-{claim}" con el valor como string
          → Si el claim es un objeto/array → ignorar silenciosamente
```

### Pseudocódigo del plugin

```typescript
// src/middleware/jwt-auth/plugin.ts

import { jwtVerify } from 'jose';
import { Logger } from 'pino';
import { GatewayPlugin, RequestContext } from '../pipeline.js';
import { JwtAuthConfig, JWT_CLAIM_HEADER_PREFIX } from './types.js';

export class JwtAuthPlugin implements GatewayPlugin {
  public readonly name = 'jwt-auth';
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  public async onRequest(ctx: RequestContext): Promise<void> {
    const { request, reply, routeMatch } = ctx;

    // 1. Verificar si la ruta tiene configuración JWT activa
    const jwtConfig: JwtAuthConfig | undefined = routeMatch.route.jwt;
    if (!jwtConfig || !jwtConfig.enabled) {
      return; // Ruta pública o JWT desactivado
    }

    // 2. Sanitizar headers entrantes (prevenir spoofing)
    this.sanitizeClaimHeaders(request);

    // 3. Extraer token del header Authorization
    const token = this.extractBearerToken(request);
    if (!token) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Token de autenticación requerido.',
        statusCode: 401,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 4. Verificar firma y expiración
    try {
      const secret = new TextEncoder().encode(jwtConfig.secret);
      const { payload } = await jwtVerify(token, secret, {
        algorithms: [jwtConfig.algorithm],
      });

      // 5. Almacenar claims en el contexto interno
      if (request.gatewayContext) {
        request.gatewayContext.jwtClaims = payload;
      }

      // 6. Inyectar claims como headers
      this.injectClaimHeaders(request, payload, jwtConfig.forwardClaims);

    } catch (error) {
      this.logger.warn(
        { err: error, url: request.url },
        'Token JWT inválido o expirado'
      );

      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Token de autenticación inválido o expirado.',
        statusCode: 401,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private extractBearerToken(request): string | null {
    const authHeader = request.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') return null;
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
    return parts[1];
  }

  private sanitizeClaimHeaders(request): void {
    const headersToRemove = Object.keys(request.headers)
      .filter(h => h.toLowerCase().startsWith(JWT_CLAIM_HEADER_PREFIX));
    for (const header of headersToRemove) {
      delete request.headers[header];
    }
  }

  private injectClaimHeaders(request, payload, forwardClaims: string[]): void {
    for (const claim of forwardClaims) {
      const value = payload[claim];
      if (value !== undefined && ['string', 'number', 'boolean'].includes(typeof value)) {
        request.headers[`${JWT_CLAIM_HEADER_PREFIX}${claim}`] = String(value);
      }
    }
  }
}
```

### Respuestas de error

| Caso | Status | `error` | `message` |
|------|--------|---------|-----------|
| Header `Authorization` ausente | 401 | `Unauthorized` | `Token de autenticación requerido.` |
| Formato del header inválido (no es `Bearer <token>`) | 401 | `Unauthorized` | `Token de autenticación requerido.` |
| Firma inválida (secreto incorrecto) | 401 | `Unauthorized` | `Token de autenticación inválido o expirado.` |
| Token expirado (`exp` vencido) | 401 | `Unauthorized` | `Token de autenticación inválido o expirado.` |
| Token malformado (no es JWT válido) | 401 | `Unauthorized` | `Token de autenticación inválido o expirado.` |

> **Regla de seguridad:** No se distingue entre "expirado", "firma inválida" o "malformado" en la respuesta al cliente. Internamente se loguea el error real con nivel `warn`.

---

## Modificaciones al esquema Zod

### Nuevo esquema `JwtAuthConfigSchema`

```typescript
// src/config/schema.ts (agregar)

export const JwtAuthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  secret: z
    .string()
    .min(1, 'El secreto JWT no puede estar vacío'),
  algorithm: z
    .enum(['HS256', 'HS384', 'HS512'])
    .default('HS256'),
  forwardClaims: z
    .array(z.string().min(1, 'Cada claim debe ser un string no vacío'))
    .default(['sub', 'iss', 'aud', 'exp', 'iat', 'jti']),
});
```

### Extensión del `RouteConfigSchema`

```typescript
// src/config/schema.ts (modificar RouteConfigSchema)

export const RouteConfigSchema = z.object({
  prefix: z.string()
    .refine(val => val.startsWith('/'), '...')
    .refine(val => val === '/' || !val.endsWith('/'), '...'),
  target: z.string().url('...').refine(val => val.startsWith('http://') || val.startsWith('https://'), '...'),
  stripPrefix: z.boolean().default(false),
  rateLimit: RateLimitConfigSchema.optional(),
  timeout: RouteTimeoutConfigSchema.optional(),
  jwt: JwtAuthConfigSchema.optional(),           // ← NUEVO
});
```

### Extensión de la interfaz `RouteConfig`

```typescript
// src/config/types.ts (modificar)

export interface RouteConfig {
  prefix: string;
  target: string;
  stripPrefix?: boolean;
  rateLimit?: RateLimitConfig;
  timeout?: RouteTimeoutConfig;
  jwt?: JwtAuthConfig;                           // ← NUEVO
}
```

---

## Modificaciones al Entry Point (`index.ts`)

### Registro del plugin JWT en el pipeline

```typescript
// src/index.ts (modificar sección 5-6)

// 5. Configurar módulos de middleware
const rateLimitStore = new RedisRateLimitStore(redis);
const rateLimitPlugin = new RateLimitPlugin(rateLimitStore, logger, config.redis.onFailure);
const jwtAuthPlugin = new JwtAuthPlugin(logger);    // ← NUEVO

// 6. Inicializar pipeline con ambos plugins (orden: rate-limit → jwt-auth)
const pipeline = new MiddlewarePipeline([
  rateLimitPlugin,
  jwtAuthPlugin,                                    // ← NUEVO
]);
```

---

## Dependencias

### Nueva dependencia

| Paquete | Versión | Motivo |
|---------|---------|--------|
| `jose` | `^6.x` | Verificación de tokens JWT con `jwtVerify()`. Sin dependencias nativas, soporte ESM nativo, basada en Web Crypto API. |

### Instalación

```bash
pnpm add jose
```

> **Nota:** No se requiere `@types/jose` — la librería incluye tipos TypeScript nativos.

---

## Escenarios BDD (Behavior-Driven Development)

### Feature: Validación de tokens JWT en el Gateway

```gherkin
Feature: Validación de tokens JWT en el Gateway
  Como operador del API Gateway
  Quiero validar tokens JWT antes de reenviar requests al backend
  Para proteger los servicios backend de accesos no autorizados

  Background:
    Given el gateway está configurado con la ruta "/api" apuntando a "http://backend:8080"
    And la ruta "/api" tiene configuración JWT con secret "test-secret-key-min-32-chars!!!" y algorithm "HS256"
    And la ruta "/public" apunta a "http://static:9090" sin configuración JWT

  # ─────────────────────────────────────────────
  # Escenarios de ruta pública (sin JWT)
  # ─────────────────────────────────────────────

  Scenario: Request a ruta pública pasa sin token
    Given la ruta "/public" no tiene bloque jwt configurado
    When envío un GET a "/public/health" sin header Authorization
    Then el request se reenvía al backend exitosamente
    And la respuesta tiene status 200

  Scenario: Request a ruta con JWT desactivado pasa sin token
    Given la ruta "/admin" tiene bloque jwt con enabled: false
    When envío un GET a "/admin/dashboard" sin header Authorization
    Then el request se reenvía al backend exitosamente

  # ─────────────────────────────────────────────
  # Escenarios de token ausente o malformado
  # ─────────────────────────────────────────────

  Scenario: Request sin header Authorization a ruta protegida
    When envío un GET a "/api/users" sin header Authorization
    Then la respuesta tiene status 401
    And el cuerpo contiene "Token de autenticación requerido."
    And el request NO se reenvía al backend

  Scenario: Request con header Authorization sin prefijo Bearer
    When envío un GET a "/api/users" con header Authorization "Basic abc123"
    Then la respuesta tiene status 401
    And el cuerpo contiene "Token de autenticación requerido."

  Scenario: Request con header Authorization vacío
    When envío un GET a "/api/users" con header Authorization ""
    Then la respuesta tiene status 401
    And el cuerpo contiene "Token de autenticación requerido."

  Scenario: Request con Bearer pero sin token
    When envío un GET a "/api/users" con header Authorization "Bearer "
    Then la respuesta tiene status 401
    And el cuerpo contiene "Token de autenticación requerido."

  # ─────────────────────────────────────────────
  # Escenarios de token inválido
  # ─────────────────────────────────────────────

  Scenario: Token con firma inválida (secreto incorrecto)
    Given un token JWT firmado con secret "wrong-secret-key-definitely-wrong!"
    When envío un GET a "/api/users" con dicho token en el header Authorization
    Then la respuesta tiene status 401
    And el cuerpo contiene "Token de autenticación inválido o expirado."
    And se genera un log de nivel "warn" con el detalle del error

  Scenario: Token expirado
    Given un token JWT firmado con el secret correcto pero con exp en el pasado
    When envío un GET a "/api/users" con dicho token
    Then la respuesta tiene status 401
    And el cuerpo contiene "Token de autenticación inválido o expirado."

  Scenario: Token con formato no-JWT (string aleatorio)
    When envío un GET a "/api/users" con header Authorization "Bearer not-a-jwt-token"
    Then la respuesta tiene status 401
    And el cuerpo contiene "Token de autenticación inválido o expirado."

  Scenario: Token firmado con algoritmo diferente al configurado
    Given la ruta "/api" está configurada con algorithm "HS256"
    And un token JWT firmado con algorithm "HS384" y el mismo secret
    When envío un GET a "/api/users" con dicho token
    Then la respuesta tiene status 401
    And el cuerpo contiene "Token de autenticación inválido o expirado."

  # ─────────────────────────────────────────────
  # Escenarios de token válido
  # ─────────────────────────────────────────────

  Scenario: Token válido permite el paso al backend
    Given un token JWT válido con claims { sub: "user-123", iss: "my-app" }
    When envío un GET a "/api/users" con dicho token
    Then el request se reenvía al backend exitosamente
    And la respuesta del backend se retorna al cliente

  # ─────────────────────────────────────────────
  # Escenarios de inyección de claims como headers
  # ─────────────────────────────────────────────

  Scenario: Claims por defecto se inyectan como headers lowercase
    Given la ruta "/api" no tiene forwardClaims configurado (usa defaults)
    And un token válido con claims { sub: "user-123", iss: "my-app", aud: "api", exp: 9999999999, iat: 1700000000, jti: "abc-uuid" }
    When envío un GET a "/api/users" con dicho token
    Then el backend recibe los headers:
      | Header              | Valor         |
      | x-jwt-claim-sub     | user-123      |
      | x-jwt-claim-iss     | my-app        |
      | x-jwt-claim-aud     | api           |
      | x-jwt-claim-exp     | 9999999999    |
      | x-jwt-claim-iat     | 1700000000    |
      | x-jwt-claim-jti     | abc-uuid      |

  Scenario: Claims custom configurados se inyectan correctamente
    Given la ruta "/api" tiene forwardClaims: ["sub", "role", "tenant_id"]
    And un token válido con claims { sub: "user-123", role: "admin", tenant_id: "t-456", iss: "my-app" }
    When envío un GET a "/api/users" con dicho token
    Then el backend recibe los headers:
      | Header                  | Valor     |
      | x-jwt-claim-sub         | user-123  |
      | x-jwt-claim-role        | admin     |
      | x-jwt-claim-tenant_id   | t-456     |
    And el backend NO recibe el header "x-jwt-claim-iss"

  Scenario: Claims de tipo objeto o array se ignoran silenciosamente
    Given la ruta "/api" tiene forwardClaims: ["sub", "metadata"]
    And un token válido con claims { sub: "user-123", metadata: { key: "value" } }
    When envío un GET a "/api/users" con dicho token
    Then el backend recibe el header "x-jwt-claim-sub" con valor "user-123"
    And el backend NO recibe el header "x-jwt-claim-metadata"

  Scenario: Claim booleano se inyecta como string
    Given un token válido con claims { sub: "user-123", is_admin: true }
    And la ruta "/api" tiene forwardClaims: ["sub", "is_admin"]
    When envío un GET a "/api/users" con dicho token
    Then el backend recibe el header "x-jwt-claim-is_admin" con valor "true"

  # ─────────────────────────────────────────────
  # Escenarios de seguridad: sanitización de headers
  # ─────────────────────────────────────────────

  Scenario: Headers x-jwt-claim-* del cliente se eliminan antes de la validación
    Given un token válido con claims { sub: "real-user" }
    When envío un GET a "/api/users" con dicho token y con header "x-jwt-claim-sub: spoofed-admin"
    Then el backend recibe el header "x-jwt-claim-sub" con valor "real-user"
    And el backend NO recibe un header con valor "spoofed-admin"

  Scenario: Múltiples headers spoofed se eliminan completamente
    When envío un GET a "/api/users" con un token válido
    And incluyo los headers:
      | Header                | Valor        |
      | x-jwt-claim-sub       | fake-user    |
      | x-jwt-claim-role      | superadmin   |
      | x-jwt-claim-custom    | malicious    |
    Then ninguno de esos headers spoofed llega al backend
    And solo los claims legítimos del token se inyectan

  Scenario: Headers spoofed se eliminan incluso si el token es inválido
    When envío un GET a "/api/users" con un token inválido
    And incluyo el header "x-jwt-claim-sub: spoofed-admin"
    Then la respuesta tiene status 401
    And el header "x-jwt-claim-sub" fue eliminado del request antes de la validación

  # ─────────────────────────────────────────────
  # Escenarios de contexto interno (gatewayContext)
  # ─────────────────────────────────────────────

  Scenario: Claims se almacenan en request.gatewayContext.jwtClaims
    Given un token válido con claims { sub: "user-123", role: "admin" }
    When el request pasa por JwtAuthPlugin
    Then request.gatewayContext.jwtClaims contiene el payload completo del token
    And request.gatewayContext.jwtClaims.sub === "user-123"
    And request.gatewayContext.routeMatch permanece intacto

  Scenario: jwtClaims es undefined para rutas públicas
    Given la ruta "/public" no tiene configuración JWT
    When el request pasa por JwtAuthPlugin hacia "/public/health"
    Then request.gatewayContext.jwtClaims es undefined

  # ─────────────────────────────────────────────
  # Escenarios de interacción con rate-limit
  # ─────────────────────────────────────────────

  Scenario: Rate limit se evalúa antes que JWT
    Given la ruta "/api" tiene rate limit de 5 requests por minuto
    And la ruta "/api" tiene JWT configurado
    When envío 6 requests a "/api/users" sin header Authorization
    Then los primeros 5 requests reciben status 401 (falla JWT, no rate limit)
    And el 6to request recibe status 429 (rate limit excedido)
    And el 6to request NO ejecuta la validación JWT

  # ─────────────────────────────────────────────
  # Escenarios de formato de respuesta de error
  # ─────────────────────────────────────────────

  Scenario: Respuesta 401 sigue el formato JSON estándar del gateway
    When envío un GET a "/api/users" sin header Authorization
    Then la respuesta tiene Content-Type "application/json"
    And el cuerpo tiene la estructura:
      """
      {
        "error": "Unauthorized",
        "message": "Token de autenticación requerido.",
        "statusCode": 401,
        "timestamp": "<ISO 8601>"
      }
      """
    And el cuerpo NO contiene stack traces ni detalles internos
```

---

## Criterios de Aceptación

### Funcionales

- [x] Rutas con bloque `jwt` configurado y `enabled: true` rechazan requests sin token válido con `HTTP 401`
- [x] Rutas sin bloque `jwt` permiten el paso sin autenticación (rutas públicas)
- [x] Rutas con `jwt.enabled: false` permiten el paso sin autenticación
- [x] Token con firma inválida, expirado o malformado retorna `HTTP 401`
- [x] Claims configurados en `forwardClaims` se inyectan como headers lowercase `x-jwt-claim-*`
- [x] Claims por defecto (`sub`, `iss`, `aud`, `exp`, `iat`, `jti`) se inyectan si no se configura `forwardClaims`
- [x] Claims de tipo objeto/array se ignoran silenciosamente
- [x] Headers `x-jwt-claim-*` del request entrante se eliminan antes de la validación (anti-spoofing)
- [x] Claims validados se almacenan en `request.gatewayContext.jwtClaims`
- [x] El plugin respeta el patrón de short-circuit del pipeline existente

### No Funcionales

- [x] El plugin JWT NO genera tokens, NO implementa refresh, NO maneja login
- [x] El mensaje de error 401 NO distingue entre tipos de fallo (seguridad por oscuridad)
- [x] Los logs internos SÍ detallan el error real (nivel `warn`)
- [x] El secreto JWT se obtiene por interpolación de variables de entorno, NUNCA hardcodeado
- [x] La interfaz interna acepta `KeyLike | Uint8Array` para preparar soporte futuro de algoritmos asimétricos

### Técnicos

- [x] Validación Zod del bloque `jwt` en la configuración YAML
- [x] Refactorización de `request.routeContext` → `request.gatewayContext` sin romper funcionalidad existente
- [x] Tests unitarios para el plugin JWT con cobertura de todos los escenarios BDD
- [x] Tests de integración que validen el flujo completo: request → rate-limit → jwt → proxy → backend
- [x] Librería `jose` instalada con `pnpm add jose`

---

## Flujos Alternativos

### Token válido pero claim solicitado no existe en el payload

```
Token payload: { sub: "user-123" }
forwardClaims: ["sub", "role", "tenant_id"]

Resultado:
  → x-jwt-claim-sub: "user-123"     ✓ inyectado
  → x-jwt-claim-role: (no enviado)  ← claim no existe, se omite silenciosamente
  → x-jwt-claim-tenant_id: (no enviado) ← claim no existe, se omite silenciosamente
```

### Múltiples rutas con diferentes secretos

```yaml
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    jwt:
      secret: "${JWT_SECRET_API}"
      algorithm: "HS256"

  - prefix: "/admin"
    target: "http://admin:9090"
    jwt:
      secret: "${JWT_SECRET_ADMIN}"
      algorithm: "HS512"
```

Cada ruta valida con su propio secreto y algoritmo. Un token firmado para `/api` no es válido en `/admin`.

### Startup con secreto JWT vacío post-interpolación

Si la variable de entorno referenciada no existe, el módulo `Config Loader` existente ya maneja este caso con `MissingEnvVarError` durante la interpolación, antes de que el esquema Zod sea evaluado. El gateway no arranca.

---

## Notas de Implementación

### Conversión del secreto para `jose`

La función `jwtVerify()` de `jose` requiere que el secreto simétrico sea un `Uint8Array` o un `KeyLike`. Para secretos simétricos (HS256/HS384/HS512), se convierte el string del secreto así:

```typescript
const secretKey = new TextEncoder().encode(jwtConfig.secret);
const { payload } = await jwtVerify(token, secretKey, {
  algorithms: [jwtConfig.algorithm],
});
```

### Preparación para algoritmos asimétricos (futuro)

El tipo interno del plugin debe aceptar `KeyLike | Uint8Array` como tipo de clave:

```typescript
import type { KeyLike } from 'jose';

// En v1, siempre es Uint8Array (secreto simétrico)
// En v2+, podría ser KeyLike (clave pública RSA/EC)
type JwtSecretOrKey = KeyLike | Uint8Array;
```

Esto permite que en el futuro se añada soporte para claves asimétricas sin cambiar la firma del plugin.

### Orden del pipeline

El orden `[RateLimitPlugin, JwtAuthPlugin]` es intencional:
1. **Rate-limit primero**: Protege contra floods de tokens inválidos que consuman CPU en operaciones criptográficas
2. **JWT después**: Solo valida tokens para requests que pasaron el rate limit
