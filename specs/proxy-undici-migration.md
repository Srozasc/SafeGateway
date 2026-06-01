# Spec: Proxy Manual con Undici

## 1. Overview

**Nombre:** `proxy-undici-migration`

**Historia de Usuario:**
> "Migrar el motor de proxy HTTP del API Gateway desde @fastify/http-proxy a una implementación manual usando el cliente HTTP undici de Node.js, para permitir control completo sobre el ciclo de vida de las requests, manejo de errores de upstream, y facilitar la implementación de circuit breakers y retries."

**Alcance:**
- Reemplazar `@fastify/http-proxy` por una implementación custom con `undici`
- Fastify se mantiene como servidor HTTP (NO se reemplaza)
- El proxy será el último paso del middleware pipeline
- Se mantienen backward compatibility con configuración existente

---

## 2. Arquitectura de la Solución

### 2.1 Componentes Nuevos

```
src/
├── proxy/
│   ├── engine.ts          # ProxyEngine - clase principal
│   ├── pool.ts            # ConnectionPoolManager - gestión de pools por backend
│   ├── types.ts           # Tipos del proxy (extendidos)
│   └── hooks.ts           # Hooks de ciclo de vida del proxy
```

### 2.2Diagrama de Flujo

```
Request entrante
       │
       ▼
┌─────────────────────────────────────────┐
│           Fastify HTTP Server           │
│                                         │
│  onRequest Hook                        │
│    │  Route Matcher                    │
│    ▼                                    │
│  Middleware Pipeline                    │
│    │  1. Rate Limit Plugin             │
│    │  2. JWT Auth Plugin               │
│    │  3. Metrics Plugin                │
│    ▼                                    │
│  ProxyEngine.forward()                  │  ◄── Nuevo: última etapa
│    │  ConnectionPool por backend       │
│    │  Timeout: connect/headers/body    │
│    │  Streaming: pipe to client       │
│    ▼                                    │
│  Response al cliente                   │
└─────────────────────────────────────────┘
```

---

## 3. Decisiones Arquitectónicas

| Decisión | Selección | Justificación |
|----------|-----------|---------------|
| Servidor HTTP | Fastify (existente) | No se toca el servidor, solo el handler de proxy |
| Cliente HTTP | `undici` | Cliente nativo de Node.js con connection pooling, timeouts nativos |
| Gestión de pools | Un pool por backend | Aislamiento por servicio, facilita circuit breakers |
| API del proxy | `ProxyEngine` con hooks | Hooks `onBeforeRequest`, `onAfterResponse`, `onError` |
| Timeouts | 3 configurables | `connectTimeout`, `headersTimeout`, `bodyTimeout` |
| Streaming | Pipe directo | Máximo rendimiento, sin buffering innecesario |
| Backward compatibility | Sí | Schema existente se extiende con campos opcionales |

---

## 4. Tipos y Interfaces

### 4.1 Tipos Existentes (Extendidos)

```typescript
// src/proxy/types.ts (extensión)

export interface ProxyTimeoutConfig {
  connect?: number;    // Timeout para establecer conexión (ms)
  headers?: number;    // Timeout para recibir headers (ms)
  body?: number;       // Timeout para recibir body (ms)
}

export interface ProxyForwardConfig {
  target: string;           // URL del backend
  prefix: string;           // Prefijo de la ruta
  stripPrefix?: boolean;    // Si Strip prefix
  timeout?: ProxyTimeoutConfig;
  // Nuevos campos opcionales
  retryableMethods?: string[];  // Métodos que pueden ser reintentados
}

export interface ProxyRequestOptions {
  backend: string;              // URL completa del backend
  method: string;               // Método HTTP original
  path: string;                 // Path sin query string
  query?: string;               // Query string
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer | null;
  timeout?: ProxyTimeoutConfig;
}
```

### 4.2 Hooks del Proxy

```typescript
// src/proxy/hooks.ts

export interface ProxyLifecycleHooks {
  /**
   * Hook ejecutado ANTES de enviar el request al backend.
   * Permite modificar opciones o rechazar el request.
   */
  onBeforeRequest?: (options: ProxyRequestOptions) => void | Promise<void>;

  /**
   * Hook ejecutado DESPUÉS de recibir headers del backend.
   * Permite inspeccionar o modificar headers de respuesta.
   */
  onBeforeResponse?: (response: ProxyResponseData) => void | Promise<void>;

  /**
   * Hook ejecutado cuando ocurre un error en el proxy.
   * Recibe el error y el contexto para logging o métricas.
   */
  onError?: (error: ProxyError, context: ProxyContext) => void | Promise<void>;
}

export interface ProxyResponseData {
  statusCode: number;
  headers: IncomingHttpHeaders;
  backend: string;
}

export interface ProxyError {
  code: string;           // 'ECONNREFUSED' | 'ETIMEDOUT' | 'RESPONSE_TIMEOUT' | etc
  message: string;
  backend: string;
}

export interface ProxyContext {
  request: FastifyRequest;
  route: RouteConfig;
  startTime: bigint;
}
```

