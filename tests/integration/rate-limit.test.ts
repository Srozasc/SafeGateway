import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildServer } from '../../src/server.js';
import { MiddlewarePipeline } from '../../src/middleware/pipeline.js';
import { RateLimitPlugin } from '../../src/middleware/rate-limit/plugin.js';
import { RateLimitStore, RateLimitIncrementResult } from '../../src/middleware/rate-limit/types.js';
import { MockBackend } from '../helpers/mock-backend.js';
import { GatewayConfig } from '../../src/config/types.js';

// Implementación en memoria robusta de la interfaz RateLimitStore para aislar los tests de integración
class InMemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, number>();

  public async increment(key: string, _windowSeconds: number): Promise<RateLimitIncrementResult> {
    const current = this.store.get(key) || 0;
    const next = current + 1;
    this.store.set(key, next);
    return { count: next };
  }

  public clear(): void {
    this.store.clear();
  }
}

describe('Rate Limit Integration Tests', () => {
  let backend: MockBackend;
  let backendPort: number;
  let server: FastifyInstance;
  let limitStore: InMemoryRateLimitStore;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    backend = new MockBackend();
    backendPort = await backend.start();
    limitStore = new InMemoryRateLimitStore();
  });

  afterAll(async () => {
    await backend.stop();
  });

  beforeEach(() => {
    backend.clear();
    limitStore.clear();
  });

  it('debería permitir solicitudes bajo el límite e inyectar cabeceras informativas', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
          rateLimit: { maxRequests: 5, windowSeconds: 60 },
        },
      ],
    };

    const rateLimitPlugin = new RateLimitPlugin(limitStore, logger);
    const pipeline = new MiddlewarePipeline([rateLimitPlugin]);
    server = buildServer(config, pipeline, logger);

    const response = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-ratelimit-limit']).toBe('5');
    expect(response.headers['x-ratelimit-remaining']).toBe('4'); // 5 - 1 = 4
    expect(response.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('debería rechazar solicitudes con HTTP 429 cuando se excede el límite', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
          rateLimit: { maxRequests: 2, windowSeconds: 60 }, // Máximo 2 peticiones
        },
      ],
    };

    const rateLimitPlugin = new RateLimitPlugin(limitStore, logger);
    const pipeline = new MiddlewarePipeline([rateLimitPlugin]);
    server = buildServer(config, pipeline, logger);

    // Intento 1 -> 200
    const res1 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '2.2.2.2' },
    });
    expect(res1.statusCode).toBe(200);

    // Intento 2 -> 200
    const res2 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '2.2.2.2' },
    });
    expect(res2.statusCode).toBe(200);

    // Intento 3 (Excedido) -> 429
    const res3 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '2.2.2.2' },
    });
    expect(res3.statusCode).toBe(429);
    expect(res3.headers['retry-after']).toBeDefined();

    const body = JSON.parse(res3.body);
    expect(body.error).toBe('Too Many Requests');
    expect(body.message).toContain('Límite de peticiones excedido');
  });

  it('debería aplicar el override de ruta con prioridad y límites más estrictos', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
          rateLimit: { maxRequests: 10, windowSeconds: 60 }, // Ruta padre amplia
        },
      ],
      overrides: [
        {
          path: '/api/login',
          rateLimit: { maxRequests: 1, windowSeconds: 30 }, // Override estricto (1 petición)
        },
      ],
    };

    const rateLimitPlugin = new RateLimitPlugin(limitStore, logger);
    const pipeline = new MiddlewarePipeline([rateLimitPlugin]);
    server = buildServer(config, pipeline, logger);

    // 1. Acceso a /api/resource -> OK (límite general 10)
    const resGen = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '3.3.3.3' },
    });
    expect(resGen.statusCode).toBe(200);

    // 2. Primer acceso a /api/login -> OK (dentro del límite 1 de override)
    const resLog1 = await server.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'x-forwarded-for': '3.3.3.3' },
    });
    expect(resLog1.statusCode).toBe(200);

    // 3. Segundo acceso a /api/login -> 429 (excede override)
    const resLog2 = await server.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'x-forwarded-for': '3.3.3.3' },
    });
    expect(resLog2.statusCode).toBe(429);
  });

  it('debería separar de forma aislada los contadores y límites por IP cliente', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
          rateLimit: { maxRequests: 1, windowSeconds: 60 }, // Máximo 1 petición
        },
      ],
    };

    const rateLimitPlugin = new RateLimitPlugin(limitStore, logger);
    const pipeline = new MiddlewarePipeline([rateLimitPlugin]);
    server = buildServer(config, pipeline, logger);

    // IP A - Intento 1 -> OK
    const resA1 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '4.4.4.4' },
    });
    expect(resA1.statusCode).toBe(200);

    // IP A - Intento 2 -> 429
    const resA2 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '4.4.4.4' },
    });
    expect(resA2.statusCode).toBe(429);

    // IP B - Intento 1 -> OK (Debe permitirse porque es una IP independiente)
    const resB1 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '5.5.5.5' },
    });
    expect(resB1.statusCode).toBe(200);
  });
});
