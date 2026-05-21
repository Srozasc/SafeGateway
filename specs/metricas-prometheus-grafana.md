# Especificación: Métricas y Observabilidad — Prometheus + Grafana

## Resumen

**Historia de usuario:**
> Como operador del API Gateway, quiero tener métricas del comportamiento del Gateway expuestas en formato Prometheus, visualizables en Grafana con dashboards preconfigurados, y desglosadas por ruta lógica, backend lógico y código de respuesta, para poder monitorear el rendimiento, detectar anomalías y tomar decisiones operativas informadas.

**Tipo de cambio:** Código en `src/` (nuevo plugin de métricas) + Infraestructura Docker (Prometheus, Grafana) + Configuración YAML.

**Principio rector:**
- Las métricas son **no-bloqueantes** y no deben degradar el rendimiento del proxy.
- Solo labels de **baja cardinalidad** (controlada por el operador, nunca por el tráfico).
- **Scope estricto:** Prometheus + Grafana. El tracing distribuido (OpenTelemetry/Jaeger) queda fuera de este alcance y se abordará en una especificación separada.

---

## Componentes Afectados

| Componente | Tipo de Cambio | Archivo |
|---|---|---|
| Plugin de Métricas | NUEVO | `src/middleware/metrics/plugin.ts` |
| Utilidades de Labels | NUEVO | `src/middleware/metrics/labels.ts` |
| Tipos de Métricas | NUEVO | `src/middleware/metrics/types.ts` |
| Schema Zod (config) | MODIFICAR | `src/config/schema.ts` |
| Tipos de config | MODIFICAR | `src/config/types.ts` |
| JSON Schema | MODIFICAR | `config/gateway-schema.json` |
| Bootstrap (index.ts) | MODIFICAR | `src/index.ts` |
| Pipeline de Middlewares | SIN CAMBIOS | `src/middleware/pipeline.ts` (se usa tal cual) |
| Docker Compose | MODIFICAR | `docker/docker-compose.example.yml` |
| Config Prometheus | NUEVO | `docker/prometheus/prometheus.yml` |
| Dashboard Grafana | NUEVO | `docker/grafana/dashboards/gateway-overview.json` |
| Datasource Grafana | NUEVO | `docker/grafana/provisioning/datasources/prometheus.yml` |
| Dashboard Provider | NUEVO | `docker/grafana/provisioning/dashboards/default.yml` |
| Config de ejemplo | MODIFICAR | `docker/gateway.yaml` |
| Tests unitarios | NUEVO | `tests/middleware/metrics/plugin.test.ts` |
| Tests unitarios | NUEVO | `tests/middleware/metrics/labels.test.ts` |
| Documentación | MODIFICAR | `README.md` |

---

## Parte 1 — Plugin de Métricas (`MetricsPlugin`)

### Descripción

Un nuevo `GatewayPlugin` que se registra en la `MiddlewarePipeline` existente. Instrumenta cada request/response del Gateway recolectando contadores, histogramas y gauges, y expone un endpoint `/metrics` compatible con el formato de scraping de Prometheus.

### Librería

- **`prom-client`** — Cliente oficial de Prometheus para Node.js. Estable, battle-tested, zero-dependency para el core.

### Métricas Expuestas

#### Métricas Custom del Gateway

| Nombre | Tipo | Labels | Descripción |
|---|---|---|---|
| `gateway_http_requests_total` | Counter | `method`, `route`, `status_code`, `backend` | Total acumulado de requests HTTP procesados por el Gateway. |
| `gateway_http_request_duration_seconds` | Histogram | `method`, `route`, `status_code`, `backend` | Latencia de cada request en segundos. Buckets por defecto de prom-client + buckets custom para proxying: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`. |
| `gateway_http_requests_in_flight` | Gauge | `method`, `route` | Cantidad de requests activos en curso. Se incrementa en `onRequest` y se decrementa en `onResponse`/`onError`/abort. |
| `gateway_rate_limit_hits_total` | Counter | `route` | Total de requests rechazados con HTTP 429 por el módulo de Rate Limiting. |

#### Métricas Estándar del Proceso Node.js

Habilitadas vía `collectDefaultMetrics()` de `prom-client`:
- CPU usage
- Memoria (heap used, RSS, external)
- Event loop lag
- Active handles/requests
- GC stats (si disponible)

### Definición de Labels

#### Label `route`

Identifica la **ruta lógica** del Gateway, nunca paths dinámicos del usuario.

**Resolución (orden de prioridad):**
1. Si la ruta en `gateway.yaml` tiene el campo `metricsLabel` → se usa ese valor.
2. Si no → se usa el campo `prefix` de la ruta (ej: `/api`, `/public`, `/secure`).
3. Si no hay match de ruta → se usa el literal `"unmatched"`.

**Ejemplos:**

```yaml
# gateway.yaml
routes:
  - prefix: /api
    target: https://pokeapi.co/api/v2
    metricsLabel: "pokeapi"    # → route="pokeapi"

  - prefix: /public
    target: http://mock-service:8080
    # Sin metricsLabel          → route="/public"
