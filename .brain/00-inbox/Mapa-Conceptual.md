---
title: Mapa Conceptual del Gateway
type: index
tags:
  - mapa-conceptual
  - arquitectura
  - gateway
canvas: "[[Gateway-Mapa-Conceptual.canvas]]"
---

# Mapa Conceptual del API Gateway

> Vista panorámica del proyecto generada en formato [[JSON Canvas]] (`.canvas`).
> Ábrela en Obsidian para navegar visualmente.

## Cómo usarla

1. Abre el archivo `Gateway-Mapa-Conceptual.canvas` en Obsidian.
2. Cada **grupo de color** representa una capa arquitectónica del gateway.
3. Las **flechas etiquetadas** muestran el orden de inicialización y las dependencias entre módulos.

## Capas cubiertas

| # | Capa                     | Color  | Módulos clave                                  |
|---|--------------------------|--------|------------------------------------------------|
| 1 | Bootstrap                | rojo   | `src/index.ts`, señales, shutdown              |
| 2 | Configuration            | naranja| `src/config/` — loader, schema, reloader       |
| 3 | Server & Routing         | amarillo | `src/server.ts`, `src/routing/`              |
| 4 | Middleware & Plugins     | verde  | pipeline + rate-limit, jwt, circuit-breaker, metrics |
| 5 | Proxy Engine (Undici)    | cian   | `src/proxy/` — engine, pool, headers, hooks    |
| 6 | Cross-cutting            | púrpura| `src/logger/`, `src/errors/`                  |
| 7 | Tests & Infra            | rojo   | `tests/`, `docker/`, comandos pnpm             |

## Flujo de un request (resumen)

```
Client → Fastify onRequest (match)
       → pipeline.onRequest [rate-limit → jwt → circuit-breaker → metrics]
       → ProxyEngine.forward (pool Undici)
            ↳ hooks.onBeforeRequest / onError / onAfterResponse
       → Upstream
       ← response streamed
       → pipeline.onResponse (orden inverso)
```

## Atajos rápidos

- Ver [[README]] del proyecto.
- Ver `config/gateway.yaml` para la configuración viva.
- Re-generar el canvas: `pnpm vitest run` (los tests cubren el matcher y el pipeline).
