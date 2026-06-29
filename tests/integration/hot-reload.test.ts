import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildServer } from '../../src/server.js';
import { MiddlewarePipeline } from '../../src/middleware/pipeline.js';
import { RateLimitPlugin } from '../../src/middleware/rate-limit/plugin.js';
import { RateLimitStore } from '../../src/middleware/rate-limit/types.js';
import { MockBackend } from '../helpers/mock-backend.js';
import { ConfigSnapshot } from '../../src/config/types.js';
import { RouteRegistry } from '../../src/routing/registry.js';
import { ConfigReloader } from '../../src/config/reloader.js';

// Implementación en memoria para aislar Redis en este test de integración
class InMemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, number>();

  public async increment(key: string, _windowSeconds: number): Promise<{ count: number }> {
    const current = this.store.get(key) || 0;
    const next = current + 1;
    this.store.set(key, next);
    return { count: next };
  }

  public clear(): void {
    this.store.clear();
  }
}

describe('Hot Reload Integration Tests', () => {
  const tmpConfigPath = path.resolve('tests/integration/tmp-gateway.yaml');
  let backend: MockBackend;
  let backendPort: number;
  let server: FastifyInstance;
  let limitStore: InMemoryRateLimitStore;
  let snapshotRef: { current: ConfigSnapshot };
  let reloader: ConfigReloader;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    // 1. Iniciar backend simulado
    backend = new MockBackend();
    backendPort = await backend.start();
    limitStore = new InMemoryRateLimitStore();
  });

  afterAll(async () => {
    // 2. Apagar backend simulado
    await backend.stop();

    // 3. Eliminar archivo temporal si existe
    if (fs.existsSync(tmpConfigPath)) {
      try {
        fs.unlinkSync(tmpConfigPath);
      } catch (_) {}
    }
  });

  beforeEach(() => {
    backend.clear();
    limitStore.clear();
  });

  it('debería recargar en caliente el rate limit y overrides dinámicamente sin reiniciar el servidor HTTP', async () => {
    // Configuración inicial: Límite muy estricto de 1 petición por minuto
    const initialConfigYaml = `
server:
  port: 3000
  host: "127.0.0.1"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
routes:
  - prefix: "/api"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
    rateLimit:
      maxRequests: 1
      windowSeconds: 60
`;
    fs.writeFileSync(tmpConfigPath, initialConfigYaml, 'utf8');

    // 1. Cargar configuración inicial y montar Snapshot
    const { loadConfig } = await import('../../src/config/loader.js');
    const config = loadConfig(tmpConfigPath);
    const registry = new RouteRegistry(config);
    const { JwtAuthRegistry } = await import('../../src/middleware/jwt-auth/registry.js');
    const jwtRegistry = new JwtAuthRegistry(config.jwt, logger);
    snapshotRef = {
      current: {
        config,
        registry,
        jwtRegistry,
        createdAt: new Date().toISOString(),
      },
    };

    // 2. Montar Fastify y Reloader con el snapshot inicial
    const rateLimitPlugin = new RateLimitPlugin(limitStore, logger);
    const pipeline = new MiddlewarePipeline([rateLimitPlugin]);
    server = buildServer(config, pipeline, logger, snapshotRef);
    reloader = new ConfigReloader(tmpConfigPath, snapshotRef, logger);

    // --- PRUEBA 1: Límite inicial de 1 petición ---
    // Petición 1 -> OK (200)
    const res1 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    expect(res1.statusCode).toBe(200);

    // Petición 2 -> Rechazada (429) por límite excedido
    const res2 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    expect(res2.statusCode).toBe(429);

    // --- PRUEBA 2: Modificar configuración y disparar Hot Reload ---
    // Cambiamos el límite de maxRequests a 3 en caliente
    const updatedConfigYaml = `
server:
  port: 3000
  host: "127.0.0.1"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
routes:
  - prefix: "/api"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
    rateLimit:
      maxRequests: 3 # Nuevo límite aumentado en caliente
      windowSeconds: 60
`;
    fs.writeFileSync(tmpConfigPath, updatedConfigYaml, 'utf8');

    // Disparar recarga
    const reloadResult = await reloader.reload();
    expect(reloadResult.success).toBe(true);
    expect(reloadResult.applied).toContain('routes[0].rateLimit');

    // --- PRUEBA 3: Validar que el nuevo límite de 3 se aplica inmediatamente ---
    // Como el contador en el limitStore ya estaba en 2, y el límite ahora es 3:
    // Petición 3 -> OK (200) - Contador sube a 3
    const res3 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    expect(res3.statusCode).toBe(200);

    // Petición 4 -> Rechazada (429) - Excede el nuevo límite de 3
    const res4 = await server.inject({
      method: 'GET',
      url: '/api/resource',
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    expect(res4.statusCode).toBe(429);
  });
});
