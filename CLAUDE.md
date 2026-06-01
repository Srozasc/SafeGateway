# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

API Gateway HTTP Modular - A TypeScript/Fastify-based reverse proxy with middleware pipeline architecture. Supports rate limiting (Redis), JWT authentication, Prometheus metrics, and hot-reload configuration.

## Commands

```bash
# Install dependencies (use pnpm exclusively)
pnpm install

# Development with hot-reload
pnpm dev

# Build for production
pnpm build

# Run production build
pnpm start

# Linting
pnpm lint

# Format code
pnpm format

# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:coverage

# Run a single test file
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/routing/matcher.test.ts

# Build Docker image
pnpm docker:build

# Start full dev stack (Redis, mock backend, Dozzle, Prometheus, Grafana)
docker compose -f docker/docker-compose.example.yml up --build
```

## Architecture

### Core Flow
1. `src/index.ts` - Bootstrap sequence: load config → connect Redis → build server → start listening
2. `src/server.ts` - Fastify server factory with `registerProxyRoutes()` and route matching hook
3. `src/routing/registry.ts` - `RouteRegistry` matches URLs by longest-prefix, supports exact-path overrides
4. `src/middleware/pipeline.ts` - `MiddlewarePipeline` orchestrates plugins sequentially (rate-limit → jwt-auth → metrics)
5. `src/config/` - YAML loading with Zod validation, hot-reload via SIGHUP with snapshot swap pattern

### Key Patterns
- **ConfigSnapshot pattern**: Immutable configuration snapshots swapped atomically on SIGHUP for zero-downtime reload
- **Route matching priority**: Exact override path > longest prefix match
- **Plugin short-circuit**: If `reply.send()` is called in `onRequest`, pipeline stops immediately
- **Redis Rate Limiting**: Fixed window counter using atomic Redis pipelines; fail-open/closed configurable

### Directory Structure
```
src/
├── index.ts          # Entry point, bootstrap, graceful shutdown
├── server.ts         # Fastify factory, proxy route registration
├── config/           # YAML loading, Zod schema, hot-reloader
├── errors/           # Global error handler, structured error responses
├── logger/           # Pino setup with redaction serializers
├── middleware/       # Pipeline, rate-limit, jwt-auth, metrics plugins
├── proxy/            # Header forwarding, proxy types
└── routing/          # RouteRegistry, Matcher, route types

tests/
├── unit/             # Component-level tests
└── integration/      # Full gateway tests (proxy, rate-limit, JWT, hot-reload)
```

## Configuration

Configuration file: `config/gateway.yaml` (or via `CONFIG_PATH` env var)

Schema validation via Zod in `src/config/schema.ts`. Environment variable interpolation: `${ENV_VAR}` supported throughout. Missing required env vars cause fast-fail on startup.

### Hot Reload Behavior
- **Reloadable without restart**: `routes[].rateLimit`, `overrides`, `logging.level`
- **Require restart**: `server.*`, `redis.*`, `routes[].prefix/target/stripPrefix`, adding/removing routes

## Observability

- **Logs**: Pino with JSON output; `Authorization` and `Cookie` headers automatically redacted
- **Metrics**: Prometheus endpoint at `/metrics` (configurable)
- **Dev tooling**: Dozzle (localhost:9999) for live log visualization; Grafana (localhost:3001) with pre-provisioned dashboard