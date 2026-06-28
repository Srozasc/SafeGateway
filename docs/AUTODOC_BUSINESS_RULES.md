# Reglas de Negocio del API Gateway

Este documento traduce la logica de control de flujo, las validaciones y las politicas operativas del codigo fuente a reglas comprensibles en lenguaje natural. Esta orientado a desarrolladores, product managers y equipos de operaciones.

---

## Reglas de Configuracion y Arranque

| ID | Regla Operativa | Implementacion Tecnica | Criticidad |
| :--- | :--- | :--- | :--- |
| CFG-01 | El Gateway no arrancara si el archivo de configuracion YAML no existe o no puede leerse. | `ConfigFileNotFoundError` lanzado en `loader.ts` si `fs.existsSync()` es falso. | Bloqueante |
| CFG-02 | El Gateway no arrancara si el YAML tiene errores de sintaxis. | `ConfigParseError` lanzado en `loader.ts` si `yaml.load()` falla. | Bloqueante |
| CFG-03 | El Gateway no arrancara si algún campo de la configuracion no cumple su esquema de validacion. | `ConfigValidationError` lanzado en `loader.ts` si `GatewayConfigSchema.safeParse()` falla. | Bloqueante |
| CFG-04 | Si una variable de entorno referenciada con `${VAR}` no esta definida, el arranque se detiene. | `MissingEnvVarError` lanzado en `interpolateEnvVars()`. | Bloqueante |
| CFG-05 | Debe existir al menos una ruta configurada. | Validacion Zod: `z.array(RouteConfigSchema).min(1)`. | Bloqueante |
| CFG-06 | Los prefijos de ruta deben comenzar con `/` y no terminar en `/` (excepto la ruta raiz). | Validaciones `.refine()` en `RouteConfigSchema`. | Bloqueante |
| CFG-07 | Los targets de backend deben ser URLs validas con protocolo `http://` o `https://`. | Validacion `.url()` y `.refine()` en `RouteConfigSchema`. | Bloqueante |
| CFG-08 | La configuracion es inmutable una vez cargada. Ningun modulo puede modificarla en tiempo de ejecucion. | `deepFreeze()` recursivo aplicado al objeto retornado por `loadConfig()`. | Alta |

---

## Reglas de Conexion a Redis

| ID | Regla Operativa | Implementacion Tecnica | Criticidad |
| :--- | :--- | :--- | :--- |
| RDS-01 | El Gateway intentara conectarse a Redis hasta 3 veces antes de abortar el arranque. | Bucle `for` con 3 iteraciones en `bootstrap()`. | Bloqueante |
| RDS-02 | Cada intento de conexion tiene un timeout maximo de 2 segundos. | Opcion `connectTimeout: 2000` en el constructor de `ioredis`. | Alta |
| RDS-03 | Entre cada reintento de conexion se espera 1 segundo. | `setTimeout(resolve, 1000)` entre iteraciones. | Alta |
| RDS-04 | Si Redis cae durante la operacion y `onFailure` es `"open"`, las peticiones no se bloquean. | El middleware de Rate Limiting omite la verificacion cuando el store no responde. | Alta |

---

## Reglas de Autenticacion JWT

| ID | Regla Operativa | Implementacion Tecnica | Criticidad |
| :--- | :--- | :--- | :--- |
| JWT-01 | Solo las rutas con `jwt.enabled: true` exigen autenticacion. Las demas son publicas. | Condicion `if (!jwtConfig \|\| jwtConfig.enabled === false) return;` en `JwtAuthPlugin.onRequest()`. | Alta |
| JWT-02 | El token debe enviarse en el header `Authorization` con el esquema `Bearer <token>`. | `extractBearerToken()` valida el formato. Si falta o es incorrecto, retorna 401. | Alta |
| JWT-03 | Cualquier header entrante que comience con `x-jwt-claim-` se elimina antes de la verificacion. | `sanitizeClaimHeaders()` borra headers potencialmente falsificados. | Critica |
| JWT-04 | Solo se inyectan al backend claims de tipo escalar (string, number, boolean). | Condicion `typeof value` en `injectClaimHeaders()`. Valores complejos se descartan. | Alta |
| JWT-05 | Un token expirado o con firma invalida genera una respuesta 401 inmediata sin reenvio al backend. | `jwtVerify()` lanza excepcion capturada en `onRequest()`. | Alta |

