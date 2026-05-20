# 🚀 API Gateway HTTP Modular, Standalone y Configurable (MVP)

Un API Gateway robusto, modular, configurable e inmutable desarrollado en **TypeScript** con **Fastify**, diseñado para funcionar como proxy inverso y orquestador de middlewares de alto rendimiento en arquitecturas de microservicios y aplicaciones web modernas.

---

## 📦 Características Principales

* **Proxy Inverso Dinámico**: Configuración flexible por prefijos de enrutamiento con soporte para reescritura de rutas (`stripPrefix`), timeouts específicos de conexión y respuesta, e inyección de cabeceras de forwarding estándar (`X-Forwarded-*`).
* **Rate Limiting Distribuido**: Algoritmo *Fixed Window Counter* atómico implementado sobre **Redis** (usando pipelines optimizados) para restringir peticiones por IP, con soporte para comportamientos configurables ante caídas del caché (*fail-open* / *fail-closed*).
* **Priorización de Enrutamiento en Cascada**: Resolución inteligente de coincidencia de rutas (Rutas específicas/Overrides > Prefijo más largo > Prefijo general).
* **Configuración Declarativa Inmutable**: Lector de archivos YAML/JSON con validación estricta de esquemas mediante **Zod** y soporte para interpolación segura de variables de entorno (`${ENV_VAR}`).
* **Registro de Logs Estructurados**: Integración nativa de **Pino** con serializadores de peticiones, respuestas y errores redactando automáticamente información sensible (tokens `Authorization`, cookies, etc.).
* **Arquitectura de Plugins**: Pipeline extensible en cascada con hooks `onRequest` y `onResponse` de ejecución secuencial y capacidad de cortocircuito (*short-circuit*).
* **Despliegue Contenerizado**: Optimizado mediante una compilación Docker *multi-stage* ultra-ligera (basada en `node:20-alpine`) e instrumentado con chequeos de salud (`HEALTHCHECK`) nativos de red.

---

## 🛠️ Requisitos Previos

Antes de arrancar, asegúrate de contar con:
* **Node.js** v20 LTS o superior.
* **pnpm** v9 o superior (gestor de paquetes exclusivo del proyecto).
* **Redis** v7 o superior (local o en un contenedor Docker).

---

## ⚡ Quick Start (Arranque Rápido en 5 Minutos)

La forma más rápida de probar el Gateway y comprender su flujo es levantando el entorno preconfigurado mediante **Docker Compose**:

### 1. Clonar el repositorio y acceder
```bash
git clone https://github.com/tu-usuario/gateway.git
cd gateway
```

### 2. Crear los archivos de configuración iniciales
Crea un archivo local `docker/gateway.yaml` para indicarle al Gateway cómo enrutar las peticiones:

```yaml
server:
  port: 3000
  host: 0.0.0.0

redis:
  url: redis://redis-cache:6379
  onFailure: open

logging:
  level: info

routes:
  # Enrutará peticiones desde http://localhost:3000/api/* hacia el Backend Mock
  - prefix: /api
    target: http://mock-backend:8080
    stripPrefix: true
    rateLimit:
      maxRequests: 5
      windowSeconds: 60
```

### 3. Levantar la infraestructura
Ejecuta Docker Compose apuntando al entorno de ejemplo:
```bash
docker compose -f docker/docker-compose.example.yml up --build
```

Esto iniciará:
1. El **API Gateway** en el puerto `3000`.
2. Una instancia limpia de **Redis** en el puerto interno `6379`.
3. Un **Backend Mock** de pruebas corriendo internamente en el puerto `8080`.

### 4. Probar el enrutamiento y el Rate Limiting
Realiza peticiones HTTP usando `curl` para verificar el comportamiento:

```bash
# 1. Petición exitosa al backend mock a través del Gateway
curl -i http://localhost:3000/api/users

# Deberías recibir cabeceras informativas de Rate Limiting en la respuesta:
# X-RateLimit-Limit: 5
# X-RateLimit-Remaining: 4
# X-RateLimit-Reset: 1716300000
```

