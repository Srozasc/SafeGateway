# Especificación de Características — Gateway HTTP Modular Reutilizable

## Sistema de Archivos

```
gateway/
├── src/
│   ├── index.ts                        # Entry point principal
│   ├── server.ts                       # Construcción y arranque del servidor Fastify
│   │
│   ├── config/
│   │   ├── loader.ts                   # Lectura y parseo del YAML
│   │   ├── validator.ts                # Validación de esquema con Zod
│   │   ├── schema.ts                   # Definición Zod del schema de config
│   │   └── types.ts                    # TypeScript types/interfaces de config
│   │
│   ├── routing/
│   │   ├── matcher.ts                  # Lógica de matching de rutas (Trie/prefix)
│   │   ├── registry.ts                 # Registro de rutas cargadas desde config
│   │   └── types.ts                    # Types de route match result
│   │
│   ├── middleware/
│   │   ├── pipeline.ts                 # Orquestador del pipeline de middlewares
│   │   ├── rate-limit/
│   │   │   ├── plugin.ts               # Fastify plugin de rate limiting
│   │   │   ├── store.ts                # Abstracción del store Redis
│   │   │   ├── window.ts               # Lógica de ventana temporal
│   │   │   └── types.ts                # Types del módulo rate limit
│   │   └── [future-plugin]/            # Placeholder para plugins futuros
│   │
│   ├── proxy/
│   │   ├── engine.ts                   # Configuración y registro del proxy Fastify
│   │   ├── headers.ts                  # Transformación de headers (forwarding)
│   │   └── types.ts                    # Types del módulo proxy
│   │
│   ├── logger/
│   │   ├── setup.ts                    # Configuración del logger pino
│   │   ├── serializers.ts              # Serializers custom request/response
│   │   └── types.ts                    # Types del módulo logger
│   │
│   └── errors/
│       ├── handler.ts                  # Handler global de errores Fastify
│       ├── responses.ts                # Respuestas de error estandarizadas
│       └── types.ts                    # Types de errores
│
├── config/
│   └── gateway.example.yaml            # Ejemplo de configuración documentado
│
├── tests/
│   ├── unit/
│   │   ├── config/
│   │   │   ├── loader.test.ts
│   │   │   └── validator.test.ts
│   │   ├── routing/
│   │   │   └── matcher.test.ts
│   │   └── middleware/
│   │       └── rate-limit/
│   │           ├── plugin.test.ts
│   │           └── window.test.ts
│   ├── integration/
│   │   ├── proxy.test.ts               # Tests de proxy end-to-end con backend mock
│   │   ├── rate-limit.test.ts          # Tests de rate limiting con Redis real/mock
│   │   └── routing.test.ts             # Tests de routing y matching
│   └── helpers/
│       ├── mock-backend.ts             # Servidor HTTP de backend simulado para tests
│       └── redis-mock.ts               # Mock de Redis para tests unitarios
│
├── docker/
│   ├── Dockerfile                      # Multi-stage build del gateway
│   └── docker-compose.example.yml     # Ejemplo de compose para proyectos consumidores
│
├── .env.example                        # Variables de entorno requeridas
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── tsconfig.build.json
├── jest.config.ts
├── .eslintrc.json
├── .prettierrc
├── .dockerignore
├── .gitignore
└── README.md
```

---

## Especificaciones de Funcionalidades

---

### Funcionalidad 1 — Config Loader y Validación

#### Objetivo
Leer, parsear y validar el archivo de configuración YAML al inicio del proceso. Es el primer módulo que se ejecuta y el punto de fallo rápido: si la configuración es inválida, el gateway no arranca. Expone un objeto de configuración tipado e inmutable al resto del sistema.

#### Relaciones con APIs / Módulos
- **Produce:** Objeto `GatewayConfig` consumido por Server, Route Registry, Rate Limit Plugin y Proxy Engine
- **Consume:** Variable de entorno `CONFIG_PATH` (default: `./config/gateway.yaml`)
- **Consume:** Variables de entorno para interpolación dentro del YAML (`${REDIS_URL}`)

