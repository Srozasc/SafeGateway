# Spec: Plugin Health Aggregation para SafeGateway

> **Estado**: Pendiente de implementación
> **Proyecto destino**: [SafeGateway](https://github.com/Srozasc/SafeGateway)
> **Origen**: Gap identificado durante la planificación de Flash Drop Backend

---

## User Story

> **Como** operador de infraestructura (SRE / DevOps)
> **quiero** un endpoint único `GET /health` que agregue el estado de todos los servicios downstream
> **para** que load balancers, Kubernetes liveness probes y herramientas de monitoreo tengan un solo punto de consulta para conocer la salud del sistema completo, sin necesidad de sondear cada servicio individualmente.

---

## Contexto

SafeGateway actualmente expone `/metrics` (Prometheus) pero no tiene un endpoint HTTP estándar de health check agregado. Esto obliga a:

- Load balancers a configurar N health checks (uno por servicio).
- Dashboards externos a consumir `/metrics` y parsear Prometheus para extraer estado.
- Operators a curl múltiples URLs para diagnosticar incidentes.

Este spec define un plugin de health aggregation que consulta en paralelo el endpoint `/health` de cada backend declarado en `routes[]` y devuelve una respuesta agregada con código HTTP apropriado.

---

## Asunciones Aceptadas

### Funcionales

- **H1**: Endpoint por defecto: `GET /health` (configurable).
- **H2**: Cada servicio expone su propio `GET /health` (path configurable globalmente).
- **H3**: Estados por servicio: `ok`, `degraded`, `down`.
- **H4**: Estado global: `ok` si todos `ok`, `down` si alguno `down`, `degraded` en cualquier otro caso.
- **H5**: HTTP status: `200` si global=ok, `207` si global=degraded, `503` si global=down.
- **H6**: Respuesta JSON con timestamp, status global, array de servicios con su estado.
- **H7**: Sin autenticación en el endpoint de health.
- **H8**: Sin rate limit en el endpoint de health.
- **H9**: Lista de servicios derivada de `routes[]` en la config.

### Técnicas

- **H10**: Consultas a servicios downstream en paralelo con `Promise.all`.
- **H11**: Timeout por servicio: 2000ms por defecto, configurable.
- **H12**: Timeout agotado → estado `down`.
- **H13**: 5xx → `down`, 2xx/3xx → `ok`, 4xx → `degraded`.
- **H14**: Sin caché de respuestas de health.
- **H15**: Sin métricas Prometheus nuevas.
- **H16**: Sin hot-reload específico (cambios en `routes[]` siguen el flujo normal).

---

## Configuración

### Mockup ASCII — Configuración global

```yaml
# config/gateway.yaml

server:
  port: 8080
  host: "0.0.0.0"

# ── Configuración Health Aggregation ───────────────────────
health:
  enabled: true                    # default: true
  path: /health                    # default: /health
  backendPath: /health             # default: /health (path en cada servicio downstream)
  timeoutMs: 2000                  # default: 2000 (2s por servicio)
  retries: 0                       # default: 0 (sin reintentos para no retrasar respuesta)

routes:
  - prefix: /api/auth
    target: http://auth-service:8082
    stripPrefix: true

  - prefix: /api/products
    target: http://catalog-service:8083
    stripPrefix: true

  - prefix: /api/orders
    target: http://orders-service:8084
    stripPrefix: true

  - prefix: /api/delivery
    target: http://delivery-service:8085
    stripPrefix: true
```

### Mockup ASCII — Configuración deshabilitada

```yaml
# Si health está deshabilitado, /health retorna 404
health:
  enabled: false
```

### Mockup ASCII — Path personalizado por entorno

```yaml
# Producción: health en path estándar
health:
  enabled: true
  path: /health
  backendPath: /health

# Desarrollo: health en path debug
health:
  enabled: true
  path: /debug/health
  backendPath: /internal/health
```

---

## Formato de Respuesta

### Caso 1: Todos los servicios OK

**HTTP 200 OK**

```json
{
  "status": "ok",
  "timestamp": "2026-06-28T14:30:00.123Z",
  "services": [
    {
      "name": "auth-service",
      "status": "ok",
      "latencyMs": 12,
      "statusCode": 200
    },
    {
      "name": "catalog-service",
      "status": "ok",
      "latencyMs": 23,
      "statusCode": 200
    },
    {
      "name": "orders-service",
      "status": "ok",
      "latencyMs": 18,
      "statusCode": 200
    },
    {
      "name": "delivery-service",
      "status": "ok",
      "latencyMs": 15,
      "statusCode": 200
    }
  ]
}
```

### Caso 2: Un servicio DOWN, otros OK

**HTTP 503 Service Unavailable**

```json
{
  "status": "down",
  "timestamp": "2026-06-28T14:30:00.123Z",
  "services": [
    {
      "name": "auth-service",
      "status": "ok",
      "latencyMs": 12,
      "statusCode": 200
    },
    {
      "name": "catalog-service",
      "status": "down",
      "latencyMs": 2000,
      "error": "timeout after 2000ms"
    },
    {
      "name": "orders-service",
      "status": "ok",
      "latencyMs": 18,
      "statusCode": 200
    },
    {
      "name": "delivery-service",
      "status": "ok",
      "latencyMs": 15,
      "statusCode": 200
    }
  ]
}
```

### Caso 3: Un servicio DEGRADED (4xx)

**HTTP 207 Multi-Status**

```json
{
  "status": "degraded",
  "timestamp": "2026-06-28T14:30:00.123Z",
  "services": [
    {
      "name": "auth-service",
      "status": "ok",
      "latencyMs": 12,
      "statusCode": 200
    },
    {
      "name": "catalog-service",
      "status": "degraded",
      "latencyMs": 8,
      "statusCode": 401,
      "error": "health endpoint requires auth (config issue?)"
    },
    {
      "name": "orders-service",
      "status": "ok",
      "latencyMs": 18,
      "statusCode": 200
    },
    {
      "name": "delivery-service",
      "status": "ok",
      "latencyMs": 15,
      "statusCode": 200
    }
  ]
}
```

---

## BDD Scenarios

### Escenario 1: Todos los servicios responden OK

```gherkin
Given el gateway con 3 servicios downstream todos healthy
When un cliente hace GET /health
Then el gateway consulta /health de los 3 servicios en paralelo
And todos responden 200 dentro del timeout
And el gateway responde HTTP 200 con JSON:
  """
  {
    "status": "ok",
    "services": [
      { "name": "auth-service", "status": "ok", "statusCode": 200, ... },
      { "name": "catalog-service", "status": "ok", "statusCode": 200, ... },
      { "name": "orders-service", "status": "ok", "statusCode": 200, ... }
    ]
  }
  """
And el campo "latencyMs" de cada servicio refleja el tiempo de respuesta real
```

### Escenario 2: Un servicio no responde (timeout)

```gherkin
Given el gateway con 3 servicios, donde catalog-service NO responde
When un cliente hace GET /health con timeoutMs=2000
Then después de 2000ms el catalog-service se marca como "down"
And el gateway responde HTTP 503
And el JSON incluye para catalog-service:
  """
  {
    "name": "catalog-service",
    "status": "down",
    "latencyMs": 2000,
    "error": "timeout after 2000ms"
  }
  """
And los otros 2 servicios aparecen como "ok"
```

### Escenario 3: Un servicio responde 5xx

```gherkin
Given el gateway con 3 servicios, donde orders-service responde HTTP 503 en /health
When un cliente hace GET /health
Then orders-service se marca como "down" con statusCode: 503
And el gateway responde HTTP 503
```

### Escenario 4: Un servicio responde 4xx

```gherkin
Given el gateway con 3 servicios, donde catalog-service responde HTTP 401 en /health
When un cliente hace GET /health
Then catalog-service se marca como "degraded" con statusCode: 401
And el gateway responde HTTP 207 (Multi-Status)
And los otros servicios aparecen como "ok"
```

### Escenario 5: Health endpoint NO requiere autenticación

```gherkin
Given el gateway con jwt-auth habilitado para /api/*
When un cliente hace GET /health SIN Authorization header
Then el gateway responde 200/207/503 sin intentar validar JWT
And el request NO pasa por el plugin jwt-auth
```

### Escenario 6: Health endpoint NO está rate-limited

```gherkin
Given el gateway con rate-limit configurado para /api/* (max 100 req/min)
When un cliente hace 1000 requests a /health en 1 minuto
Then todos los requests pasan (no se aplica rate-limit)
And ningún request retorna 429
```

### Escenario 7: Health endpoint no aparece en rutas de proxy

```gherkin
Given el gateway con health.path = /health y una ruta con prefix /api
When un cliente hace GET /health
Then el gateway responde con el JSON de health (no proxea a ningún backend)
And el request NO se cuenta en métricas de proxy
```

### Escenario 8: Health deshabilitado retorna 404

```gherkin
Given la configuración con health.enabled = false
When un cliente hace GET /health
Then el gateway responde HTTP 404
```

### Escenario 9: Path personalizado

```gherkin
Given la configuración con health.path = /status y health.backendPath = /internal/health
When un cliente hace GET /status
Then el gateway consulta <target>/internal/health en cada servicio
And responde con el formato estándar de health
```

### Escenario 10: Servicio con error de conexión (ECONNREFUSED)

```gherkin
Given el gateway con un servicio configurado pero el puerto está cerrado
When un cliente hace GET /health
Then ese servicio se marca como "down"
And el error reportado es: "connection refused"
And el gateway responde HTTP 503
```

### Escenario 11: Lista vacía de servicios

```gherkin
Given el gateway con routes: [] (ningún servicio configurado)
When un cliente hace GET /health
Then el gateway responde HTTP 200 con JSON:
  """
  {
    "status": "ok",
    "timestamp": "2026-06-28T14:30:00.123Z",
    "services": []
  }
  """
```

### Escenario 12: Validación al startup — timeout inválido

```gherkin
Given el archivo gateway.yaml con:
  """
  health:
    timeoutMs: -1
  """
When el gateway arranca
Then la validación Zod falla con error:
  """
  health.timeoutMs: must be positive integer
  """
And el proceso aborta con exit code 1
```

---

## Criterios de Aceptación

### Funcionales

- [ ] El endpoint `/health` responde con código HTTP apropriado (`200`/`207`/`503`).
- [ ] La respuesta JSON incluye timestamp, status global, y estado por servicio.
- [ ] Las consultas a servicios downstream se ejecutan en paralelo.
- [ ] El estado global se calcula correctamente según las reglas definidas.
- [ ] El endpoint no requiere autenticación ni rate limiting.
- [ ] El endpoint no se proxea a ningún backend.
- [ ] El path del endpoint y el path del backend son configurables.
- [ ] Funciona correctamente cuando no hay servicios configurados.

### Técnicos

- [ ] Implementación en `src/middleware/health/` siguiendo interfaz `GatewayPlugin`.
- [ ] Schema Zod añadido a `src/config/schema.ts`.
- [ ] El endpoint se registra en Fastify **antes** de las rutas de proxy (`src/server.ts`).
- [ ] Tests unitarios cubren los 12 BDD scenarios.
- [ ] Tests de integración con 3 mock backends (uno healthy, uno degraded, uno down).
- [ ] Cobertura ≥85% en `src/middleware/health/`.
- [ ] Documentación actualizada en CLAUDE.md y README.md.

### Operacionales

- [ ] Logs estructurados con nivel `debug` por servicio consultado.
- [ ] Latencia del endpoint ≤ timeout configurado (no acumulado).
- [ ] Sin nuevas dependencias externas.

---

## Dependencias

### Internas (SafeGateway)

- `src/middleware/pipeline.ts` — interfaz `GatewayPlugin`
- `src/config/schema.ts` — añadir schema Zod para `health`
- `src/server.ts` — registrar endpoint antes de rutas de proxy
- `src/proxy/engine.ts` — reutilizar cliente HTTP (Undici) o fetch nativo para health checks

### Externas

- Ninguna nueva. Usar `fetch` nativo de Node.js 20+ o el cliente Undici ya incluido.

---

## Fuera de Alcance (Out of Scope)

- Health checks con dependencias específicas (BD, cache, message queue) — eso es responsabilidad de cada servicio.
- Caché de resultados de health (cada request consulta en tiempo real).
- Métricas Prometheus específicas de health.
- Soporte para métodos distintos a GET (`POST /health` etc).
- Autenticación opcional del endpoint.
- Histórico de health (uptime tracking) — usar herramientas externas para eso.

---

## Mockup ASCII — Flujo del plugin

```
    Cliente ───GET /health───► Gateway

    Gateway:
    ┌─────────────────────────────────────┐
    │ 1. Recibir request a /health        │
    └──────────────┬──────────────────────┘
                   │
    ┌──────────────▼──────────────────────┐
    │ 2. Extraer lista de backends        │
    │    desde routes[]                   │
    │    [auth, catalog, orders, delivery]│
    └──────────────┬──────────────────────┘
                   │
    ┌──────────────▼──────────────────────┐
    │ 3. Promise.all con timeoutMs       │
    │    ┌────────┐ ┌────────┐ ┌────────┐ │
    │    │ /auth  │ │ /cat   │ │ /ord   │ │
    │    │ /health│ │ /health│ │ /health│ │
    │    └───┬────┘ └───┬────┘ └───┬────┘ │
    │        │          │          │      │
    │     200 OK     timeout     503     │
    │        │          │          │      │
    └────────┼──────────┼──────────┼──────┘
             │          │          │
    ┌────────▼──────────▼──────────▼──────┐
    │ 4. Mapear resultados:              │
    │    auth      → ok                  │
    │    catalog   → down (timeout)      │
    │    orders    → down (503)          │
    └──────────────┬──────────────────────┘
                   │
    ┌──────────────▼──────────────────────┐
    │ 5. Calcular status global:         │
    │    hay algún "down" → global=down  │
    └──────────────┬──────────────────────┘
                   │
    ┌──────────────▼──────────────────────┐
    │ 6. Responder HTTP 503 + JSON       │
    └────────────────────────────────────┘
```

---

## Notas de Implementación

1. **Registro en Fastify**: El endpoint `/health` debe registrarse con `fastify.get(path, handler)` **antes** de registrar las rutas de proxy. Esto evita que el matcher de rutas lo capture.

2. **Reutilizar Undici**: Para consistencia con el resto del gateway, usar el mismo cliente HTTP (Undici pool por backend) que ya existe en `src/proxy/pool.ts`. Alternativamente, `fetch` nativo es aceptable por simplicidad.

3. **Cálculo del status global**:

```typescript
const statuses = services.map(s => s.status);
const globalStatus =
  statuses.includes("down") ? "down" :
  statuses.includes("degraded") ? "degraded" :
  "ok";

const httpStatus =
  globalStatus === "down" ? 503 :
  globalStatus === "degraded" ? 207 :
  200;
```

4. **Manejo de errores de Undici**: Mapear códigos de error a mensajes legibles:
   - `UND_ERR_SOCKET` → `"connection failed"`
   - `UND_ERR_CONNECT_TIMEOUT` → `"timeout after ${timeoutMs}ms"`
   - Otros → mensaje del error

5. **Métrica de latencia**: El campo `latencyMs` debe medirse con `performance.now()` antes y después del request.

---

## Referencias

- [Kubernetes Liveness/Readiness Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [RFC 7231: HTTP Status Codes (207 Multi-Status)](https://www.rfc-editor.org/rfc/rfc7231#section-6.3.7)
- SafeGateway existentes: `src/middleware/rate-limit/`, `src/proxy/pool.ts` (referencia de patrón)