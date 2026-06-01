# Spec: Circuit Breakers y Retries

## 1. Overview

**Nombre:** `circuit-breakers-retries`

**Historia de Usuario:**
> "Implementar Circuit Breakers y Retries en el API Gateway para proteger los backends de sobrecargas y fallas en cascada, con detección automática de backends no saludables, reintentos inteligentes con backoff exponencial y jitter, y respuestas fallidas configurables."

**Dependencia:** Esta especificación depende de `proxy-undici-migration.md` y sus hooks de ciclo de vida.

---

## 2. Arquitectura de la Solución

### 2.1 Diagrama de Estados

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
            ┌───────────────┐         N errors      ┌───────▼───────┐
            │    CLOSED     │ ─────────────────────▶│     OPEN      │
            │  (normal)    │      exceed %         │  (blocked)    │
            └───────┬───────┘                       └───────┬───────┘
                    │                                        │
                    │ All requests in                        │
                    │ HALF_OPEN succeed                      │ timeout
                    │                                        │
                    ▼                                        ▼
            ┌───────────────┐                        ┌───────────────┐
            │   HALF_OPEN   │◀─────────────────────│ timeout +     │
            │  (testing)    │                        │ retry config  │
            └───────────────┘                        └───────────────┘
```

### 2.2 Diagrama de Flujo Completo

```
Request entrante
       │
       ▼
┌─────────────────────────────────────────┐
│      CircuitBreakerPlugin (hook)        │
│                                         │
│  onBeforeRequest hook del ProxyEngine   │
│       │                                 │
│       ├──[circuit is CLOSED]──▶ Permmitir │
│       │                                 │
│       ├──[circuit is HALF_OPEN]──▶ Test  │
│       │                                 │
│       └──[circuit is OPEN]──▶ 503      │
│                                         │
└─────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│      RetryInterceptor (hook)             │
│                                         │
│  onError hook del ProxyEngine           │
│       │                                 │
│       ├──[is retryable?]──▶ No ──▶ Error│
│       │                                 │
│       └──[Yes]──▶ Retry con backoff    │
│                      │                  │
│                      ├──[attempts < max]│
│                      │   └──▶ loop      │
│                      │                  │
│                      └──[exceeded]──▶   │
│                            Error final  │
└─────────────────────────────────────────┘
```

---

## 3. Tipos y Estados

### 3.1 Estados del Circuit Breaker

```typescript
// src/middleware/circuit-breaker/types.ts

export enum CircuitState {
  CLOSED = 'CLOSED',       // Normal operation
  OPEN = 'OPEN',           // Blocking requests
  HALF_OPEN = 'HALF_OPEN', // Testing recovery
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  // Thresholds
  errorThreshold: number;      // Porcentaje de errores para abrir (default: 50)
  requestCount: number;        // Cantidad de requests en ventana (default: 100)
  // Recovery
  recoveryTimeMs: number;      // Tiempo en OPEN antes de HALF_OPEN (default: 30000)
  halfOpenRequests: number;    // Requests permitidas en HALF_OPEN (default: 3)
  // Retry integration
  maxRetries: number;          // Max reintentos (default: 3)
  retryDelayMs: number;       // Base delay para jitter (default: 100)
  retryMaxDelayMs: number;    // Max delay cap (default: 5000)
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failures: number;           // Errores consecutivos o en ventana
  successCount: number;       // Success consecutivos en HALF_OPEN
  lastFailure: string | null; // ISO timestamp del último error
  totalRequests: number;      // Total de requests procesadas
  totalFailures: number;      // Total de requests fallidas
  totalRetries: number;       // Total de reintentos realizados
  totalSuccessAfterRetry: number; // Éxitos después de retry
}
```

### 3.2 Estados de Retry

```typescript
export interface RetryConfig {
  maxRetries: number;           // Máximo número de reintentos
  baseDelayMs: number;          // Delay base para cálculo de jitter
  maxDelayMs: number;           // Delay máximo (cap)
  retryableMethods: string[];   // Métodos que pueden ser reintentados
  retryableErrors: string[];    // Códigos de error que justifican retry
}

export interface RetryContext {
  attempt: number;              // Intento actual (0 = primer intento)
  maxAttempts: number;
  startTime: bigint;
  lastError: string | null;
}