#### Requisitos Detallados

**Formato de configuración YAML esperado:**
```yaml
server:
  port: 3000
  host: "0.0.0.0"

redis:
  url: "${REDIS_URL}"           # Interpolación de env vars

logging:
  level: "info"                 # debug | info | warn | error

routes:
  - prefix: "/api"
    target: "http://backend:8080"
    rateLimit:
      maxRequests: 1000
      windowSeconds: 60

  - prefix: "/admin"
    target: "http://admin-service:9090"
    rateLimit:
      maxRequests: 100
      windowSeconds: 60

overrides:
  - path: "/api/login"
    rateLimit:
      maxRequests: 5
      windowSeconds: 60
```

**Reglas de validación del esquema (Zod):**
- `server.port`: integer entre 1 y 65535 (default: 3000)
- `server.host`: string, IP válida o `"0.0.0.0"` (default: `"0.0.0.0"`)
- `redis.url`: string URL válida (debe iniciar con `redis://` o `rediss://`)
- `logging.level`: enum `["debug", "info", "warn", "error"]` (default: `"info"`)
- `routes`: array no vacío de `RouteConfig`
  - `routes[].prefix`: string que inicia con `/`, sin trailing slash
  - `routes[].target`: string URL válida con protocolo http/https
  - `routes[].rateLimit`: opcional, si presente requiere `maxRequests` y `windowSeconds`
- `overrides`: array opcional de `OverrideConfig`
  - `overrides[].path`: string que inicia con `/`, path exacto (sin wildcards)
  - `overrides[].rateLimit`: objeto con `maxRequests` y `windowSeconds`

**Comportamiento de interpolación de variables de entorno:**
- Antes del parseo YAML, aplicar regex sobre el string raw del archivo
- Reemplazar `${VAR_NAME}` por el valor de `process.env.VAR_NAME`
- Si la variable no existe: lanzar error descriptivo indicando cuál variable falta

**Comportamiento en caso de error:**
- Archivo no encontrado: `Error: Config file not found at path: [path]`
- YAML inválido: `Error: Invalid YAML syntax: [detalle del parser]`
- Validación fallida: `Error: Config validation failed:\n  - [campo]: [mensaje Zod]`
- En todos los casos: loguear el error y llamar `process.exit(1)`

#### Guía de Implementación

**Paso 1 — Leer el archivo:**
```
function loadRawConfig(configPath: string): string
  - Leer configPath usando fs.readFileSync (sync, ya que es startup)
  - Si falla: lanzar ConfigFileNotFoundError
  - Retornar string raw del archivo
```

**Paso 2 — Interpolar variables de entorno:**
```
function interpolateEnvVars(raw: string): string
  - Aplicar regex /\$\{([^}]+)\}/g sobre el string
  - Para cada match, buscar en process.env
  - Si no existe: lanzar MissingEnvVarError con nombre de la variable
  - Retornar string con variables reemplazadas
```

**Paso 3 — Parsear YAML:**
```
function parseYaml(interpolated: string): unknown
  - Usar js-yaml.load()
  - Envolver en try/catch
  - Si error: lanzar ConfigParseError con detalle del parser
```

**Paso 4 — Validar con Zod:**
```
function validateConfig(raw: unknown): GatewayConfig
  - Llamar GatewayConfigSchema.safeParse(raw)
  - Si .success === false: formatear errores Zod y lanzar ConfigValidationError
  - Retornar .data como GatewayConfig
```

**Paso 5 — Congelar el objeto:**
```
function freezeConfig(config: GatewayConfig): Readonly<GatewayConfig>
  - Aplicar Object.freeze() recursivo
  - Retornar config inmutable
```

---

### Funcionalidad 2 — Route Matcher y Registry

#### Objetivo
Determinar, para cada request HTTP entrante, qué ruta de configuración aplica (si alguna). Implementa la lógica de prioridad: override exacto → prefijo más largo coincidente → prefijo general. Es el núcleo de decisión del gateway.

