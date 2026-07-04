# 🚀 API Gateway HTTP Modular, Standalone y Configurable

Un API Gateway robusto, modular, configurable e inmutable desarrollado en **TypeScript** con **Fastify**, diseñado para funcionar como proxy inverso de alto rendimiento y orquestador de middlewares con patrones de resiliencia avanzados para arquitecturas de microservicios.

---

## 📦 Características Principales

* **Proxy Inverso de Alto Rendimiento (Undici)**: Motor de proxy implementado sobre [Undici](https://undici.nodejs.org/), el cliente HTTP nativo de Node.js. Soporta reescritura de rutas (`stripPrefix`), timeouts de conexión/cabecera/cuerpo de forma granular e inyección de cabeceras de forwarding estándar (`X-Forwarded-*`).
* **Circuit Breaker & Retries**: Patrón de circuit breaker con máquina de estados (CLOSED → OPEN → HALF_OPEN) y reintentos automáticos con *exponential backoff* y *full jitter* para proteger los backends de sobrecargas y fallas en cascada.
* **Rate Limiting Distribuido**: Algoritmo *Fixed Window Counter* atómico implementado sobre **Redis** (usando pipelines optimizados) para restringir peticiones por IP, con soporte para comportamientos configurables ante caídas del caché (*fail-open* / *fail-closed*).
* **Manejo de CORS Centralizado**: Política configurable de orígenes, métodos, headers y credenciales por ruta, con tres niveles de precedencia (`corsOverrides[path]` > `routes[].cors` > `cors` global). Los preflights se responden automáticamente con HTTP 204 sin pasar por rate-limit, auth ni circuit breaker.
* **Priorización de Enrutamiento en Cascada**: Resolución inteligente de coincidencia de rutas (Rutas específicas/Overrides > Prefijo más largo > Prefijo general).
* **Configuración Declarativa Inmutable**: Lector de archivos YAML/JSON con validación estricta de esquemas mediante **Zod** y soporte para interpolación segura de variables de entorno (`${ENV_VAR}`).
* **Registro de Logs Estructurados**: Integración nativa de **Pino** con serializadores de peticiones, respuestas y errores redactando automáticamente información sensible (tokens `Authorization`, cookies, etc.).
* **Arquitectura de Plugins con Hooks de Ciclo de Vida**: Pipeline extensible con hooks `onBeforeRequest`, `onBeforeResponse` y `onError` (en `ProxyLifecycleHooks`) más los hooks de alto nivel `onRequest` y `onResponse` por plugin (`GatewayPlugin`). Ejecución secuencial con capacidad de cortocircuito (*short-circuit*).
* **Endpoint de Health Aggregation**: `GET /health` que consulta en paralelo el endpoint de salud de cada servicio downstream declarado en `routes[]` y devuelve un estado agregado (`ok` / `degraded` / `down`) con código HTTP apropiado. Ideal para load balancers, Kubernetes readiness probes y herramientas de monitoreo. No requiere autenticación, no consume rate-limit y se excluye de las métricas HTTP para no contaminar la observabilidad del tráfico real.
* **Despliegue Contenerizado**: Optimizado mediante una compilación Docker *multi-stage* ultra-ligera (basada en `node:20-alpine`) e instrumentado con chequeos de salud (`HEALTHCHECK`) nativos de red.

---

## 🛠️ Requisitos Previos

Antes de arrancar, asegúrate de contar con:
* **Node.js** v20 LTS o superior.
* **pnpm** v9 o superior (gestor de paquetes exclusivo del proyecto).
* **Redis** v7 o superior (local o en un contenedor Docker).

---

## ⚡ Quick Start (Arranque Rápido en 5 Minutos)

La forma más rápida de probar el Gateway y comprender su flujo es levantando el entorno preconfigurado mediante **Docker Compose**:

### 1. Clonar el repositorio y acceder
```bash
git clone https://github.com/tu-usuario/gateway.git
cd gateway
```

### 2. Crear los archivos de configuración iniciales
Crea un archivo local `docker/gateway.yaml` para indicarle al Gateway cómo enrutar las peticiones:

```yaml
server:
  port: 3000
  host: 0.0.0.0

redis:
  url: redis://redis-cache:6379
  onFailure: open

logging:
  level: info

routes:
  # Enrutará peticiones desde http://localhost:3000/api/* hacia el Backend Mock
  - prefix: /api
    target: http://mock-backend:8080
    stripPrefix: true
    rateLimit:
      maxRequests: 5
      windowSeconds: 60
```

### 3. Levantar la infraestructura
Ejecuta Docker Compose apuntando al entorno de ejemplo:
```bash
docker compose -f docker/docker-compose.example.yml up --build
```

Esto iniciará:
1. El **API Gateway** en el puerto `3000`.
2. Una instancia limpia de **Redis** en el puerto interno `6379`.
3. Un **Backend Mock** de pruebas corriendo internamente en el puerto `8080`.

### 4. Probar el enrutamiento y el Rate Limiting
Realiza peticiones HTTP usando `curl` para verificar el comportamiento:

```bash
# 1. Petición exitosa al backend mock a través del Gateway
curl -i http://localhost:3000/api/users

# Deberías recibir cabeceras informativas de Rate Limiting en la respuesta:
# X-RateLimit-Limit: 5
# X-RateLimit-Remaining: 4
# X-RateLimit-Reset: 1716300000
```

Si realizas más de **5 peticiones** en menos de un minuto desde la misma IP, el Gateway cortocircuitará la petición y te devolverá un estado estructurado **429 (Too Many Requests)**:
```bash
curl -i http://localhost:3000/api/users

# HTTP/1.1 429 Too Many Requests
# Retry-After: 48
# Content-Type: application/json
#
# {
#   "error": "Too Many Requests",
#   "message": "Límite de peticiones excedido. Inténtalo de nuevo en 48 segundos.",
#   "retryAfter": 48
# }
```

---

## ⚙️ Configuración Declarativa (`gateway.yaml`)

El archivo de configuración principal se valida estrictamente con **Zod** al arrancar. A continuación se detallan todas las propiedades disponibles:

```yaml
# ===============================================================
# Configuración del Servidor Fastify Core
# ===============================================================
server:
  port: 3000       # Puerto TCP en el que escuchará el Gateway (Por defecto: 3000)
  host: 0.0.0.0    # Host en el que escuchará (0.0.0.0 acepta tráfico externo)

# ===============================================================
# Configuración de Conexión a Redis
# ===============================================================
redis:
  url: ${REDIS_URL}       # URL de conexión (Soporta interpolación de variables de entorno)
  onFailure: open         # Comportamiento ante fallos de Redis:
                          #   - 'open': Deja pasar el request sin rate-limit (fail-open)
                          #   - 'closed': Bloquea el tráfico con HTTP 503 (fail-closed)

# ===============================================================
# Configuración de Logs Estructurados
# ===============================================================
logging:
  level: info             # Nivel mínimo de log (debug | info | warn | error)

# ===============================================================
# Rutas del API Gateway (Microservicios Destino)
# ===============================================================
routes:
  - prefix: /api          # Prefijo de la ruta entrante (Debe comenzar con "/" y no terminar en "/")
    target: http://users-service:8081  # URL destino del microservicio
    stripPrefix: true     # Si es true, elimina '/api' al reenviar al microservicio
    rateLimit:            # Opcional. Reglas de Rate Limiting para esta ruta
      maxRequests: 100
      windowSeconds: 60
    timeout:              # Opcional. Timeouts granulares por fase de conexión (ms)
      connect: 2000       # Timeout de establecimiento de conexión TCP
      headers: 10000      # Timeout para recibir los headers de respuesta
      body: 30000         # Timeout para recibir el cuerpo completo de la respuesta
    circuitBreaker:       # Opcional. Patrón de circuit breaker para este backend
      enabled: true
      errorThreshold: 50  # % de errores para abrir el circuit (default: 50)
      requestCount: 100   # Tamaño de la ventana de evaluación (default: 100)
      recoveryTimeMs: 30000  # ms en OPEN antes de pasar a HALF_OPEN (default: 30000)
      halfOpenRequests: 3    # Requests exitosas en HALF_OPEN para cerrar el circuit (default: 3)
      maxRetries: 3          # Máximo de reintentos por request (default: 3)
      retryDelayMs: 100      # Base delay para backoff exponencial en ms (default: 100)
      retryMaxDelayMs: 5000  # Delay máximo de retry en ms (default: 5000)

  - prefix: /auth
    target: http://auth-service:8082
    stripPrefix: false
    circuitBreaker:
      enabled: false      # Circuit breaker deshabilitado para esta ruta

# ===============================================================
# Overrides específicos (Excepciones a nivel de endpoint exacto)
# ===============================================================
overrides:
  - path: /api/login      # Path exacto que sobreescribirá la política de su ruta padre (/api)
    rateLimit:
      maxRequests: 5      # Aplica un límite mucho más restrictivo para evitar ataques de fuerza bruta
      windowSeconds: 60
```

### 🌐 Configuración de CORS (Cross-Origin Resource Sharing)

El Gateway incluye un módulo CORS configurable con tres niveles de precedencia (de mayor a menor):

1. **`corsOverrides[path]`** — Override exacto por path (path-exact)
2. **`routes[].cors`** — Override parcial por prefijo de ruta
3. **`cors` global** — Política por defecto aplicada a todas las rutas

```yaml
# ─── CORS global (default para todas las rutas) ───
cors:
  enabled: true                    # Habilita CORS (default: false)
  origins:                         # Lista de orígenes permitidos
    - "https://app.flashdrop.cl"
    - "https://admin.flashdrop.cl"
  methods:                         # Métodos HTTP permitidos
    - GET
    - POST
    - PUT
    - DELETE
    - PATCH
    - OPTIONS
  allowedHeaders:                  # Headers que el cliente puede enviar
    - Content-Type
    - Authorization
  exposedHeaders:                  # Headers expuestos al cliente (no en preflights)
    - X-Request-ID
  credentials: false               # Permitir cookies/Authorization (true requiere origins específicos)
  maxAge: 86400                    # Cache de preflight en segundos (24h default)

routes:
  # Ruta general hereda config global
  - prefix: /api
    target: http://backend:3000

  # Override por prefijo: solo origins=["*"] para esta ruta
  - prefix: /api/dev
    target: http://backend-dev:3000
    cors:
      origins: ["*"]

# Override exacto por path: mayor prioridad
corsOverrides:
  - path: /api/auth/login
    cors:
      origins: ["*"]
      credentials: false
```

**Validación al startup** (fail-fast, rollback automático en hot-reload):
- ❌ `enabled: true` con `origins: []` — requiere al menos un origin
- ❌ `credentials: true` con `origins: ["*"]` — incompatible con wildcard
- ❌ `credentials: true` con `allowedHeaders: ["*"]` — incompatible

**Comportamiento clave**:
- **Preflight** (`OPTIONS` con `Origin` permitido) → responde `204` sin pasar al backend
- **Request normal con Origin permitido** → pasa al backend, headers CORS se agregan en la respuesta
- **Request normal con Origin NO permitido** → pasa al backend sin headers CORS (decisión del cliente)
- **Request sin `Origin`** → server-to-server, no se afecta
- **Comparación de origines**: case-insensitive sobre `scheme + host + port` (normalizado a lowercase)

### 🔐 Configuración de JWT (HS256/HS384/HS512 + JWKS RS256)

El plugin JWT soporta **dos modos** que pueden coexistir en distintas rutas:

#### Modo 1: Shared-Secret (HS256/HS384/HS512) — Compatibilidad

Cada ruta define su propio secreto local. No requiere sección global `jwt`. **Backward compatible** con configuraciones existentes.

```yaml
routes:
  - prefix: /api/protected
    target: http://backend:3000
    jwt:
      enabled: true
      secret: ${JWT_SECRET}
      algorithm: HS256          # default; HS384, HS512 también soportados
      issuer: "flashdrop-api"   # claim `iss` esperado (opcional)
      audience: "flashdrop-api" # claim `aud` esperado (opcional)
```

#### Modo 2: JWKS (RS256) — Multi-tenant con claves públicas remotas

Las rutas referencian por nombre a un issuer declarado en `jwt.issuers[]`. El Gateway descubre claves públicas vía endpoint JWKS (RFC 7517), las cachea con TTL, y soporta múltiples issuers simultáneos (multi-tenant / multi-entorno).

```yaml
jwt:                            # Sección global
  enabled: true
  mode: jwks                    # "shared-secret" | "jwks"
  issuers:
    - name: auth-service-prod
      jwksUri: https://auth.flashdrop.cl/.well-known/jwks.json
      issuer: "https://auth.flashdrop.cl"   # claim `iss` esperado
      audience: "flashdrop-api"             # claim `aud` esperado (opcional)
      cacheTtlSeconds: 3600                 # TTL del cache (default: 1h)
      staleGracePeriodSeconds: 1800         # ventana de gracia (default: 30min)
      refreshCooldownSeconds: 30            # cooldown entre refreshes sync (default: 30s)
      refreshOnMiss: true                   # refresh on miss sincronico (default: true)
      timeoutMs: 3000                       # timeout HTTP al JWKS endpoint (default: 3000)

    - name: auth-service-staging
      jwksUri: https://auth-staging.flashdrop.cl/.well-known/jwks.json
      issuer: "https://auth-staging.flashdrop.cl"

routes:
  - prefix: /api/orders
    target: http://orders-service:8084
    jwt:
      issuer: auth-service-prod  # Referencia al issuer global por nombre

  - prefix: /api/public
    target: http://public-service:8086
    jwt:
      issuer: any                # Acepta tokens de cualquier issuer registrado
                                 # (mapeo via decode-unsafe del claim `iss`)

  - prefix: /api/auth/login       # Ruta explícitamente pública
    target: http://auth-service:8082
    jwt:
      enabled: false

jwtOverrides:                    # Path-exact overrides (mayor prioridad que routes[].jwt)
  - path: /api/health
    jwt:
      enabled: false             # Health checks públicos
```

**Validación fail-fast al startup**:
- `jwksUri` debe ser una URL válida
- No se permiten nombres de `issuer` duplicados
- Cada `routes[].jwt.issuer` (≠ "any") debe existir en `jwt.issuers[]`
- `routes[].jwt.issuer: "any"` requiere al menos un issuer configurado

**State machine del cache JWKS** (por issuer):
- `empty` → nunca se hizo un fetch exitoso (estado inicial tras arranque o tras un rebuild del registry por SIGHUP)
- `fresh` → dentro del TTL, sirve directo (latencia <5ms p99)
- `stale` → pasó TTL pero dentro de `staleGracePeriodSeconds`, sirve + background refresh
- `expired` → pasó ambos, refresh on miss síncrono (gated por `refreshCooldownSeconds`)
- `401 Unauthorized` — firma inválida, expired, claims incorrectos, kid desconocido
- `503 Service Unavailable` — Auth Service caído más allá de stale grace

#### Métricas de JWT

| Métrica | Tipo | Labels | Descripción |
|---------|------|--------|-------------|
| `gateway_jwt_validations_total` | Counter | `result` | Validaciones JWT. `result` ∈ `ok \| missing_token \| unknown_kid \| missing_kid \| expired \| invalid_issuer \| invalid_audience \| invalid_claims \| invalid_signature \| service_unavailable` |
| `gateway_jwks_refresh_total` | Counter | `result` | Refrescos JWKS. `result` ∈ `ok \| error \| cooldown` |

```promql
# Tasa de validaciones exitosas
rate(gateway_jwt_validations_total{result="ok"}[5m])

# Tasa de 401 (cualquier fallo criptográfico)
sum(rate(gateway_jwt_validations_total{result=~"expired|invalid_issuer|invalid_audience|invalid_signature|unknown_kid|missing_kid"}[5m]))

# Tasa de 503 (Auth Service caído)
rate(gateway_jwt_validations_total{result="service_unavailable"}[5m])

# Refresh errors
rate(gateway_jwks_refresh_total{result="error"}[5m])
```

### 💡 Interpolación de Variables de Entorno
Cualquier campo del archivo YAML puede contener expresiones del tipo `${NOMBRE_VARIABLE}`. El Gateway las reemplazará automáticamente en tiempo de arranque utilizando los valores de `process.env`. Si una variable requerida en el YAML no está definida en el entorno, el Gateway **fallará rápido** lanzando una excepción `MissingEnvVarError` para evitar arranques inconsistentes.

---

## 🛡️ Resiliencia: Circuit Breaker y Retries

El Gateway implementa el patrón de **Circuit Breaker** integrado en el motor de proxy (`ProxyEngine`) a través del módulo [`src/middleware/circuit-breaker/`](file:///d:/desarrollo/Gateway/src/middleware/circuit-breaker/). Cada ruta con `circuitBreaker.enabled: true` obtiene su propio circuit breaker independiente.

### Máquina de Estados

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
            ┌───────────────┐    N errores o 5       ┌────▼──────────┐
            │    CLOSED     │ ──── consecutivos ────▶│     OPEN      │
            │  (normal)     │                         │  (bloqueado)  │
            └───────┬───────┘                         └───────┬───────┘
                    │                                          │
                    │ halfOpenRequests                         │ recoveryTimeMs
                    │ consecutivos OK                          │
                    │                                          ▼
                    └─────────────────────────────── HALF_OPEN ◀──┘
                                                     (probando)
```

| Estado | Comportamiento |
|--------|----------------|
| `CLOSED` | Tráfico fluye con normalidad. Se contabilizan errores en ventana deslizante. |
| `OPEN` | Rechaza todas las requests con **HTTP 503** y cabecera `Retry-After`. |
| `HALF_OPEN` | Permite un número limitado de requests de prueba para verificar la recuperación. |

### Transiciones

* **CLOSED → OPEN**: Se activa cuando el porcentaje de errores supera `errorThreshold` en la ventana de `requestCount`, **o** cuando ocurren **5 errores consecutivos**.
* **OPEN → HALF_OPEN**: Tras `recoveryTimeMs` milisegundos desde el último fallo.
* **HALF_OPEN → CLOSED**: Cuando `halfOpenRequests` requests consecutivas son exitosas.
* **HALF_OPEN → OPEN**: Si cualquier request falla durante la prueba, el circuit vuelve a abrirse.

### Retries con Exponential Backoff y Full Jitter

El [`RetryInterceptor`](file:///d:/desarrollo/Gateway/src/middleware/circuit-breaker/retry.ts) reintenta automáticamente requests fallidas usando **backoff exponencial con jitter completo** para evitar el efecto *thundering herd*.

**Fórmula:** `delay = random(0, min(baseDelay × 2^attempt, maxDelay))`

| Intento | Rango de Delay (base=100ms, max=5000ms) |
|---------|------------------------------------------|
| 0 (1er retry) | 0 – 100 ms |
| 1 (2do retry) | 0 – 200 ms |
| 2 (3er retry) | 0 – 400 ms |
| 3 (4to retry) | 0 – 800 ms |

**Restricciones de seguridad:**
- Por defecto solo se reintenta en **métodos idempotentes**: `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`. La lista es **configurable por ruta** vía `routes[].retryableMethods` (si necesitas incluir `POST` o `PATCH`, decláralo explícitamente).
- Solo se reintenta en errores elegibles: `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`, `EPIPE` y códigos HTTP `500`, `502`, `503`, `504`.
- **No se reintenta** cuando el circuit está en estado `OPEN`.

```yaml
# Ejemplo: habilitar retry también para POST en una ruta específica
routes:
  - prefix: /api/webhook
    target: http://webhooks-svc:8080
    circuitBreaker:
      enabled: true
      maxRetries: 3
    retryableMethods:
      - POST  # ⚠️ Solo si tu backend acepta POSTs reintentables (idempotency-key, etc.)
```

### Respuesta cuando el Circuit está OPEN

```json
HTTP/1.1 503 Service Unavailable
Retry-After: 28
Content-Type: application/json

{
  "error": "Circuit Open",
  "message": "El servicio /api no está disponible temporalmente. Inténtalo de nuevo más tarde.",
  "retryAfter": 28
}
```

---

## 🩺 Health Aggregation (Endpoint `/health`)

SafeGateway expone un endpoint nativo `GET /health` (path configurable) que **agrega el estado de todos los servicios downstream** declarados en `routes[]`. Está pensado para ser consumido por load balancers, Kubernetes readiness probes y herramientas de monitoreo como **un único punto de consulta** para conocer la salud de las dependencias del gateway.

> ⚠️ **Importante**: Este endpoint está diseñado como **readiness probe**, no como **liveness probe**. Su propósito es indicar si las dependencias están operativas, no si el proceso del gateway está vivo (para eso usar `/metrics` y métricas de proceso, o un `HEALTHCHECK` nativo de Docker).

### Características clave

- **Sin autenticación ni rate limiting**: el endpoint se registra como ruta nativa de Fastify **antes** de las rutas de proxy, por lo que bypassa el pipeline de middlewares.
- **Sin proxy**: nunca se reenvía a un backend. Lee directamente la lista de servicios desde `routes[]`.
- **Consultas paralelas**: usa `Promise.all` con `fetch` nativo + `AbortSignal.timeout(timeoutMs)`. La latencia total ≈ `timeoutMs` + overhead, **no se acumula** por cantidad de servicios.
- **Excluido de métricas HTTP**: `MetricsPlugin` se configura dinámicamente para no contar requests a `/health` en `gateway_http_requests_total` ni en el histograma de latencia.
- **Refleja SIGHUP**: la lista de servicios se lee del snapshot vivo, por lo que añadir/quitar rutas vía hot-reload se ve reflejado sin reiniciar.

### Configuración

```yaml
health:
  enabled: true           # Habilita el endpoint /health (default: true)
  path: "/health"         # Path del endpoint en el Gateway (default: /health)
  backendPath: "/health"  # Path del health en cada servicio downstream (default: /health)
  timeoutMs: 2000         # Timeout por servicio en ms (default: 2000)
```

### Formato de Respuesta

#### Caso 1: Todos los servicios OK → HTTP 200

```json
{
  "status": "ok",
  "timestamp": "2026-06-28T14:30:00.123Z",
  "services": [
    { "name": "auth-service",    "status": "ok",       "latencyMs": 12, "statusCode": 200 },
    { "name": "catalog-service", "status": "ok",       "latencyMs": 23, "statusCode": 200 },
    { "name": "orders-service",  "status": "ok",       "latencyMs": 18, "statusCode": 200 }
  ]
}
```

#### Caso 2: Un servicio DOWN → HTTP 503

```json
{
  "status": "down",
  "timestamp": "2026-06-28T14:30:00.123Z",
  "services": [
    { "name": "auth-service",    "status": "ok",   "latencyMs": 12,   "statusCode": 200 },
    { "name": "catalog-service", "status": "down", "latencyMs": 2000, "error": "timeout after 2000ms" },
    { "name": "orders-service",  "status": "ok",   "latencyMs": 18,   "statusCode": 200 }
  ]
}
```

#### Caso 3: Un servicio DEGRADED (4xx) → HTTP 200

```json
{
  "status": "degraded",
  "timestamp": "2026-06-28T14:30:00.123Z",
  "services": [
    { "name": "auth-service",    "status": "ok",       "latencyMs": 12, "statusCode": 200 },
    { "name": "catalog-service", "status": "degraded", "latencyMs": 8,  "statusCode": 401, "error": "backend returned 401" },
    { "name": "orders-service",  "status": "ok",       "latencyMs": 18, "statusCode": 200 }
  ]
}
```

### Reglas de clasificación

| Status del backend | Estado del servicio | Estado global posible | HTTP code |
|---|---|---|---|
| `2xx` / `3xx` | `ok` | `ok` | 200 |
| `4xx` | `degraded` | `degraded` | 200 |
| `5xx` | `down` | `down` | 503 |
| Timeout / `ECONNREFUSED` / `ENOTFOUND` | `down` | `down` | 503 |

**Estado global** se calcula así:
- Cualquier servicio `down` → global `down` (HTTP 503)
- Si no hay `down` pero hay `degraded` → global `degraded` (HTTP 200)
- Todos `ok` → global `ok` (HTTP 200)

El HTTP 200 en `degraded` es **deliberado**: permite mantener al gateway en el pool de balanceadores cuando solo hay degradación parcial.

### Nombre de servicio

El campo `name` de cada servicio se resuelve con esta prioridad:
1. `route.backendName` (config explícita)
2. `hostname(route.target)` (extraído de la URL del target)
3. `route.prefix` (fallback)

### Ejemplo de uso con curl

```bash
# Quick check
curl -s http://localhost:3000/health | jq

# Solo el status global y los servicios caídos
curl -s http://localhost:3000/health | jq '{status, down: .services | map(select(.status == "down"))}'

# Watch continuo
watch -n 5 'curl -s http://localhost:3000/health | jq ".status"'
```

---

## 🔌 Extensibilidad: Crear Plugins Personalizados

El orquestador de middlewares funciona mediante un pipeline secuencial basado en la interfaz `GatewayPlugin`. Los hooks de ciclo de vida del proxy (`ProxyLifecycleHooks`) permiten interceptar el flujo completo.

### Interfaces del Plugin
Las interfaces se encuentran definidas en [src/middleware/pipeline.ts](file:///d:/desarrollo/Gateway/src/middleware/pipeline.ts):

```typescript
export interface RequestContext {
  request: FastifyRequest;
  reply: FastifyReply;
  routeMatch: RouteMatch;
}

export interface ResponseContext {
  request: FastifyRequest;
  reply: FastifyReply;
  routeMatch: RouteMatch;
  payload: unknown;
}

export interface GatewayPlugin {
  name: string;
  onRequest?(context: RequestContext): Promise<void>;
  onResponse?(context: ResponseContext): Promise<void>;
}
```

### Hooks de Ciclo de Vida del Proxy

Además del pipeline estándar, el `ProxyEngine` expone hooks de bajo nivel para integración con patrones de resiliencia. Sus definiciones viven en [`src/proxy/types.ts`](src/proxy/types.ts):

```typescript
export interface ProxyLifecycleHooks {
  // Ejecutado justo antes de enviar la request al backend (puede mutar opciones o rechazar)
  onBeforeRequest?(
    options: ProxyRequestOptions,
    context: ProxyContext
  ): void | Promise<void>;

  // Ejecutado tras recibir las cabeceras del backend (puede inspeccionar/mutar headers)
  onBeforeResponse?(
    response: ProxyResponseData,
    context: ProxyContext
  ): void | Promise<void>;

  // Ejecutado cuando ocurre un error de red o timeout
  onError?(error: ProxyError, context: ProxyContext): void | Promise<void>;
}
```

> **Importante**: `onBeforeResponse` se ejecuta **antes** de `reply.send()`, por lo que es el hook correcto para plugins que necesitan añadir cabeceras a la respuesta del backend (ver patrón del `CorsPlugin`). El hook `onResponse` de `GatewayPlugin`, en cambio, se ejecuta **después** de `reply.send()` y no puede agregar nuevas cabeceras.

### Ejemplo Práctico: Plugin de Telemetría

```typescript
// src/middleware/telemetry-plugin.ts
import { GatewayPlugin, RequestContext, ResponseContext } from './pipeline.js';
import { Logger } from 'pino';

export class TelemetryPlugin implements GatewayPlugin {
  public readonly name = 'telemetry';
  private readonly logger: Logger;

  constructor(logger: Logger) { this.logger = logger; }

  public async onRequest(ctx: RequestContext): Promise<void> {
    (ctx.request as any).startTime = Date.now();
  }

  public async onResponse(ctx: ResponseContext): Promise<void> {
    const durationMs = Date.now() - (ctx.request as any).startTime;
    this.logger.info({ url: ctx.request.url, durationMs }, 'Petición procesada');
  }
}
```

### Registrar el Plugin en el Bootstrap

```typescript
// Dentro de bootstrap() en src/index.ts:
const pluginsList: GatewayPlugin[] = [
  corsPlugin,           // PRIMERO: responde preflights OPTIONS sin consumir rate-limit/auth/circuit-breaker
  rateLimitPlugin,
  jwtAuthPlugin,
  circuitBreakerPlugin, // Registra hooks de ciclo de vida en ProxyEngine
  // metricsPlugin (opcional, ver config.metrics.enabled)
];
const pipeline = new MiddlewarePipeline(pluginsList);
```

**Orden importa**: el bootstrap oficial ejecuta los plugins en este orden — request: CORS → rate-limit → JWT → circuit-breaker → metrics; response: orden inverso. Los preflights CORS se cortocircuitan al inicio y nunca pasan por el resto del pipeline.

*Nota: Si un plugin responde la petición directamente llamando a `reply.send()` en su gancho `onRequest`, los siguientes middlewares y el proxy se **cancelarán automáticamente** (Short-circuit).*

---

## 🐳 Comandos de Desarrollo y Docker

El proyecto utiliza **pnpm** de forma mandatoria. A continuación se listan los comandos principales disponibles:

### Desarrollo Local
```bash
# Instalar dependencias
pnpm install

# Levantar el servidor en modo desarrollo (con recarga en caliente)
pnpm dev

# Formatear el código con Prettier
pnpm format

# Ejecutar el analizador de código estático (ESLint)
pnpm lint
```

### Compilación y Construcción
```bash
# Compilar TypeScript a JavaScript de producción
pnpm build

# Levantar el Gateway compilado en producción
pnpm start
```

### Ejecutar Pruebas
```bash
# Ejecutar todas las suites de prueba (unitarias e integradas)
pnpm test

# Ejecutar solo las pruebas unitarias (tests/unit/**)
pnpm test:unit

# Ejecutar solo las pruebas de integración (tests/integration/**)
pnpm test:integration

# Modo watch (re-ejecuta al detectar cambios)
pnpm test:watch

# Ejecutar pruebas y generar reporte de cobertura
pnpm test:coverage

# Ejecutar un único archivo de prueba
pnpm vitest run tests/unit/routing/matcher.test.ts

# Filtrar pruebas por nombre (subconjunto del archivo activo)
pnpm vitest run -t "matches longest prefix"
```

### Docker
```bash
# Construir la imagen Docker optimizada de producción
pnpm docker:build
```

---

## 📊 Observabilidad, Métricas y Tooling de Desarrollo (Prometheus, Grafana, Dozzle & JSON Schema)

El Gateway incluye un stack de desarrollo y observabilidad optimizado para facilitar el diagnóstico, monitoreo en tiempo real y configuración local sin sobrecargar los componentes en producción.

### 1. Visualización de Logs en Tiempo Real (Dozzle)

**Dozzle** es un visualizador de logs interactivo y ultra-ligero (consume menos de 10 MB de RAM) que se conecta al socket de Docker y expone una interfaz web moderna para monitorear los contenedores.

* **Cómo arrancar**: Levanta el stack de desarrollo completo mediante:
  ```bash
  docker compose -f docker/docker-compose.example.yml up -d
  ```
* **Acceso**: Abre en tu navegador [http://localhost:9999](http://localhost:9999).
* **Características**:
  * Visualización en tiempo real de los logs estructurados (JSON de Pino).
  * Búsqueda por texto (ej. filtra por "Rate limit" o errores "429").
  * Monitoreo conjunto de `gateway-service`, `gateway-redis` y `mock-service`.
  * Socket de Docker montado de forma segura en modo **solo lectura (`ro`)**.

---

### 2. Autocompletado y Validación de Configuración (JSON Schema)

Para evitar errores humanos y agilizar la edición del archivo `gateway.yaml`, el proyecto incluye un **JSON Schema** que proporciona ayuda interactiva directamente en el editor.

#### Requisitos
1. Utilizar **Visual Studio Code**.
2. Instalar la extensión oficial **YAML** de Red Hat (`redhat.vscode-yaml`).

#### Características integradas:
* **Autocompletado Inteligente (`Ctrl+Espacio`)**: Sugerencias en tiempo real al definir propiedades clave como `server`, `redis`, `logging`, `routes` u `overrides`.
* **Validación de Tipos y Formatos**: VS Code marcará en rojo configuraciones erróneas (ej. puertos fuera de rango `1-65535`, URL de Redis que no empiece con `redis://` o un array `routes` vacío).
* **Soporte para Interpolación**: La validación es totalmente compatible con la sintaxis de variables de entorno `${ENV_VAR}` en cualquier propiedad escalar (ej. `port: ${PORT}`).
* **Tooltips en Español**: Hover explicativo sobre cualquier propiedad detallando su propósito, valores por defecto y ejemplos de uso en español.

#### Estructura de Asociación
El archivo `.vscode/settings.json` mapea automáticamente el esquema `config/gateway-schema.json` a los siguientes archivos:
* `config/gateway.yaml`
* `config/gateway.example.yaml`
* `docker/gateway.yaml`

#### 🔄 Mantenimiento y Regeneración del Schema
Si el esquema de configuración Zod en `src/config/schema.ts` se modifica (por ejemplo, al añadir un nuevo middleware o una nueva propiedad al servidor), el JSON Schema en `config/gateway-schema.json` debe actualizarse correspondientemente para mantener la coherencia.
Para actualizarlo:
1. Modifica la estructura en `src/config/schema.ts`.
2. Replica de forma correspondiente las propiedades, tipos y descripciones en `config/gateway-schema.json`.

---

### 3. Métricas y Observabilidad (Prometheus + Grafana)

El API Gateway incluye soporte nativo y de alto rendimiento para la recolección y exposición de métricas de telemetría compatibles con **Prometheus**. Esto permite monitorear la salud de las rutas, los tiempos de respuesta, la eficiencia del rate limiting y el estado de los circuit breakers en tiempo real.

#### Características y Red de Seguridad
* **Endpoint `/metrics` Nativo:** Expone de forma nativa un endpoint en formato de texto plano que recopila tanto las métricas por defecto de Node.js (CPU, memoria, loops de eventos) como las métricas personalizadas del Gateway.
* **Mitigación de Fugas en Conexiones In-Flight:** La métrica de peticiones activas (`gateway_http_requests_in_flight`) cuenta con una red de doble seguridad (doble mitigación). Utiliza un flag único (`Symbol` privado) para evitar doble decremento por eventos redundantes de Fastify y un listener directo al socket de bajo nivel (`request.raw.socket.once('close')`) para asegurar que si un cliente interrumpe abruptamente la conexión, el contador de peticiones en vuelo se decremente correctamente.
* **Baja Cardinalidad Controlada:** Para evitar problemas de sobrecarga y crecimiento desmedido en la base de datos de Prometheus (cardinalidad), las etiquetas de las métricas están acotadas a valores controlados:
  * `method`: Método HTTP (`GET`, `POST`, etc.).
  * `route`: Prefijo lógico o nombre descriptivo asignado a la ruta (`metricsLabel` en la configuración) o fallback a `unmatched`.
  * `status_code`: Código de estado HTTP retornado (`200`, `404`, `429`, `500`, o `499` para peticiones canceladas/abortadas).
  * `backend`: Nombre descriptivo del backend (`backendName`) o fallback al hostname destino de la petición (o `unknown`).

#### Métricas del Gateway (HTTP)
| Métrica | Tipo | Etiquetas | Descripción |
| :--- | :--- | :--- | :--- |
| `gateway_http_requests_total` | Counter | `method`, `route`, `status_code`, `backend` | Cantidad total acumulada de peticiones HTTP procesadas por el Gateway. |
| `gateway_http_request_duration_seconds` | Histogram | `method`, `route`, `status_code`, `backend` | Latencia de procesamiento de las peticiones en segundos (buckets: `0.005s` a `10s`). |
| `gateway_http_requests_in_flight` | Gauge | `method`, `route` | Cantidad actual de peticiones siendo procesadas de forma concurrente. |
| `gateway_rate_limit_hits_total` | Counter | `route` | Cantidad de peticiones rechazadas con código `429 (Too Many Requests)` por rate limit. |

#### Métricas de CORS
| Métrica | Tipo | Etiquetas | Descripción |
| :--- | :--- | :--- | :--- |
| `gateway_cors_requests_total` | Counter | `decision` | Total de peticiones procesadas por el plugin CORS. Valores posibles (`decision`): `allowed`, `blocked`, `preflight`, `no_origin`. Cardinalidad baja (4 valores). |

**Consultas PromQL útiles:**
```promql
# Tasa de preflights
rate(gateway_cors_requests_total{decision="preflight"}[5m])

# Tasa de orígenes bloqueados
rate(gateway_cors_requests_total{decision="blocked"}[5m])

# % de requests con header Origin (i.e., desde un navegador)
sum(rate(gateway_cors_requests_total{decision=~"allowed|blocked|preflight"}))
  / sum(rate(gateway_cors_requests_total))
```

#### Métricas del Circuit Breaker
| Métrica | Tipo | Etiquetas | Descripción |
| :--- | :--- | :--- | :--- |
| `gateway_circuit_breaker_state` | Gauge | `route`, `backend` | Estado actual: `0`=CLOSED, `1`=HALF_OPEN, `2`=OPEN. |
| `gateway_circuit_breaker_failures_total` | Counter | `route`, `backend` | Total de fallos registrados por el circuit breaker. |
| `gateway_circuit_breaker_requests_total` | Counter | `route`, `backend`, `status` | Total de requests procesadas (etiqueta `status`: `success` / `failure`). |
| `gateway_circuit_breaker_transitions_total` | Counter | `route`, `backend`, `from_state`, `to_state` | Transiciones de estado del circuit. |
| `gateway_circuit_breaker_open_total` | Counter | `route`, `backend` | Veces que el circuit ha pasado al estado OPEN. |

#### Métricas de Retry
| Métrica | Tipo | Etiquetas | Descripción |
| :--- | :--- | :--- | :--- |
| `gateway_retries_total` | Counter | `route`, `backend`, `error_code` | Total de reintentos realizados, desglosados por tipo de error. |
| `gateway_retry_success_total` | Counter | `route`, `backend` | Reintentos que resultaron exitosos. |
| `gateway_retry_delay_seconds` | Histogram | `route`, `attempt` | Distribución de los delays entre reintentos. |

#### Configuración del Módulo de Métricas
En el archivo `gateway.yaml` se pueden configurar las siguientes propiedades bajo la clave global `metrics`:
```yaml
metrics:
  enabled: true                  # Habilita o deshabilita la recolección y exposición de métricas
  path: /metrics                 # Ruta donde se expondrá el endpoint (Por defecto: /metrics)
  defaultLabels:                 # Etiquetas globales que se inyectarán en todas las métricas
    env: production
    region: us-east-1

routes:
  - prefix: /api
    target: http://users-service:8080
    metricsLabel: users-api       # Sobrescribe el valor de la etiqueta 'route' en las métricas
    backendName: users-backend   # Sobrescribe el valor de la etiqueta 'backend' en las métricas
```

#### Levantando el Stack de Monitoreo Local
El entorno de desarrollo preconfigurado en `docker/docker-compose.example.yml` incluye servicios listos para usar de **Prometheus** y **Grafana** autoaprovisionados:
1. **Configuración de Raspado:** Prometheus está configurado para raspar automáticamente el endpoint `/metrics` del Gateway cada 5 segundos.
2. **Dashboard Auto-Aprovisionado:** Grafana arranca con un dashboard preconfigurado interactivo llamado **Gateway Overview** que ofrece los siguientes paneles esenciales:
   * **RPS (Requests por Segundo):** Muestra el volumen de tráfico actual y su evolución histórica.
   * **Latencia P95:** Visualiza el percentil 95 de duración de las peticiones por ruta para identificar cuellos de botella de rendimiento.
   * **Estado del Circuit Breaker:** Gauge por ruta mostrando el estado actual (CLOSED/HALF_OPEN/OPEN).
   * **Distribución de Códigos HTTP:** Un gráfico de distribución que desglosa las respuestas en familias (`2xx`, `4xx`, `5xx`, etc.).
   * **Bloqueos por Rate Limit (Hits 429):** Monitorea las peticiones bloqueadas por rate limit en tiempo real.

Para levantar el stack de monitoreo:
```bash
docker compose -f docker/docker-compose.example.yml up -d
```
* **Acceso a Grafana:** Abre en tu navegador [http://localhost:3001](http://localhost:3001).
* **Credenciales de Acceso:** Usuario: `admin`, Contraseña: `admin` (se solicita cambio al primer inicio o se puede omitir).
* **Acceso a Prometheus (Opcional):** Abre [http://localhost:9090](http://localhost:9090) para realizar consultas PromQL directamente.

---

## 🔄 Recarga de Configuración en Caliente (Hot Reload)

El Gateway cuenta con soporte para recargar su configuración en caliente sin detener el proceso ni re-bindear puertos, garantizando **zero-downtime absoluto**. Este mecanismo funciona mediante el envío de la señal del sistema operativo `SIGHUP`.

### 🚀 Cómo Ejecutar la Recarga en Caliente

#### En Entorno Contenerizado (Docker/Docker Compose)
Para notificar al Gateway dentro del contenedor de que el archivo `gateway.yaml` ha sido modificado, ejecuta el siguiente comando desde la máquina host:

```bash
docker kill -s SIGHUP gateway-service
```

#### En Desarrollo Local (Linux/macOS)
Envía la señal directamente al proceso Node.js utilizando su Identificador de Proceso (PID):

```bash
kill -s SIGHUP <PID_DEL_PROCESO>
```

---

### 🧠 Mecanismo de Snapshots Inmutables

La recarga implementa un patrón de **Swap de Snapshots Inmutables** en memoria:
1. **Validación Previa:** Al recibir la señal, el Gateway lee, interpola y valida la nueva configuración con **Zod** antes de realizar cualquier cambio. Si la validación falla (ej. YAML inválido o tipos incorrectos), la recarga se aborta por completo y el Gateway continúa operando de forma estable con la configuración anterior (**Rollback Automático**).
2. **Swap Atómico:** Si la nueva configuración es válida, se genera un nuevo snapshot completo (`ConfigSnapshot`) y se realiza un reemplazo atómico de la referencia en memoria. Los requests concurrentes en vuelo terminan de procesarse con el snapshot con el que iniciaron, mientras que los nuevos consumen instantáneamente el snapshot recién aplicado.
3. **Protección Concurrente:** El proceso está protegido contra ráfagas de señales mediante un **Mutex lógico** asíncrono. Señales adicionales recibidas mientras hay una recarga en curso serán ignoradas de forma segura emitiendo un aviso (`warn`) en el log.

---

### 📋 Campos Recargables vs. Campos Estáticos

Para mantener la estabilidad de la red y el sistema, los campos se clasifican en dos categorías cuando el Gateway procesa una recarga:

#### ⚡ Campos Recargables en Caliente (Se aplican inmediatamente)
* **`routes[].rateLimit` (`maxRequests`, `windowSeconds`)**: Los límites de tasa se reajustan dinámicamente y se aplican a los nuevos requests. **Los contadores vigentes en Redis se preservan intactos**.
* **`routes[].cors`**: Cambios en la política CORS por ruta (orígenes, métodos, headers) se aplican sin reiniciar.
* **`cors` (global)**: Cambios en la política CORS global se aplican inmediatamente a todas las rutas que no tengan override.
* **`corsOverrides`**: Añadir, modificar o remover overrides CORS por path exacto.
* **`overrides` (excepciones de endpoints)**: Permite añadir, modificar o remover overrides específicos de rate limit sobre paths exactos.
* **`jwt` (global)**: Cambios en la sección JWT global (lista de issuers, TTLs) se reflejan inmediatamente. El `JwtAuthRegistry` se reconstruye: los issuers nuevos arrancan background refresh, los removidos se detienen. **Las caches de issuers no modificados se recrean vacías** (es un trade-off del swap atómico — un request con un kid previamente cacheado puede disparar un refresh on miss durante el primer segundo post-reload).
* **`jwtOverrides`**: Añadir, modificar o remover overrides JWT por path exacto.
* **`routes[].jwt`**: Cambios en el modo (shared-secret ↔ jwks) o en la referencia al issuer se aplican al siguiente request.
* **`logging.level`**: Modifica en caliente el nivel del logger dinámicamente en Pino (`logger.level = nuevoLevel`) sin reiniciar.

#### ⚠️ Campos Estáticos (Ignorados de forma segura con un `warn`)
Cualquier cambio en las siguientes secciones estructurales no bloqueará la recarga de los campos aplicables, pero no surtirá efecto y emitirá una advertencia (`warn`) en los logs auditados indicando que **requieren un reinicio completo del Gateway**:
* **`server.port` / `server.host`**: Requieren re-bind del socket TCP.
* **`redis.url` / `redis.onFailure`**: Requieren reconectar o reconstruir la inicialización del plugin.
* **`routes[].prefix` / `routes[].target` / `routes[].stripPrefix` / `routes[].timeout`**: Están inyectados en la inicialización estática del proxy inverso (motor `Undici`).
* **Agregar o eliminar rutas**: No se pueden desregistrar plugins dinámicamente en Fastify.

---

## 🔒 Seguridad e Integridad de Datos

* **Ocultación de Errores Internos**: El manejador de errores global intercepta cualquier error crítico en producción (estados `5xx`) y retorna una estructura JSON limpia sin exponer trazas de pila (*stack traces*), dependencias caídas, IPs o puertos de backends internos.
* **Logs Limpios**: El logger Pino redacta automáticamente las siguientes cabeceras sensibles, reemplazándolas por el literal `[REDACTED]` antes de escribirlas en `stdout` para asegurar que ninguna credencial termine persistida en disco:
  * `Authorization`
  * `Cookie`
  * `Proxy-Authorization`
  * `Set-Cookie` (cabecera de respuesta)

---

## 📄 Licencia

Este proyecto está bajo la Licencia **MIT**. Consulte el archivo `LICENSE` para obtener más información.

