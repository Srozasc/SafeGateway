# Plan de Acción — Gateway HTTP Modular Reutilizable (MVP)

---

## Tarea 1 — Inicialización del Proyecto

### Paso 1. Configuración del Entorno y Estructura Base

#### Explicación técnica
Establecer el repositorio del proyecto con la estructura de carpetas definida en la especificación, configurar TypeScript, ESLint, Prettier y el gestor de paquetes `pnpm`. Este paso es el fundamento sobre el cual se construye todo lo demás.

##### Desglose de Tareas

###### Inicializar repositorio Git
* Inicializar git en el directorio raíz del proyecto
* `.gitignore`
* Crear (Crear)

###### Inicializar proyecto con pnpm
* Crear el `package.json` inicial del proyecto con nombre, versión y scripts base
* `package.json`
* Crear (Crear)

###### Instalar dependencias de producción
* Instalar: `fastify`, `@fastify/http-proxy`, `js-yaml`, `zod`, `ioredis`, `pino`, `uuid`
* `package.json`, `pnpm-lock.yaml`
* Actualizar (Actualizar)

###### Instalar dependencias de desarrollo
* Instalar: `typescript`, `@types/node`, `@types/js-yaml`, `ts-node`, `tsx`, `jest`, `ts-jest`, `@types/jest`, `eslint`, `prettier`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`
* `package.json`, `pnpm-lock.yaml`
* Actualizar (Actualizar)

###### Configurar TypeScript
* Crear `tsconfig.json` con `strict: true`, `target: ES2022`, `module: NodeNext`, `outDir: dist`, `rootDir: src`
* Crear `tsconfig.build.json` que extiende `tsconfig.json` y excluye `tests/`
* `tsconfig.json`
* Crear (Crear)
* `tsconfig.build.json`
* Crear (Crear)

###### Configurar ESLint y Prettier
* Crear `.eslintrc.json` con reglas TypeScript estrictas
* Crear `.prettierrc` con configuración de formato (2 espacios, single quotes, trailing commas)
* `.eslintrc.json`
* Crear (Crear)
* `.prettierrc`
* Crear (Crear)

###### Configurar Jest
* Crear `jest.config.ts` configurado para TypeScript via `ts-jest`
* Definir `testMatch` para `tests/**/*.test.ts`
* `jest.config.ts`
* Crear (Crear)

###### Crear estructura de carpetas
* Crear todos los directorios definidos en la especificación: `src/config/`, `src/routing/`, `src/middleware/rate-limit/`, `src/proxy/`, `src/logger/`, `src/errors/`, `config/`, `tests/unit/`, `tests/integration/`, `tests/helpers/`, `docker/`
* _(directorios — sin archivos aún)_
* Crear (Crear)

###### Configurar scripts npm en package.json
* `"dev"`: `tsx watch src/index.ts`
* `"build"`: `tsc -p tsconfig.build.json`
* `"start"`: `node dist/index.js`
* `"test"`: `jest`
* `"test:watch"`: `jest --watch`
* `"test:coverage"`: `jest --coverage`
* `"lint"`: `eslint src/ tests/`
* `"format"`: `prettier --write src/ tests/`
* `package.json`
* Actualizar (Actualizar)

#### Otros Comentarios del Paso 1
* **Acción manual requerida:** Instalar `pnpm` globalmente si no está instalado: `npm install -g pnpm` (única vez con npm permitida para instalar pnpm)
* **Acción manual requerida:** Instalar `Node.js 20 LTS` si no está disponible
* **Acción manual requerida:** Instalar `Redis 7+` localmente o tener Docker disponible para los tests de integración

---

## Tarea 2 — Módulo de Configuración

### Paso 2. Implementar Config Types, Schema y Loader

#### Explicación técnica
Construir el sistema completo de configuración: tipos TypeScript, schema de validación Zod, y el loader que lee el YAML, interpola variables de entorno y valida el resultado. Es el primer módulo funcional porque todos los demás dependen de él.

##### Desglose de Tareas

###### Definir tipos TypeScript de configuración
* Crear interfaces: `ServerConfig`, `RedisConfig`, `LoggingConfig`, `RateLimitConfig`, `RouteConfig`, `OverrideConfig`, `GatewayConfig`
* `src/config/types.ts`
* Crear (Crear)

###### Definir schema Zod de validación
* Crear `GatewayConfigSchema` con todas las reglas de validación especificadas
* Incluir valores por defecto para campos opcionales (port: 3000, host: "0.0.0.0", level: "info")
* `src/config/schema.ts`
* Crear (Crear)

###### Implementar interpolación de variables de entorno
* Función `interpolateEnvVars(raw: string): string`
* Regex `/\$\{([^}]+)\}/g` sobre el string raw
* Lanzar `MissingEnvVarError` con nombre de variable si no existe en `process.env`
* `src/config/loader.ts`
* Crear (Crear)

###### Implementar parseador YAML
* Función `parseYaml(interpolated: string): unknown` usando `js-yaml`
* Try/catch con `ConfigParseError`
* `src/config/loader.ts`
* Actualizar (Actualizar)

###### Implementar validador de configuración
* Función `validateConfig(raw: unknown): GatewayConfig` usando el schema Zod
* Formatear errores Zod en mensajes legibles
* `src/config/loader.ts`
* Actualizar (Actualizar)

###### Implementar función principal loadConfig
* Función `loadConfig(configPath?: string): Readonly<GatewayConfig>`
* Orquestar: leer archivo → interpolar → parsear → validar → congelar
* Usar `CONFIG_PATH` de env vars con fallback a `./config/gateway.yaml`
* `src/config/loader.ts`
* Actualizar (Actualizar)

###### Crear archivo de configuración de ejemplo
* Documentar con comentarios cada campo disponible
* Incluir ejemplos de múltiples rutas, overrides y variables de entorno
* `config/gateway.example.yaml`
* Crear (Crear)

###### Escribir tests unitarios del Config Loader
* Test: carga exitosa con YAML válido
* Test: error con archivo no encontrado
* Test: error con YAML con sintaxis inválida
* Test: error con schema inválido (campo requerido faltante)
* Test: interpolación correcta de variables de entorno
* Test: error con variable de entorno faltante
* Test: valores por defecto aplicados correctamente
* `tests/unit/config/loader.test.ts`
* Crear (Crear)

#### Otros Comentarios del Paso 2
* Los tests deben pasar ANTES de continuar al paso 3
* Ejecutar: `pnpm test tests/unit/config/`

---

## Tarea 3 — Módulo de Routing

### Paso 3. Implementar Route Registry y Matcher

#### Explicación técnica
Construir el sistema de resolución de rutas que determina, para cada URL entrante, qué configuración de ruta aplica. Incluye la lógica de prioridad (override exacto > prefijo más largo) y la construcción eficiente del registro al startup.

##### Desglose de Tareas

###### Definir tipos del módulo de routing
* Interfaces: `RouteMatch`, tipos de resultado de matching
* `src/routing/types.ts`
* Crear (Crear)

###### Implementar RouteRegistry
* Clase `RouteRegistry` con constructor que recibe `GatewayConfig`
* Ordenar rutas por longitud de prefix descendente en el constructor
* Construir `Map<string, OverrideConfig>` para lookup O(1) de overrides
* `src/routing/registry.ts`
* Crear (Crear)

###### Implementar método match()
* Método `match(url: string): RouteMatch | null`
* Extraer path sin query string
* Buscar override exacto primero
* Buscar ruta con prefijo más largo coincidente
* Calcular `effectiveRateLimit` según prioridad (override > ruta > null)
* `src/routing/matcher.ts`
* Crear (Crear)

###### Escribir tests unitarios del Route Matcher
* Test: match exacto de prefijo raíz
* Test: match de path anidado dentro de prefijo
* Test: override exacto tiene prioridad sobre prefijo
* Test: prefijo más largo tiene prioridad sobre prefijo general
* Test: retorna null para URL sin match
* Test: ignora query string en el matching
* Test: ruta sin rateLimit retorna effectiveRateLimit null
* Test: override sobreescribe rateLimit de la ruta
* `tests/unit/routing/matcher.test.ts`
* Crear (Crear)

#### Otros Comentarios del Paso 3
* Los tests deben pasar ANTES de continuar al paso 4
* Ejecutar: `pnpm test tests/unit/routing/`

---

## Tarea 4 — Sistema de Logging

### Paso 4. Configurar Logger con Pino

#### Explicación técnica
Configurar el logger pino con serializers custom, redacción de campos sensibles y formato JSON estructurado. El logger debe inicializarse antes que cualquier otro módulo para capturar errores de startup.

##### Desglose de Tareas

###### Definir tipos del módulo de logger
* Type `LogLevel = "debug" | "info" | "warn" | "error"`
* `src/logger/types.ts`
* Crear (Crear)

###### Implementar función createLogger
* Función `createLogger(level: LogLevel): pino.Logger`
* Configurar `timestamp: pino.stdTimeFunctions.isoTime`
* Serializer de request: method, url, remoteAddress, userAgent
* Serializer de response: statusCode
* Redactar `req.headers.authorization` y `req.headers.cookie` como `[REDACTED]`
* `src/logger/setup.ts`
* Crear (Crear)

###### Implementar serializers adicionales
* Serializer de error: message, type (constructor.name), stack (solo en non-production)
* `src/logger/serializers.ts`
* Crear (Crear)

#### Otros Comentarios del Paso 4
* Pino es el logger nativo de Fastify — la instancia creada se pasa directamente al constructor de Fastify

---

## Tarea 5 — Módulo de Rate Limiting

### Paso 5. Implementar Rate Limit Plugin

#### Explicación técnica
Construir el plugin de rate limiting con Redis como store distribuido. Implementar el algoritmo Fixed Window Counter con operaciones atómicas Redis (pipeline INCR + EXPIRE). Manejar el fallo de Redis según configuración (fail-open / fail-closed).

##### Desglose de Tareas

###### Definir tipos del módulo de rate limiting
* Interfaces: `RateLimitResult`, `RateLimitStore`
* `src/middleware/rate-limit/types.ts`
* Crear (Crear)

###### Implementar abstracción del store Redis
* Clase `RedisRateLimitStore` que implementa `RateLimitStore`
* Método `increment(key: string, windowSeconds: number): Promise<number>`
* Usar pipeline Redis: INCR + EXPIRE atómicos
* `src/middleware/rate-limit/store.ts`
* Crear (Crear)

###### Implementar lógica de ventana temporal
* Función `getCurrentWindow(windowSeconds: number): { windowStart: number, resetAt: number }`
* `windowStart = floor(now / windowSeconds) * windowSeconds`
* `src/middleware/rate-limit/window.ts`
* Crear (Crear)

###### Implementar función de construcción de clave Redis
* Función `buildKey(ip: string, prefix: string, windowStart: number): string`
* Formato: `ratelimit:{ip}:{prefix}:{windowStart}`
* `src/middleware/rate-limit/window.ts`
* Actualizar (Actualizar)

###### Implementar extracción de IP de origen
* Función `extractClientIp(request: FastifyRequest): string`
* Leer `X-Forwarded-For` → tomar primer IP de la lista
* Fallback: `request.ip`
* Fallback final: `"unknown"`
* `src/middleware/rate-limit/plugin.ts`
* Crear (Crear)

###### Implementar clase RateLimitPlugin
* Clase `RateLimitPlugin` que implementa `GatewayPlugin`
* Método `onRequest(ctx: RequestContext): Promise<void>`
* Lógica completa: no-op si no hay rateLimit → calcular clave → ejecutar INCR → evaluar límite → setear headers → enviar 429 si excedido
* Manejo de error Redis con comportamiento configurable
* `src/middleware/rate-limit/plugin.ts`
* Actualizar (Actualizar)

###### Implementar helpers de headers de respuesta
* Función `setRateLimitHeaders(reply, limit, count, resetAt)`
* Función `buildRateLimitErrorBody(resetAt: number)`
* `src/middleware/rate-limit/plugin.ts`
* Actualizar (Actualizar)

###### Crear mock de Redis para tests unitarios
* Clase `MockRedisStore` que simula comportamiento de Redis en memoria
* `tests/helpers/redis-mock.ts`
* Crear (Crear)

###### Escribir tests unitarios del Rate Limit Plugin
* Test: no-op cuando effectiveRateLimit es null
* Test: permite request cuando counter < maxRequests
* Test: bloquea con 429 cuando counter > maxRequests
* Test: headers X-RateLimit-* correctos en respuesta permitida
* Test: headers Retry-After correcto en respuesta 429
* Test: fail-open cuando Redis falla
* Test: fail-closed cuando Redis falla y está configurado
* Test: clave Redis construida correctamente con IP, prefix y window
* `tests/unit/middleware/rate-limit/plugin.test.ts`
* Crear (Crear)

#### Otros Comentarios del Paso 5
* Los tests deben pasar ANTES de continuar al paso 6
* Ejecutar: `pnpm test tests/unit/middleware/`

---

## Tarea 6 — Middleware Pipeline

### Paso 6. Implementar Pipeline Orchestrator

#### Explicación técnica
Construir el orquestador del pipeline de middlewares. Define el contrato `GatewayPlugin` y ejecuta los plugins secuencialmente, respetando el short-circuit cuando un plugin envía una respuesta.

##### Desglose de Tareas

###### Definir interfaz GatewayPlugin
* Interfaz `GatewayPlugin`, `RequestContext`, `ResponseContext`
* `src/middleware/pipeline.ts`
* Crear (Crear)

###### Implementar clase MiddlewarePipeline
* Clase `MiddlewarePipeline` con constructor `(plugins: GatewayPlugin[])`
* Método `executeOnRequest(ctx: RequestContext): Promise<void>`
* Loop secuencial de plugins con detección de short-circuit (`reply.sent`)
* `src/middleware/pipeline.ts`
* Actualizar (Actualizar)

###### Generar método preHandler compatible con Fastify
* Método `preHandler` como arrow function Fastify-compatible
* Construye `RequestContext` desde el `RouteMatch` almacenado en el request
* `src/middleware/pipeline.ts`
* Actualizar (Actualizar)

#### Otros Comentarios del Paso 6
* El `RouteMatch` debe almacenarse en `request.routeContext` (extensión del tipo FastifyRequest via declaration merging)

---

## Tarea 7 — Módulo de Errores

### Paso 7. Implementar Error Handler Global

#### Explicación técnica
Registrar el handler global de errores en Fastify para garantizar que todos los errores no capturados se retornen en formato JSON estándar, sin filtrar información interna.

##### Desglose de Tareas

###### Definir clases de error custom
* Clases: `GatewayError`, `ConfigError`, `RouteNotFoundError`, `BackendError`, `RateLimitError`
* Todas extienden `Error` con `statusCode: number`
* `src/errors/types.ts`
* Crear (Crear)

###### Implementar función buildErrorResponse
* Función `buildErrorResponse(error, requestId, timestamp): ErrorResponse`
* Mapear `statusCode` a texto HTTP estándar
* No incluir stack traces en producción
* `src/errors/responses.ts`
* Crear (Crear)

###### Implementar error handler Fastify
* Función `registerErrorHandler(fastify: FastifyInstance): void`
* Manejar: errores de validación Fastify (400), not found (404), errores custom (statusCode del error), errores genéricos (500)
* Loguear errores 5xx con `logger.error`, errores 4xx con `logger.warn`
* `src/errors/handler.ts`
* Crear (Crear)

#### Otros Comentarios del Paso 7
* El handler de 404 debe registrarse con `fastify.setNotFoundHandler()` además del error handler

---

## Tarea 8 — Proxy Engine y Server Core

### Paso 8. Implementar Proxy Engine y Server Builder

#### Explicación técnica
Construir el servidor Fastify completo, registrar los plugins de proxy para cada ruta configurada, y conectar el pipeline de middlewares. Este paso integra todos los módulos anteriores en un sistema funcional.

##### Desglose de Tareas

###### Definir tipos del módulo proxy
* Interfaces de configuración del proxy, opciones de forwarding
* `src/proxy/types.ts`
* Crear (Crear)

###### Implementar lógica de reescritura de headers
* Función `buildForwardingHeaders(request: FastifyRequest): Record<string, string>`
* Construir headers: X-Forwarded-For, X-Forwarded-Host, X-Forwarded-Proto, X-Real-IP
* `src/proxy/headers.ts`
* Crear (Crear)

###### Implementar función buildServer
* Función `buildServer(config: GatewayConfig, pipeline: MiddlewarePipeline, logger: pino.Logger): FastifyInstance`
* Crear instancia Fastify con logger proporcionado
* Registrar error handler
* Registrar not found handler
* Almacenar RouteRegistry en el contexto del servidor
* Agregar hook `onRequest` para ejecutar route matching y almacenar resultado en request
* `src/server.ts`
* Crear (Crear)

###### Implementar registro de rutas del proxy
* Función `registerProxyRoutes(fastify, config, pipeline, registry)`
* Para cada ruta en `config.routes`: registrar `@fastify/http-proxy` con:
  - `upstream`: target de la ruta
  - `prefix`: prefix de la ruta
  - `rewritePrefix`: según `stripPrefix` config
  - `preHandler`: `pipeline.preHandler`
  - `replyOptions.rewriteRequestHeaders`: agregar forwarding headers
* `src/server.ts`
* Actualizar (Actualizar)

###### Escribir mock de backend para tests de integración
* Servidor HTTP minimal que registra requests recibidos y retorna respuestas configurables
* `tests/helpers/mock-backend.ts`
* Crear (Crear)

###### Escribir tests de integración del proxy
* Test: request GET es reenviado al backend correctamente
* Test: response del backend llega al cliente sin modificaciones
* Test: headers de forwarding (X-Forwarded-For, etc.) están presentes en el request al backend
* Test: request a URL sin ruta configurada retorna 404
* Test: método POST con body es reenviado correctamente
* Test: timeout del backend retorna 502
* `tests/integration/proxy.test.ts`
* Crear (Crear)

###### Escribir tests de integración de rate limiting
* Test: requests bajo el límite son procesados
* Test: request que excede el límite recibe 429
* Test: override de ruta aplica límite más restrictivo
* Test: contadores son por IP (diferentes IPs tienen contadores separados)
* `tests/integration/rate-limit.test.ts`
* Crear (Crear)

#### Otros Comentarios del Paso 8
* Los tests de integración requieren Redis corriendo localmente o vía Docker
* **Acción manual requerida:** Iniciar Redis antes de ejecutar tests de integración: `docker run -p 6379:6379 redis:7-alpine`

---

## Tarea 9 — Entry Point y Bootstrap

### Paso 9. Implementar Entry Point con Startup y Shutdown Graceful

#### Explicación técnica
Implementar el punto de entrada que orquesta el arranque completo del sistema en el orden correcto y maneja las señales del sistema operativo para un shutdown limpio.

##### Desglose de Tareas

###### Implementar función bootstrap
* Función `async function bootstrap(): Promise<void>`
* Secuencia de arranque completa según especificación (10 pasos)
* Incluir reintentos de conexión Redis (3 intentos, 1 segundo entre intentos)
* Loguear cada etapa del arranque
* `src/index.ts`
* Crear (Crear)

###### Implementar shutdown graceful
* Registrar handlers para `SIGTERM` y `SIGINT`
* `fastify.close()` → `redis.disconnect()` → `process.exit(0)`
* `src/index.ts`
* Actualizar (Actualizar)

###### Implementar manejo de errores de startup
* Envolver `bootstrap()` en try/catch
* En error: loguear con `logger.fatal()` y llamar `process.exit(1)`
* `src/index.ts`
* Actualizar (Actualizar)

###### Crear archivo de variables de entorno de ejemplo
* Documentar todas las variables de entorno disponibles con valores de ejemplo
* `.env.example`
* Crear (Crear)

#### Otros Comentarios del Paso 9
* El proceso debe fallar rápido y claro si Redis no está disponible después de los reintentos

---

## Tarea 10 — Contenerización con Docker

### Paso 10. Crear Dockerfile y Ejemplo de Docker Compose

#### Explicación técnica
Empaquetar el gateway como imagen Docker optimizada con multi-stage build para minimizar el tamaño de la imagen final. Proporcionar un ejemplo de `docker-compose.yml` que los proyectos consumidores puedan adaptar.

##### Desglose de Tareas

###### Crear Dockerfile multi-stage
* Stage 1 (`builder`): instalar dependencias + compilar TypeScript
* Stage 2 (`runtime`): imagen `node:20-alpine`, copiar solo `dist/` y `node_modules` de producción
* Exponer puerto 3000
* `CMD ["node", "dist/index.js"]`
* Agregar `HEALTHCHECK` con curl o wget
* `docker/Dockerfile`
* Crear (Crear)

###### Crear .dockerignore
* Excluir: `node_modules/`, `dist/`, `.env`, `tests/`, `*.md`, `.git/`
* `.dockerignore`
* Crear (Crear)

###### Crear ejemplo de docker-compose para proyectos consumidores
* Servicios: gateway, redis, backend (placeholder)
* Gateway: mapeado a puerto 3000 público, config montada como volumen
* Redis y backend sin puertos públicos (red interna)
* `docker/docker-compose.example.yml`
* Crear (Crear)

###### Crear script de build de imagen
* Script en `package.json`: `"docker:build"`: `docker build -f docker/Dockerfile -t gateway-http:latest .`
* `package.json`
* Actualizar (Actualizar)

#### Otros Comentarios del Paso 10
* **Acción manual requerida:** Docker debe estar instalado en la máquina de desarrollo
* El tag de la imagen debe seguir versionado semántico en producción: `gateway-http:1.0.0`

---

## Tarea 11 — Documentación

### Paso 11. Crear README y Documentación de Uso

#### Explicación técnica
Documentar el gateway para que cualquier desarrollador pueda desplegarlo en su proyecto sin conocer el código fuente. El README es la interfaz pública de la herramienta.

##### Desglose de Tareas

###### Crear README.md principal
* Secciones: descripción, quick start, referencia completa del `gateway.yaml`, variables de entorno, Docker, ejemplos de configuración avanzada, troubleshooting
* `README.md`
* Crear (Crear)

###### Documentar referencia completa del schema de configuración
* Documentar cada campo del `gateway.yaml` con tipo, descripción, valor por defecto y ejemplo
* `README.md`
* Actualizar (Actualizar)

###### Documentar cómo agregar nuevos plugins
* Guía de implementación de la interfaz `GatewayPlugin`
* Ejemplo de plugin minimal con comentarios
* `README.md`
* Actualizar (Actualizar)

#### Otros Comentarios del Paso 11
* La sección de quick start debe permitir poner en marcha el gateway en menos de 5 minutos

---

## Tarea 12 — Validación Final

### Paso 12. Verificación End-to-End y Checklist de Calidad

#### Explicación técnica
Ejecutar el suite completo de tests, verificar el build de producción y realizar una prueba manual end-to-end con un backend real para confirmar que el sistema funciona correctamente.

##### Desglose de Tareas

###### Ejecutar suite completo de tests
* Comando: `pnpm test --coverage`
* Meta: cobertura > 80% en módulos core (config, routing, rate-limit)
* Todos los tests deben pasar
* `tests/`
* Verificar

###### Verificar build de producción
* Comando: `pnpm build`
* Verificar que `dist/` contiene `index.js` sin errores de compilación
* `dist/`
* Verificar

###### Prueba manual end-to-end
* Levantar Redis con Docker
* Iniciar gateway con `gateway.example.yaml` apuntando a un backend real (o httpbin.org)
* Verificar: request forwarding, logs JSON en stdout, rate limiting con curl
* _(ejecución manual)_
* Verificar

###### Verificar build Docker
* Construir imagen: `pnpm docker:build`
* Ejecutar imagen con variables de entorno de prueba
* Verificar healthcheck pasa
* _(ejecución manual)_
* Verificar

###### Checklist de seguridad mínima
* Confirmar que stack traces NO aparecen en respuestas de error en producción
* Confirmar que IPs/puertos internos NO aparecen en respuestas al cliente
* Confirmar que headers `Authorization` y `Cookie` NO aparecen en los logs
* _(revisión de código)_
* Verificar

#### Otros Comentarios del Paso 12
* **Acción manual requerida:** Ejecutar la prueba end-to-end en un entorno con Redis disponible
* Si algún test falla: volver al paso correspondiente y corregir antes de marcar como completo