---

## Reglas de Rate Limiting

| ID | Regla Operativa | Implementacion Tecnica | Criticidad |
| :--- | :--- | :--- | :--- |
| RL-01 | El limite de peticiones se evalua por direccion IP del cliente. | La clave de Redis combina el prefijo de la ruta con la IP obtenida de `x-forwarded-for`, `x-real-ip` o el socket remoto. | Alta |
| RL-02 | Si una IP excede `maxRequests` dentro de `windowSeconds`, recibe un error 429. | El store retorna el conteo actual. Si supera el maximo, el plugin envia `RateLimitError`. | Alta |
| RL-03 | Solo las rutas con `rateLimit` definido son limitadas. Las demas permiten trafico ilimitado. | El plugin verifica la existencia de la configuracion antes de evaluar. | Media |

---

## Reglas de Circuit Breaker

| ID | Regla Operativa | Implementacion Tecnica | Criticidad |
| :--- | :--- | :--- | :--- |
| CB-01 | Cada ruta tiene un circuito independiente. El fallo de un backend no afecta a otros. | `CircuitBreakerRegistry` crea instancias de `CircuitStateMachine` por prefijo. | Alta |
| CB-02 | El circuito se abre si el porcentaje de errores en la ventana supera el `errorThreshold`. | `checkErrorThreshold()` calcula `(failureCount / requestsInWindow) * 100`. | Alta |
| CB-03 | El circuito se abre inmediatamente tras 5 fallos consecutivos, sin importar el tamaño de la ventana. | Condicion `consecutiveFailures >= 5` en `recordFailure()`. | Alta |
| CB-04 | Cuando el circuito esta abierto, todas las peticiones reciben un error 503 inmediato. | `canExecute()` retorna `false`, el plugin responde sin intentar la conexion al backend. | Alta |
| CB-05 | Tras el periodo de recuperacion (`recoveryTimeMs`), el circuito pasa a Half-Open y permite peticiones de prueba. | `canExecute()` evalua si `elapsed >= recoveryTimeMs` y transiciona a `HALF_OPEN`. | Alta |
| CB-06 | Si todas las peticiones de prueba en Half-Open son exitosas, el circuito se cierra. | `recordSuccess()` cuenta exitos y compara con `halfOpenRequests`. | Alta |
| CB-07 | Si alguna peticion de prueba en Half-Open falla, el circuito se reabre inmediatamente. | `recordFailure()` en estado `HALF_OPEN` transiciona a `OPEN`. | Alta |
| CB-08 | Las peticiones fallidas se reintentan automaticamente con backoff exponencial. | El modulo `retry.ts` calcula delays con formula exponencial limitada por `retryMaxDelayMs`. | Media |

---

## Reglas de Proxy y Enrutamiento

| ID | Regla Operativa | Implementacion Tecnica | Criticidad |
| :--- | :--- | :--- | :--- |
| PXY-01 | Las rutas se registran de mayor a menor longitud de prefijo para evitar colisiones. | `sortedRoutes` ordena por `b.prefix.length - a.prefix.length` en `server.ts`. | Alta |
| PXY-02 | Si `stripPrefix` es `true`, el prefijo de la ruta se elimina antes de reenviar al backend. | `targetPath = targetPath.slice(route.prefix.length)` en `ProxyEngine.forward()`. | Alta |
| PXY-03 | Si ninguna ruta coincide con la URL solicitada, se retorna un error 404 con mensaje descriptivo. | El handler de proxy verifica `gatewayContext?.routeMatch` y envia 404 si es nulo. | Media |

---

## Reglas de Recarga en Caliente

| ID | Regla Operativa | Implementacion Tecnica | Criticidad |
| :--- | :--- | :--- | :--- |
| RLD-01 | No se pueden procesar dos recargas simultaneamente. | Mutex logico `isReloading` en `ConfigReloader`. | Alta |
| RLD-02 | Si la nueva configuracion es invalida, se conserva la anterior sin interrumpir el servicio. | `try/catch` en `reload()` mantiene `snapshotRef.current` intacto ante excepciones. | Critica |
| RLD-03 | El intercambio de configuracion es atomico: se construye un snapshot completo antes de asignarlo. | `newSnapshot` se construye completamente antes de `snapshotRef.current = newSnapshot`. | Alta |
