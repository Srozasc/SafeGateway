# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Reglas del Proyecto

- **Gestor de paquetes**: queda estrictamente prohibido usar `npm` o `npx`. Utilizar exclusivamente **pnpm** para gestionar dependencias y **`pnpx`** para ejecutar binarios.
- **Idioma**: todas las comunicaciones con el usuario, explicaciones, comentarios de código, mensajes de commit y nombres visibles al usuario deben estar en **español**. El código de programación y los identificadores técnicos permanecen en inglés.

## Runtime & Tooling

### Versiones fijadas (Docker)
- **Node.js v20 LTS** — base image `node:20-alpine` en `docker/Dockerfile`.
- **pnpm v9.15.9** — fijada con `corepack prepare` en el Dockerfile.
- **Redis v7** — `redis:7-alpine` en `docker-compose.example.yml`. Requerido por `src/middleware/rate-limit/`.

### Path canónico: Docker Compose
Este proyecto está pensado para correr con Docker. El path nativo (`pnpm dev`) es solo para iterar código FUERA del container y requiere un Redis accesible desde el host.

- **Canónico**: `docker compose -f docker/docker-compose.example.yml up -d --build` levanta gateway + Redis + mock-service + Dozzle + Prometheus + Grafana.
- **Nativo**: `pnpm dev` exige exportar `REDIS_URL` apuntando a un Redis accesible (ej. `redis://localhost:6379`).

> **Gotcha de archivos de config**: el compose monta `./docker` en `/app/config:ro` dentro del container, así que el YAML efectivo es **`docker/gateway.yaml`** — NO `config/gateway.yaml`. Los dos archivos son independientes y se mantienen por separado. El config nativo vive en `config/`.

### Observabilidad (compose levantado)
| Servicio | URL local | Notas |
|----------|-----------|-------|
| Gateway + `/health` + `/metrics` | `http://localhost:3000` | Reverse proxy principal |
| Dozzle (logs en vivo) | `http://localhost:9999` | Live tail, búsqueda full-text |
| Prometheus | `http://localhost:9090` | Scrape target: `gateway:3000/metrics` |
| Grafana | `http://localhost:3001` | `admin`/`admin`, anonymous Viewer habilitado |

## Project Overview