#### Relaciones con APIs / Módulos
- **Consume:** `GatewayConfig.routes` y `GatewayConfig.overrides` del Config Loader
- **Produce:** `RouteMatch` (ruta coincidente + override si existe) consumido por el Middleware Pipeline y el Proxy Engine
- **Invocado por:** Hook `onRequest` de Fastify en cada request

#### Requisitos Detallados

**Algoritmo de matching (orden de precedencia):**
1. Buscar en `overrides` si `request.url` coincide exactamente con `override.path` (ignorar query string)
2. Si hay override exacto: aplicar rateLimit del override, target de la ruta padre
3. Si no hay override: buscar en `routes` el prefijo más largo que sea prefijo de `request.url`
4. Si hay match de prefijo: aplicar rateLimit de la ruta
5. Si no hay ningún match: retornar `null` → Fastify responderá `404`

**Ejemplos de matching:**
```
Request: GET /api/users/123
  → Match route: { prefix: "/api", target: "http://backend:8080" }
  → No override
  → RateLimit: ruta /api

Request: GET /api/login
  → Match route: { prefix: "/api", target: "http://backend:8080" }
  → Override encontrado: { path: "/api/login", rateLimit: { maxRequests: 5 } }
  → RateLimit: override (maxRequests: 5)

Request: GET /unknown
  → Sin match → 404
```

**Estructura del resultado de matching:**
```typescript
interface RouteMatch {
  route: RouteConfig         // Ruta padre que hizo match
  override: OverrideConfig | null  // Override específico si aplica
  effectiveRateLimit: RateLimitConfig | null  // Rate limit final a aplicar
}
```

**Optimización del matching:**
- El Route Registry debe construirse una sola vez al startup (no re-evaluar config en cada request)
- Ordenar rutas por longitud de prefijo descendente al construir el registry (el más largo primero)
- Los overrides se almacenan en un Map<string, OverrideConfig> para lookup O(1)

#### Guía de Implementación

**RouteRegistry (construido al startup):**
```
class RouteRegistry
  - constructor(config: GatewayConfig)
    - this.routes = config.routes.sort por longitud de prefix DESC
    - this.overrides = new Map(config.overrides.map(o => [o.path, o]))
  
  - match(url: string): RouteMatch | null
    - pathWithoutQuery = url.split('?')[0]
    - override = this.overrides.get(pathWithoutQuery) ?? null
    - route = this.routes.find(r => pathWithoutQuery.startsWith(r.prefix))
    - if (!route) return null
    - effectiveRateLimit = override?.rateLimit ?? route.rateLimit ?? null
    - return { route, override, effectiveRateLimit }
```

---

### Funcionalidad 3 — Middleware Pipeline

#### Objetivo
Orquestar la ejecución secuencial de middlewares (plugins) antes y después de que el request sea enviado al backend. Cada plugin debe poder: inspeccionar el request, modificar headers, bloquear el request (short-circuit) o simplemente pasar al siguiente. El diseño debe permitir agregar nuevos plugins sin modificar el núcleo.

#### Relaciones con APIs / Módulos
- **Consume:** `RouteMatch` del Route Matcher
- **Consume:** Plugins registrados (Rate Limit Plugin, futuros: Auth, Audit)
- **Produce:** Request modificado (con headers adicionales) enviado al Proxy Engine
- **Integración:** Fastify hooks (`preHandler`, `onSend`)

#### Requisitos Detallados

**Interfaz de plugin (contrato):**
```typescript
interface GatewayPlugin {
  name: string
  // Ejecutado antes de enviar al backend
  onRequest?(context: RequestContext): Promise<void>
  // Ejecutado después de recibir respuesta del backend
  onResponse?(context: ResponseContext): Promise<void>
}

interface RequestContext {
  request: FastifyRequest
  reply: FastifyReply
  routeMatch: RouteMatch
  // Si el plugin llama reply.send(), el pipeline se detiene (short-circuit)
}
```

**Orden de ejecución del pipeline (MVP):**
1. `RateLimitPlugin.onRequest()` — evalúa y aplica rate limit
2. _(Futuros: AuthPlugin, AuditPlugin)_
3. Proxy Engine reenvía al backend
4. _(Futuros: TransformPlugin.onResponse())_

