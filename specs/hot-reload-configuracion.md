# Especificación: Hot Reload de Configuración (SIGHUP)

## Resumen

**Historia de usuario:**
> Como operador del API Gateway, quiero poder recargar el archivo `gateway.yaml` en caliente (sin reiniciar el proceso ni perder conexiones activas) enviando una señal `SIGHUP` al contenedor, para poder modificar rate limits, overrides y niveles de log sin downtime.

**Tipo de cambio:** Funcionalidad Post-MVP — código en `src/` (nueva feature del runtime).

**Principio rector:** Swap atómico de snapshots inmutables en memoria. No se reconstruye el servidor Fastify ni se re-bindea el puerto TCP. La implementación de `@fastify/http-proxy` permanece aislada como detalle de implementación en su módulo, sin acoplamiento arquitectónico.

---

## Asunciones Aprobadas (14/14)

| # | Asunción |
|---|---|
| 1 | Señal `SIGHUP` exclusivamente — sin endpoint HTTP administrativo |
| 2 | Alcance: `routes[].rateLimit`, `overrides`, `logging.level` — NO `server`, `redis`, `routes[].target/prefix/stripPrefix` |
| 3 | Swap atómico en memoria (parcial) — NO rebuild del servidor |
| 4 | Validación Zod completa antes de aplicar — fallo = rollback a config anterior |
| 5 | Zero-downtime inherente — la instancia Fastify nunca se detiene |
| 6 | Conexión Redis reutilizada — no se reconecta |
| 7 | Logging level: cambio dinámico inmediato vía Pino (`logger.level = nuevo`) |
| 8 | Compatibilidad Docker: `docker kill -s SIGHUP <contenedor>` |
| 9 | Mismo path de config siempre (el del startup) |
| 10 | Logs de auditoría estructurados para cada intento de reload |
| 11 | Contadores de rate limit en Redis preservados tras reload |
| 12 | Protección contra recargas concurrentes (mutex lógico) |
| 13 | Windows no soportado nativamente (solo Docker/Linux) |
| 14 | Snapshots de configuración inmutables — reemplazo atómico de referencia completa |

---

## Componentes Afectados

| Componente | Tipo | Archivo |
|---|---|---|
| Config Reloader | NUEVO | `src/config/reloader.ts` |
| Config Snapshot (tipo) | NUEVO | `src/config/types.ts` |
| Entry Point (Bootstrap) | MODIFICAR | `src/index.ts` |
| Server Builder | MODIFICAR | `src/server.ts` |
| Tests unitarios del Reloader | NUEVO | `tests/unit/config/reloader.test.ts` |
| Tests de integración del Reload | NUEVO | `tests/integration/hot-reload.test.ts` |
| Documentación | MODIFICAR | `README.md` |

---

## Parte 1 — Concepto: ConfigSnapshot

### Descripción

Un `ConfigSnapshot` encapsula el estado completo de configuración vigente del Gateway en un instante dado. Es un objeto inmutable que se crea atómicamente y reemplaza la referencia anterior sin mutaciones parciales.

### Definición del tipo

```typescript
// En src/config/types.ts (agregar)
interface ConfigSnapshot {
  /** Configuración completa validada y congelada */
  config: Readonly<GatewayConfig>;
  /** Registry de rutas construido a partir de esta configuración */
  registry: RouteRegistry;
  /** Timestamp de creación del snapshot (ISO 8601) */
  createdAt: string;
}
```

### Reglas

- Cada llamada exitosa a `loadConfig()` (tanto en startup como en reload) genera un nuevo `ConfigSnapshot`.
- El `ConfigSnapshot` activo es la **única fuente de verdad** para el matching de rutas y rate limits.
- El hook `onRequest` del servidor lee siempre desde el snapshot activo, no desde una referencia capturada por closure en el startup.
- El snapshot anterior no se destruye explícitamente; el garbage collector de V8 lo recolecta cuando no hay más referencias.

---

## Parte 2 — ConfigReloader: Módulo de Recarga

### Descripción