```

#### Label `backend`

Identifica el **backend lógico** de destino.

**Resolución (orden de prioridad):**
1. Si la ruta tiene el campo `backendName` → se usa ese valor.
2. Si no → se extrae automáticamente el hostname del campo `target` (ej: `http://mock-service:8080` → `"mock-service"`, `https://pokeapi.co/api/v2` → `"pokeapi.co"`).
3. Si no hay match de ruta → se usa el literal `"unknown"`.

**Ejemplos:**

```yaml
routes:
  - prefix: /api
    target: https://pokeapi.co/api/v2
    backendName: "pokeapi"     # → backend="pokeapi"

  - prefix: /public
    target: http://mock-service:8080
    # Sin backendName           → backend="mock-service"
```

#### Label `status_code`

Siempre **string**. Valores: `"200"`, `"404"`, `"429"`, `"500"`, `"503"`, etc.

#### Label `method`

Método HTTP en uppercase: `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, `"PATCH"`, etc.

### Política de Cardinalidad (Asunción 15)

**Labels PROHIBIDOS** en métricas:
- `userId`, `sub`, `email` (datos de JWT)
- `ip` o `clientIp`
- `requestId` o `traceId`
- `queryParams`, `path` dinámico (ej: `/users/123`)
- URLs completas de upstream

**Labels PERMITIDOS** (exclusivamente):
- `route` (lógico, definido por operador)
- `backend` (lógico, definido por operador o hostname)
- `method` (HTTP, 7-8 valores posibles)
- `status_code` (string, ~50 valores posibles en la práctica)

**Cardinalidad máxima estimada:**
- `routes × backends × methods × status_codes` ≈ 5 × 5 × 5 × 20 = **2,500 series** — perfectamente manejable por Prometheus.

---

## Parte 2 — Instrumentación Robusta con Hooks

### Descripción

La instrumentación NO se limita al camino feliz (`onResponse`). Debe capturar **todo** el ciclo de vida del request, incluyendo errores y abortos.

### Hooks Utilizados

```
Request entrante
       │
       ▼
  ┌─────────────────────────────────────────────┐
  │  onRequest (hook Fastify)                   │
  │  → Incrementar requests_in_flight           │
  │  → Iniciar timer de duración (hrtime)       │
  │  → Almacenar startTime en request context   │
  └──────────────────┬──────────────────────────┘
                     │
          ┌──────────┼──────────┐
          │          │          │
          ▼          ▼          ▼
     onResponse   onError    onRequestAbort
          │          │          │
          ▼          ▼          ▼
  ┌─────────────────────────────────────────────┐
  │  Finalización (cualquier path)              │
  │  → Decrementar requests_in_flight           │
  │  → Registrar duration en histogram          │
  │  → Incrementar requests_total               │
  │  → Si status=429: incrementar rate_limits   │
  └─────────────────────────────────────────────┘
```

### Detalle de Cada Hook

| Hook | Cuándo se ejecuta | Acciones |
|---|---|---|
| `onRequest` | Al recibir cada request | `requests_in_flight.inc()`, almacenar `startTime = process.hrtime.bigint()` |
| `onResponse` | Respuesta exitosa enviada al cliente | `requests_in_flight.dec()`, registrar duración, incrementar counter |
| `onError` | Error durante el procesamiento (timeout, crash, etc.) | `requests_in_flight.dec()`, registrar duración con `status_code` del error |
| `onRequestAbort` | Cliente cierra la conexión antes de recibir respuesta | `requests_in_flight.dec()`, registrar duración con `status_code="499"` (client closed) |

### Guard contra Doble Conteo

Se usará un flag `request.__metricsFinalized` (symbol privado) para garantizar que la finalización se ejecute **exactamente una vez**, incluso si múltiples hooks se disparan para el mismo request.

```typescript
const METRICS_FINALIZED = Symbol('metricsFinalized');