export interface RetryResult {
  success: boolean;
  finalError?: string;
  attempts: number;
  totalRetryDelayMs: number;
}
```

---

## 4. Algoritmos

### 4.1 Detección de Fallas (CLOSED → OPEN)

```
En cada request completada (éxito o error):

1. Si response.statusCode >= 500:
   - Incrementar failureCount
   - Incrementar totalFailures

2. Si response.statusCode >= 200 && response.statusCode < 300:
   - Reset failureCount a 0

3. Si (failureCount / requestCount) >= (errorThreshold / 100):
   - Transition to OPEN
   - Record lastFailure timestamp
   - Log: "Circuit breaker opened for {backend} after {failureCount}/{requestCount} failures"

4. Si failureCount >= 5 (consecutive failures threshold):
   - También abrir el circuit (protección adicional)
```

### 4.2 Recuperación (OPEN → HALF_OPEN)

```
En estado OPEN, cada nueva request:

1. Si (now - lastFailure) >= recoveryTimeMs:
   - Transition to HALF_OPEN
   - Reset successCount = 0
   - Log: "Circuit breaker half-open for {backend}, allowing test requests"

2. Si no, retornar 503 inmediatamente
```

### 4.3 Validación de Salud (HALF_OPEN → CLOSED/OPEN)

```
En cada request en estado HALF_OPEN:

1. Si request es exitosa (2xx):
   - Increment successCount

2. Si request falla (5xx, timeout, error):
   - Transition to OPEN
   - Reset successCount
   - Log: "Circuit breaker reopened for {backend} after {successCount} successful requests"

3. Si successCount >= halfOpenRequests AND todas fueron exitosas:
   - Transition to CLOSED
   - Reset failureCount = 0
   - Log: "Circuit breaker closed for {backend} after recovery"
```

### 4.4 Exponential Backoff with Jitter

```typescript
/**
 * Calcula el delay para el retry actual usando exponential backoff con full jitter.
 * Fórmula: random(0, min(baseDelay * 2^attempt, maxDelay))
 *
 * @param attempt - Número de intento actual (0 = primer retry)
 * @param baseDelayMs - Delay base en ms (ej: 100)
 * @param maxDelayMs - Delay máximo en ms (ej: 5000)
 * @returns Delay en ms para este retry
 */
export function calculateRetryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  const jitter = Math.random() * cappedDelay; // Full jitter: 0 to cappedDelay
  return Math.floor(jitter);
}

/**
 * Ejemplo de delays:
 * Attempt 0: random(0, 100)     → 0-100ms
 * Attempt 1: random(0, 200)     → 0-200ms
 * Attempt 2: random(0, 400)     → 0-400ms
 * Attempt 3: random(0, 800)     → 0-800ms
 * Attempt 4: random(0, 1600)    → 0-1600ms
 * ... hasta maxDelayMs (5000)
 */
```

### 4.5 Scope de Retry (Métodos Idempotentes)

```typescript
const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];

/**
 * Determina si una request es candidata para retry.
 * Solo métodos idempotentes pueden ser reintentados de forma segura.
 */
export function isRetryable(method: string): boolean {
  return IDEMPOTENT_METHODS.includes(method.toUpperCase());
}

/**
 * Códigos de error que justifican un retry.
 */
export const RETRYABLE_ERRORS = [
  'ECONNREFUSED',  // Backend no responde
  'ETIMEDOUT',     // Timeout de conexión
  'ECONNRESET',    // Conexión reseteada
  'ENOTFOUND',     // DNS resolution failed
  'EAI_AGAIN',     // DNS temporáneo
  '500',           // Internal server error
  '502',           // Bad gateway
  '503',           // Service unavailable
  '504',           // Gateway timeout
];
```

---

## 5. API del Circuit Breaker

### 5.1 CircuitBreakerPlugin

```typescript
// src/middleware/circuit-breaker/plugin.ts

import { CircuitBreakerConfig, CircuitState, CircuitBreakerMetrics } from './types.js';

export interface CircuitBreakerPlugin {
  name: 'circuit-breaker';