Módulo encargado de orquestar la recarga segura de configuración. Encapsula la lógica de validación, detección de cambios no recargables, construcción de snapshots y swap atómico.

### Ubicación: `src/config/reloader.ts`

### Interfaz pública

```typescript
interface ReloadResult {
  success: boolean;
  /** Campos que cambiaron y fueron aplicados */
  applied: string[];
  /** Campos que cambiaron pero requieren reinicio */
  ignored: string[];
  /** Mensaje de error si success === false */
  error?: string;
}

class ConfigReloader {
  constructor(
    configPath: string,
    snapshotRef: { current: ConfigSnapshot },
    logger: Logger
  );

  /**
   * Ejecuta el proceso completo de recarga.
   * Thread-safe: descarta señales SIGHUP concurrentes.
   */
  async reload(): Promise<ReloadResult>;
}
```

### Algoritmo de recarga (paso a paso)

```
SIGHUP recibida
     │
     ▼
┌─ Mutex check ─┐
│ ¿Recarga en   │──── SÍ ──→ Log warn("Recarga ya en curso, señal ignorada")
│ curso?         │            return { success: false }
└──────┬─────────┘
       │ NO
       ▼
  Adquirir mutex (isReloading = true)
       │
       ▼
  1. Leer archivo YAML desde configPath
       │
       ▼
  2. Interpolar variables de entorno
       │
       ▼
  3. Parsear YAML
       │
       ▼
  4. Validar con Zod (GatewayConfigSchema)
       │
       ├── FALLO ──→ Log error("Recarga fallida: [detalles Zod]")
       │              Liberar mutex
       │              return { success: false, error: "..." }
       │
       ▼ ÉXITO
  5. Comparar config nueva vs config activa (snapshot.current.config)
       │
       ├── Detectar cambios en secciones NO recargables:
       │     - server.port / server.host
       │     - redis.url / redis.onFailure
       │     - routes[].prefix / routes[].target / routes[].stripPrefix
       │     - Agregar o eliminar rutas (longitud de routes[] cambió)
       │     → Log warn("Cambios detectados que requieren reinicio: [lista]")
       │     → Agregar a resultado.ignored[]
       │
       ├── Detectar cambios en secciones SÍ recargables:
       │     - routes[].rateLimit (maxRequests, windowSeconds)
       │     - overrides (agregar, eliminar, modificar)
       │     - logging.level
       │     → Agregar a resultado.applied[]
       │
       ▼
  6. ¿Hay cambios aplicables?
       │
       ├── NO ──→ Log info("No se detectaron cambios aplicables")
       │           Liberar mutex
       │           return { success: true, applied: [], ignored: [...] }
       │
       ▼ SÍ
  7. Construir nuevo ConfigSnapshot:
       │   - new RouteRegistry(newConfig)
       │   - deepFreeze(newConfig)
       │   - createdAt = new Date().toISOString()
       │
       ▼
  8. Swap atómico: snapshotRef.current = nuevoSnapshot
       │
       ▼
  9. Si logging.level cambió:
       │   logger.level = newConfig.logging.level
       │
       ▼
  10. Log info("Configuración recargada exitosamente")
       │   Log info con detalle de cambios aplicados e ignorados
       │
       ▼
  Liberar mutex (isReloading = false)
  return { success: true, applied: [...], ignored: [...] }
```

---

## Parte 3 — Modificaciones al Server Builder

### Descripción

El `buildServer()` actual captura el `RouteRegistry` por closure en el hook `onRequest`. Esto impide swapear la referencia. Se debe refactorizar para que el hook lea desde una referencia mutable compartida.

### Cambio en `src/server.ts`

**Antes (actual):**
```typescript
export function buildServer(config, pipeline, logger): FastifyInstance {
  const registry = new RouteRegistry(config);    // ← Capturado por closure
  server.decorate('routeRegistry', registry);

  server.addHook('onRequest', async (request) => {
    const match = registry.match(request.url);   // ← Referencia fija
    if (match) request.routeContext = match;
  });
  // ...
}
```