function finalizeMetrics(request: FastifyRequest, statusCode: string): void {
  if ((request as any)[METRICS_FINALIZED]) return;
  (request as any)[METRICS_FINALIZED] = true;

  // Decrementar in-flight, registrar duración, incrementar counter...
}
```

---

## Parte 3 — Endpoint `/metrics`

### Descripción

Endpoint HTTP que expone todas las métricas en formato de texto Prometheus para scraping.

### Requisitos

- **Ruta:** Configurable vía `metrics.path` en `gateway.yaml` (default: `/metrics`)
- **Método:** `GET`
- **Content-Type:** `text/plain; version=0.0.4; charset=utf-8`
- **Registro:** Como ruta nativa de Fastify, **no** como ruta proxy. Se registra antes del pipeline de proxy.
- **Excluido de métricas:** El propio endpoint `/metrics` NO debe instrumentarse a sí mismo (evitar recursión en los contadores).
- **Sin autenticación:** En el MVP no lleva auth. Se recomienda restringir por red en producción.

### Ejemplo de Respuesta

```
# HELP gateway_http_requests_total Total acumulado de requests HTTP procesados
# TYPE gateway_http_requests_total counter
gateway_http_requests_total{method="GET",route="/api",status_code="200",backend="pokeapi.co"} 142
gateway_http_requests_total{method="GET",route="/api",status_code="429",backend="pokeapi.co"} 8
gateway_http_requests_total{method="GET",route="/public",status_code="200",backend="mock-service"} 57

# HELP gateway_http_request_duration_seconds Latencia de requests en segundos
# TYPE gateway_http_request_duration_seconds histogram
gateway_http_request_duration_seconds_bucket{method="GET",route="/api",status_code="200",backend="pokeapi.co",le="0.1"} 120
gateway_http_request_duration_seconds_bucket{method="GET",route="/api",status_code="200",backend="pokeapi.co",le="0.25"} 138
...

# HELP gateway_http_requests_in_flight Requests activos en curso
# TYPE gateway_http_requests_in_flight gauge
gateway_http_requests_in_flight{method="GET",route="/api"} 3

# HELP gateway_rate_limit_hits_total Requests rechazados por rate limiting (429)
# TYPE gateway_rate_limit_hits_total counter
gateway_rate_limit_hits_total{route="/api"} 8
```

---

## Parte 4 — Configuración en `gateway.yaml`

### Nueva Sección `metrics`

```yaml
# Sección de métricas Prometheus
metrics:
  enabled: true          # Habilitar/deshabilitar la recolección y exposición de métricas
  path: /metrics         # Endpoint HTTP de scraping (default: /metrics)
  defaultLabels: {}      # Labels adicionales globales que se agregan a TODAS las métricas
                         # Ejemplo: { environment: "staging", region: "us-east-1" }
```

### Campos Opcionales Nuevos en Cada Ruta

```yaml
routes:
  - prefix: /api
    target: https://pokeapi.co/api/v2
    stripPrefix: true
    metricsLabel: "pokeapi"       # Opcional: override del label 'route' para métricas
    backendName: "pokeapi-ext"    # Opcional: override del label 'backend' para métricas
    rateLimit:
      maxRequests: 8
      windowSeconds: 60
```

### Validación Zod

```typescript
// Añadir al schema existente
const MetricsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().startsWith('/').default('/metrics'),
  defaultLabels: z.record(z.string()).default({}),
}).default({});

// Añadir a RouteConfigSchema
const RouteConfigSchema = z.object({
  // ... campos existentes ...
  metricsLabel: z.string().optional(),
  backendName: z.string().optional(),
});

// Añadir a GatewayConfigSchema
const GatewayConfigSchema = z.object({
  // ... campos existentes ...
  metrics: MetricsConfigSchema,
});
```

---

## Parte 5 — Infraestructura Docker

### Servicio Prometheus

```yaml
# docker/docker-compose.example.yml (añadir)
prometheus:
  image: prom/prometheus:v3.4.1
  container_name: gateway-prometheus
  ports:
    - "9090:9090"
  volumes:
    - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
  depends_on:
    - gateway
  networks:
    - gateway-network
```

### Configuración de Prometheus

```yaml
# docker/prometheus/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'gateway'
    static_configs:
      - targets: ['gateway-service:3000']
    metrics_path: /metrics
    scrape_interval: 10s
