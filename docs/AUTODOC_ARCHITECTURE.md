# Arquitectura del Sistema: API Gateway HTTP Modular

Este documento detalla la arquitectura de software, el stack tecnológico y la organización interna del API Gateway HTTP Modular. Está diseñado para ofrecer una comprensión profunda a ingenieros de software e ingenieros de infraestructura.

## Resumen del Stack Tecnológico (Tech Stack Overview)

El Gateway está construido bajo la plataforma Node.js utilizando TypeScript y un conjunto de librerías de alto rendimiento y robustez comprobada en producción.

| Componente | Tecnología | Versión | Propósito / Rol |
| :--- | :--- | :--- | :--- |
| **Entorno de Ejecución** | Node.js | v20 LTS | Plataforma de ejecución de JavaScript del lado del servidor. |
| **Lenguaje** | TypeScript | v6.0.3 | Lenguaje tipado que compila a JavaScript moderno. |
| **Framework Web** | Fastify | v5.8.5 | Servidor HTTP de bajísima sobrecarga y alta velocidad de procesamiento. |
| **Cliente de Proxy** | Undici | v6.26.0 | Cliente HTTP/1.1 y HTTP/2 oficial de Node.js, optimizado para alto rendimiento y pool de sockets. |
| **Base de Datos / Caché** | Redis (ioredis) | v5.10.1 | Almacenamiento clave-valor en memoria utilizado para la limitación de tasa (Rate Limiting) distribuido. |
| **Autenticación** | jose | v6.2.3 | Implementación ligera y sin dependencias nativas para firmas y validaciones JWT (JSON Web Tokens). |
| **Validación de Esquemas** | Zod | v4.4.3 | Declaración y validación estricta de esquemas de configuración y peticiones. |
| **Monitoreo / Métricas** | prom-client | v15.1.3 | Exportador de métricas compatible con el formato scrape de Prometheus. |
| **Logs** | Pino | v10.3.1 | Motor de registro JSON extremadamente rápido y de bajo impacto en CPU. |
| **Motor de Pruebas** | Vitest | v4.1.7 | Framework de testing rápido y nativo con soporte para ESM y TypeScript. |

---

## Diagrama de Arquitectura (D2)

El siguiente diagrama ilustra el flujo de una solicitud desde el cliente a través del API Gateway, detallando cómo se ejecutan los middlewares de control antes de que el motor de proxy reenvíe la petición al microservicio correspondiente.

```d2
direction: down

Client: "Cliente / Frontend"
Gateway: "API Gateway (Fastify)" {
  direction: right
  Pipeline: "Pipeline de Middlewares"
  ProxyEngine: "Proxy Engine (Undici)"
  ConfigLoader: "Config Loader / Reloader"
  Registry: "Registro de Rutas"

  Pipeline -> ProxyEngine: "petición válida"
  ProxyEngine -> Registry: "consulta ruta"
  ConfigLoader -> Registry: "actualiza rutas en caliente"
}

Middlewares: "Middlewares de Control" {
  direction: down
  JWT: "JWT Auth (jose)"
  RateLimit: "Rate Limiter (Redis / En Memoria)"
  CB: "Circuit Breaker"
  Metrics: "Metrics (prom-client)"
}

Pipeline -> JWT: "verifica tokens"
Pipeline -> RateLimit: "valida límites"
Pipeline -> CB: "comprueba estado del backend"
Pipeline -> Metrics: "registra métricas del request"

RateLimit -> Redis: "consulta cuotas"
Metrics -> Prometheus: "scraping de puerto"

ProxyEngine -> Backend: "reenvío HTTP/1.1-2"

Redis: "Redis Cache"
Prometheus: "Prometheus Server"
Backend: "Mock Backend / Microservicios"

# Estilos de los Nodos para Contraste
Client.style.fill: "#e3f2fd"
Client.style.stroke: "#0d47a1"
Client.style.font-color: "#0d47a1"

Gateway.style.fill: "#f5f5f5"
Gateway.style.stroke: "#424242"
Gateway.style.font-color: "#212121"

Middlewares.style.fill: "#f9fbe7"
Middlewares.style.stroke: "#827717"
Middlewares.style.font-color: "#33691e"

Redis.style.fill: "#ffebee"
Redis.style.stroke: "#b71c1c"
Redis.style.font-color: "#b71c1c"
Redis.shape: cylinder

Prometheus.style.fill: "#fff3e0"
Prometheus.style.stroke: "#e65100"
Prometheus.style.font-color: "#e65100"
Prometheus.shape: cylinder

Backend.style.fill: "#e8f5e9"
Backend.style.stroke: "#1b5e20"
Backend.style.font-color: "#1b5e20"
Backend.shape: rectangle
```

---

## Estructura del Proyecto (Anatomía)

La distribución física del código sigue un enfoque modular centrado en responsabilidades desacopladas, lo que permite añadir middlewares o modificar el motor de proxy de manera aislada.

```text
Gateway/
├── .agent/                  # Configuración y skills del asistente de desarrollo
├── config/                  # Archivos de configuración del Gateway (ej. gateway.yaml)
├── docker/                  # Recursos de Dockerización y Orquestación
│   ├── grafana/             # Dashboards y configuración de Grafana para métricas
│   └── prometheus/          # Configuración de scrape y jobs de Prometheus
├── src/                     # Código fuente en TypeScript
│   ├── config/              # Carga, validación con Zod y monitorización de recargas (Hot-reload)
│   ├── errors/              # Definiciones y manejador global de errores del Gateway
│   ├── logger/              # Módulo de logging centralizado con Pino
│   ├── middleware/          # Canalización (pipeline) y middlewares individuales (Rate Limiting, Auth, CB, Metrics)
│   ├── proxy/               # Motor de reenvío inverso de red (conexiones persistentes con Undici)
│   ├── routing/             # Tabla de rutas y lógica de emparejamiento (matching)
│   ├── index.ts             # Punto de entrada de la aplicación
│   └── server.ts            # Configuración inicial del servidor de Fastify
├── tests/                   # Suite de pruebas unitarias y de integración
├── package.json             # Manifiesto de dependencias y scripts npm/pnpm
└── pnpm-lock.yaml           # Archivo de bloqueo de versiones del gestor pnpm
```

---

## Guía de Inicio Rápido (Quick Start)

### Requisitos Previos
- Node.js v20 o superior.
- **pnpm** instalado globalmente (`npm install -g pnpm` o vía corepack).
- Docker y Docker Compose (opcional, para entornos de producción y pruebas).

### Instalación de dependencias
```bash
pnpm install
```

### Ejecutar en modo desarrollo
```bash
pnpm dev
```

### Compilar para producción
```bash
pnpm build
```

### Ejecutar la aplicación compilada
```bash
pnpm start
```

### Ejecutar pruebas
```bash
# Ejecutar todas las pruebas con Vitest
pnpm test

# Ejecutar pruebas con reporte de cobertura
pnpm test:coverage
```
