import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildServer } from '../../src/server.js';
import { MiddlewarePipeline } from '../../src/middleware/pipeline.js';
import { MockBackend } from '../helpers/mock-backend.js';
import { ConfigSnapshot } from '../../src/config/types.js';
import { RouteRegistry } from '../../src/routing/registry.js';
import { ConfigReloader } from '../../src/config/reloader.js';
import { CorsPlugin } from '../../src/middleware/cors/plugin.js';

describe('CORS Integration Tests', () => {
  const tmpConfigPath = path.resolve('tests/integration/tmp-cors-gateway.yaml');
  let backend: MockBackend;
  let backendPort: number;
  let server: FastifyInstance;
  let snapshotRef: { current: ConfigSnapshot };
  let reloader: ConfigReloader;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    backend = new MockBackend();
    backendPort = await backend.start();
  });

  afterAll(async () => {
    await backend.stop();
    if (fs.existsSync(tmpConfigPath)) {
      try {
        fs.unlinkSync(tmpConfigPath);
      } catch (_) {}
    }
  });

  beforeEach(() => {
    backend.clear();
  });

  // Helper para montar el server con una config dada
  async function mountServer(configYaml: string): Promise<void> {
    fs.writeFileSync(tmpConfigPath, configYaml, 'utf8');
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
    const corsPlugin = new CorsPlugin(logger);
    const pipeline = new MiddlewarePipeline([corsPlugin]);
    server = buildServer(config, pipeline, logger, snapshotRef);
    reloader = new ConfigReloader(tmpConfigPath, snapshotRef, logger);
  }

  describe('Escenario 3: Preflight (OPTIONS)', () => {
    it('debería responder 204 con headers CORS sin pasar al backend', async () => {
      const yaml = `
server:
  port: 3000
  host: "127.0.0.1"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
cors:
  enabled: true
  origins:
    - "https://app.flashdrop.cl"
routes:
  - prefix: "/api"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
`;
      await mountServer(yaml);

      const res = await server.inject({
        method: 'OPTIONS',
        url: '/api/orders',
        headers: {
          origin: 'https://app.flashdrop.cl',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'Content-Type, Authorization',
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.flashdrop.cl');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('content-type');
      expect(res.headers['access-control-max-age']).toBe('86400');
      expect(res.headers['vary']).toBe('Origin');

      // El backend NO recibió el request
      expect(backend.lastRequestUrl).toBeNull();
    });
  });

  describe('Escenario 1: Request normal desde origin permitido', () => {
    it('debería agregar headers CORS en la respuesta del backend', async () => {
      const yaml = `
server:
  port: 3000
  host: "127.0.0.1"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
cors:
  enabled: true
  origins:
    - "https://app.flashdrop.cl"
routes:
  - prefix: "/api"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
`;
      await mountServer(yaml);

      const res = await server.inject({
        method: 'GET',
        url: '/api/products',
        headers: { origin: 'https://app.flashdrop.cl' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.flashdrop.cl');
      expect(res.headers['vary']).toBe('Origin');

      // El backend SÍ recibió el request
      expect(backend.lastRequestUrl).toBe('/api/products');
    });
  });

  describe('Escenario 2: Request desde origin NO permitido', () => {
    it('NO debería agregar headers CORS y pasar al backend normalmente', async () => {
      const yaml = `
server:
  port: 3000
  host: "127.0.0.1"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
cors:
  enabled: true
  origins:
    - "https://app.flashdrop.cl"
routes:
  - prefix: "/api"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
`;
      await mountServer(yaml);

      const res = await server.inject({
        method: 'GET',
        url: '/api/products',
        headers: { origin: 'https://malicious.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();

      // El backend SÍ recibió el request (CORS es decisión del cliente)
      expect(backend.lastRequestUrl).toBe('/api/products');
    });
  });

  describe('Escenario 8: Request sin Origin (server-to-server)', () => {
    it('NO debería agregar headers CORS y pasar al backend', async () => {
      const yaml = `
server:
  port: 3000
  host: "127.0.0.1"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
cors:
  enabled: true
  origins:
    - "https://app.flashdrop.cl"
routes:
  - prefix: "/api"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
`;
      await mountServer(yaml);

      const res = await server.inject({
        method: 'GET',
        url: '/api/products',
        // sin header Origin
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(backend.lastRequestUrl).toBe('/api/products');
    });
  });

  describe('Escenario 5: Override por ruta con policy wildcard', () => {
    it('debería usar "*" como Allow-Origin para rutas con origins=["*"]', async () => {
      const yaml = `
server:
  port: 3000
  host: "127.0.0.1"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
cors:
  enabled: true
  origins:
    - "https://app.flashdrop.cl"
routes:
  - prefix: "/api"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
  - prefix: "/api/dev"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
    cors:
      origins:
        - "*"
`;
      await mountServer(yaml);

      const res = await server.inject({
        method: 'GET',
        url: '/api/dev/users',
        headers: { origin: 'https://anywhere.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      // Vary NO debe estar presente con wildcard (A14)
      expect(res.headers['vary']).toBeUndefined();
    });
  });

  describe('Escenario 7: Hot-reload de configuración CORS', () => {
    it('debería aplicar cambios de cors.origins sin reiniciar', async () => {
      const initialYaml = `
server:
  port: 3000
  host: "127.0.0.1"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
cors:
  enabled: true
  origins:
    - "https://old.flashdrop.cl"
routes:
  - prefix: "/api"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
`;
      await mountServer(initialYaml);

      // Antes del reload: old.flashdrop.cl permitido
      const res1 = await server.inject({
        method: 'GET',
        url: '/api/products',
        headers: { origin: 'https://old.flashdrop.cl' },
      });
      expect(res1.headers['access-control-allow-origin']).toBe('https://old.flashdrop.cl');

      // Recargar con nueva config
      const updatedYaml = `
server:
  port: 3000
  host: "127.0.0.1"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
cors:
  enabled: true
  origins:
    - "https://new.flashdrop.cl"
routes:
  - prefix: "/api"
    target: "http://127.0.0.1:${backendPort}"
    stripPrefix: false
`;
      fs.writeFileSync(tmpConfigPath, updatedYaml, 'utf8');
      const reloadResult = await reloader.reload();

      expect(reloadResult.success).toBe(true);
      expect(reloadResult.applied).toContain('cors');

      // Después del reload: new.flashdrop.cl permitido, old.flashdrop.cl NO
      const res2 = await server.inject({
        method: 'GET',
        url: '/api/products',
        headers: { origin: 'https://new.flashdrop.cl' },
      });
      expect(res2.headers['access-control-allow-origin']).toBe('https://new.flashdrop.cl');

      const res3 = await server.inject({
        method: 'GET',
        url: '/api/products',
        headers: { origin: 'https://old.flashdrop.cl' },
      });
      expect(res3.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('Sin bloque cors global (Escenario 18)', () => {
    it('debería funcionar como si cors.enabled=false (no headers, no short-circuit)', async () => {
      const yaml = `
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
`;
      await mountServer(yaml);

      const res = await server.inject({
        method: 'GET',
        url: '/api/products',
        headers: { origin: 'https://app.flashdrop.cl' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(backend.lastRequestUrl).toBe('/api/products');
    });
  });
});