**Comportamiento de short-circuit:**
- Si un plugin llama `reply.send()` (ej: 429 Too Many Requests), Fastify detiene el ciclo automáticamente
- El Proxy Engine NO se ejecuta

**Registro de plugins:**
- El Pipeline recibe un array de plugins en el constructor
- Los plugins se ejecutan en el orden del array

#### Guía de Implementación

```
class MiddlewarePipeline
  - constructor(plugins: GatewayPlugin[])
  - async executeOnRequest(context: RequestContext): Promise<void>
    - for plugin of this.plugins:
        if plugin.onRequest:
          await plugin.onRequest(context)
          if context.reply.sent: break  // Short-circuit
```

---

### Funcionalidad 4 — Rate Limit Plugin

#### Objetivo
Controlar la tasa de requests por IP de origen, usando Redis como store distribuido. Aplica la configuración de rate limit efectiva del `RouteMatch` y responde `HTTP 429` si el límite es superado. Es el plugin más crítico del MVP.

#### Relaciones con APIs / Módulos
- **Consume:** `RouteMatch.effectiveRateLimit` del Route Matcher
- **Consume:** Redis (vía `ioredis`) para contadores atómicos
- **Produce:** Response `429` con headers informativos (si límite superado)
- **Produce:** Headers `X-RateLimit-*` en la respuesta al cliente

#### Requisitos Detallados

**Algoritmo de Fixed Window Counter:**
```
key = "ratelimit:{ip}:{prefix}:{windowStart}"
windowStart = floor(now / windowSeconds) * windowSeconds

INCR key         → incrementar contador atómicamente
EXPIRE key windowSeconds + 1  → TTL de la ventana

if counter > maxRequests:
  → responder 429
else:
  → continuar pipeline
```

**Cálculo de headers de respuesta:**
```
X-RateLimit-Limit:     maxRequests
X-RateLimit-Remaining: max(0, maxRequests - counter)
X-RateLimit-Reset:     windowStart + windowSeconds (Unix timestamp)
```

**Respuesta 429 estándar:**
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in {secondsRemaining} seconds.",
  "retryAfter": 42
}
```
Headers adicionales en 429: `Retry-After: {secondsRemaining}`

**Comportamiento si Redis no está disponible:**
- Configurable vía `redis.onFailure`: `"open"` (permitir request) o `"closed"` (bloquear con 503)
- Default: `"open"` (fail-open, priorizar disponibilidad)
- Loguear el error de Redis con nivel `warn`

**Caso: `effectiveRateLimit === null`:**
- La ruta no tiene rate limiting configurado
- El plugin debe ser un no-op (pasar inmediatamente al siguiente)

**Caso: IP no identificable:**
- Usar `request.headers['x-forwarded-for']` → primer IP de la lista
- Fallback: `request.ip` de Fastify
- Si ambos son vacíos: usar `"unknown"` como clave (limitar globalmente)

#### Guía de Implementación

```
class RateLimitPlugin implements GatewayPlugin
  name = "rate-limit"
  
  constructor(private redis: Redis, private config: RedisConfig)
  
  async onRequest(ctx: RequestContext): Promise<void>
    - if ctx.routeMatch.effectiveRateLimit === null: return
    - ip = extractIp(ctx.request)
    - { maxRequests, windowSeconds } = ctx.routeMatch.effectiveRateLimit
    - prefix = ctx.routeMatch.route.prefix
    - windowStart = floor(Date.now()/1000 / windowSeconds) * windowSeconds
    - key = `ratelimit:${ip}:${prefix}:${windowStart}`
    
    - try:
        [count] = await redis.multi()
          .incr(key)
          .expire(key, windowSeconds + 1)
          .exec()
        
        setRateLimitHeaders(ctx.reply, maxRequests, count, windowStart + windowSeconds)
        
        if count > maxRequests:
          ctx.reply.code(429).send(buildRateLimitError(windowStart + windowSeconds))
    
    - catch (redisError):
        log.warn({ err: redisError }, "Redis unavailable, rate limit skipped")
        if config.onFailure === "closed":
          ctx.reply.code(503).send({ error: "Service Unavailable" })