```

### Servicio Grafana

```yaml
# docker/docker-compose.example.yml (añadir)
grafana:
  image: grafana/grafana:12.1.0
  container_name: gateway-grafana
  ports:
    - "3001:3000"
  environment:
    - GF_SECURITY_ADMIN_USER=admin
    - GF_SECURITY_ADMIN_PASSWORD=admin
    - GF_AUTH_ANONYMOUS_ENABLED=true
    - GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
  volumes:
    - ./grafana/provisioning:/etc/grafana/provisioning:ro
    - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
  depends_on:
    - prometheus
  networks:
    - gateway-network
```

### Provisioning Automático de Grafana

**Datasource** (`docker/grafana/provisioning/datasources/prometheus.yml`):
```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://gateway-prometheus:9090
    isDefault: true
    editable: false
```

**Dashboard Provider** (`docker/grafana/provisioning/dashboards/default.yml`):
```yaml
apiVersion: 1
providers:
  - name: 'Gateway Dashboards'
    orgId: 1
    folder: 'Gateway'
    type: file
    disableDeletion: true
    editable: false
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: false
```

---

## Parte 6 — Dashboard Grafana (Mínimo)

### Descripción

Un único dashboard preconfigurado con **4 paneles esenciales**. Sin complejidad innecesaria.

### Paneles

| # | Panel | Tipo | Query PromQL |
|---|---|---|---|
| 1 | **Requests por segundo** | Time Series | `rate(gateway_http_requests_total[1m])` |
| 2 | **Latencia P95** | Time Series | `histogram_quantile(0.95, rate(gateway_http_request_duration_seconds_bucket[5m]))` |
| 3 | **Status Codes** | Time Series (stacked) | `sum by (status_code) (rate(gateway_http_requests_total[1m]))` |
| 4 | **Rate Limit Hits** | Stat / Time Series | `rate(gateway_rate_limit_hits_total[1m])` |

El archivo JSON del dashboard se generará y guardará en `docker/grafana/dashboards/gateway-overview.json`.

### Acceso

- URL: `http://localhost:3001`
- Login: `admin` / `admin` (o acceso anónimo como Viewer)
- Dashboard: navegable desde `Dashboards → Gateway → Gateway Overview`

---

## Parte 7 — Integración en el Bootstrap

### Cambios en `src/index.ts`

```typescript
// Después de crear rateLimitPlugin y jwtAuthPlugin:

// Configurar módulo de Métricas Prometheus
if (config.metrics.enabled) {
  logger.info('Configurando módulo de Métricas Prometheus...');
  const metricsPlugin = new MetricsPlugin(config, logger);
  plugins.push(metricsPlugin);

  // Registrar endpoint /metrics ANTES de las rutas proxy
  // (se hace dentro de buildServer o como ruta directa)
}

const pipeline = new MiddlewarePipeline([rateLimitPlugin, jwtAuthPlugin, metricsPlugin]);
```

### Cambios en `src/server.ts`

El endpoint `/metrics` se registra como ruta nativa de Fastify (no pasa por el proxy):

```typescript
// En buildServer(), antes de registerProxyRoutes():
if (config.metrics.enabled) {
  server.get(config.metrics.path, async (_request, reply) => {
    const metrics = await register.metrics();
    reply.header('Content-Type', register.contentType).send(metrics);
  });
}
```

### Hooks de Fastify para Instrumentación

Los hooks `onResponse`, `onError` y `onRequestAbort` se registran como hooks globales de Fastify (no solo como parte del pipeline de plugins), garantizando cobertura completa:

```typescript
// En buildServer():
server.addHook('onRequest', metricsPlugin.onRequestHook);
server.addHook('onResponse', metricsPlugin.onResponseHook);
server.addHook('onError', metricsPlugin.onErrorHook);
server.addHook('onRequestAbort', metricsPlugin.onAbortHook);
```

---

## Escenarios BDD