### 4.3 Pool Manager

```typescript
// src/proxy/pool.ts

export interface PoolConfig {
  connections?: number;    // Max conexiones por pool (default: 100)
  keepAliveTimeout?: number; // Timeout de keep-alive (ms)
}

export class ConnectionPoolManager {
  private pools: Map<string, Pool> = new Map();

  /**
   * Obtiene o crea un pool para un backend específico.
   */
  getPool(backendUrl: string, config?: PoolConfig): Pool;

  /**
   * Cierra todos los pools (usado en shutdown graceful).
   */
  closeAll(): Promise<void>;

  /**
   * Obtiene estadísticas de un pool.
   */
  getStats(backendUrl: string): PoolStats;
}

export interface PoolStats {
  backend: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
}
```

---

## 5. API del ProxyEngine

```typescript
// src/proxy/engine.ts

export class ProxyEngine {
  private readonly poolManager: ConnectionPoolManager;
  private readonly hooks: ProxyLifecycleHooks;
  private readonly logger: Logger;

  constructor(
    poolManager: ConnectionPoolManager,
    hooks: ProxyLifecycleHooks,
    logger: Logger
  );

  /**
   * Reenvía la request al backend configurado.
   * Soporta streaming directo del response.
   *
   * @param request Request de Fastify
   * @param reply Reply de Fastify
   * @param routeMatch RouteMatch con la configuración de la ruta
   */
  async forward(
    request: FastifyRequest,
    reply: FastifyReply,
    routeMatch: RouteMatch
  ): Promise<void>;

  /**
   * Construye las headers de forwarding para el backend.
   * Extiende las headers existentes con X-Forwarded-*, X-Request-Id, X-Forwarded-Proto.
   */
  buildProxyHeaders(request: FastifyRequest, additionalHeaders?: Record<string, string>): Record<string, string>;

  /**
   * Registra los hooks de ciclo de vida del proxy.
   */
  setHooks(hooks: ProxyLifecycleHooks): void;
}
```

---

## 6. BDD - Comportamiento Esperado

### Feature: Proxy Manual con Undici

```gherkin
Feature: Proxy HTTP Manual
  Como desarrollador del gateway
  Quiero una implementación manual del proxy usando undici
  Para tener control total sobre el ciclo de vida de las requests

  Scenario: Request exitoso a backend
    Given un backend configurado en "http://backend:8080"
    And una request GET a "/api/users" con headers de cliente
    When la request llega al ProxyEngine
    Then el backend recibe headers "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP"
    And el backend recibe headers "X-Request-Id" generado
    And el response del backend se transmite al cliente sin buffering
    And el código de estado del backend se preserva

  Scenario: Timeout de conexión
    Given un backend que no responde en el tiempo de connectTimeout
    When ProxyEngine.forward() es llamado
    Then se emite hook onError con code "ECONNREFUSED" o "ETIMEDOUT"
    And el cliente recibe HTTP 502 Bad Gateway

  Scenario: Timeout de headers
    Given un backend que conecta pero no envía headers en headersTimeout
    When ProxyEngine.forward() es llamado
    Then se emite hook onError con code "HEADERS_TIMEOUT"
    And el cliente recibe HTTP 504 Gateway Timeout

  Scenario: Timeout de body
    Given un backend que envía headers pero no body en bodyTimeout
    When ProxyEngine.forward() es llamado
    Then se emite hook onError con code "BODY_TIMEOUT"
    And el cliente recibe HTTP 504 Gateway Timeout

  Scenario: Backend responde con error 5xx
    Given un backend que devuelve HTTP 503
    When la request llega al ProxyEngine
    Then el cliente recibe el mismo código 503
    And el hook onError es emitido con información del error

  Scenario: Connection pool por backend
    Given múltiples backends configurados
    When se hacen requests a diferentes backends
    Then cada backend tiene su propio pool de conexiones
    And los pools son independientes entre sí

  Scenario: Streaming de respuesta grande
    Given un backend que responde con un archivo de 10MB
    When la response se transmite
    Then los datos se envían al cliente en chunks
    And no se buffering en memoria del body completo

  Scenario: Hook onBeforeRequest permite modificar headers
    Given un cliente que envía header "X-Custom-Header: value"
    And un hook onBeforeRequest configurado
    When el request se reenvía al backend
    Then el hook puede agregar, modificar o eliminar headers
    And el backend recibe las headers modificadas

  Scenario: Hook onBeforeResponse permite inspeccionar respuesta
    Given un backend que responde con headers específicos
    And un hook onBeforeResponse configurado
    When la response llega al gateway
    Then el hook recibe statusCode y headers antes de transmitir
    And el hook puede decidir rechazar o modificar la response

  Scenario: Request con query string
    Given una request a "/api/users?page=1&limit=10"
    When se reenvía al backend
    Then el backend recibe "/api/users?page=1&limit=10"
    And el query string se preserva correctamente

  Scenario: Request POST con body
    Given una request POST con JSON body
    When se reenvía al backend
    Then el backend recibe el mismo body sin modificación
    And el header Content-Type se preserva
```