**Después (refactorizado):**
```typescript
export function buildServer(
  config: GatewayConfig,
  pipeline: MiddlewarePipeline,
  logger: Logger,
  snapshotRef: { current: ConfigSnapshot }       // ← Nueva dependencia
): FastifyInstance {
  // Ya no crea el RouteRegistry internamente
  server.addHook('onRequest', async (request) => {
    const match = snapshotRef.current.registry.match(request.url);  // ← Lee del snapshot activo
    if (match) request.routeContext = match;
  });
  // ...
}
```

### Impacto

- El `RouteRegistry` ya no se construye dentro de `buildServer()`. Se construye en `index.ts` (startup) y en `ConfigReloader` (reload).
- El decorator `routeRegistry` en Fastify se mantiene para compatibilidad, pero apunta al `snapshotRef.current.registry`.
- Las rutas de proxy (`registerProxyRoutes`) siguen registrándose una sola vez en el startup con la configuración inicial. **No cambian en un reload.**

---

## Parte 4 — Modificaciones al Entry Point (Bootstrap)

### Descripción

El `src/index.ts` se modifica para:
1. Crear el `ConfigSnapshot` inicial durante el bootstrap.
2. Mantener una referencia mutable (`snapshotRef`) al snapshot activo.
3. Instanciar el `ConfigReloader` con las dependencias necesarias.
4. Registrar el handler de la señal `SIGHUP`.

### Cambios principales

```typescript
// Variables a nivel de módulo (agregar)
let snapshotRef: { current: ConfigSnapshot };
let reloader: ConfigReloader;

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logging.level);

  // ...conexión Redis...

  // Crear snapshot inicial
  const registry = new RouteRegistry(config);
  snapshotRef = {
    current: {
      config,
      registry,
      createdAt: new Date().toISOString(),
    },
  };

  // ...pipeline, server (pasando snapshotRef)...
  server = buildServer(config, pipeline, logger, snapshotRef);

  // Instanciar el reloader con las dependencias
  const configPath = process.env['CONFIG_PATH'] || './config/gateway.yaml';
  reloader = new ConfigReloader(configPath, snapshotRef, logger);

  // ...listen...
}

// Handler de señal SIGHUP (nuevo)
process.on('SIGHUP', async () => {
  if (reloader) {
    await reloader.reload();
  }
});
```

---

## Parte 5 — Detección de Cambios No Recargables

### Descripción

El reloader debe comparar la configuración nueva con la activa para identificar qué cambió. Los cambios en secciones no recargables no impiden la recarga de las secciones que sí lo son — simplemente se emite un `warn`.

### Campos recargables

| Campo YAML | Mecanismo de aplicación |
|---|---|
| `routes[N].rateLimit.maxRequests` | Nuevo `RouteRegistry` → `effectiveRateLimit` actualizado |
| `routes[N].rateLimit.windowSeconds` | Nuevo `RouteRegistry` → `effectiveRateLimit` actualizado |
| `overrides[N].rateLimit.maxRequests` | Nuevo `RouteRegistry` → override actualizado en el `Map` |
| `overrides[N].rateLimit.windowSeconds` | Nuevo `RouteRegistry` → override actualizado |
| Agregar/eliminar overrides | Nuevo `RouteRegistry` → `Map` reconstruido |
| `logging.level` | `logger.level = newLevel` (Pino dinámico) |

### Campos NO recargables (requieren reinicio)

| Campo YAML | Razón técnica |
|---|---|
| `server.port` | Requiere re-bind del socket TCP |
| `server.host` | Requiere re-bind del socket TCP |
| `redis.url` | Requiere reconexión del cliente ioredis |
| `redis.onFailure` | Capturado en el constructor de `RateLimitPlugin` |
| `routes[N].prefix` | Baked-in en el plugin `@fastify/http-proxy` |
| `routes[N].target` | Baked-in en el plugin `@fastify/http-proxy` |
| `routes[N].stripPrefix` | Baked-in como `rewritePrefix` en el plugin |
| `routes[N].timeout` | Baked-in en `undici` options del plugin |
| Agregar nuevas rutas | Requiere registrar nuevos plugins de proxy |
| Eliminar rutas | Fastify no soporta desregistrar plugins |