```gherkin
Feature: Métricas Prometheus del API Gateway

  Background:
    Given el Gateway está levantado con la configuración por defecto
    And la sección "metrics" está habilitada en gateway.yaml con path "/metrics"

  # =============================================
  # Endpoint /metrics
  # =============================================

  Scenario: El endpoint /metrics responde con métricas en formato Prometheus
    When se realiza un request "GET /metrics"
    Then el status code de la respuesta es 200
    And el header "Content-Type" contiene "text/plain"
    And el body contiene la línea "# HELP gateway_http_requests_total"
    And el body contiene la línea "# TYPE gateway_http_requests_total counter"

  Scenario: El endpoint /metrics incluye métricas estándar del proceso Node.js
    When se realiza un request "GET /metrics"
    Then el body contiene "process_cpu_seconds_total"
    And el body contiene "nodejs_heap_size_total_bytes"
    And el body contiene "nodejs_eventloop_lag_seconds"

  Scenario: El endpoint /metrics NO se instrumenta a sí mismo
    Given se han realizado 3 requests a "GET /metrics"
    When se realiza un request "GET /metrics"
    Then el counter "gateway_http_requests_total" NO tiene entradas con label route="/metrics"

  Scenario: El endpoint /metrics es configurable via YAML
    Given la configuración tiene metrics.path = "/internal/prometheus"
    When se realiza un request "GET /internal/prometheus"
    Then el status code de la respuesta es 200
    And el body contiene métricas en formato Prometheus

  Scenario: Las métricas se deshabilitan completamente si metrics.enabled = false
    Given la configuración tiene metrics.enabled = false
    When se realiza un request "GET /metrics"
    Then el status code de la respuesta es 404

  # =============================================
  # Counter: gateway_http_requests_total
  # =============================================

  Scenario: El counter de requests se incrementa tras cada petición exitosa
    Given se han realizado 0 requests al Gateway
    When se realiza un request "GET /public/test"
    And se consulta "GET /metrics"
    Then existe una métrica "gateway_http_requests_total" con labels:
      | label       | value         |
      | method      | GET           |
      | route       | /public       |
      | status_code | 200           |
      | backend     | mock-service  |
    And el valor del counter es 1

  Scenario: El counter distingue por status code
    Given se realiza un request "GET /public/test" que retorna 200
    And se realiza un request "GET /ruta-inexistente" que retorna 404
    When se consulta "GET /metrics"
    Then existen entradas separadas para status_code="200" y status_code="404"

  Scenario: El label route usa metricsLabel cuando está definido
    Given la ruta /api tiene configurado metricsLabel = "pokeapi"
    When se realiza un request "GET /api/pokemon/ditto"
    And se consulta "GET /metrics"
    Then la métrica "gateway_http_requests_total" tiene label route="pokeapi"

  Scenario: El label route usa el prefix cuando metricsLabel no está definido
    Given la ruta /public NO tiene configurado metricsLabel
    When se realiza un request "GET /public/test"
    And se consulta "GET /metrics"
    Then la métrica "gateway_http_requests_total" tiene label route="/public"

  Scenario: El label backend usa backendName cuando está definido
    Given la ruta /api tiene configurado backendName = "pokeapi-ext"
    When se realiza un request "GET /api/pokemon/ditto"
    And se consulta "GET /metrics"
    Then la métrica "gateway_http_requests_total" tiene label backend="pokeapi-ext"

  Scenario: El label backend extrae el hostname del target como fallback
    Given la ruta /public apunta a target "http://mock-service:8080"
    And la ruta /public NO tiene configurado backendName
    When se realiza un request "GET /public/test"
    And se consulta "GET /metrics"
    Then la métrica "gateway_http_requests_total" tiene label backend="mock-service"

  # =============================================
  # Histogram: gateway_http_request_duration_seconds
  # =============================================

  Scenario: El histograma registra la duración de cada request
    When se realiza un request "GET /public/test"
    And se consulta "GET /metrics"
    Then existe una métrica "gateway_http_request_duration_seconds_bucket" con labels method="GET", route="/public"
    And existe una métrica "gateway_http_request_duration_seconds_count" con valor 1
    And existe una métrica "gateway_http_request_duration_seconds_sum" con un valor mayor a 0

  # =============================================
  # Gauge: gateway_http_requests_in_flight
  # =============================================

  Scenario: El gauge de in-flight se incrementa durante el request y decrementa al finalizar
    Given no hay requests activos
    When se consulta "GET /metrics"
    Then el gauge "gateway_http_requests_in_flight" tiene valor 0

  # =============================================
  # Counter: gateway_rate_limit_hits_total
  # =============================================

  Scenario: El counter de rate limiting se incrementa cuando se rechaza un request con 429
    Given la ruta /api tiene rateLimit con maxRequests=2 y windowSeconds=60
    And se han realizado 2 requests "GET /api/pokemon/ditto" dentro de la ventana
    When se realiza un tercer request "GET /api/pokemon/ditto"
    Then el status code es 429
    And se consulta "GET /metrics"
    And la métrica "gateway_rate_limit_hits_total" con label route="/api" tiene valor 1

  # =============================================
  # Instrumentación robusta (errores y abortos)
  # =============================================

  Scenario: Un request con error de backend se instrumenta correctamente
    Given la ruta /api apunta a un backend que retorna 500
    When se realiza un request "GET /api/test"
    And se consulta "GET /metrics"
    Then la métrica "gateway_http_requests_total" tiene una entrada con status_code="500"
    And el gauge "gateway_http_requests_in_flight" no tiene fugas (valor=0)

  Scenario: Un request abortado por el cliente se instrumenta correctamente
    Given se inicia un request "GET /api/pokemon/ditto" y el cliente cierra la conexión antes de recibir respuesta
    When se consulta "GET /metrics"
    Then la métrica "gateway_http_requests_total" tiene una entrada con status_code="499"
    And el gauge "gateway_http_requests_in_flight" no tiene fugas (valor=0)

  Scenario: Los contadores nunca se incrementan más de una vez por request
    Given se registran hooks onResponse, onError y onRequestAbort
    When un request produce un error Y también cierra la conexión
    Then la métrica "gateway_http_requests_total" se incrementa exactamente 1 vez
    And el gauge "gateway_http_requests_in_flight" se decrementa exactamente 1 vez

  # =============================================
  # Cardinalidad y seguridad
  # =============================================

  Scenario: Las métricas no contienen labels de alta cardinalidad
    When se realizan 100 requests con diferentes IPs, paths dinámicos y query params
    And se consulta "GET /metrics"
    Then las métricas NO contienen labels "ip", "userId", "requestId", "path" dinámico o "queryParams"
    And los labels son exclusivamente: method, route, status_code, backend

  Scenario: El label route para requests sin match de ruta es "unmatched"
    When se realiza un request "GET /ruta-que-no-existe"
    And se consulta "GET /metrics"
    Then la métrica contiene label route="unmatched" y backend="unknown"

  # =============================================
  # Infraestructura Docker
  # =============================================

  Scenario: Prometheus hace scraping exitoso del Gateway
    Given el stack Docker Compose está levantado
    When se accede a Prometheus en "http://localhost:9090/targets"
    Then el target "gateway-service:3000" aparece con estado "UP"
    And el último scrape fue exitoso

  Scenario: Grafana muestra el dashboard preconfigurado
    Given el stack Docker Compose está levantado
    When se accede a Grafana en "http://localhost:3001"
    And se navega a Dashboards > Gateway > Gateway Overview
    Then se muestra un dashboard con 4 paneles
    And los paneles muestran datos de métricas del Gateway

  Scenario: El Gateway arranca correctamente sin Prometheus ni Grafana
    Given los servicios "prometheus" y "grafana" están detenidos
    When se levanta solo "gateway" y "redis-cache"
    Then el Gateway arranca y procesa peticiones correctamente
    And el endpoint "/metrics" sigue respondiendo con métricas locales

  Scenario: Los defaultLabels se agregan a todas las métricas
    Given la configuración tiene metrics.defaultLabels = { environment: "staging" }
    When se consulta "GET /metrics"
    Then todas las métricas custom del Gateway incluyen el label environment="staging"
```