Si realizas más de **5 peticiones** en menos de un minuto desde la misma IP, el Gateway cortocircuitará la petición y te devolverá un estado estructurado **429 (Too Many Requests)**:
```bash
curl -i http://localhost:3000/api/users

# HTTP/1.1 429 Too Many Requests
# Retry-After: 48
# Content-Type: application/json
#
# {
#   "error": "Too Many Requests",
#   "message": "Límite de peticiones excedido. Inténtalo de nuevo en 48 segundos.",
#   "retryAfter": 48
# }
```

---

## ⚙️ Configuración Declarativa (`gateway.yaml`)

El archivo de configuración principal se valida estrictamente con **Zod** al arrancar. A continuación se detallan todas las propiedades disponibles:

```yaml
# ===============================================================
# Configuración del Servidor Fastify Core
# ===============================================================
server:
  port: 3000       # Puerto TCP en el que escuchará el Gateway (Por defecto: 3000)
  host: 0.0.0.0    # Host en el que escuchará (0.0.0.0 acepta tráfico externo)

# ===============================================================
# Configuración de Conexión a Redis
# ===============================================================
redis:
  url: ${REDIS_URL}       # URL de conexión (Soporta interpolación de variables de entorno)
  onFailure: open         # Comportamiento ante fallos de Redis:
                          #   - 'open': Deja pasar el request sin rate-limit (fail-open)
                          #   - 'closed': Bloquea el tráfico con HTTP 503 (fail-closed)

# ===============================================================
# Configuración de Logs Estructurados
# ===============================================================
logging:
  level: info             # Nivel mínimo de log (debug | info | warn | error)

# ===============================================================
# Rutas del API Gateway (Microservicios Destino)
# ===============================================================
routes:
  - prefix: /api          # Prefijo de la ruta entrante (Debe comenzar con "/" y no terminar en "/")
    target: http://users-service:8081  # URL destino del microservicio
    stripPrefix: true     # Si es true, elimina '/api' al reenviar al microservicio
    rateLimit:            # Opcional. Reglas de Rate Limiting para esta ruta
      maxRequests: 100
      windowSeconds: 60
    timeout:              # Opcional. Control de tiempos de espera para evitar bloqueos
      connect: 2000       # Timeout de establecimiento de conexión en milisegundos
      response: 5000      # Timeout máximo para recibir respuesta del backend en milisegundos

  - prefix: /auth
    target: http://auth-service:8082
    stripPrefix: false

# ===============================================================
# Overrides específicos (Excepciones a nivel de endpoint exacto)
# ===============================================================
overrides:
  - path: /api/login      # Path exacto que sobreescribirá la política de su ruta padre (/api)
    rateLimit:
      maxRequests: 5      # Aplica un límite mucho más restrictivo para evitar ataques de fuerza bruta
      windowSeconds: 60
```

### 💡 Interpolación de Variables de Entorno
Cualquier campo del archivo YAML puede contener expresiones del tipo `${NOMBRE_VARIABLE}`. El Gateway las reemplazará automáticamente en tiempo de arranque utilizando los valores de `process.env`. Si una variable requerida en el YAML no está definida en el entorno, el Gateway **fallará rápido** lanzando una excepción `MissingEnvVarError` para evitar arranques inconsistentes.

---

## 🔌 Extensibilidad: Crear Plugins Personalizados

El orquestador de middlewares funciona mediante un pipeline secuencial basado en la interfaz `GatewayPlugin`. Puedes crear tus propios middlewares implementando los ganchos `onRequest` y/o `onResponse`.