### Algoritmo de comparación

```typescript
function detectChanges(
  oldConfig: GatewayConfig,
  newConfig: GatewayConfig
): { applied: string[]; ignored: string[] } {
  const applied: string[] = [];
  const ignored: string[] = [];

  // --- Sección server ---
  if (oldConfig.server.port !== newConfig.server.port)
    ignored.push('server.port');
  if (oldConfig.server.host !== newConfig.server.host)
    ignored.push('server.host');

  // --- Sección redis ---
  if (oldConfig.redis.url !== newConfig.redis.url)
    ignored.push('redis.url');
  if (oldConfig.redis.onFailure !== newConfig.redis.onFailure)
    ignored.push('redis.onFailure');

  // --- Sección logging ---
  if (oldConfig.logging.level !== newConfig.logging.level)
    applied.push(`logging.level: "${oldConfig.logging.level}" → "${newConfig.logging.level}"`);

  // --- Sección routes (estructura) ---
  if (oldConfig.routes.length !== newConfig.routes.length)
    ignored.push(`routes: cantidad cambió de ${oldConfig.routes.length} a ${newConfig.routes.length}`);

  // --- Sección routes (por cada ruta existente) ---
  for (let i = 0; i < Math.min(oldConfig.routes.length, newConfig.routes.length); i++) {
    const oldRoute = oldConfig.routes[i];
    const newRoute = newConfig.routes[i];

    if (oldRoute.prefix !== newRoute.prefix)
      ignored.push(`routes[${i}].prefix`);
    if (oldRoute.target !== newRoute.target)
      ignored.push(`routes[${i}].target`);
    if (oldRoute.stripPrefix !== newRoute.stripPrefix)
      ignored.push(`routes[${i}].stripPrefix`);

    // Rate limit SÍ es recargable
    if (JSON.stringify(oldRoute.rateLimit) !== JSON.stringify(newRoute.rateLimit))
      applied.push(`routes[${i}].rateLimit`);

    // Timeout NO es recargable
    if (JSON.stringify(oldRoute.timeout) !== JSON.stringify(newRoute.timeout))
      ignored.push(`routes[${i}].timeout`);
  }

  // --- Sección overrides ---
  if (JSON.stringify(oldConfig.overrides) !== JSON.stringify(newConfig.overrides))
    applied.push('overrides');

  return { applied, ignored };
}
```

---

## Parte 6 — Escenarios BDD