```

---

### Funcionalidad 5 — Proxy Engine

#### Objetivo
Reenviar el request HTTP al backend de destino determinado por el `RouteMatch`, retornar la respuesta al cliente y gestionar los headers de forwarding. Es la funcionalidad nuclear del gateway: todo request que supere el pipeline llega aquí.

#### Relaciones con APIs / Módulos
- **Consume:** `RouteMatch.route.target` del Route Matcher
- **Consume:** Request original de Fastify (method, headers, body, query params)
- **Produce:** Response del backend reenviada al cliente
- **Librería:** `@fastify/http-proxy`

#### Requisitos Detallados

**Headers de forwarding agregados por el proxy:**
```
X-Forwarded-For:    {ip original del cliente}
X-Forwarded-Host:   {Host header original}
X-Forwarded-Proto:  http | https
X-Real-IP:          {ip original del cliente}
```

**Reescritura de path (prefix stripping):**
- Configurable por ruta: `stripPrefix: true | false` (default: `false`)
- Si `stripPrefix: true` y prefix es `/api`, request a `/api/users` → backend recibe `/users`
- Si `stripPrefix: false` (default): backend recibe el path completo `/api/users`

**Timeout configurables:**
```yaml
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    timeout:
      connect: 5000    # ms para establecer conexión
      response: 30000  # ms para recibir primera respuesta