  /**
   * Hook para integrar con ProxyEngine.onBeforeRequest.
   * Verifica estado del circuit antes de enviar request al backend.
   */
  onBeforeRequestHook: (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

  /**
   * Hook para integrar con ProxyEngine.onError.
   * Registra errores y determina si se debe hacer retry.
   */
  onErrorHook: (error: ProxyError, context: ProxyContext) => RetryDecision;

  /**
   * Hook para integrar con ProxyEngine.onAfterResponse.
   * Actualiza contadores de éxito/falla.
   */
  onAfterResponseHook: (response: ProxyResponseData, context: ProxyContext) => void;

  /**
   * Obtiene métricas actuales del circuit breaker.
   */
  getMetrics(routePrefix: string): CircuitBreakerMetrics;

  /**
   * Obtiene el estado actual del circuit.
   */
  getState(routePrefix: string): CircuitState;

  /**
   * Fuerza el estado del circuit (para testing/admin).
   */
  forceState(routePrefix: string, state: CircuitState): void;
}

export interface RetryDecision {
  shouldRetry: boolean;
  retryContext?: RetryContext;
}
```

### 5.2 RetryInterceptor

```typescript
// src/middleware/circuit-breaker/retry.ts

export class RetryInterceptor {
  private readonly config: RetryConfig;
  private readonly logger: Logger;

  constructor(config: RetryConfig, logger: Logger);

  /**
   * Ejecuta una función con reintentos automáticos.
   * Retorna el resultado o lanza el último error.
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    context: RetryContext
  ): Promise<RetryResult & { result?: T }>;

  /**
   * Calcula el delay para el siguiente retry.
   */
  calculateDelay(attempt: number): number;

  /**
   * Determina si un error es elegible para retry.
   */
  isRetryableError(error: ProxyError): boolean;
}
```

---

## 6. Configuración en gateway.yaml

### 6.1 Schema Extendido

```yaml
# src/config/schema.ts (extensión)

const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  errorThreshold: z.number().min(1).max(100).default(50),
  requestCount: z.number().positive().default(100),
  recoveryTimeMs: z.number().positive().default(30000),
  halfOpenRequests: z.number().positive().default(3),
  maxRetries: z.number().nonNegative().default(3),
  retryDelayMs: z.number().positive().default(100),
  retryMaxDelayMs: z.number().positive().default(5000),
}).optional();

const RouteSchema = z.object({
  prefix: z.string(),
  target: z.string().url(),
  stripPrefix: z.boolean().default(false),
  rateLimit: RateLimitSchema.optional(),
  jwt: JwtAuthSchema.optional(),
  timeout: ProxyTimeoutSchema,
  retryableMethods: z.array(z.string()).optional(),
  // --- Circuit Breaker ---
  circuitBreaker: CircuitBreakerConfigSchema,
});
```

### 6.2 Ejemplo de Configuración

```yaml
# config/gateway.yaml

routes:
  - prefix: /api/users
    target: http://users-backend:8080
    stripPrefix: false
    timeout:
      connect: 5000
      headers: 30000
      body: 60000
    circuitBreaker:
      enabled: true
      errorThreshold: 50        # 50% de errores abre el circuit
      requestCount: 100         # Ventana de 100 requests
      recoveryTimeMs: 30000     # 30 segundos antes de probar recovery
      halfOpenRequests: 3      # 3 requests exitosas cierran el circuit
      maxRetries: 3            # Máximo 3 reintentos
      retryDelayMs: 100        # Base delay 100ms
      retryMaxDelayMs: 5000    # Max delay 5 segundos

  - prefix: /api/orders
    target: http://orders-backend:8080
    stripPrefix: false
    circuitBreaker:
      enabled: true
      errorThreshold: 30       # Más estricto: 30%
      requestCount: 50
      recoveryTimeMs: 60000    # 1 minuto
      halfOpenRequests: 5
      maxRetries: 2
      retryDelayMs: 200
      retryMaxDelayMs: 10000   # Max 10 segundos

  - prefix: /api/public
    target: http://public-backend:8080
    stripPrefix: false
    circuitBreaker:
      enabled: false           # Deshabilitado para rutas públicas
