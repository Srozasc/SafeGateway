# Arquitectura — Gateway HTTP Modular Reutilizable

## Visión General

Un **API Gateway standalone, agnóstico del stack tecnológico del backend**, diseñado para actuar como única puerta de entrada pública entre frontends y servicios backend. Cada proyecto despliega su propia instancia del gateway, logrando aislamiento, portabilidad y simplicidad operativa. El gateway no contiene lógica de negocio: es exclusivamente infraestructura transversal.

```
Cliente (Browser / Mobile / Third-Party)
           │
           ▼
    ┌─────────────┐
    │   GATEWAY   │  ← Punto de entrada único, IP pública expuesta
    │  (Fastify)  │
    └──────┬──────┘
           │  HTTP/HTTPS interno
           ▼
    ┌─────────────┐
    │   BACKEND   │  ← IP/puerto internos, nunca expuestos
    │ (cualquier  │
    │  lenguaje)  │
    └─────────────┘
```

---

## Funcionalidades de Lanzamiento (MVP)

### 1. Reverse Proxy HTTP

Actúa como intermediario transparente entre el cliente y el backend, ocultando completamente la infraestructura interna. Recibe requests HTTP/HTTPS, los reenvía al backend configurado y retorna la respuesta al cliente sin modificaciones no deseadas.

**Requisitos principales:**
- Recibir y reenviar requests HTTP/HTTPS
- Preservar headers relevantes del request original (método, body, query params)
- Agregar headers de forwarding estándar (`X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`)
- Retornar respuesta del backend al cliente con código y body originales
- Ocultar completamente IP, puerto y hostname del backend
- Soportar backends en cualquier lenguaje/stack (Node.js, Java, Python, Go, .NET, PHP)
- Timeouts configurables para conexión y respuesta

**Tecnología involucrada:**
- **Runtime:** Node.js 20+ LTS
- **Framework HTTP:** Fastify v4
- **Proxy Engine:** `@fastify/http-proxy`
- **Lenguaje:** TypeScript 5

---

### 2. Configuración Declarativa (Config Loader)

Toda la configuración del gateway se define en un archivo YAML externo, sin ninguna ruta o regla hardcodeada en el código. El sistema lee, valida y expone esta configuración al resto de los módulos al iniciar.

**Requisitos principales:**
- Leer configuración desde archivo YAML (ruta configurable vía variable de entorno)
- Validar el esquema de la configuración al startup (fallo rápido si inválida)
- Exponer configuración como objeto tipado a todos los módulos
- Soporte para variables de entorno interpoladas dentro del YAML (`${ENV_VAR}`)
- Errores de configuración deben detener el proceso con mensaje claro
- Configuración inmutable en runtime (no hot-reload en MVP)

**Tecnología involucrada:**
- **Parser YAML:** `js-yaml`
- **Validación de esquema:** `zod`
- **Tipado:** TypeScript interfaces/types

---

### 3. Routing Flexible Basado en Prefijos y Patrones

Sistema de resolución de rutas que mapea URLs entrantes a backends de destino sin necesidad de registrar cada endpoint individualmente. Soporta prefijos, wildcards y overrides específicos.

**Requisitos principales:**
- Matching por prefijo (`/api/*` → `http://backend:8080`)
- Matching por wildcard en path segments
- Overrides de ruta específica con mayor prioridad que reglas de prefijo
- Orden de evaluación: override exacto → prefijo más largo → prefijo general
- Un mismo gateway puede servir múltiples backends distintos
- Responder `404 Not Found` si ninguna ruta coincide
- Logging de la ruta coincidente para observabilidad

**Tecnología involucrada:**
- **Matching:** Lógica custom con árboles de prefijos (Trie) o evaluación ordenada
- **Integración:** Fastify hooks (`onRequest` / `preHandler`)

---

### 4. Rate Limiting por IP

Mecanismo de control de tasa configurable que limita la cantidad de requests por ventana temporal según la IP de origen. Responde `HTTP 429` cuando se supera el límite, protegiendo los backends de abuso o sobrecarga.

**Requisitos principales:**
- Límite configurable: `maxRequests` por `windowSeconds` por IP
- Almacenamiento de contadores en Redis (atómico, distribuido)
- Respuesta `HTTP 429` con mensaje JSON estructurado al superar el límite
- Soporte de reglas globales y overrides por ruta específica
- Headers de respuesta informativos: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Rate limiting aplicado ANTES del proxy (en el pipeline de middlewares)
- Manejo de fallo de Redis: configurable entre "fail-open" (permitir) o "fail-closed" (bloquear)

**Tecnología involucrada:**
- **Almacenamiento:** Redis 7+
- **Cliente Redis:** `ioredis`
- **Algoritmo:** Sliding window counter o Fixed window (configurable)
- **Plugin Fastify:** Integración como middleware en el pipeline

---

### 5. Logging Estructurado

Sistema de logging que registra cada request/response con información mínima necesaria para observabilidad y auditoría básica. Los logs son estructurados en JSON para facilitar integración con herramientas de agregación de logs.

**Requisitos principales:**
- Registrar por cada request: `timestamp`, `method`, `path`, `statusCode`, `responseTimeMs`, `ipOrigen`
- Formato JSON estructurado (una línea por request)
- Niveles de log configurables: `debug`, `info`, `warn`, `error`
- Output a stdout (compatible con Docker/Kubernetes log collection)
- No bloquear el flujo principal (logging asíncrono)
- Incluir identificador único de request (`requestId`) para correlación