### Interfaz del Plugin
Las interfaces se encuentran definidas en [src/middleware/pipeline.ts](file:///d:/desarrollo/Gateway/src/middleware/pipeline.ts):

```typescript
export interface RequestContext {
  request: FastifyRequest;
  reply: FastifyReply;
  routeMatch: RouteMatch;
}

export interface ResponseContext {
  request: FastifyRequest;
  reply: FastifyReply;
  routeMatch: RouteMatch;
  payload: unknown;
}

export interface GatewayPlugin {
  name: string;
  onRequest?(context: RequestContext): Promise<void>;
  onResponse?(context: ResponseContext): Promise<void>;
}
```

### Ejemplo Práctico: Plugin de Telemetría (Medición de Tiempos)
A continuación se muestra un ejemplo de un plugin que calcula el tiempo de respuesta de las peticiones que pasan por el Gateway:

```typescript
// src/middleware/telemetry-plugin.ts
import { GatewayPlugin, RequestContext, ResponseContext } from './pipeline.js';
import { Logger } from 'pino';

export class TelemetryPlugin implements GatewayPlugin {
  public readonly name = 'telemetry';
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // Hook ejecutado ANTES de enviar la petición al microservicio
  public async onRequest(ctx: RequestContext): Promise<void> {
    // Almacenar el timestamp de inicio en el objeto request de Fastify
    (ctx.request as any).startTime = Date.now();
  }

  // Hook ejecutado DESPUÉS de recibir la respuesta del microservicio
  public async onResponse(ctx: ResponseContext): Promise<void> {
    const startTime = (ctx.request as any).startTime;
    if (startTime) {
      const durationMs = Date.now() - startTime;
      this.logger.info({
        path: ctx.routeMatch.route.prefix,
        url: ctx.request.url,
        durationMs,
        statusCode: ctx.reply.statusCode
      }, `Petición procesada en ${durationMs}ms`);
    }
  }
}
```

### Registrar el Plugin en el Bootstrap
Una vez creado tu plugin, inyéctalo en la matriz de inicialización de la Middleware Pipeline en [src/index.ts](file:///d:/desarrollo/Gateway/src/index.ts):

```typescript
// Dentro de bootstrap() en src/index.ts:
const telemetryPlugin = new TelemetryPlugin(logger);
const pipeline = new MiddlewarePipeline([
  rateLimitPlugin,
  telemetryPlugin // Se ejecutará secuencialmente después del rate limiter
]);
```

*Nota: Si un plugin responde la petición directamente llamando a `reply.send()` en su gancho `onRequest`, la ejecución de los siguientes middlewares y el reenvío al proxy inverso se **cancelarán automáticamente** (Short-circuit).*

---

## 🐳 Comandos de Desarrollo y Docker

El proyecto utiliza **pnpm** de forma mandatoria. A continuación se listan los comandos principales disponibles:

### Desarrollo Local
```bash
# Instalar dependencias
pnpm install

# Levantar el servidor en modo desarrollo (con recarga en caliente)
pnpm dev

# Formatear el código con Prettier
pnpm format

# Ejecutar el analizador de código estático (ESLint)
pnpm lint
```

### Compilación y Construcción
```bash
# Compilar TypeScript a JavaScript de producción
pnpm build

# Levantar el Gateway compilado en producción
pnpm start
```

### Ejecutar Pruebas
```bash
# Ejecutar todas las suites de prueba (unitarias e integradas)
pnpm test

# Ejecutar pruebas y generar reporte de cobertura
pnpm test:coverage
```

### Docker
```bash
# Construir la imagen Docker optimizada de producción
pnpm docker:build
```

---

## 🔒 Seguridad e Integridad de Datos

* **Ocultación de Errores Internos**: El manejador de errores global intercepta cualquier error crítico en producción (estados `5xx`) y retorna una estructura JSON limpia sin exponer trazas de pila (*stack traces*), dependencias caídas, IPs o puertos de backends internos.
* **Logs Limpios**: Las cabeceras `Authorization` y `Cookie` de las peticiones son automáticamente reemplazadas por el string `[REDACTED]` por el logger Pino antes de ser escritas en stdout para asegurar que ninguna credencial se guarde en disco.

---

## 📄 Licencia

Este proyecto está bajo la Licencia **MIT**. Consulte el archivo `LICENSE` para obtener más información.
