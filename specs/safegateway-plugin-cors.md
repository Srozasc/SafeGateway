# Spec: Plugin CORS para SafeGateway

> **Estado**: Pendiente de implementación (revisión #2)
> **Proyecto destino**: [SafeGateway](https://github.com/Srozasc/SafeGateway)
> **Origen**: Gap identificado durante la planificación de Flash Drop Backend
> **Cambios vs revisión #1**: Ver [CHANGELOG del spec](#changelog-de-revisiones) al final

---

## User Story

> **Como** operador del API Gateway
> **quiero** configurar reglas CORS (orígenes, métodos, headers, credentials) por ruta
> **para** permitir que clientes web (apps frontend, admin panels) consuman los servicios backend a través del gateway sin errores de CORS en el navegador, manteniendo control centralizado de la política de orígenes permitidos.

---

## Contexto

SafeGateway actualmente no tiene un plugin CORS. Las aplicaciones frontend que consumen APIs a través del gateway reciben errores de CORS en el navegador porque las respuestas no incluyen los headers `Access-Control-Allow-*`.

Este spec define un plugin CORS configurable, alineado con los patrones existentes (rate-limit, jwt-auth, circuit-breaker).

---

## Asunciones Aceptadas

### Funcionales

- **A1**: El origen de la petición es un navegador web (no server-to-server).
- **A2**: Soporte para lista explícita de origins + wildcard `*`.
- **A3**: Métodos HTTP permitidos por defecto: `GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD`.
- **A4**: Headers permitidos por defecto: `Content-Type, Authorization`.
- **A5**: `credentials = false` por defecto.
- **A6**: `maxAge = 86400` segundos (24h) por defecto.
- **A7**: Origin no permitido → no se envían headers CORS (respuesta normal del backend).
- **A8**: Preflight (OPTIONS) se responde automáticamente sin pasar al backend cuando el origin es permitido.
- **A9**: Precedencia de configuración (de mayor a menor prioridad):
  1. `corsOverrides[path=X]` (path-exact) — mismo patrón que `overrides[]` de rate-limit
  2. `routes[].cors` (prefijo de ruta)
  3. `cors` (configuración global)
- **A10**: OPTIONS con header `Origin` se trata como preflight **incluso si faltan `Access-Control-Request-Method` / `Access-Control-Request-Headers`**. La presencia de `Origin` es señal suficiente de contexto de navegador.
- **A11**: Origin vacío, ausente o con valor literal `"null"` → no se agregan headers CORS, request pasa al backend normalmente, sin log de bloqueo.
- **A12**: Si el request incluye múltiples headers `Origin` (clientes mal configurados), se toma el primero y se loguea warning una sola vez por origin malformado.
- **A13**: `Access-Control-Expose-Headers` se envía **únicamente** en respuestas del backend (`onResponse`), nunca en preflights (204). Es lo que dicta el standard Fetch.
- **A14**: `Vary: Origin` se agrega **solo** cuando el origin reflejado es específico. Si la respuesta usa wildcard `*`, no se agrega `Vary: Origin` (no aporta caché diferenciada).
- **A15**: `Access-Control-Allow-Credentials` se emite **solo si `credentials: true` en la config**. Con `credentials: false`, el header se omite completamente (cumple standard Fetch §3.2).
- **A16**: Solo se reflejan en `Access-Control-Allow-Headers` los headers solicitados por el browser que estén en `allowedHeaders`. Si el browser pide un header no permitido, el preflight **no falla en el gateway** — el browser será quien rechace la petición real.
- **A17**: Wildcards en `methods` y `allowedHeaders`:
  - `methods: ["*"]` se trata como `[GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD]`
  - `allowedHeaders: ["*"]` requiere `credentials: false` (validado en Zod)
  - `origins: ["*"]` + `credentials: true` se rechaza (validado en Zod)

### Técnicas

- **A18**: Implementación como plugin nuevo en `src/middleware/cors/` siguiendo la interfaz `GatewayPlugin`.
- **A19**: Hot-reload de configuración CORS sin reinicio (cubre `cors`, `routes[].cors`, `corsOverrides[]`).
- **A20**: Logging de orígenes bloqueados solo en nivel `debug`.
- **A21**: Sin dependencias nuevas — implementación manual de headers.
- **A22**: Métricas Prometheus mínimas (1 counter con label de baja cardinalidad). Ver [Criterios de Aceptación — Operacionales](#criterios-de-aceptación).
- **A23**: `credentials = true` solo permitido con origins específicos (no `*`).
- **A24**: Validación de origin **case-insensitive** sobre scheme + host + puerto normalizado a lowercase. Aplica tanto al comparar el `Origin` del request contra la allowlist como al reflejarlo en `Access-Control-Allow-Origin`.
- **A25**: Sin caché de normalización: el costo de `.toLowerCase()` sobre un string corto es despreciable frente al lookup. Complejidad por request: O(n) en número de origins configurados.

### Operacionales

- **A26**: Combinaciones inválidas (`credentials + origins:["*"]`, `enabled=true + origins=[]`, `allowedHeaders:["*"] + credentials=true`) son **errores fatales al startup** y se loguean claramente. Rollback automático en hot-reload.
- **A27**: Si el backend tiene circuit breaker abierto, los preflights (OPTIONS con origin permitido) **se responden 204 sin tocar el backend**, evitando que el circuit breaker impacte a clientes web.
- **A28**: Tests de integración deben cubrir el escenario de hot-reload mid-flight: requests previos terminan con config antigua, nuevos requests usan la nueva.

---

## Configuración

### Jerarquía de precedencia

```
corsOverrides[path=X]   ← path-exact (mayor prioridad)
       ↓ (fallback)
routes[].cors           ← prefijo de ruta
       ↓ (fallback)
cors                    ← global (default)
       ↓ (fallback)
disabled                ← si nada está definido
```

### Mockup ASCII — Configuración completa

```yaml
# config/gateway.yaml

server:
  port: 8080
  host: "0.0.0.0"

# ── Configuración CORS global ──────────────────────────────────
cors:
  enabled: true                    # default: false
  origins:                         # default: [] (CORS deshabilitado)
    - "https://app.flashdrop.cl"
    - "https://admin.flashdrop.cl"
    - "https://staging.flashdrop.cl"
  methods:                         # default: GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD
    - GET
    - POST
    - PUT
    - DELETE
    - PATCH
    - OPTIONS
  allowedHeaders:                  # default: Content-Type, Authorization
    - Content-Type
    - Authorization
    - X-Request-ID
  exposedHeaders:                  # default: [] (solo aplica a respuestas reales, no preflights)
    - X-Request-ID
    - X-RateLimit-Remaining
  credentials: false               # default: false
  maxAge: 86400                    # default: 86400 (24h). Algunos navegadores limitan a 7200.

routes:
  # ── Ruta general (hereda config CORS global) ────────────────
  - prefix: /api
    target: http://backend:3000
    stripPrefix: true

  # ── Override: ruta con policy más permisiva (solo dev) ───────
  - prefix: /api/dev
    target: http://backend-dev:3000
    stripPrefix: true
    cors:
      origins:
        - "*"                      # Wildcard solo permitido si credentials=false
      methods:
        - "*"                      # Equivale a [GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD]

  # ── Override: ruta con credentials habilitado (auth) ─────────
  - prefix: /api/auth
    target: http://auth-service:8082
    stripPrefix: true
    cors:
      origins:
        - "https://app.flashdrop.cl"
      credentials: true            # Permitido solo con origins específicos
      allowedHeaders:
        - Content-Type
        - Authorization
        - Cookie

  # ── Override: ruta sin CORS (servicio interno) ───────────────
  - prefix: /internal
    target: http://internal-service:9000
    stripPrefix: true
    cors:
      enabled: false               # Deshabilita CORS para esta ruta

# ── Overrides por path exacto (path-exact, mayor prioridad) ───
corsOverrides:
  - path: /api/auth/login
    cors:
      origins:
        - "*"                      # Login público: cualquier origen
      credentials: false
```

---

## BDD Scenarios

### Escenario 1: Request normal desde origin permitido

```gherkin
Given el gateway con CORS habilitado y origin "https://app.flashdrop.cl" en la lista permitida
When el navegador envía un GET a /api/products con header "Origin: https://app.flashdrop.cl"
Then el gateway agrega a la respuesta (después de pasar al backend):
  | Header                          | Value                       |
  | Access-Control-Allow-Origin     | https://app.flashdrop.cl    |
  | Access-Control-Allow-Methods    | GET, POST, PUT, ...         |
  | Access-Control-Allow-Headers    | Content-Type, Authorization |
  | Vary                            | Origin                      |
And NO se agrega Access-Control-Allow-Credentials (porque credentials=false por default)
And el request pasa al backend normalmente
```

### Escenario 2: Request desde origin NO permitido

```gherkin
Given el gateway con CORS habilitado y origin "https://app.flashdrop.cl" en la lista permitida
When el navegador envía un GET a /api/products con header "Origin: https://malicious.com"
Then la respuesta NO contiene ningún header "Access-Control-Allow-*"
And NO contiene "Vary: Origin"
And el backend recibe el request normalmente (CORS es decisión del cliente)
And se registra un log nivel "debug":
  """
  cors: blocked origin https://malicious.com for route /api/*
  """
```

### Escenario 3: Preflight request (OPTIONS)

```gherkin
Given el gateway con CORS habilitado
When el navegador envía un OPTIONS a /api/orders con headers:
  | Origin: https://app.flashdrop.cl        |
  | Access-Control-Request-Method: POST     |
  | Access-Control-Request-Headers: Content-Type, Authorization |
Then el gateway responde directamente con HTTP 204 (sin pasar al backend)
And la respuesta incluye:
  | Header                              | Value                                          |
  | Access-Control-Allow-Origin         | https://app.flashdrop.cl                       |
  | Access-Control-Allow-Methods        | GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD   |
  | Access-Control-Allow-Headers        | Content-Type, Authorization                    |
  | Access-Control-Max-Age              | 86400                                          |
  | Vary                                | Origin                                         |
And NO se incluye Access-Control-Expose-Headers (solo aplica a respuestas reales)
And NO se incluye Access-Control-Allow-Credentials (credentials=false por default)
And el backend NO recibe el request OPTIONS
```

### Escenario 4: Origin wildcard con credentials (bloqueado por spec)

```gherkin
Given la configuración:
  """
  cors:
    origins: ["*"]
    credentials: true
  """
When el operador intenta validar o hacer reload de la configuración
Then la validación Zod falla con error:
  """
  cors: cannot use credentials=true with wildcard origin "*"
  """
And el ConfigSnapshot anterior se mantiene (rollback automático)
```

### Escenario 5: Override por ruta con policy más permisiva (wildcard)

```gherkin
Given la ruta /api/dev configurada con cors.origins: ["*"] y cors.credentials: false (default)
When el navegador envía un GET a /api/dev/users con "Origin: https://anywhere.com"
Then la respuesta incluye "Access-Control-Allow-Origin: *"
And NO se incluye "Vary: Origin" (no aporta con wildcard)
And NO se incluye "Access-Control-Allow-Credentials" (credentials=false, no se emite el header)
```

### Escenario 6: Override por ruta con CORS deshabilitado

```gherkin
Given la ruta /internal configurada con cors.enabled: false
When el navegador envía cualquier request a /internal/health
Then la respuesta NO contiene ningún header "Access-Control-Allow-*"
And el request pasa al backend normalmente
```

### Escenario 7: Hot-reload de configuración CORS

```gherkin
Given el gateway corriendo con cors.origins: ["https://old.flashdrop.cl"]
When el operador envía SIGHUP con nueva configuración:
  """
  cors:
    origins:
      - "https://new.flashdrop.cl"
  """
Then el ConfigReloader valida la nueva config con Zod (incluyendo cors)
And si pasa validación: el snapshot se actualiza atómicamente
And los requests in-flight terminan con el snapshot anterior (ver Escenario 14)
And los nuevos requests usan la nueva lista de origins
And se registra log:
  """
  config: reloaded successfully (cors: 1 origin updated)
  """
```

### Escenario 8: Request sin header Origin (server-to-server)

```gherkin
Given el gateway con CORS habilitado
When un cliente backend envía un request SIN header "Origin"
Then el gateway NO agrega headers CORS a la respuesta
And el request pasa al backend normalmente
And NO se registra log (no hay origin que bloquear)
```

### Escenario 9: Validación al startup — orígenes vacíos

```gherkin
Given el archivo gateway.yaml con:
  """
  cors:
    enabled: true
    origins: []
  """
When el gateway arranca
Then la validación Zod falla con error:
  """
  cors: enabled=true requires at least one origin (use ["*"] for wildcard)
  """
And el proceso aborta con exit code 1
```

### Escenario 10: Preflight sin Access-Control-Request-Method

```gherkin
Given el gateway con CORS habilitado y origin permitido
When el navegador envía un OPTIONS a /api/products con SOLO el header:
  | Origin: https://app.flashdrop.cl |
  (sin Access-Control-Request-Method ni Access-Control-Request-Headers)
Then el gateway responde 204 con headers CORS de preflight
  | Access-Control-Allow-Origin  | https://app.flashdrop.cl |
  | Access-Control-Allow-Methods | GET, POST, ...          |
  | Access-Control-Max-Age       | 86400                   |
And el backend NO recibe el request (la presencia de Origin basta para considerarlo preflight)
```

### Escenario 11: Origin vacío o "null"

```gherkin
Given el gateway con CORS habilitado
When llega un request con header "Origin: " (vacío) o "Origin: null"
Then el gateway NO agrega headers CORS
And el request pasa al backend normalmente
And NO se registra log de bloqueo
```

### Escenario 12: Múltiples headers Origin

```gherkin
Given el gateway con CORS habilitado
When llega un request con múltiples headers "Origin" (cliente mal configurado):
  | Origin: https://app.flashdrop.cl   |
  | Origin: https://other.flashdrop.cl |
Then el gateway toma el PRIMER valor (https://app.flashdrop.cl) para la decisión
And se registra un warning UNA VEZ al detectar el patrón (rate-limited log):
  """
  cors: multiple Origin headers detected, using first value
  """
And el resto del flujo sigue normal (preflight o request normal según método)
```

### Escenario 13: Preflight con header solicitado no permitido

```gherkin
Given el gateway con allowedHeaders: ["Content-Type", "Authorization"]
When el navegador envía un OPTIONS a /api/orders con:
  | Origin: https://app.flashdrop.cl                          |
  | Access-Control-Request-Method: POST                       |
  | Access-Control-Request-Headers: Content-Type, X-Custom-Hdr |
Then el gateway responde 204 con:
  | Access-Control-Allow-Headers | Content-Type |
  (NO se incluye X-Custom-Hdr porque no está permitido)
And el browser será quien rechace la petición real (no es responsabilidad del gateway)
```

### Escenario 14: Hot-reload mid-flight (atomicidad)

```gherkin
Given el gateway corriendo con cors.origins: ["https://old.flashdrop.cl"]
And un request en curso para /api/products desde "https://old.flashdrop.cl"
When el operador envía SIGHUP con cors.origins: ["https://new.flashdrop.cl"]
Then el request en curso TERMINA con cors.origins = ["https://old.flashdrop.cl"]
  (su gatewayContext.routeMatch referencia el snapshot anterior)
And los NUEVOS requests desde "https://old.flashdrop.cl" ya NO reciben headers CORS
And los nuevos requests desde "https://new.flashdrop.cl" SÍ reciben headers CORS
And no hay condición de carrera observable
```

### Escenario 15: Circuit breaker abierto + preflight

```gherkin
Given el backend /api tiene circuit breaker en estado OPEN
When el navegador envía un OPTIONS a /api/orders con Origin permitido
Then el gateway responde 204 con headers CORS directamente
And el backend NO recibe el request (no se invoca el proxy)
And el circuit breaker NO se ve afectado (no se cuentan requests preflight)
```

### Escenario 16: Override por path exacto con `corsOverrides`

```gherkin
Given corsOverrides:
  """
  - path: /api/auth/login
    cors:
      origins: ["*"]
      credentials: false
  """
And la ruta /api/auth con cors.credentials: true y origins específicos
When llega un OPTIONS a /api/auth/login con "Origin: https://anywhere.com"
Then el gateway responde 204 con "Access-Control-Allow-Origin: *"
And NO incluye "Access-Control-Allow-Credentials" (override tiene credentials=false)
And este comportamiento es ESPECÍFICO a /api/auth/login
  (un OPTIONS a /api/auth/register usaría la config de routes[].cors con credentials=true)
```

### Escenario 17: Wildcard en allowedHeaders con credentials (bloqueado)

```gherkin
Given la configuración:
  """
  cors:
    allowedHeaders: ["*"]
    credentials: true
  """
When el operador intenta validar la configuración
Then la validación Zod falla con error:
  """
  cors: cannot use allowedHeaders=["*"] with credentials=true
  """
And el ConfigSnapshot anterior se mantiene en hot-reload, o el proceso aborta al startup
```

### Escenario 18: Validación al startup — sin bloque `cors`

```gherkin
Given el archivo gateway.yaml SIN bloque "cors" en absoluto
When el gateway arranca
Then CORS está completamente deshabilitado (no se cargan headers, no se hace short-circuit)
And no se requiere ninguna config CORS
And todas las rutas se comportan como si cors.enabled=false
```

---

## Criterios de Aceptación

### Funcionales

- [ ] El plugin responde preflight (OPTIONS con Origin permitido) automáticamente con HTTP 204, sin pasar al backend.
- [ ] Requests desde origins permitidos reciben todos los headers `Access-Control-Allow-*` configurados (excepto `Expose-Headers` en preflights, según A13).
- [ ] Requests desde origins NO permitidos NO reciben headers CORS pero sí pasan al backend.
- [ ] Requests sin header `Origin`, con Origin vacío, o con Origin `"null"` pasan al backend sin agregar headers CORS (A11).
- [ ] Precedencia correcta: `corsOverrides[path]` > `routes[].cors` > `cors` global (A9).
- [ ] `credentials: true` con `origins: ["*"]` se rechaza en validación Zod con mensaje claro (A23, Escenario 4).
- [ ] `allowedHeaders: ["*"]` con `credentials: true` se rechaza en validación Zod (A17, Escenario 17).
- [ ] `cors.enabled: true` con `origins: []` se rechaza al startup (Escenario 9).
- [ ] El plugin responde antes de cualquier rate-limit, auth o circuit breaker (orden en pipeline).
- [ ] Preflights (OPTIONS) responden 204 incluso si el circuit breaker del backend está abierto (A27, Escenario 15).

### Técnicos

- [ ] Implementación en `src/middleware/cors/` siguiendo interfaz `GatewayPlugin`.
- [ ] Headers CORS se aplican en `onRequest` (preflight 204) y en `onResponse` (respuestas del backend). Ver [Notas de Implementación #2](#notas-de-implementación).
- [ ] Schema Zod añadido a `src/config/schema.ts` con `.superRefine()` para validar combinaciones inválidas (credentials+*, enabled+[], allowedHeaders=*+credentials).
- [ ] `RouteMatch` extendido con campo `effectiveCors` (analogía con `effectiveRateLimit`).
- [ ] `RouteRegistry.match()` calcula `effectiveCors` con la precedencia definida en A9.
- [ ] `ConfigReloader.detectChanges()` incluye diff de `cors`, `routes[].cors`, `corsOverrides` y los reporta como `applied`.
- [ ] Hot-reload testeado mid-flight: requests previos usan snapshot anterior (Escenario 14).
- [ ] Tests unitarios cubren los 18 escenarios BDD.
- [ ] Tests de integración: preflight end-to-end contra mock backend.
- [ ] Documentación actualizada en [CLAUDE.md](../CLAUDE.md) y [README.md](../README.md).
- [ ] Cobertura ≥ 85% en `src/middleware/cors/`.

### Operacionales

- [ ] Logs estructurados en Pino con campo `cors.decision: "allowed" | "blocked" | "preflight" | "no_origin"`:
  - `allowed` y `preflight`: nivel `debug`
  - `blocked`: nivel `debug` (A20)
  - `no_origin`: no se loguea
- [ ] Warning UNA VEZ al detectar múltiples headers `Origin` (rate-limited, Escenario 12).
- [ ] Sin impacto medible en latencia (<0.5ms p99 overhead por request, A25).
- [ ] Sin nuevas dependencias en `package.json`.
- [ ] Métrica Prometheus: `gateway_cors_requests_total{decision}` (4 valores de label: allowed/blocked/preflight/no_origin).

---

## Dependencias

### Internas (SafeGateway)

| Archivo | Cambio requerido |
|---------|------------------|
| [`src/middleware/pipeline.ts`](../src/middleware/pipeline.ts) | Interfaz `GatewayPlugin` (sin cambios) |
| [`src/config/schema.ts`](../src/config/schema.ts) | Añadir `CorsConfigSchema`, `corsOverrides`, `routes[].cors`. Usar `.superRefine()` para combinaciones inválidas. |
| [`src/config/types.ts`](../src/config/types.ts) | Añadir `CorsConfig`, `CorsOverrideConfig`, `CorsConfigOverride` (interface). Extender `RouteConfig.cors?` y `OverrideConfig.cors?`. Añadir `GatewayConfig.cors?` y `GatewayConfig.corsOverrides?`. |
| [`src/config/reloader.ts`](../src/config/reloader.ts) | Ampliar `detectChanges()` para incluir diff de `cors`, `routes[].cors`, `corsOverrides`. Reportarlos como `applied`. |
| [`src/routing/types.ts`](../src/routing/types.ts) | Añadir `effectiveCors: CorsConfigOverride \| null` a `RouteMatch`. |
| [`src/routing/registry.ts`](../src/routing/registry.ts) | Calcular `effectiveCors` en `match()` con precedencia A9. |
| [`src/server.ts`](../src/server.ts) | Sin cambios estructurales. La creación del plugin CORS ocurre en bootstrap. |
| [`src/index.ts`](../src/index.ts) | Añadir `corsPlugin` AL INICIO de `pluginsList` (orden crítico). |

### Externas

Ninguna nueva. Implementación usa solo módulos nativos de Node y los headers HTTP estándar.

---

## Fuera de Alcance (Out of Scope)

- Logging de orígenes bloqueados en nivel `info` (solo `debug`, A20).
- Soporte para CSP (Content-Security-Policy) u otros headers de seguridad relacionados.
- Validación de origin contra allowlist dinámica (ej: BD de dominios).
- Soporte para cookies SameSite o atributos de cookie.
- Métricas adicionales más allá del counter único (sin histogramas por origin, sin duration).
- Soporte para `Access-Control-Request-Private-Network` (PNA / Private Network Access) — se puede agregar en versión futura.
- Wildcards parciales en origins (ej: `https://*.flashdrop.cl`) — requiere regex matching, no soportado en v1.

---

## Mockup ASCII — Flujo de decisión del plugin

```
                    ┌──────────────────────────┐
                    │ Request entrante         │
                    │ con header Origin?       │
                    └─────────┬────────────────┘
                              │
                  ┌───────────┴───────────┐
                  │                       │
              [No Origin]          [Con Origin]
              (o vacío/null)              │
                  │                       ▼
                  │              ┌──────────────────┐
                  │              │ ¿Múltiples       │
                  │              │  headers Origin? │
                  │              └────────┬─────────┘
                  │                       │
                  │                  [Sí] → warning + tomar primero
                  │                       │
                  │                       ▼
                  │              ┌──────────────────┐
                  │              │ Método = OPTIONS?│
                  │              └────────┬─────────┘
                  │                       │
                  │              ┌────────┴────────┐
                  │              │                 │
                  │        [Preflight]      [Request normal]
                  │              │                 │
                  ▼              ▼                 ▼
        ┌──────────────────┐  ┌─────────┐  ┌────────────────┐
        │ Pasar al backend │  │ Responder│  │ Origin en       │
        │ sin agregar      │  │ 204 con  │  │ allowlist?      │
        │ headers CORS     │  │ headers  │  └────────┬────────┘
        │ (no log)         │  │ CORS     │           │
        └──────────────────┘  │ (sin     │     ┌─────┴─────┐
                              │ backend) │     │           │
                              └─────────┘   [Sí]         [No]
                                                │           │
                                                ▼           ▼
                                      ┌─────────────┐  ┌────────────┐
                                      │ Agregar     │  │ NO agregar │
                                      │ headers     │  │ headers    │
                                      │ CORS en     │  │ CORS       │
                                      │ onResponse  │  │ pasar al   │
                                      │ (+Vary si   │  │ backend    │
                                      │  específico)│  │ (debug log)│
                                      └──────┬──────┘  └─────┬──────┘
                                             │              │
                                             └──────┬───────┘
                                                    ▼
                                          ┌─────────────────┐
                                          │ Backend responde│
                                          │ (o CORS plugin  │
                                          │ responde 204)   │
                                          └─────────────────┘
```

---

## Notas de Implementación

### 1. Orden en el pipeline

CORS debe ser el **primer plugin** en `onRequest` (antes de jwt-auth, rate-limit, circuit-breaker) para que:
- Los preflights no consuman rate limit
- Los preflights no intenten validar JWT
- Los preflights no se vean afectados por circuit breaker abierto (A27)

En [`src/index.ts`](../src/index.ts#L91), insertar `corsPlugin` AL INICIO de `pluginsList`:

```typescript
const pluginsList: GatewayPlugin[] = [corsPlugin, rateLimitPlugin, jwtAuthPlugin];
//                                                        ↑ nuevo: primero
```

### 2. Headers CORS en `onRequest` y `onResponse`

El plugin CORS agrega headers en **dos puntos** del ciclo de vida:

- **`onRequest`**:
  - **Preflight (OPTIONS con Origin permitido)**: agregar headers y responder 204. El pipeline hace short-circuit y `onResponse` nunca se ejecuta.
  - **Request normal con Origin permitido**: solo **decidir** si el origin está permitido; **no** agregar headers todavía. Se hace en `onResponse` para no contaminar respuestas del backend si este ya envía los headers.

- **`onResponse`**:
  - **Request normal con Origin permitido**: agregar headers CORS (`Allow-Origin`, `Allow-Methods`, `Allow-Headers`, `Allow-Credentials` si aplica, `Expose-Headers`, `Vary` si específico).
  - **Request normal con Origin NO permitido**: NO agregar nada (A7).
  - **Preflight**: nunca llega aquí (short-circuit).

> ⚠️ **Error común a evitar**: NO agregar headers en `onRequest` para requests normales y luego también en `onResponse`. Solo en uno. La decisión correcta es: preflights en `onRequest`, requests normales en `onResponse`.

### 3. Validación Zod con `.superRefine()`

Para validar combinaciones cross-field como `credentials + origins:["*"]`, usar `.superRefine()` (no `.refine()` a nivel de campo):

```typescript
export const CorsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  origins: z.array(z.string()).default([]),
  methods: z.array(z.string()).default([...]),
  // ...
}).superRefine((data, ctx) => {
  if (data.enabled && data.origins.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cors: enabled=true requires at least one origin (use ["*"] for wildcard)',
    });
  }
  if (data.origins.includes('*') && data.credentials) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cors: cannot use credentials=true with wildcard origin "*"',
    });
  }
  if (data.allowedHeaders.includes('*') && data.credentials) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cors: cannot use allowedHeaders=["*"] with credentials=true',
    });
  }
});
```

### 4. Normalización de origins

Comparar y almacenar SIEMPRE en lowercase:

```typescript
function normalizeOrigin(origin: string): string {
  // scheme + host + port en lowercase; path se ignora (no aplica a Origin)
  try {
    const url = new URL(origin);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return origin.toLowerCase();
  }
}
```

Almacenar la allowlist normalizada en memoria al cargar config (no por cada request).

### 5. Hot-reload y `effectiveCors`

`RouteRegistry.match()` debe calcular `effectiveCors` con la precedencia A9:

```typescript
function resolveEffectiveCors(
  route: RouteConfig,
  override: OverrideConfig | null,
  globalCors: CorsConfig | null
): CorsConfigOverride | null {
  // 1. Override por path exacto
  if (override?.cors) return override.cors;
  // 2. Override por prefijo de ruta
  if (route.cors) return route.cors;
  // 3. Config global
  if (globalCors) return globalCors;
  return null; // CORS deshabilitado
}
```

`ConfigReloader.detectChanges()` debe reportar como `applied` los cambios en:
- `cors.origins`, `cors.methods`, etc.
- `routes[].cors.*`
- `corsOverrides[]`

### 6. Testing del schema Zod

Cada combinación inválida debe tener un test específico en `tests/unit/config/schema.test.ts`:

- `credentials: true` + `origins: ["*"]` → falla
- `credentials: true` + `allowedHeaders: ["*"]` → falla
- `enabled: true` + `origins: []` → falla
- Combinaciones válidas (sanity checks) → pasan

---

## Referencias

- [MDN: Cross-Origin Resource Sharing (CORS)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [Fetch Standard: CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol)
- SafeGateway existentes: [`src/middleware/rate-limit/`](../src/middleware/rate-limit/), [`src/middleware/jwt-auth/`](../src/middleware/jwt-auth/) (referencia de patrón)

---

## CHANGELOG de revisiones

### Revisión #2 (2026-06-28) — actual

**Issues bloqueantes corregidos**:

- **B1**: Aclarado que headers CORS se aplican en `onRequest` (preflights) y `onResponse` (respuestas del backend). Short-circuit del pipeline hace que `onResponse` no se ejecute tras preflight.
- **B2**: Mantenida la jerarquía de 3 niveles (`corsOverrides` > `routes[].cors` > `cors`) por consistencia con el patrón existente de `overrides[]` para rate-limit. Jerarquía documentada explícitamente (A9).
- **B3**: Sección "Dependencias Internas" ampliada con tabla de archivos y cambios requeridos (`RouteMatch`, `RouteRegistry`, `ConfigReloader`, etc.).

**Mejoras aplicadas (M1-M6)**:

- **M1**: Documentado que `exposedHeaders` no aplica a preflights (A13).
- **M2**: `Vary: Origin` solo cuando el origin es específico (A14).
- **M3**: Nota sobre el límite de navegadores (Chromium 7200, Firefox 86400) para `maxAge`.
- **M4**: Escenario 15 añadido: circuit breaker abierto + OPTIONS → 204 sin tocar backend.
- **M5**: A24 cambia "case-sensitive (lowercase)" a "case-insensitive sobre scheme+host+puerto normalizado a lowercase".
- **M6**: Escenario 5 reescrito: con `credentials: false` el header NO se emite (cumple standard Fetch).

**Edge cases añadidos (A10-A17)**:

- A10: OPTIONS + Origin → preflight incluso sin `Access-Control-Request-Method`.
- A11: Origin vacío / `"null"` → no headers, no log.
- A12: Múltiples headers Origin → warning + tomar primero.
- A16: Solo reflejar headers permitidos en `Access-Control-Allow-Headers`.
- A17: Wildcards en `methods` y `allowedHeaders` documentados.

**Nuevos escenarios BDD**:

- 10: Preflight sin `Access-Control-Request-Method`.
- 11: Origin vacío o `"null"`.
- 12: Múltiples headers Origin.
- 13: Preflight con header solicitado no permitido.
- 14: Hot-reload mid-flight (atomicidad).
- 15: Circuit breaker abierto + preflight.
- 16: Override por path exacto (`corsOverrides`).
- 17: Wildcard en `allowedHeaders` con credentials (bloqueado).
- 18: Sin bloque `cors` → todo deshabilitado.

**Métricas Prometheus reconsideradas**:

- A22: Añadido UN counter simple `gateway_cors_requests_total{decision}` con 4 valores. Era A14 ("sin métricas"), reconsiderado por valor operacional.

**Estructura**:

- Añadido bloque `CHANGELOG de revisiones` al final para tracking de cambios.
- Tabla de dependencias internas con archivos y cambios específicos.

### Revisión #1 (original)

Versión inicial del spec.