---

## Criterios de Aceptación Globales

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | El endpoint `/metrics` responde con formato Prometheus válido | `curl localhost:3000/metrics` y validar formato |
| CA-2 | Las métricas incluyen los 4 instrumentos custom (counter, histogram, gauge, rate limit counter) | Inspeccionar output de `/metrics` |
| CA-3 | Los labels son exclusivamente de baja cardinalidad | Revisar output: solo `method`, `route`, `status_code`, `backend` |
| CA-4 | `metricsLabel` y `backendName` funcionan como override | Configurar en YAML y verificar labels en `/metrics` |
| CA-5 | El fallback de `route` a `prefix` funciona | Ruta sin `metricsLabel` usa prefix como label |
| CA-6 | El fallback de `backend` a hostname funciona | Ruta sin `backendName` usa hostname del target |
| CA-7 | Los hooks `onError` y `onRequestAbort` instrumentan correctamente | Test con backend caído y con conexión abortada |
| CA-8 | No hay fugas en `requests_in_flight` | Después de N requests, gauge vuelve a 0 |
| CA-9 | No hay doble conteo (guard con Symbol) | Test unitario que verifica incremento exacto |
| CA-10 | El endpoint `/metrics` no se instrumenta a sí mismo | Verificar ausencia de label route="/metrics" |
| CA-11 | Prometheus hace scraping exitoso | `http://localhost:9090/targets` muestra UP |
| CA-12 | Grafana muestra los 4 paneles con datos | Navegar al dashboard y verificar visualmente |
| CA-13 | `metrics.enabled: false` deshabilita todo | Verificar 404 en `/metrics` |
| CA-14 | Los tests unitarios pasan | `pnpm test` exitoso |
| CA-15 | El Gateway arranca sin Prometheus/Grafana | Levantar solo gateway + redis, verificar operación normal |