```

**Comportamiento ante error del backend:**
- Backend no responde (timeout): `502 Bad Gateway` con mensaje JSON
- Backend con error de conexión: `502 Bad Gateway`
- Backend retorna 5xx: pasar al cliente tal cual (no transformar)

**El gateway NO debe:**
- Cachear respuestas (MVP)
- Modificar el body del request o response
- Añadir headers de autenticación (MVP)
- Reintentar requests fallidos (MVP)

#### Guía de Implementación

```
// En server.ts, para cada ruta de config:
fastify.register(httpProxy, {
  upstream: routeConfig.target,
  prefix: routeConfig.prefix,
  rewritePrefix: routeConfig.stripPrefix ? "" : routeConfig.prefix,
  httpMethods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"],
  preHandler: [middlewarePipeline.preHandler],
  replyOptions: {
    rewriteRequestHeaders: (req, headers) => ({
      ...headers,
      "x-forwarded-for": getClientIp(req),
      "x-forwarded-host": req.hostname,
      "x-forwarded-proto": req.protocol,
      "x-real-ip": getClientIp(req),
    })
  }
})
```

---

### Funcionalidad 6 — Logger Estructurado

#### Objetivo
Registrar cada request/response con información mínima para observabilidad. Los logs son la única ventana de visibilidad del gateway en producción. El formato JSON permite integración inmediata con herramientas como Elasticsearch, Loki, CloudWatch o Datadog sin configuración adicional.

#### Relaciones con APIs / Módulos
- **Integrado:** Directamente en Fastify (pino es el logger nativo)
- **Produce:** JSON Lines a stdout
- **Consume:** Cada request/response del ciclo de vida de Fastify

#### Requisitos Detallados

**Campos mínimos por log de request:**
```json
{
  "level": "info",
  "time": "2026-05-20T15:30:00.000Z",
  "reqId": "req-uuid-v4",
  "req": {
    "method": "GET",
    "url": "/api/users",
    "remoteAddress": "192.168.1.10",
    "userAgent": "Mozilla/5.0..."
  },
  "res": {
    "statusCode": 200
  },
  "responseTime": 42.3,
  "routePrefix": "/api",
  "backendTarget": "http://backend:8080"
}
```

**Campos adicionales en errores del gateway (no del backend):**
```json
{
  "level": "error",
  "err": {
    "message": "Redis connection refused",
    "type": "RedisError",
    "stack": "..."
  }
}
```

**Niveles de log por evento:**
- `debug`: detalles de matching de rutas, headers de forwarding
- `info`: cada request completado exitosamente
- `warn`: Redis no disponible, configuración con valores por defecto, rate limit cercano
- `error`: error del gateway (no del backend), fallo al conectar a backend

**Configuración de serializers (excluir datos sensibles):**
- NO loguear: `Authorization` header, `Cookie` header, body del request/response
- SÍ loguear: headers públicos (Content-Type, Accept, User-Agent)

**Logs de startup:**
```
INFO: Gateway starting on 0.0.0.0:3000
INFO: Config loaded from /config/gateway.yaml
INFO: Routes registered: 2 routes, 1 override
INFO: Redis connected at redis://redis:6379
INFO: Gateway ready
```

#### Guía de Implementación

```typescript
// src/logger/setup.ts
export function createLogger(level: LogLevel): pino.Logger {
  return pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        remoteAddress: req.ip,
        userAgent: req.headers['user-agent'],
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      censor: '[REDACTED]',
    },
  })
}
```

---

### Funcionalidad 7 — Error Handler Global y Respuestas Estándar

#### Objetivo
Centralizar el manejo de errores no capturados por los middlewares individuales. Garantizar que todos los errores del gateway (no del backend) se retornen en un formato JSON consistente y no filtren stack traces o información interna al cliente.

#### Relaciones con APIs / Módulos
- **Registrado en:** Fastify `setErrorHandler`
- **Consume:** Errores lanzados por cualquier parte del sistema
- **Produce:** Response JSON estandarizado

#### Requisitos Detallados

**Formato de respuesta de error:**
```json
{
  "error": "Not Found",
  "message": "No route matched for path /unknown",
  "statusCode": 404,
  "timestamp": "2026-05-20T15:30:00.000Z",
  "requestId": "req-uuid-v4"
}
```

**Mapeo de errores a status codes:**
| Error Type | Status Code | Mensaje |
|---|---|---|
| Route not found | 404 | `No route matched for path {path}` |
| Rate limit exceeded | 429 | `Rate limit exceeded. Retry after {n}s` |
| Backend timeout | 502 | `Backend did not respond in time` |
| Backend connection failed | 502 | `Could not connect to upstream service` |
| Internal gateway error | 500 | `Internal gateway error` |
| Redis unavailable (fail-closed) | 503 | `Service temporarily unavailable` |

**Regla crítica:** Nunca exponer stack traces, rutas internas, IPs de backend ni nombres de servicios internos en las respuestas al cliente.

---

### Funcionalidad 8 — Entry Point y Bootstrap

#### Objetivo
Orquestar el arranque completo del gateway en el orden correcto: cargar config → inicializar dependencias → construir pipeline → registrar rutas → iniciar servidor. Manejar señales del sistema operativo para shutdown graceful.

#### Relaciones con APIs / Módulos
- **Coordina:** Config Loader, Redis, RouteRegistry, MiddlewarePipeline, Proxy Engine, Logger

#### Requisitos Detallados

**Orden de arranque:**
1. Crear logger con nivel `info` (antes de cargar config, para loguear errores de config)
2. Cargar y validar `GatewayConfig`
3. Conectar a Redis (con reintentos: 3 intentos, 1s entre intentos)
4. Construir `RouteRegistry`
5. Construir `MiddlewarePipeline` con plugins habilitados
6. Construir servidor Fastify con logger configurado
7. Registrar error handler global
8. Registrar rutas y proxy handlers
9. Iniciar servidor (`fastify.listen`)
10. Loguear "Gateway ready"

**Shutdown graceful:**
```
SIGTERM / SIGINT recibido:
  → Loguear "Shutting down..."
  → fastify.close() (dejar de aceptar nuevas conexiones)
  → redis.disconnect()
  → process.exit(0)
```

**Variables de entorno requeridas:**
```env
CONFIG_PATH=/config/gateway.yaml    # Ruta al archivo de configuración
REDIS_URL=redis://localhost:6379    # URL de conexión a Redis
NODE_ENV=production                 # Entorno de ejecución
```

**Variables de entorno opcionales:**
```env
LOG_LEVEL=info                      # Nivel de logging (default: info)
PORT=3000                           # Override del puerto (default: del yaml)
```