```gherkin
Feature: Hot Reload de configuración del API Gateway vía SIGHUP

  Background:
    Given el API Gateway está corriendo con la configuración inicial:
      | Campo                          | Valor              |
      | server.port                    | 3000               |
      | logging.level                  | info               |
      | routes[0].prefix               | /api               |
      | routes[0].target               | https://pokeapi.co |
      | routes[0].rateLimit.maxRequests | 10                 |
      | routes[0].rateLimit.windowSeconds | 60               |
    And el proceso del Gateway tiene PID 1 dentro del contenedor
    And la conexión a Redis está activa y estable


  # ==========================================
  # Escenarios de recarga exitosa
  # ==========================================

  Scenario: Recargar rate limit de una ruta existente
    Given el archivo "gateway.yaml" se modifica cambiando "routes[0].rateLimit.maxRequests" a 50
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway emite un log nivel "info" con el mensaje "Señal SIGHUP recibida. Iniciando recarga de configuración..."
    And el Gateway emite un log nivel "info" con el mensaje que contiene "Configuración recargada exitosamente"
    And el log incluye el cambio aplicado "routes[0].rateLimit"
    And el nuevo rate limit efectivo para la ruta "/api" es maxRequests=50
    And el Gateway continúa respondiendo peticiones HTTP en el puerto 3000 sin interrupción
    And no se ha creado una nueva conexión a Redis

  Scenario: Recargar el nivel de logging dinámicamente
    Given el archivo "gateway.yaml" se modifica cambiando "logging.level" de "info" a "debug"
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway emite un log nivel "info" con el cambio aplicado 'logging.level: "info" → "debug"'
    And a partir de ese momento, el Gateway emite logs de nivel "debug"
    And las peticiones HTTP siguientes generan logs detallados de matching de rutas

  Scenario: Recargar overrides de rate limit
    Given el archivo "gateway.yaml" se modifica agregando un override:
      """yaml
      overrides:
        - path: /api/login
          rateLimit:
            maxRequests: 3
            windowSeconds: 60
      """
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway emite un log nivel "info" con el cambio aplicado "overrides"
    And las peticiones a "/api/login" aplican el rate limit de maxRequests=3
    And las peticiones a "/api/users" siguen aplicando el rate limit original de la ruta padre

  Scenario: Modificar rate limit Y logging.level en el mismo reload
    Given el archivo "gateway.yaml" se modifica con:
      | Campo                          | Nuevo Valor |
      | logging.level                  | debug       |
      | routes[0].rateLimit.maxRequests | 100         |
    When se envía la señal SIGHUP al proceso del Gateway
    Then ambos cambios se aplican atómicamente en el mismo reload
    And el log de auditoría lista ambos campos en "applied"

  Scenario: No hay cambios aplicables en el archivo
    Given el archivo "gateway.yaml" no ha sido modificado desde el último arranque
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway emite un log nivel "info" con el mensaje "No se detectaron cambios aplicables"
    And el Gateway continúa operando con la misma configuración


  # ==========================================
  # Escenarios de cambios no recargables
  # ==========================================

  Scenario: Cambio en una sección no recargable (target de ruta)
    Given el archivo "gateway.yaml" se modifica cambiando "routes[0].target" a "https://otro-api.com"
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway emite un log nivel "warn" con el mensaje que contiene "Cambios detectados que requieren reinicio"
    And el log incluye "routes[0].target" en la lista de campos ignorados
    And el proxy sigue reenviando peticiones al target original "https://pokeapi.co"

  Scenario: Cambio en el puerto del servidor
    Given el archivo "gateway.yaml" se modifica cambiando "server.port" a 4000
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway emite un log nivel "warn" que incluye "server.port" en la lista de campos ignorados
    And el Gateway sigue escuchando en el puerto 3000

  Scenario: Cambio mixto — campos recargables y no recargables
    Given el archivo "gateway.yaml" se modifica con:
      | Campo                          | Nuevo Valor          |
      | server.port                    | 4000                 |
      | routes[0].target               | https://otro-api.com |
      | routes[0].rateLimit.maxRequests | 50                   |
      | logging.level                  | debug                |
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway aplica los cambios recargables: "routes[0].rateLimit" y "logging.level"
    And el Gateway emite un warn con los campos ignorados: "server.port" y "routes[0].target"
    And el rate limit efectivo para "/api" es maxRequests=50
    And el nivel de logging es "debug"
    And el Gateway sigue escuchando en el puerto 3000
    And el proxy sigue apuntando a "https://pokeapi.co"


  # ==========================================
  # Escenarios de error y protección
  # ==========================================

  Scenario: Recarga con YAML inválido (sintaxis)
    Given el archivo "gateway.yaml" se modifica con contenido YAML inválido (tabulación mixta)
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway emite un log nivel "error" con el mensaje que contiene "Recarga de configuración fallida"
    And el log incluye el detalle del error de parseo YAML
    And el Gateway continúa operando con la configuración anterior sin interrupción
    And el rate limit efectivo para "/api" sigue siendo maxRequests=10

  Scenario: Recarga con validación Zod fallida (campo requerido faltante)
    Given el archivo "gateway.yaml" se modifica eliminando la sección "redis" (campo requerido)
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway emite un log nivel "error" con el mensaje que contiene "Recarga de configuración fallida"
    And el log incluye los detalles de validación Zod
    And el Gateway continúa operando con la configuración anterior

  Scenario: Recarga con variable de entorno faltante
    Given el archivo "gateway.yaml" se modifica agregando "${VARIABLE_INEXISTENTE}" en un campo
    When se envía la señal SIGHUP al proceso del Gateway
    Then el Gateway emite un log nivel "error" indicando la variable de entorno faltante
    And el Gateway continúa operando con la configuración anterior

  Scenario: Múltiples señales SIGHUP en ráfaga
    Given el archivo "gateway.yaml" se modifica con un cambio válido
    When se envían 3 señales SIGHUP al proceso del Gateway en menos de 100ms
    Then solo se ejecuta una recarga completa
    And las 2 señales adicionales son descartadas
    And el Gateway emite un log nivel "warn" con el mensaje "Recarga ya en curso, señal SIGHUP ignorada" por cada señal descartada


  # ==========================================
  # Escenarios de inmutabilidad de snapshots
  # ==========================================

  Scenario: Requests en vuelo usan el snapshot vigente al momento de su llegada
    Given hay un request HTTP en proceso (esperando respuesta del backend)
    When se envía la señal SIGHUP y se completa un reload exitoso durante ese request
    Then el request en vuelo completa su procesamiento con la configuración original
    And los requests nuevos que lleguen después del swap usan la configuración nueva

  Scenario: Los contadores de rate limit en Redis se preservan
    Given la IP "192.168.1.10" ha realizado 8 de 10 peticiones permitidas en la ventana actual
    And el archivo "gateway.yaml" se modifica cambiando maxRequests de 10 a 20
    When se envía la señal SIGHUP al proceso del Gateway
    Then la IP "192.168.1.10" puede realizar 12 peticiones más en la ventana actual (20 - 8 = 12)
    And las claves de Redis existentes NO se eliminan ni se reinician


  # ==========================================
  # Escenarios de integración Docker
  # ==========================================

  Scenario: Enviar SIGHUP desde el host al contenedor
    Given el contenedor "gateway-service" está corriendo vía Docker Compose
    When el operador ejecuta "docker kill -s SIGHUP gateway-service" desde el host
    Then el proceso Node.js dentro del contenedor recibe la señal SIGHUP
    And se ejecuta el proceso de recarga de configuración

  Scenario: SIGHUP no interfiere con shutdown graceful
    Given el Gateway está procesando una recarga (SIGHUP recibida)
    When se envía una señal SIGTERM al proceso
    Then el shutdown graceful tiene prioridad
    And la recarga en curso se aborta limpiamente
    And el servidor Fastify se cierra sin errores
    And la conexión Redis se libera correctamente
```