```

---

## 7. BDD - Comportamiento Esperado

### Feature: Circuit Breaker

```gherkin
Feature: Circuit Breaker
  Como operador del gateway
  Quiero proteger los backends con circuit breakers
  Para evitar fallas en cascada y permitir recuperación

  # ===== ESTADOS DEL CIRCUIT =====

  Scenario: Circuit inicia en estado CLOSED
    Given el gateway con circuit breaker configurado
    When el gateway inicia
    Then todos los circuits están en estado CLOSED
    And las requests se procesan normalmente

  Scenario: Circuit se abre cuando se excede el umbral de errores
    Given un backend con 50% de tasa de error
    And el umbral configurado es 50%
    When se procesan 100 requests
    Then el circuit pasa a estado OPEN
    And las siguientes requests reciben HTTP 503

  Scenario: Circuit se abre después de 5 errores consecutivos
    Given un backend que retorna 500 para cada request
    When ocurren 5 errores consecutivos
    Then el circuit pasa a estado OPEN inmediatamente
    And las siguientes requests reciben HTTP 503

  Scenario: Circuit se recupera después del tiempo de recuperación
    Given un circuit en estado OPEN
    And han pasado 30 segundos desde que se abrió
    When llega una nueva request
    Then el circuit pasa a estado HALF_OPEN
    And se permiten máximo 3 requests de prueba

  Scenario: Circuit se cierra después de requests exitosas en HALF_OPEN
    Given un circuit en estado HALF_OPEN
    When 3 requests exitosas ocurren consecutivamente
    Then el circuit pasa a estado CLOSED
    And las requests se procesan normalmente

  Scenario: Circuit se reabre si falla en HALF_OPEN
    Given un circuit en estado HALF_OPEN
    When una request falla durante el período de prueba
    Then el circuit vuelve a estado OPEN
    And el temporizador de recuperación se reinicia

  # ===== RETRIES =====

  Scenario: Retry con exponential backoff y jitter para GET
    Given una request GET que falla con error 503
    And el circuit está CLOSED
    And maxRetries es 3
    When se ejecuta la request
    Then se reintenta hasta 3 veces
    And los delays son: random(0-100), random(0-200), random(0-400) ms
    And se usa el resultado del último intento

  Scenario: No se hace retry en métodos no idempotentes
    Given una request POST que falla
    And retryableMethods incluye solo GET, HEAD, OPTIONS, PUT, DELETE
    When la request falla
    Then NO se hace retry
    And se retorna el error inmediatamente

  Scenario: No se hace retry cuando circuit está OPEN
    Given un circuit en estado OPEN
    When llega una nueva request
    Then se retorna HTTP 503 inmediatamente
    And NO se hace retry

  Scenario: Retry solo para errores elegibles
    Given una request que falla con error 400 (Bad Request)
    When la request falla
    Then NO se hace retry (400 no es retryable)
    And se retorna el error inmediatamente

  Scenario: Retry para errores de red
    Given una request que falla con ETIMEDOUT
    When la request falla
    Then se hace retry
    And se usa exponential backoff con jitter

  # ===== MÉTRICAS =====

  Scenario: Métricas reflejan estado del circuit
    Given un circuit en estado CLOSED
    When se consultan las métricas
    Then state = 0 (CLOSED)
    And failures = 0
    And totalRequests refleja las requests procesadas

  Scenario: Métricas se actualizan en transición a OPEN
    Given un circuit en estado CLOSED
    When el circuit pasa a OPEN
    Then las métricas reflejan novo estado
    And totalFailures se ha incrementado

  # ===== FALLBACK RESPONSE =====

  Scenario: Response cuando circuit OPEN
    Given un circuit en estado OPEN
    When llega una request
    Then se retorna HTTP 503
    And el body es JSON: {"error": "Circuit Open", "message": "...", "retryAfter": <seconds>}
    And el header Retry-After indica el tiempo restante
```

### Feature: Retry con Backoff

```gherkin
Feature: Retry con Exponential Backoff y Jitter
  Como desarrollador del gateway
  Quiero que los retries usen exponential backoff con jitter
  Para evitar thundering herd cuando un backend se recupera

  Scenario: Delays crecen exponencialmente
    Given maxRetries = 3 y baseDelay = 100ms
    When ocurre un failure y se hacen 3 retries
    Then el primer retry ocurre después de ~0-100ms
    And el segundo retry ocurre después de ~0-200ms
    And el tercer retry ocurre después de ~0-400ms

  Scenario: Jitter evita sincronización
    Given dos clients haciendo retry al mismo tiempo
    When ambos fallan y hacen retry
    Then los delays son diferentes (random diferentes)
    And no se sincronizan los reintentos

  Scenario: Delay tiene límite máximo
    Given baseDelay = 100ms y maxDelay = 500ms
    When ocurre el retry 10
    Then el delay es capped a 500ms máximo

  Scenario: Retry exhaustivo con todos los intentos
    Given una request que siempre falla
    And maxRetries = 3
    When se ejecuta la request
    Then se hacen 4 intentos en total (1 original + 3 retries)
    And el último error sepropaga al cliente