**Tecnología involucrada:**
- **Logger:** `pino` (integrado nativo en Fastify)
- **Serializers:** Custom serializers para request/response
- **Formato:** JSON Lines (JSONL)

---

## Arquitectura Técnica — Flujo Interno

```
Request entrante
       │
       ▼
┌──────────────────────────────────────────────────┐
│                  GATEWAY CORE                    │
│                                                  │
│  ┌─────────────┐                                 │
│  │ Config      │ ← Lee gateway.yaml al startup   │
│  │ Loader      │                                 │
│  └──────┬──────┘                                 │
│         │ config tipada                          │
│         ▼                                        │
│  ┌─────────────────────────────────────────┐     │
│  │         Fastify HTTP Server             │     │
│  │                                         │     │
│  │  Request  →  onRequest Hook             │     │
│  │                │                        │     │
│  │                ▼                        │     │
│  │         Route Matcher                   │     │
│  │         (Trie / prefix eval)            │     │
│  │                │                        │     │
│  │                ▼                        │     │
│  │    ┌─── Middleware Pipeline ───┐        │     │
│  │    │   1. Rate Limit Plugin   │        │     │
│  │    │   2. [Auth Plugin - fut] │        │     │
│  │    │   3. [Audit Plugin - fut]│        │     │
│  │    └───────────┬──────────────┘        │     │
│  │                │                        │     │
│  │                ▼                        │     │
│  │         Proxy Engine                   │     │
│  │    (@fastify/http-proxy)               │     │
│  │                │                        │     │
│  │                ▼                        │     │
│  │    ┌─── Response Pipeline ──┐          │     │
│  │    │   Logger (pino)        │          │     │
│  │    └───────────┬────────────┘          │     │
│  │                │                        │     │
│  │                ▼                        │     │
│  │         Response al cliente            │     │
│  └─────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
```

---

## Decisiones Arquitectónicas Clave

| Decisión | Elección | Justificación |
|---|---|---|
| Runtime | Node.js 20 LTS | Ecosistema maduro, excelente I/O no bloqueante, ideal para proxying |
| Framework | Fastify v4 | Mayor performance que Express, plugin system nativo, pino integrado |
| Proxy Engine | `@fastify/http-proxy` | Oficial del ecosistema Fastify, battle-tested |
| Rate Limit Store | Redis | Atómico, distribuido, soporte nativo de TTL |
| Config format | YAML | Legible para humanos, soporta comentarios, estándar en infraestructura |
| Validación config | Zod | Type-safe, errores descriptivos, integración TypeScript nativa |
| Logger | Pino | Logger más rápido del ecosistema Node.js, JSON nativo |
| Package Manager | pnpm | Eficiencia en disco, strictness en dependencias |
| Deploy | Docker | Portabilidad, aislamiento, estándar de facto |
| Lenguaje | TypeScript 5 | Seguridad de tipos, mantenibilidad, detección temprana de errores |

---

## Estructura de Despliegue

Cada proyecto que consuma el Gateway desplegará su propia instancia, idealmente vía Docker Compose:

```yaml
# docker-compose.yml (en el proyecto consumidor)
services:
  gateway:
    image: gateway-http:latest
    ports:
      - "3000:3000"       # Puerto público expuesto
    environment:
      - CONFIG_PATH=/config/gateway.yaml
      - REDIS_URL=redis://redis:6379
    volumes:
      - ./gateway.yaml:/config/gateway.yaml:ro
    depends_on:
      - redis
      - backend

  redis:
    image: redis:7-alpine
    # NO expuesto públicamente

  backend:
    image: mi-backend:latest
    # NO expuesto públicamente (sin ports)
```

---

## Funcionalidades Futuras (Post MVP)

### Autenticación JWT
- Validación de tokens JWT en el gateway antes de reenviar al backend
- Configuración de secretos y algoritmos por ruta
- Inyección de claims en headers hacia el backend

### API Keys
- Generación y validación de API Keys por cliente/proyecto
- Rate limiting diferenciado por API Key

### Auditoría Avanzada
- Log de body de requests/responses (configurable por ruta)
- Almacenamiento de auditoría en base de datos externa

### Dashboard Web de Monitoreo
- Visualización de métricas en tiempo real
- Gestión de configuración vía UI

### Métricas y Observabilidad
- Integración con Prometheus / Grafana
- Métricas por ruta, backend, código de respuesta
- OpenTelemetry traces distribuidos

### Caching de Respuestas
- Cache configurable por ruta con TTL
- Backends de cache: Redis / in-memory

### Circuit Breakers y Retries
- Detección de backends caídos
- Retries con backoff exponencial
- Fallback responses configurables

### Hot Reload de Configuración
- Recarga de `gateway.yaml` sin reiniciar el proceso
- Signal SIGHUP para recargar configuración

### Versionado de APIs
- Routing por versión (`/v1/`, `/v2/`)
- Estrategias de migración entre versiones

### Plugin System Avanzado
- Carga dinámica de plugins desde módulos npm o carpetas locales
- API estándar de plugin para extender el pipeline

### Multi-tenant
- Un gateway sirviendo múltiples proyectos/tenants
- Aislamiento de rate limits y configuración por tenant
