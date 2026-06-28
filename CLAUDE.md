# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **`src/routing/registry.ts`** — `RouteRegistry.match(url)` resolves routes via: **exact override path > longest prefix match**. Returned `RouteMatch` carries target, stripPrefix, rateLimit, timeout, circuitBreaker, effectiveCors, and metric label overrides.
- **`src/middleware/pipeline.ts`** — `MiddlewarePipeline` runs plugin `onRequest` hooks sequentially. **Short-circuit**: if a hook calls `reply.send()`, remaining hooks and the proxy are skipped. Also exposes `getPreHandler()` and `getLifecycleHooks()` for proxy integration.
- **`src/proxy/`** — Undici-based proxy engine:
  - `engine.ts` — `ProxyEngine.forward()` performs the upstream request, streams the body bidirectionally, applies `X-Forwarded-*` headers.
  - `pool.ts` — `ConnectionPoolManager` keeps one Undici pool per backend target.
  - `headers.ts` — Forwarding-header construction.
  - `hooks.ts` / `types.ts` — `ProxyLifecycleHooks` interface (`onBeforeRequest`, `onBeforeResponse`, `onError`).
- **`src/middleware/circuit-breaker/`** — Per-route circuit breaker state machine (`state.ts`), retry interceptor with exponential backoff + full jitter (`retry.ts`), metrics (`metrics.ts`), and plugin wiring (`plugin.ts`).
- **`src/middleware/rate-limit/`** — Redis fixed-window counter using ioredis pipelines (`store.ts`, `window.ts`) with configurable `fail-open`/`fail-closed`.
- **`src/middleware/jwt-auth/`** — JWT validation via `jose` (HS256/RS256).
- **`src/middleware/cors/`** — CORS handling with 3-level precedence (`corsOverrides[path]` > `routes[].cors` > `cors` global). Preflights (OPTIONS + Origin) handled via short-circuit; normal responses get headers via `onBeforeResponse` lifecycle hook. Prometheus counter `gateway_cors_requests_total{decision}`. See [specs/safegateway-plugin-cors.md](specs/safegateway-plugin-cors.md).
- **`src/middleware/metrics/`** — Prometheus collectors via `prom-client`, with low-cardinality label controls.
- **`src/config/`** — Zod-validated YAML loader, immutable `ConfigSnapshot`, `ConfigReloader` that swaps snapshots atomically (mutex-guarded against reload storms).

### Key Patterns
- **ConfigSnapshot pattern**: Immutable configuration snapshots swapped atomically on SIGHUP. In-flight requests finish with their original snapshot; new requests use the new one.
- **Route matching priority**: Exact `overrides[].path` > longest `routes[].prefix`.
- **Plugin short-circuit**: If `reply.send()` is called in `onRequest`, pipeline stops immediately and the proxy is never invoked.
- **CORS first in pipeline**: CORS plugin is registered first so preflights (OPTIONS + Origin) don't consume rate-limit, auth, or circuit-breaker resources.
- **Response header injection via lifecycle hooks**: Plugins that need to add headers to backend responses use `getLifecycleHooks().onBeforeResponse` (called BEFORE `reply.send()`), not `onResponse` (called AFTER).
- **Redis Rate Limiting**: Fixed window counter using atomic ioredis pipelines; `fail-open` (let through) or `fail-closed` (503) on Redis errors.
- **Circuit Breaker states**: `CLOSED` → `OPEN` (on threshold or 5 consecutive failures) → `HALF_OPEN` (after `recoveryTimeMs`) → `CLOSED` (after `halfOpenRequests` consecutive successes) or back to `OPEN` on any failure.
- **Retry safety**: Only retries idempotent methods (GET/HEAD/OPTIONS/PUT/DELETE) and only on `ECONNREFUSED`/`ETIMEDOUT`/`ECONNRESET`/`ENOTFOUND`/`EPIPE` or HTTP 5xx. Never retries while circuit is `OPEN`.

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
│   └── cors/               # plugin, types, origins, headers, merge, metrics
├── proxy/                  # engine, pool, headers, hooks, types
└── routing/                # registry, matcher, types