```

---

## 8. Métricas de Prometheus

### 8.1 Métricas del Circuit Breaker

| Métrica | Tipo | Labels | Descripción |
|---------|------|--------|-------------|
| `gateway_circuit_breaker_state` | Gauge | `route`, `backend` | Estado: 0=CLOSED, 1=HALF_OPEN, 2=OPEN |
| `gateway_circuit_breaker_failures_total` | Counter | `route`, `backend` | Total de failures |
| `gateway_circuit_breaker_requests_total` | Counter | `route`, `backend`, `status` | Total de requests |
| `gateway_circuit_breaker_transitions_total` | Counter | `route`, `backend`, `from_state`, `to_state` | Transiciones de estado |
| `gateway_circuit_breaker_open_total` | Counter | `route`, `backend` | Veces que se abrió el circuit |

### 8.2 Métricas de Retry

| Métrica | Tipo | Labels | Descripción |
|---------|------|--------|-------------|
| `gateway_retries_total` | Counter | `route`, `backend`, `error_code` | Total de reintentos realizados |
| `gateway_retry_success_total` | Counter | `route`, `backend` | Reintentos que resultaron en éxito |
| `gateway_retry_delay_seconds` | Histogram | `route`, `attempt` | Delay de cada retry |

---

## 9. Plan de Implementación

### Fase 1: Core del Circuit Breaker
1. Crear `src/middleware/circuit-breaker/types.ts` - Estados y tipos
2. Crear `src/middleware/circuit-breaker/state.ts` - Máquina de estados
3. Crear `src/middleware/circuit-breaker/plugin.ts` - CircuitBreakerPlugin
4. Tests unitarios del state machine

### Fase 2: Sistema de Retry
5. Crear `src/middleware/circuit-breaker/retry.ts` - RetryInterceptor
6. Implementar exponential backoff con jitter
7. Tests unitarios del retry

### Fase 3: Integración con ProxyEngine
8. Integrar hooks en `src/proxy/hooks.ts` (extender)
9. Conectar con ProxyEngine.onBeforeRequest
10. Conectar con ProxyEngine.onError
11. Tests de integración

### Fase 4: Métricas y Admin
12. Agregar métricas de circuit breaker a Prometheus
13. Endpoint de estado (opcional: `/admin/circuits`)

### Fase 5: Validación
14. Tests de integración completos
15. Validar con backends que fallan artificialmente

---

## 10. Criterios de Aceptación

- [ ] Circuit breaker tiene 3 estados: CLOSED, OPEN, HALF_OPEN
- [ ] El circuit abre cuando 50% de requests fallan en ventana de 100
- [ ] El circuit abre después de 5 errores consecutivos
- [ ] Recovery time configurable (default 30s)
- [ ] En HALF_OPEN se permiten 3 requests de prueba
- [ ] Circuit cierra cuando todas las requests en HALF_OPEN son exitosas
- [ ] Retry usa exponential backoff con full jitter
- [ ] Retry solo para métodos idempotentes (GET, HEAD, OPTIONS, PUT, DELETE)
- [ ] Max 3 retries configurables
- [ ] No se hace retry cuando circuit está OPEN
- [ ] HTTP 503 cuando circuit OPEN con body JSON y Retry-After header
- [ ] Métricas de estado y transiciones disponibles en Prometheus
- [ ] Estado almacenado in-memory por instancia
- [ ] Todos los tests pasan

---

## 11. Archivos a Crear/Modificar

### Archivos a Crear
- `src/middleware/circuit-breaker/types.ts` - Estados y tipos
- `src/middleware/circuit-breaker/state.ts` - State machine
- `src/middleware/circuit-breaker/plugin.ts` - CircuitBreakerPlugin
- `src/middleware/circuit-breaker/retry.ts` - RetryInterceptor
- `tests/unit/middleware/circuit-breaker/state.test.ts`
- `tests/unit/middleware/circuit-breaker/retry.test.ts`
- `tests/integration/circuit-breaker.test.ts`

### Archivos a Modificar
- `src/proxy/hooks.ts` - Extender con nuevos tipos de error
- `src/config/schema.ts` - Agregar circuitBreaker config
- `src/config/types.ts` - Agregar CircuitBreakerConfig
- `src/middleware/pipeline.ts` - Agregar CircuitBreakerPlugin

### Dependencias
- Ninguna nueva (usa la arquitectura de hooks del proxy-undici)