---

## Archivos a Crear/Modificar — Resumen

| Archivo | Acción | Descripción |
|---|---|---|
| `src/middleware/metrics/plugin.ts` | NUEVO | Plugin de métricas con hooks y endpoint `/metrics` |
| `src/middleware/metrics/labels.ts` | NUEVO | Utilidades para resolver labels (`route`, `backend`) |
| `src/middleware/metrics/types.ts` | NUEVO | Interfaces y tipos del módulo de métricas |
| `src/config/schema.ts` | MODIFICAR | Agregar `MetricsConfigSchema`, `metricsLabel`, `backendName` |
| `src/config/types.ts` | MODIFICAR | Agregar `MetricsConfig`, campos opcionales en `RouteConfig` |
| `config/gateway-schema.json` | MODIFICAR | Agregar sección `metrics` y campos nuevos en routes |
| `src/index.ts` | MODIFICAR | Instanciar `MetricsPlugin` y registrar en pipeline |
| `src/server.ts` | MODIFICAR | Registrar endpoint `/metrics` y hooks globales |
| `docker/docker-compose.example.yml` | MODIFICAR | Agregar servicios Prometheus y Grafana |
| `docker/prometheus/prometheus.yml` | NUEVO | Configuración de scraping de Prometheus |
| `docker/grafana/provisioning/datasources/prometheus.yml` | NUEVO | Datasource de Prometheus para Grafana |
| `docker/grafana/provisioning/dashboards/default.yml` | NUEVO | Provider de dashboards de Grafana |
| `docker/grafana/dashboards/gateway-overview.json` | NUEVO | Dashboard preconfigurado con 4 paneles |
| `docker/gateway.yaml` | MODIFICAR | Agregar sección `metrics` y ejemplos de `metricsLabel`/`backendName` |
| `tests/middleware/metrics/plugin.test.ts` | NUEVO | Tests unitarios del MetricsPlugin |
| `tests/middleware/metrics/labels.test.ts` | NUEVO | Tests unitarios de resolución de labels |
| `README.md` | MODIFICAR | Documentar métricas, Prometheus y Grafana |

---

## Flujos Alternativos

### FA-1: Prometheus no está corriendo

- **Síntoma:** No se recolectan métricas históricas, pero el Gateway funciona normalmente.
- **Comportamiento esperado:** El endpoint `/metrics` sigue respondiendo localmente. Las métricas se acumulan en memoria del proceso Node.js. Cuando Prometheus se reconecte, obtendrá los valores acumulados actuales (contadores monotónicos).

### FA-2: Grafana no puede conectar con Prometheus

- **Síntoma:** Los paneles del dashboard muestran "No data".
- **Solución:** Verificar que el servicio `prometheus` está corriendo y accesible desde la red Docker. Verificar la URL del datasource.

### FA-3: Backend con hostname que cambia (ej: IPs dinámicas)

- **Síntoma:** Si el `target` usa IPs en lugar de hostnames, el label `backend` será una IP (cardinalidad controlada pero poco legible).
- **Solución:** Definir explícitamente `backendName` en el YAML para ese caso.

### FA-4: Métricas con defaultLabels muy largos

- **Síntoma:** Labels con valores extensos pueden degradar ligeramente el rendimiento de Prometheus.
- **Solución:** Mantener `defaultLabels` cortos y relevantes (ej: `environment`, `region`).

### FA-5: Proceso reiniciado pierde métricas acumuladas

- **Síntoma:** Al reiniciar el Gateway, los counters vuelven a 0.
- **Comportamiento esperado:** Esto es normal en Prometheus. Los counters monotónicos se manejan con `rate()` / `increase()` que detectan resets automáticamente.

---

## Dependencia Nueva

| Paquete | Versión | Propósito |
|---|---|---|
| `prom-client` | `^15.x` | Cliente oficial de Prometheus para Node.js |

**Instalación:**
```bash
pnpm add prom-client
```

---

## Decisiones Arquitectónicas