tests/
├── unit/                   # config, errors, middleware, proxy, routing
└── integration/            # proxy, rate-limit, jwt-auth, circuit-breaker, cors, hot-reload
```

## Configuration

Primary config: `config/gateway.yaml` (path overridable via `CONFIG_PATH` env var). Schema in `src/config/schema.ts` (Zod). Environment interpolation: `${VAR_NAME}` supported in any scalar; missing required vars throw `MissingEnvVarError` and abort startup.

### Top-level keys
- `server`: `{ port, host }` — bind config (restart required to change)
- `redis`: `{ url, onFailure: "open" | "closed" }` — rate-limit store (restart required)
- `logging`: `{ level }` — hot-reloadable
- `metrics`: `{ enabled, path?, defaultLabels? }` — Prometheus endpoint config
- `cors`: `{ enabled, origins, methods, allowedHeaders, exposedHeaders, credentials, maxAge }` — CORS global policy (hot-reloadable, see CORS section below)
- `routes[]`: `{ prefix, target, stripPrefix, rateLimit?, timeout?, circuitBreaker?, cors?, metricsLabel?, backendName? }`
  - `timeout`: `{ connect, response }` in ms (backend-specific, restart required)
  - `circuitBreaker`: `{ enabled, errorThreshold, requestCount, recoveryTimeMs, halfOpenRequests, maxRetries, retryDelayMs, retryMaxDelayMs }`
  - `cors`: partial CORS override for this route (only specified fields override the global config)
  - `metricsLabel`/`backendName`: override low-cardinality metric labels
- `overrides[]`: `{ path, rateLimit }` — exact-path overrides for rate limit (hot-reloadable)
- `corsOverrides[]`: `{ path, cors }` — exact-path CORS overrides (hot-reloadable, takes precedence over `routes[].cors`)

### CORS Configuration

CORS handling is configurable via 3-level precedence:

1. **`corsOverrides[path=X]`** (highest priority) — path-exact CORS override
2. **`routes[].cors`** (route prefix) — partial override of global config
3. **`cors`** (global default) — applied to all routes

All CORS fields are optional. When a partial config is specified, missing fields inherit from the parent (global → defaults).

```yaml
cors:
  enabled: true
  origins: ["https://app.flashdrop.cl"]
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]
  allowedHeaders: ["Content-Type", "Authorization"]
  exposedHeaders: []
  credentials: false
  maxAge: 86400

routes:
  - prefix: /api
    target: http://backend:3000
  - prefix: /api/dev
    target: http://backend-dev:3000
    cors:
      origins: ["*"]            # Override: this route accepts any origin

corsOverrides:
  - path: /api/auth/login
    cors:
      origins: ["*"]            # Login is public, accepts any origin
```

**Validation rules** (validated at startup, fail-fast):
- `enabled=true` requires at least one origin in `origins`
- `credentials=true` cannot be combined with `origins=["*"]`
- `credentials=true` cannot be combined with `allowedHeaders=["*"]`

**Preflight behavior**: An OPTIONS request with `Origin` header is treated as a preflight and responded with HTTP 204 (no backend invocation). This means preflights don't consume rate-limit, auth, or circuit-breaker resources.

**Origin matching**: Case-insensitive comparison on `scheme + host + port` (normalized to lowercase). Wildcard `*` accepts any origin but disables `credentials`.

### Hot Reload (SIGHUP) Behavior
- **Reloadable without restart**: `routes[].rateLimit`, `routes[].cors`, `overrides`, `cors`, `corsOverrides`, `logging.level`
- **Require restart** (logged as `warn`, ignored on reload): `server.*`, `redis.*`, `routes[].prefix/target/stripPrefix/timeout`, adding/removing routes
- **Validation first**: invalid YAML/Zod failures abort the reload and the previous snapshot is kept (automatic rollback).
- **Concurrency guard**: SIGHUP during an in-progress reload is logged and ignored.

### JSON Schema Autocomplete
`config/gateway-schema.json` provides autocomplete/validation in VS Code via the Red Hat YAML extension (mapped in `.vscode/settings.json`). When modifying `src/config/schema.ts`, mirror changes into the JSON Schema to keep editor assistance in sync.

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

- **Logs**: Pino with JSON output; `Authorization` and `Cookie` headers are redacted via serializer.
- **Metrics**: Prometheus endpoint at `/metrics` (path configurable). Includes Node.js defaults plus custom `gateway_http_*`, `gateway_rate_limit_*`, `gateway_circuit_breaker_*`, `gateway_retries_*`, `gateway_cors_*` metrics. Labels are constrained to low-cardinality values (`metricsLabel`/`backendName` fallbacks).
- **In-flight safety**: `gateway_http_requests_in_flight` uses a private `Symbol` flag + `socket.once('close')` listener to prevent double-decrement on client aborts (mitigates connection-leak false positives).
- **Error handler**: 5xx errors return a sanitized JSON envelope; stack traces and internal IPs are never exposed to clients.
- **Dev tooling** (via `docker-compose.example.yml`): Dozzle (localhost:9999) for live log viewing, Prometheus (localhost:9090), Grafana (localhost:3001) with pre-provisioned "Gateway Overview" dashboard.

### CORS Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `gateway_cors_requests_total` | Counter | `decision` | Total requests processed by CORS plugin. `decision` ∈ `allowed` \| `blocked` \| `preflight` \| `no_origin` (low-cardinality, 4 values). |

Example PromQL queries:
- Preflight rate: `rate(gateway_cors_requests_total{decision="preflight"}[5m])`
- Blocked origins: `rate(gateway_cors_requests_total{decision="blocked"}[5m])`
- % of requests with `Origin` header: `sum(rate(gateway_cors_requests_total{decision=~"allowed|blocked|preflight"})) / sum(rate(gateway_cors_requests_total))`