---

## Criterios de Aceptación Globales

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | La señal SIGHUP dispara la recarga de configuración | Enviar `kill -HUP <pid>` y verificar log de auditoría |
| CA-2 | Los rate limits se actualizan tras el reload | Modificar `maxRequests`, enviar SIGHUP, verificar header `X-RateLimit-Limit` |
| CA-3 | Los overrides se actualizan tras el reload | Agregar/modificar override, enviar SIGHUP, verificar comportamiento |
| CA-4 | El logging level se actualiza dinámicamente | Cambiar a `debug`, enviar SIGHUP, verificar que aparecen logs debug |
| CA-5 | Un YAML inválido no rompe el Gateway | Introducir error de sintaxis, enviar SIGHUP, verificar que sigue operando |
| CA-6 | Los cambios no recargables emiten un warn claro | Cambiar `server.port`, enviar SIGHUP, verificar log warn |
| CA-7 | Las recargas concurrentes están protegidas por mutex | Enviar 3 SIGHUP seguidos, verificar que solo se procesa 1 |
| CA-8 | Zero-downtime durante la recarga | Enviar SIGHUP mientras hay peticiones activas, verificar 0 errores |
| CA-9 | Los contadores de rate limit en Redis se preservan | Verificar que las claves Redis no se eliminan tras reload |
| CA-10 | Ningún archivo en `src/proxy/` se modifica | Verificar con `git diff --name-only src/proxy/` (debe estar vacío) |
| CA-11 | La suite de tests existente (62 tests) sigue pasando | Ejecutar `pnpm test` y verificar 62/62 passed |
| CA-12 | Tests nuevos del reloader cubren los escenarios BDD | Verificar cobertura del módulo `src/config/reloader.ts` ≥ 90% |