| Decisión | Elección | Justificación |
|---|---|---|
| Librería de métricas | `prom-client` | Oficial, estable, sin dependencias externas, battle-tested |
| Exposición de métricas | Endpoint HTTP en mismo puerto | Simplifica configuración; Prometheus scraping estándar |
| Labels de ruta | `metricsLabel` con fallback a `prefix` | Cardinalidad controlada por el operador |
| Labels de backend | `backendName` con fallback a hostname | Pragmático: funciona sin config pero permite override |
| Instrumentación | Hooks globales de Fastify | Cobertura completa: éxito, error, abort |
| Guard de doble conteo | Symbol privado en request | Previene race conditions entre hooks |
| Dashboard Grafana | Provisioning automático | Zero-config al levantar Docker Compose |
| Scope | Solo métricas Prometheus | Tracing distribuido se abordará en spec separada |

---

## Riesgos Técnicos Conocidos

### RT-1: Comportamiento inconsistente de `onRequestAbort` (RIESGO ALTO)

**Descripción:**
El hook `onRequestAbort` de Fastify depende del evento `close` del socket de Node.js, cuyo comportamiento varía según:
- Versión de Fastify (v4 vs v5 tienen APIs ligeramente distintas)
- Versión de Node.js (cambios en el manejo interno de sockets HTTP entre v18, v20 y v22)
- Tipo de cierre: abort del cliente, timeout de upstream, socket reset, half-open connections

En la práctica, no todos los escenarios de desconexión disparan los hooks de la misma manera:

| Escenario | `onResponse` | `onError` | `onRequestAbort` |
|---|---|---|---|
| Respuesta exitosa normal | ✅ Siempre | ❌ | ❌ |
| Error del backend (5xx) | ✅ Siempre | ⚠️ Depende | ❌ |
| Timeout de upstream | ⚠️ A veces | ✅ Generalmente | ⚠️ A veces |
| Cliente cierra conexión (abort) | ❌ | ⚠️ A veces | ✅ Generalmente |
| Socket reset (RST) | ❌ | ⚠️ A veces | ⚠️ A veces |
| Half-open / keep-alive roto | ❌ | ⚠️ Impredecible | ⚠️ Impredecible |

**Impacto:** Si un escenario de cierre no dispara ningún hook, el gauge `requests_in_flight` podría tener fugas (nunca decrementar), produciendo datos de monitoreo incorrectos.

**Mitigación primaria — Guard con Symbol:**
El pattern `METRICS_FINALIZED` (Symbol privado) garantiza que la finalización se ejecute **como máximo una vez**, sin importar cuántos hooks se disparen. Esto previene el doble conteo, pero **no resuelve** el caso de cero hooks disparados.

**Mitigación secundaria — Listener directo en `request.raw.socket`:**
Como respaldo, registrar un listener `close` directamente en el socket raw de Node.js:

```typescript
// En el hook onRequest, como safety net:
request.raw.socket.once('close', () => {
  finalizeMetrics(request, statusCode || '499');
});
```

Este listener se dispara **siempre** cuando el socket se cierra, independientemente de los hooks de Fastify. Combinado con el guard de Symbol, garantiza:
- **Exactamente una finalización** en el caso feliz (Fastify hook + guard)
- **Al menos una finalización** en edge cases (socket close como fallback)

**Estrategia de testing:**

Este será el punto más complejo de testear, no por la lógica sino por simular comportamiento real de sockets. Los tests deben cubrir:

1. **Test unitario con mocks:** Verificar que `finalizeMetrics` se llama exactamente una vez cuando múltiples hooks se disparan (Symbol guard).
2. **Test de integración con servidor real:** Levantar un Fastify real y simular:
   - Request normal → verificar que `in_flight` vuelve a 0
   - Abort del cliente (destruir socket) → verificar que `in_flight` vuelve a 0
   - Timeout de upstream (backend lento) → verificar que `in_flight` vuelve a 0
3. **Test de estrés de fugas:** Ejecutar N requests concurrentes con mezcla de éxitos, errores y aborts, y verificar que `in_flight` converge a 0 después de que todos finalicen.
4. **Test con versión específica de Fastify:** Documentar en qué versión exacta de Fastify se valida el comportamiento (pinear en package.json).

> ⚠️ **Nota para implementación:** Si durante la implementación se descubre que algún escenario edge case no se puede cubrir de manera confiable con hooks + socket listener, considerar como alternativa un **sweep periódico** (timer cada 30s) que limpie entradas `in_flight` con timestamp mayor a un umbral (ej: 5 minutos), como safety net final contra fugas.