API Gateway HTTP Modular - A TypeScript/Fastify-based reverse proxy with middleware pipeline architecture. Built on **Undici** (Node's native HTTP client) for the proxy engine. Features: Redis-backed rate limiting, JWT authentication, Prometheus metrics, circuit breakers with retries, CORS handling with preflight, and zero-downtime config hot-reload via SIGHUP.

## Commands

```bash
# Install dependencies (use pnpm exclusively — required by project policy)
pnpm install

# Development with hot-reload (tsx watch)
pnpm dev

# Build for production (emits to dist/)
pnpm build

# Run production build
pnpm start

# Lint (ESLint over src/ and tests/)
pnpm lint

# Format (Prettier)
pnpm format

# Run all tests (Vitest)
pnpm test

# Run only unit tests
pnpm test:unit

# Run only integration tests
pnpm test:integration

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:coverage

# Run a single test file
pnpm vitest run tests/unit/routing/matcher.test.ts
# Or filter by name pattern:
pnpm vitest run -t "matches longest prefix"

# Build Docker image
pnpm docker:build

# Validate MCP server setup (verifica `.mcp.json` y plugins referenciados)
pnpm validate:mcp

# Start full dev stack (Redis, mock backend, Dozzle, Prometheus, Grafana)
docker compose -f docker/docker-compose.example.yml up --build

# Trigger hot-reload of gateway.yaml in a running container
docker kill -s SIGHUP gateway-service
# Or locally:
kill -s SIGHUP <PID>
```

## Architecture

### Bootstrap Sequence (`src/index.ts`)
1. Load & validate config (`loadConfig`)
2. Initialize Pino logger
3. Connect to Redis (3 retries, 1s apart, fast-fail)
4. Build `RouteRegistry` + initial `ConfigSnapshot`
5. Instantiate middleware plugins (CORS first, then rate-limit, jwt-auth, circuit-breaker, optional metrics)
6. Construct `MiddlewarePipeline` (collects lifecycle hooks from plugins)
7. Build Fastify server via `buildServer`
8. Wire `ConfigReloader` (listens for SIGHUP)
9. `server.listen({ port, host })`

Graceful shutdown on `SIGTERM`/`SIGINT`: close Fastify → close Undici pools → quit Redis.

### Core Modules
- **`src/server.ts`** — Fastify factory. Registers the global `onRequest` hook that attaches `routeMatch` to `request.gatewayContext`, mounts the `/metrics` endpoint (when enabled), then registers each route as `${prefix}*` with `preHandler: pipeline.getPreHandler()` and the proxy as handler.
- **`src/routing/registry.ts`** — `RouteRegistry.match(url)` resolves routes via: **exact override path > longest prefix match**. Returned `RouteMatch` carries target, stripPrefix, rateLimit, timeout, circuitBreaker, effectiveCors, effectiveJwt, and metric label overrides (the `effective*` fields are computed by merging through the 3-level precedence chain so plugins never have to re-merge).
- **`src/middleware/pipeline.ts`** — `MiddlewarePipeline` runs plugin `onRequest` hooks sequentially. **Short-circuit**: if a hook calls `reply.send()`, remaining hooks and the proxy are skipped. Also exposes `getPreHandler()` and `getLifecycleHooks()` for proxy integration.
- **`src/proxy/`** — Undici-based proxy engine:
  - `engine.ts` — `ProxyEngine.forward()` performs the upstream request, streams the body bidirectionally, applies `X-Forwarded-*` headers.
  - `pool.ts` — `ConnectionPoolManager` keeps one Undici pool per backend target.
  - `headers.ts` — Forwarding-header construction.
  - `hooks.ts` / `types.ts` — `ProxyLifecycleHooks` interface (`onBeforeRequest`, `onBeforeResponse`, `onError`).
- **`src/middleware/circuit-breaker/`** — Per-route circuit breaker state machine (`state.ts`), retry interceptor with exponential backoff + full jitter (`retry.ts`), metrics (`metrics.ts`), and plugin wiring (`plugin.ts`).
- **`src/middleware/rate-limit/`** — Redis fixed-window counter using ioredis pipelines (`store.ts`, `window.ts`) with configurable `fail-open`/`fail-closed`.
- **`src/middleware/jwt-auth/`** — JWT validation with dual mode via `jose`:
  - `plugin.ts`: dispatches between shared-secret (HS256/HS384/HS512) and JWKS (RS256). Reads `routeMatch.effectiveJwt` from snapshot. Errors via `buildErrorResponse` (centralized 401/503 responses with `requestId`).
  - `jwks-client.ts`: per-issuer JWKS client with state machine (`empty` → `fresh` → `stale` → `expired`). Sync refresh on miss gated by `refreshCooldownSeconds`. Recursive `setTimeout` background refresh. Single-flight via cached `inflight` Promise. Uses native `fetch` + `AbortSignal.timeout`.
  - `registry.ts`: per-issuer registry of `JwksClient` instances. Provides `getClient(name)` for specific routes and `resolveByIssClaim(iss)` for `issuer: "any"` mode (decode-unsafe mapping only).
  - `merge.ts`: 3-level precedence (`jwtOverrides[path]` > `routes[].jwt` > `jwt` global) mirroring CORS.
  - `metrics.ts`: idempotent Prometheus counters (`gateway_jwt_validations_total{result}`, `gateway_jwks_refresh_total{result}`). Registration checks `register.getSingleMetric()` to avoid double-register.
  - See [specs/safegateway-jwt-jwks-validation.md](specs/safegateway-jwt-jwks-validation.md).
- **`src/middleware/cors/`** — CORS handling with 3-level precedence (`corsOverrides[path]` > `routes[].cors` > `cors` global). Preflights (OPTIONS + Origin) handled via short-circuit; normal responses get headers via `onBeforeResponse` lifecycle hook. Prometheus counter `gateway_cors_requests_total{decision}`. See [specs/safegateway-plugin-cors.md](specs/safegateway-plugin-cors.md).
- **`src/middleware/metrics/`** — Prometheus collectors via `prom-client`, with low-cardinality label controls.
- **`src/middleware/health/`** — Health aggregation endpoint (`GET /health`, path configurable). Registered as a **native Fastify route** (not a `GatewayPlugin`) before proxy routes, so it bypasses the middleware pipeline (no auth, no rate-limit, no circuit-breaker) and never proxies to a backend. Queries each service's `backendPath` in parallel via native `fetch` with `AbortSignal.timeout`. Status codes: 200 if global `ok`/`degraded`, 503 if global `down`. Service name resolution: `route.backendName ?? hostname(target) ?? route.prefix`. `MetricsPlugin` is configured with the `health.path` to exclude it from HTTP metrics. See [specs/safegateway-health-aggregation.md](specs/safegateway-health-aggregation.md).
- **`src/config/`** — Zod-validated YAML loader, immutable `ConfigSnapshot`, `ConfigReloader` that swaps snapshots atomically (mutex-guarded against reload storms).

### Key Patterns
- **ConfigSnapshot pattern**: Immutable configuration snapshots swapped atomically on SIGHUP. In-flight requests finish with their original snapshot; new requests use the new one.
- **Route matching priority**: Exact `overrides[].path` > longest `routes[].prefix`.
- **Plugin short-circuit**: If `reply.send()` is called in `onRequest`, pipeline stops immediately and the proxy is never invoked.
- **CORS first in pipeline**: CORS plugin is registered first so preflights (OPTIONS + Origin) don't consume rate-limit, auth, or circuit-breaker resources.
- **Response header injection via lifecycle hooks**: Plugins that need to add headers to backend responses use `getLifecycleHooks().onBeforeResponse` (called BEFORE `reply.send()`), not `onResponse` (called AFTER).
- **Redis Rate Limiting**: Fixed window counter using atomic ioredis pipelines; `fail-open` (let through) or `fail-closed` (503) on Redis errors.
- **Circuit Breaker states**: `CLOSED` → `OPEN` (on threshold or 5 consecutive failures) → `HALF_OPEN` (after `recoveryTimeMs`) → `CLOSED` (after `halfOpenRequests` consecutive successes) or back to `OPEN` on any failure.
- **Retry safety**: Solo reintenta métodos idempotentes por defecto (`GET`/`HEAD`/`OPTIONS`/`PUT`/`DELETE`). La lista es **configurable por ruta** vía `routes[].retryableMethods` (e.g. añadir `POST` solo si el backend implementa idempotency-key). Solo reintenta en errores elegibles (`ECONNREFUSED`/`ETIMEDOUT`/`ECONNRESET`/`ENOTFOUND`/`EPIPE` o HTTP 5xx). Nunca reintenta con el circuit en estado `OPEN`.

### Directory Structure
```
src/
├── index.ts                # Entry point, bootstrap, graceful shutdown
├── server.ts               # Fastify factory, proxy route registration
├── config/                 # loader.ts, schema.ts, reloader.ts, types.ts
├── errors/                 # Global error handler
├── logger/                 # Pino setup with redaction serializers
├── middleware/
│   ├── pipeline.ts         # MiddlewarePipeline + GatewayPlugin interface
│   ├── rate-limit/         # plugin, store (Redis), window, types
│   ├── jwt-auth/           # plugin, types
│   ├── metrics/            # plugin, labels, types
│   ├── circuit-breaker/    # plugin, state, retry, metrics, types
│   ├── cors/               # plugin, types, origins, headers, merge, metrics
│   └── health/             # aggregator, handler, types (Health Aggregation endpoint)
├── proxy/                  # engine, pool, headers, hooks, types
└── routing/                # registry, matcher, types

tests/
├── unit/                   # config, errors, middleware, proxy, routing
└── integration/            # proxy, rate-limit, jwt-auth, circuit-breaker, cors, hot-reload, health
```

## Configuration

Primary config: `config/gateway.yaml` (path overridable via `CONFIG_PATH` env var). Schema in `src/config/schema.ts` (Zod). Environment interpolation: `${VAR_NAME}` supported in any scalar; missing required vars throw `MissingEnvVarError` and abort startup.

### Top-level keys
- `server`: `{ port, host }` — bind config (restart required to change)
- `redis`: `{ url, onFailure: "open" | "closed" }` — rate-limit store (restart required)
- `logging`: `{ level }` — hot-reloadable
- `metrics`: `{ enabled, path?, defaultLabels? }` — Prometheus endpoint config
- `cors`: `{ enabled, origins, methods, allowedHeaders, exposedHeaders, credentials, maxAge }` — CORS global policy (hot-reloadable, see CORS section below)
- `routes[]`: `{ prefix, target, stripPrefix, rateLimit?, timeout?, circuitBreaker?, cors?, jwt?, retryableMethods?, metricsLabel?, backendName? }`
  - `timeout`: `{ connect, headers, body }` en ms (backend-specific, requiere reinicio)
  - `circuitBreaker`: `{ enabled, errorThreshold, requestCount, recoveryTimeMs, halfOpenRequests, maxRetries, retryDelayMs, retryMaxDelayMs }`
  - `cors`: partial CORS override for this route (only specified fields override the global config)
  - `jwt`: per-route JWT config. **Two modes** (auto-detected by Zod):
    - `shared-secret` (compat): `{ enabled?, secret, algorithm?, issuer?, audience?, forwardClaims? }` — HS256/HS384/HS512 with local secret.
    - `jwks`: `{ enabled?, mode: "jwks", issuer, forwardClaims? }` — `issuer` is the name declared in `jwt.issuers[]` or `"any"`.
  - `metricsLabel`/`backendName`: override low-cardinality metric labels
- `overrides[]`: `{ path, rateLimit }` — exact-path overrides for rate limit (hot-reloadable)
- `corsOverrides[]`: `{ path, cors }` — exact-path CORS overrides (hot-reloadable, takes precedence over `routes[].cors`)
- `jwt`: `{ enabled, mode: "shared-secret" | "jwks", issuers[] }` — global JWT config. Required when any route uses JWKS mode.
  - `issuers[]`: `{ name, jwksUri, issuer, audience?, cacheTtlSeconds=3600, staleGracePeriodSeconds=1800, refreshCooldownSeconds=30, refreshOnMiss=true, timeoutMs=3000 }` — declared JWKS endpoints per issuer.
- `jwtOverrides[]`: `{ path, jwt }` — exact-path JWT overrides (hot-reloadable, takes precedence over `routes[].jwt`)
- `health`: `{ enabled, path, backendPath, timeoutMs }` — Health aggregation endpoint config. `path` is the Gateway endpoint (default `/health`), `backendPath` is the health path queried on each downstream service (default `/health`), `timeoutMs` is the per-service timeout (default `2000`). See [specs/safegateway-health-aggregation.md](specs/safegateway-health-aggregation.md).

### CORS Configuration

CORS tiene **3 niveles de precedencia** (mayor a menor):

1. **`corsOverrides[path=X]`** — path-exact override
2. **`routes[].cors`** — partial override por prefijo de ruta
3. **`cors`** (global) — default aplicado a todas las rutas

Todos los campos son opcionales en los overrides; un campo no especificado hereda del padre (global → defaults). Las **reglas fail-fast** (en `validateMergedCorsConfig`) incluyen: `enabled=true` requiere ≥1 origin; `credentials=true` no se puede combinar con `origins=["*"]` ni `allowedHeaders=["*"]`.

Preflight (OPTIONS + Origin) hace **short-circuit** y devuelve HTTP 204 sin tocar backend (no consume rate-limit/auth/circuit-breaker). Origin matching case-insensitive sobre `scheme + host + port`. Wildcard `*` acepta cualquier origin pero desactiva `credentials`.

Detalles completos, ejemplos YAML y referencia de la spec en [README.md §CORS](README.md).

### JWT Configuration

JWT soporta **dos modos** auto-detectados por Zod por ruta:

1. **shared-secret (compat)** — HS256/HS384/HS512 con secreto local. Cada ruta declara su propio `secret` + `algorithm`. No requiere sección global `jwt`.
2. **JWKS (RS256)** — Validación contra endpoint JWKS remoto (RFC 7517). Requiere sección global `jwt.issuers[]`. Soporta múltiples issuers (multi-tenant).

**Precedencia** (mayor a menor): `jwtOverrides[path=X]` > `routes[].jwt` > `jwt` (global; solo JWKS).

**State machine del cache JWKS** (por issuer): `empty` (sin fetch) → `fresh` (≤ TTL, sirve directo) → `stale` (TTL < t ≤ stale_grace, sirve + dispara background refresh) → `expired` (refresh on miss sincrónico, gated por `refreshCooldownSeconds`).

**Status codes**: `401` para fallos criptográficos (firma, expiración, claims, `kid`/`iss`/`aud` inválidos); `503` para indisponibilidad del Auth Service (fuera de `staleGracePeriodSeconds`).

Detalles completos, ejemplos YAML, defaults numéricos y validación fail-fast en [README.md §JWT](README.md) y [specs/safegateway-jwt-jwks-validation.md](specs/safegateway-jwt-jwks-validation.md).

### JWT Metrics

Métricas Prometheus registradas por el plugin JWT (cardinalidad baja):

- `gateway_jwt_validations_total{result}` — Counter. `result` ∈ `ok | missing_token | unknown_kid | missing_kid | expired | invalid_issuer | invalid_audience | invalid_claims | invalid_signature | service_unavailable` (10 valores).
- `gateway_jwks_refresh_total{result}` — Counter. `result` ∈ `ok | error | cooldown` (3 valores).

Queries PromQL de ejemplo (tasa de éxito, tasa de 401, tasa de 503, refresh errors, cooldown hits) en [README.md §JWT Metrics](README.md).

### Hot Reload (SIGHUP) Behavior
- **Reloadable without restart**: `routes[].rateLimit`, `routes[].cors`, `routes[].jwt`, `overrides`, `cors`, `corsOverrides`, `jwt`, `jwtOverrides`, `logging.level`
- **Require restart** (logged as `warn`, ignored on reload): `server.*`, `redis.*`, `routes[].prefix/target/stripPrefix/timeout`, adding/removing routes
- **JWKS reloader behavior**: el `JwtAuthRegistry` se reconstruye en cada reload con cambios. El registry viejo se detiene (clear timers + await inflight fetch) antes del swap atómico del snapshot; el nuevo arranca su background refresh inmediatamente después. Los issuers que no cambiaron se recrean como clientes nuevos (sus caches inician vacías; primer request dispara fetch).
- **Validation first**: invalid YAML/Zod failures abort the reload and the previous snapshot is kept (automatic rollback).
- **Concurrency guard**: SIGHUP during an in-progress reload is logged and ignored.

### JSON Schema Autocomplete
`config/gateway-schema.json` provides autocomplete/validation in VS Code via the Red Hat YAML extension (mapped in `.vscode/settings.json`). When modifying `src/config/schema.ts`, mirror changes into the JSON Schema to keep editor assistance in sync.

### Environment Variables

Variables leídas por el proceso (defaults fijados en `docker/Dockerfile`, algunas seteadas en `docker-compose.example.yml`):

| Variable | Default | Notas |
|----------|---------|-------|
| `CONFIG_PATH` | `config/gateway.yaml` | Ruta del YAML. En el container, `docker-compose.example.yml` la deja en `/app/config/gateway.yaml` (efectivo: `docker/gateway.yaml` por el mount de `./docker` → `/app/config`). |
| `REDIS_URL` | — (requerida) | Formato `redis://[user:pass@]host:port/db`. Alternativa: usar `${REDIS_URL}` interpolation en el YAML. |
| `PORT` | `3000` | Bind del Fastify server. |
| `HOST` | `0.0.0.0` | Bind host. |
| `NODE_ENV` | `production` (en container) | Controla visibilidad de `stack` en respuestas de error (`buildErrorResponse`). Fuera de producción: stack incluido; en producción: omitido. |

> ⚠️ **`LOG_LEVEL` está en `docker-compose.example.yml` pero el código NO la lee.** El gateway usa `logging.level` del YAML (`src/index.ts:32`, `src/config/reloader.ts:83`). La entry `LOG_LEVEL=info` en el compose es ruido. Si querés cambiar el nivel de log, editá `logging.level` en el YAML.

`${VAR_NAME}` interpolation funciona en cualquier escalar del YAML (`${REDIS_URL}`, `${JWT_SECRET}`, etc.) y falla con `MissingEnvVarError` al startup si la variable no está seteada.

## Adding a New Plugin

1. Implement `GatewayPlugin` (`src/middleware/pipeline.ts`):
   ```typescript
   export interface GatewayPlugin {
     name: string;
     onRequest?(context: RequestContext): Promise<void>;
     onResponse?(context: ResponseContext): Promise<void>;
     // Optional: expose proxy lifecycle hooks
     getLifecycleHooks?(): ProxyLifecycleHooks;
   }
   ```
2. Register it in `bootstrap()` in `src/index.ts` by pushing into `pluginsList` before constructing `MiddlewarePipeline`.
3. Order matters: earlier plugins run first on the request and last on the response. To short-circuit, call `reply.send()` in `onRequest`.
4. For low-level proxy integration (e.g., the circuit breaker), implement `getLifecycleHooks()` returning `{ onBeforeRequest, onBeforeResponse, onError }`.
5. **Important**: To modify response headers from the backend, use `getLifecycleHooks().onBeforeResponse` (called BEFORE `reply.send()`). The plugin's `onResponse` is called AFTER `reply.send()` and cannot add new headers. See `CorsPlugin` for the canonical pattern.

## Observability

- **Logs**: Pino con salida JSON. El serializador redacta automáticamente las siguientes cabeceras sensibles (sustituyéndolas por el literal `[REDACTED]` antes de escribirlas en `stdout`):
  - `authorization`
  - `cookie`
  - `proxy-authorization`
  - `set-cookie` (cabecera de respuesta)
- **Metrics**: Prometheus endpoint at `/metrics` (path configurable). Includes Node.js defaults plus custom `gateway_http_*`, `gateway_rate_limit_*`, `gateway_circuit_breaker_*`, `gateway_retries_*`, `gateway_cors_*`, `gateway_jwt_*` metrics. Labels are constrained to low-cardinality values (`metricsLabel`/`backendName` fallbacks).
- **In-flight safety**: `gateway_http_requests_in_flight` uses a private `Symbol` flag + `socket.once('close')` listener to prevent double-decrement on client aborts (mitigates connection-leak false positives).
- **Error handler & centralized envelope**: todos los plugins (CORS, rate-limit, JWT, circuit-breaker, health) y el handler global usan `buildErrorResponse()` (`src/errors/responses.ts`) para producir un sobre JSON uniforme con la forma `{ statusCode, error, message, requestId?, timestamp, stack? }`. El campo `stack` **solo se incluye fuera de producción** (`NODE_ENV !== 'production'`); en producción se omite por completo. Direcciones IP internas y nombres de backends jamás se exponen al cliente.
- **Dev tooling** (via `docker-compose.example.yml`): Dozzle (localhost:9999) for live log viewing, Prometheus (localhost:9090), Grafana (localhost:3001) with pre-provisioned "Gateway Overview" dashboard.

### CORS Metrics

Métricas Prometheus registradas por el plugin CORS:

- `gateway_cors_requests_total{decision}` — Counter. `decision` ∈ `allowed | blocked | preflight | no_origin` (4 valores, baja cardinalidad).

Queries PromQL (preflight rate, blocked origins, % de requests con `Origin` header) en [README.md §CORS Metrics](README.md).