---

## Archivos a Crear/Modificar — Resumen

| Archivo | Acción | Descripción |
|---|---|---|
| `src/config/types.ts` | MODIFICAR | Agregar interfaz `ConfigSnapshot` y tipo `ReloadResult` |
| `src/config/reloader.ts` | NUEVO | Clase `ConfigReloader` con lógica de recarga, comparación y swap atómico |
| `src/index.ts` | MODIFICAR | Crear `snapshotRef`, instanciar `ConfigReloader`, registrar handler `SIGHUP` |
| `src/server.ts` | MODIFICAR | Refactorizar `buildServer()` para aceptar `snapshotRef` en vez de crear `RouteRegistry` internamente |
| `tests/unit/config/reloader.test.ts` | NUEVO | Tests unitarios del `ConfigReloader` |
| `tests/integration/hot-reload.test.ts` | NUEVO | Tests de integración del reload end-to-end |
| `README.md` | MODIFICAR | Documentar el uso de SIGHUP y las secciones recargables |

---

## Nota Arquitectónica — Aislamiento del Proxy

> **Decisión de diseño acordada:** `@fastify/http-proxy` debe permanecer como un **detalle de implementación** encapsulado exclusivamente en `src/server.ts` (función `registerProxyRoutes`). Ningún otro módulo del sistema debe depender directamente de esta librería ni de sus tipos. Esto garantiza que una futura refactorización a un proxy dinámico (Camino B) sea un cambio localizado en un solo archivo sin propagación al resto de la arquitectura.

Los módulos que participan en el hot reload (`ConfigReloader`, `RouteRegistry`, `MiddlewarePipeline`) operan con abstracciones propias del Gateway (`ConfigSnapshot`, `RouteMatch`, `GatewayPlugin`) y no tienen conocimiento de cómo se ejecuta el proxy real.

---

## Flujos Alternativos

### FA-1: El archivo de configuración fue eliminado

- **Síntoma:** SIGHUP recibida, pero `configPath` ya no existe en el filesystem.
- **Comportamiento:** `loadConfig()` lanza `ConfigFileNotFoundError`. El reloader captura el error, emite log `error`, y mantiene la configuración anterior.
- **El Gateway no se detiene.**

### FA-2: El archivo de configuración tiene permisos de lectura revocados

- **Síntoma:** SIGHUP recibida, `fs.readFileSync` falla con `EACCES`.
- **Comportamiento:** Igual que FA-1. Error capturado, log emitido, config anterior preservada.

### FA-3: Redis se desconectó durante el reload

- **Síntoma:** La recarga se ejecuta correctamente (no depende de Redis), pero las peticiones posteriores con rate limit fallan.
- **Comportamiento:** El `RateLimitPlugin` ya maneja este caso con su política `onFailure` (open/closed). La recarga no interfiere con la conexión Redis.

### FA-4: SIGTERM durante un reload activo

- **Síntoma:** Se envía SIGTERM mientras hay un reload en progreso.
- **Comportamiento:** El handler de SIGTERM tiene prioridad. El shutdown graceful cierra el servidor y la conexión Redis. El reload no bloquea el shutdown porque:
  1. `reload()` es asíncrono y coopera con el event loop.
  2. Si el proceso se está cerrando, las operaciones pendientes del reload se abandonan naturalmente.

### FA-5: Docker Desktop en Windows y señales

- **Síntoma:** En Docker Desktop para Windows, la señal SIGHUP funciona dentro del contenedor Linux.
- **Nota:** El operador usa `docker kill -s SIGHUP gateway-service` desde PowerShell. Docker Desktop traduce la señal al proceso Linux dentro de la VM de WSL2/Hyper-V. No se requiere configuración especial.
