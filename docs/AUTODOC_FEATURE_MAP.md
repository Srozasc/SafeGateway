# Mapa de Funcionalidades (Feature Map)

Este documento traduce los componentes tecnicos del API Gateway a capacidades funcionales comprensibles para cualquier miembro del equipo. Cada funcionalidad se asocia con su modulo tecnico y el beneficio concreto que aporta.

---

## Mapa General de Capacidades

| Funcionalidad | Modulo Tecnico | Archivos Clave | Beneficio |
| :--- | :--- | :--- | :--- |
| **Proxy Inverso Transparente** | `src/proxy/engine.ts`, `src/proxy/pool.ts` | ProxyEngine, ConnectionPoolManager | Redirige peticiones HTTP de clientes a multiples backends sin que el cliente conozca la topologia interna. Centraliza un unico punto de acceso para todos los microservicios. |
| **Enrutamiento Dinamico por Prefijo** | `src/routing/registry.ts`, `src/routing/matcher.ts` | RouteRegistry | Permite definir multiples rutas (`/public`, `/secure`, `/api`) en un archivo YAML. Cada prefijo apunta a un backend diferente con configuracion independiente. |
| **Autenticacion JWT por Ruta** | `src/middleware/jwt-auth/plugin.ts` | JwtAuthPlugin | Protege rutas individuales exigiendo un token Bearer valido. Inyecta los claims decodificados como headers seguros al backend, eliminando la necesidad de que cada microservicio implemente su propia logica de autenticacion. |
| **Rate Limiting Distribuido** | `src/middleware/rate-limit/plugin.ts`, `src/middleware/rate-limit/store.ts` | RateLimitPlugin, RedisRateLimitStore | Limita el numero de peticiones por IP en una ventana de tiempo configurable. Funciona de forma distribuida gracias a Redis, garantizando coherencia en despliegues con multiples replicas. |
| **Circuit Breaker con Reintentos** | `src/middleware/circuit-breaker/plugin.ts`, `src/middleware/circuit-breaker/state.ts`, `src/middleware/circuit-breaker/retry.ts` | CircuitBreakerPlugin, CircuitStateMachine | Protege al Gateway y a los backends de fallos en cascada. Si un backend deja de responder, el circuito se abre y devuelve errores locales rapidos (503), evitando consumir recursos en conexiones inutiles. Incluye reintentos automaticos con backoff exponencial. |
| **Metricas Prometheus Nativas** | `src/middleware/metrics/plugin.ts` | MetricsPlugin | Expone un endpoint `/metrics` compatible con Prometheus que incluye contadores de peticiones, histogramas de latencia y tasas de error, desglosados por ruta, metodo HTTP y backend. |
| **Recarga de Configuracion en Caliente** | `src/config/reloader.ts` | ConfigReloader | Permite modificar parametros operativos (limites de tasa, nivel de log) sin reiniciar el proceso, enviando la senal `SIGHUP`. Ideal para ajustes en produccion sin tiempo de inactividad. |
| **Logging Estructurado JSON** | `src/logger/setup.ts` | createLogger (Pino) | Emite logs en formato JSON optimizado para ingesta por herramientas de observabilidad (ELK, Datadog, CloudWatch). El nivel de log es dinamicamente reconfigurable. |
| **Validacion Estricta de Configuracion** | `src/config/schema.ts`, `src/config/loader.ts` | GatewayConfigSchema (Zod) | Garantiza que toda la configuracion sea valida antes de que el Gateway acepte trafico. Un campo malformado detiene el arranque inmediatamente, evitando estados inconsistentes en produccion. |
| **Graceful Shutdown** | `src/index.ts` | gracefulShutdown() | Asegura un apagado limpio del proceso: drena peticiones activas, cierra pools de conexiones y libera la conexion a Redis antes de terminar. Evita la perdida de datos y conexiones huerfanas durante despliegues. |
| **Connection Pooling Inteligente** | `src/proxy/pool.ts` | ConnectionPoolManager | Mantiene pools de sockets TCP/TLS persistentes por cada backend, reutilizando conexiones entre peticiones. Reduce drasticamente la latencia de red y el consumo de descriptores de archivo del sistema operativo. |

---

## Flujo de una Peticion Completa

El siguiente diagrama muestra el camino que recorre una peticion desde que el cliente la envia hasta que recibe la respuesta del backend:

```d2
direction: right

Client: "Cliente"
RateLimit: "Rate Limiter"
JwtAuth: "JWT Auth"
CircuitBreaker: "Circuit Breaker"
ProxyEngine: "Proxy Engine"
Backend: "Backend"
Metrics: "Metricas"

Client -> RateLimit: "1. Verificar cuota IP"
RateLimit -> JwtAuth: "2. Verificar token"
JwtAuth -> CircuitBreaker: "3. Comprobar estado circuito"
CircuitBreaker -> ProxyEngine: "4. Reenviar al backend"
ProxyEngine -> Backend: "5. HTTP request"
Backend -> ProxyEngine: "6. HTTP response"
ProxyEngine -> Client: "7. Respuesta al cliente"

Client -> Metrics: "Registrar inicio"
ProxyEngine -> Metrics: "Registrar fin y latencia"

Client.style.fill: "#e3f2fd"
Client.style.font-color: "#0d47a1"
Backend.style.fill: "#e8f5e9"
Backend.style.font-color: "#1b5e20"
Metrics.style.fill: "#fff3e0"
Metrics.style.font-color: "#e65100"
```

---

## Arquitectura de Plugins (Extensibilidad)

El sistema de middlewares esta disenado como un pipeline de plugins donde cada modulo implementa la interfaz `GatewayPlugin`:

```typescript
interface GatewayPlugin {
  name: string;
  onRequest?(context: RequestContext): Promise<void>;
  onResponse?(context: ResponseContext): Promise<void>;
}
```

Para agregar una nueva funcionalidad al Gateway (por ejemplo, un middleware de CORS, un transformador de respuestas o un cache en memoria), basta con:

1. Crear una clase que implemente `GatewayPlugin`.
2. Implementar `onRequest()` para la logica pre-proxy o `onResponse()` para la logica post-proxy.
3. Registrar la instancia en el array `pluginsList` en `src/index.ts`.

El pipeline ejecuta los plugins en el orden de registro. Si un plugin responde directamente al cliente (`reply.sent === true`), el pipeline se detiene y no ejecuta los plugins restantes (short-circuit).