---

## 7. Extensión del Schema de Configuración

### 7.1 gateway.yaml (extensión)

```yaml
# Nuevo campo en RouteConfig (opcional, backward compatible)
routes:
  - prefix: /api
    target: http://backend:8080
    stripPrefix: false
    # --- Nuevos campos ---
    timeout:
      connect: 5000      # ms - Timeout para establecer conexión
      headers: 30000     # ms - Timeout para recibir headers
      body: 60000        # ms - Timeout para recibir body
    retryableMethods:    # Opcional, default: GET, HEAD, OPTIONS
      - GET
      - HEAD
      - OPTIONS
```

### 7.2 Zod Schema (extensión)

```typescript
// src/config/schema.ts (extensión)

const ProxyTimeoutSchema = z.object({
  connect: z.number().positive().optional(),
  headers: z.number().positive().optional(),
  body: z.number().positive().optional(),
}).optional();

const RouteSchema = z.object({
  prefix: z.string(),
  target: z.string().url(),
  stripPrefix: z.boolean().default(false),
  rateLimit: RateLimitSchema.optional(),
  jwt: JwtAuthSchema.optional(),
  // --- Extensión ---
  timeout: ProxyTimeoutSchema,
  retryableMethods: z.array(z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])).optional(),
});
```

---

## 8. Métricas de Prometheus (Extensión)

Nuevas métricas del proxy:

| Métrica | Tipo | Labels | Descripción |
|---------|------|--------|-------------|
| `gateway_proxy_requests_total` | Counter | `method`, `route`, `status_code`, `backend` | Total de requests proxy |
| `gateway_proxy_request_duration_seconds` | Histogram | `method`, `route`, `backend` | Duración de requests proxy |
| `gateway_proxy_bytes_transferred_total` | Counter | `direction` (in/out), `backend` | Bytes transferidos |
| `gateway_proxy_pool_connections` | Gauge | `backend`, `state` (active/idle) | Conexiones en pool |

---

## 9. Plan de Implementación

### Fase 1: Infraestructura de pools
1. Crear `src/proxy/pool.ts` - ConnectionPoolManager
2. Crear `src/proxy/types.ts` - Tipos del proxy (extender existentes)
3. Tests unitarios del pool manager

### Fase 2: ProxyEngine básico
4. Crear `src/proxy/engine.ts` - ProxyEngine con forward()
5. Implementar streaming con undici
6. Implementar timeouts (connect, headers, body)
7. Tests unitarios del engine

### Fase 3: Hooks de ciclo de vida
8. Crear `src/proxy/hooks.ts` - Definición de hooks
9. Integrar hooks en ProxyEngine
10. Tests de integración de hooks

### Fase 4: Integración con servidor
11. Modificar `src/server.ts` - Usar ProxyEngine en lugar de http-proxy
12. Actualizar `src/proxy/headers.ts` - Extender headers de forwarding
13. Integrar con pipeline existente

### Fase 5: Validación
14. Tests de integración completos
15. Validar backward compatibility con configuración existente
16. Performance testing (streaming)

---

## 10. Criterios de Aceptación

- [ ] El proxy usa `undici.Dispatcher` directamente en lugar de `@fastify/http-proxy`
- [ ] Cada backend tiene su propio pool de conexiones separado
- [ ] Los 3 timeouts (connect, headers, body) son configurables por ruta
- [ ] Las responses se transmiten por streaming sin buffering completo en memoria
- [ ] Los hooks `onBeforeRequest`, `onBeforeResponse`, `onError` funcionan correctamente
- [ ] Headers de forwarding incluyen: X-Forwarded-*, X-Real-IP, X-Request-Id, X-Forwarded-Proto
- [ ] Métricas de proxy se exponen en `/metrics`
- [ ] La configuración existente sigue siendo válida (backward compatible)
- [ ] Todos los tests pasan (unitarios + integración)

---

## 11. Archivos a Crear/Modificar

### Archivos a Crear
- `src/proxy/pool.ts` - ConnectionPoolManager
- `src/proxy/hooks.ts` - Lifecycle hooks
- `tests/unit/proxy/pool.test.ts`
- `tests/unit/proxy/engine.test.ts`
- `tests/integration/proxy.test.ts` (actualizar existente)

### Archivos a Modificar
- `src/proxy/types.ts` - Extender con nuevos tipos
- `src/proxy/headers.ts` - Agregar X-Request-Id
- `src/server.ts` - Integrar ProxyEngine
- `src/config/schema.ts` - Agregar campos opcionales
- `src/middleware/pipeline.ts` - Último paso del pipeline

### Archivo a Eliminar (post-migración)
- Dependencia `@fastify/http-proxy` (remover de package.json post-validación)