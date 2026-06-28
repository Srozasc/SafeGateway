# Puntos de Entrada y Secuencia de Inicializacion

Este documento detalla los archivos de arranque del API Gateway, la secuencia exacta de operaciones que ocurren durante el bootstrap y las configuraciones globales que controlan el comportamiento del sistema.

---

## Lista de Entry Points

El Gateway tiene un modelo de ejecucion lineal con un unico punto de entrada principal. No existe una arquitectura de modulos independientes o workers; todo se orquesta desde un flujo secuencial centralizado.

| Entry Point | Ubicacion | Rol Tecnico |
| :--- | :--- | :--- |
| **index.ts** | `src/index.ts` | Punto de entrada principal. Orquesta el bootstrap completo: carga de configuracion, conexion a Redis, instanciacion de middlewares, construccion del servidor Fastify y registro de signal handlers. |
| **server.ts** | `src/server.ts` | Factoría del servidor. Recibe la configuracion ya validada y construye la instancia Fastify con todas las rutas, hooks, middlewares y el endpoint nativo de metricas. |
| **loader.ts** | `src/config/loader.ts` | Motor de configuracion. Lee el archivo YAML, interpola variables de entorno con sintaxis `${VAR}`, valida contra el esquema Zod y congela el objeto resultante con `Object.freeze` profundo. |
| **reloader.ts** | `src/config/reloader.ts` | Recarga en caliente. Escucha la senal SIGHUP del sistema operativo y ejecuta un proceso thread-safe de recarga parcial de la configuracion sin reiniciar el proceso. |

---

## Secuencia de Inicializacion (Bootstrap)

La funcion `bootstrap()` en `src/index.ts` ejecuta los siguientes pasos en orden estricto. Si cualquier paso falla, el proceso se detiene con `process.exit(1)` para evitar un estado inconsistente.

```d2
direction: down

Step1: "1. Cargar Config (YAML + Zod)"
Step2: "2. Inicializar Logger (Pino)"
Step3: "3. Conectar a Redis (3 reintentos)"
Step4: "4. Crear Snapshot de Configuracion"
Step5: "5. Instanciar Middlewares (Rate Limit, JWT, CB, Metrics)"
Step6: "6. Construir Pipeline de Middlewares"
Step7: "7. Construir Servidor Fastify"
Step8: "8. Inicializar Config Reloader (SIGHUP)"
Step9: "9. Escuchar en puerto TCP"

Step1 -> Step2: OK
Step2 -> Step3: OK
Step3 -> Step4: OK
Step4 -> Step5: OK
Step5 -> Step6: OK
Step6 -> Step7: OK
Step7 -> Step8: OK
Step8 -> Step9: OK

Step1.style.fill: "#e3f2fd"
Step1.style.font-color: "#0d47a1"
Step9.style.fill: "#e8f5e9"
Step9.style.font-color: "#1b5e20"
```

### Detalle de cada paso

1. **Cargar configuracion**: `loadConfig()` localiza el archivo YAML (por defecto `./config/gateway.yaml` o la variable de entorno `CONFIG_PATH`), interpola variables de entorno con la sintaxis `${VARIABLE}`, parsea el YAML con `js-yaml` y valida el resultado contra `GatewayConfigSchema` (Zod). Si falla, lanza una excepcion tipada (`ConfigFileNotFoundError`, `ConfigParseError`, `ConfigValidationError` o `MissingEnvVarError`). El objeto devuelto es inmutable (`Object.freeze` profundo).

2. **Inicializar Logger**: Crea una instancia de Pino con el nivel de log de la configuracion (`debug`, `info`, `warn`, `error`). Toda salida es JSON estructurado.

3. **Conectar a Redis**: Ejecuta hasta 3 intentos de conexion al servidor Redis configurado. Cada intento tiene un timeout de 2 segundos. Entre intentos espera 1 segundo. Si los 3 fallan, el bootstrap aborta con `process.exit(1)`.

4. **Crear Snapshot**: Construye un `ConfigSnapshot` inmutable que contiene la configuracion validada, una instancia de `RouteRegistry` y un timestamp. Este snapshot se almacena en una referencia mutable (`snapshotRef.current`) que permite el hot-reload posterior.

5. **Instanciar Middlewares**: Crea las instancias de los 4 plugins del pipeline en este orden:
   - `RateLimitPlugin` (respaldado por Redis).
   - `JwtAuthPlugin` (verificacion de tokens con `jose`).
   - `CircuitBreakerPlugin` (maquina de estados por ruta).
   - `MetricsPlugin` (contadores y histogramas Prometheus, condicional a `metrics.enabled`).

6. **Construir Pipeline**: `MiddlewarePipeline` recibe el array de plugins y recolecta sus lifecycle hooks para integrarlos con el `ProxyEngine`.

7. **Construir Servidor Fastify**: `buildServer()` registra el manejador global de errores, define la propiedad reactiva `routeRegistry`, engancha los hooks de metricas, registra el endpoint `/metrics` y crea las rutas proxy con `preHandler` (pipeline) y `handler` (proxy engine).

8. **Inicializar Config Reloader**: Crea una instancia de `ConfigReloader` que reacciona a la senal `SIGHUP` del sistema operativo para recargar la configuracion en caliente sin detener el proceso.

9. **Escuchar en puerto TCP**: `server.listen({ port, host })` abre el socket TCP y comienza a aceptar conexiones entrantes.

---

## Senales del Sistema Operativo

El Gateway registra handlers para tres senales del sistema operativo:

| Senal | Comportamiento |
| :--- | :--- |
| `SIGTERM` | Ejecuta un graceful shutdown: cierra el servidor HTTP, drena los connection pools de Undici, cierra la conexion a Redis y sale con codigo 0. |
| `SIGINT` | Identico a SIGTERM. Permite apagar limpiamente con Ctrl+C durante el desarrollo. |
| `SIGHUP` | Recarga la configuracion en caliente. Ejecuta `ConfigReloader.reload()` que carga, valida e intercambia atomicamente el snapshot de configuracion activo. Los cambios de `logging.level` y `rateLimit` se aplican de inmediato; los de `server.port`, `server.host` y `redis.url` son ignorados (requieren reinicio). |

---

## Graceful Shutdown

El proceso de apagado seguro (`gracefulShutdown()`) sigue un orden estricto para evitar perdida de datos o conexiones huerfanas:

1. Cerrar el servidor Fastify (dejar de aceptar nuevas peticiones HTTP).
2. Cerrar todos los connection pools de Undici (drenar sockets persistentes hacia backends).
3. Cerrar la conexion a Redis (liberar el socket del store de Rate Limiting).
4. Salir del proceso con `process.exit(0)`.

Si ocurre un error durante el shutdown, el proceso sale con `process.exit(1)`.
