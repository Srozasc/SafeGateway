import fs from 'fs';
import { vi, describe, it, expect, beforeEach, afterAll, MockInstance } from 'vitest';
import pino, { Logger } from 'pino';
import { ConfigReloader } from '../../../src/config/reloader.js';
import { RouteRegistry } from '../../../src/routing/registry.js';
import { ConfigSnapshot, GatewayConfig } from '../../../src/config/types.js';

describe('ConfigReloader Unit Tests', () => {
  const originalEnv = { ...process.env };
  let existsSpy: MockInstance<typeof fs.existsSync>;
  let readSpy: MockInstance<typeof fs.readFileSync>;
  let logger: Logger;
  let snapshotRef: { current: ConfigSnapshot };

  const baseConfig: GatewayConfig = {
    server: { port: 3000, host: '0.0.0.0' },
    redis: { url: 'redis://localhost:6379', onFailure: 'open' },
    logging: { level: 'info' },
    metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
    routes: [
      {
        prefix: '/api',
        target: 'http://backend:8080',
        stripPrefix: false, // Valor por defecto explícito de Zod
        rateLimit: { maxRequests: 100, windowSeconds: 60 },
      },
    ],
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };

    existsSpy = vi.spyOn(fs, 'existsSync') as MockInstance<typeof fs.existsSync>;
    readSpy = vi.spyOn(fs, 'readFileSync') as unknown as MockInstance<
      typeof fs.readFileSync
    >;

    logger = pino({ level: 'silent' });
    const registry = new RouteRegistry(baseConfig);
    const { JwtAuthRegistry } = await import('../../../src/middleware/jwt-auth/registry.js');
    const jwtRegistry = new JwtAuthRegistry(baseConfig.jwt, logger);
    snapshotRef = {
      current: {
        config: baseConfig,
        registry,
        jwtRegistry,
        createdAt: new Date().toISOString(),
      },
    };
  });

  afterAll(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('debería recargar exitosamente cuando cambia logging.level y actualizar Pino', async () => {
    const updatedYaml = `
server:
  port: 3000
  host: "0.0.0.0"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "debug" # Cambiado de info a debug
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    rateLimit:
      maxRequests: 100
      windowSeconds: 60
`;
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(updatedYaml as unknown as ReturnType<typeof fs.readFileSync>);

    const reloader = new ConfigReloader('config.yaml', snapshotRef, logger);
    const result = await reloader.reload();

    expect(result.success).toBe(true);
    expect(result.applied).toContain('logging.level: "info" → "debug"');
    expect(result.ignored).toHaveLength(0);
    expect(snapshotRef.current.config.logging.level).toBe('debug');
    expect(logger.level).toBe('debug');
  });

  it('debería recargar rateLimit de rutas y overrides sin afectar campos estáticos', async () => {
    const updatedYaml = `
server:
  port: 3000
  host: "0.0.0.0"
redis:
  url: "redis://localhost:6379"
logging:
  level: "info"
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    rateLimit:
      maxRequests: 200 # Cambiado de 100 a 200
      windowSeconds: 30 # Cambiado de 60 a 30
overrides:
  - path: "/api/login"
    rateLimit:
      maxRequests: 5
      windowSeconds: 60
`;
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(updatedYaml as unknown as ReturnType<typeof fs.readFileSync>);

    const reloader = new ConfigReloader('config.yaml', snapshotRef, logger);
    const result = await reloader.reload();

    expect(result.success).toBe(true);
    expect(result.applied).toContain('routes[0].rateLimit');
    expect(result.applied).toContain('overrides');
    expect(result.ignored).toHaveLength(0);

    // Verificar que el nuevo snapshot tenga la configuración aplicada y un nuevo registry activo
    expect(snapshotRef.current.config.routes[0]?.rateLimit?.maxRequests).toBe(200);
    const matchOverride = snapshotRef.current.registry.match('/api/login');
    expect(matchOverride).toBeDefined();
    expect(matchOverride?.effectiveRateLimit?.maxRequests).toBe(5);
  });

  it('debería ignorar cambios no recargables (server, redis, prefix, target) y emitir advertencias', async () => {
    const updatedYaml = `
server:
  port: 4000 # Cambiado
  host: "127.0.0.1" # Cambiado
redis:
  url: "redis://localhost:9999" # Cambiado
  onFailure: "closed" # Cambiado
logging:
  level: "info"
routes:
  - prefix: "/apiv2" # Cambiado
    target: "http://other-backend:8080" # Cambiado
    stripPrefix: true # Cambiado
    rateLimit:
      maxRequests: 50 # Cambiado (recargable)
      windowSeconds: 60
    timeout:
      connect: 5000 # Nuevo (no recargable)
`;
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(updatedYaml as unknown as ReturnType<typeof fs.readFileSync>);

    const reloader = new ConfigReloader('config.yaml', snapshotRef, logger);
    const result = await reloader.reload();

    expect(result.success).toBe(true);
    expect(result.applied).toContain('routes[0].rateLimit'); // Cambio aplicado
    expect(result.ignored).toContain('server.port');
    expect(result.ignored).toContain('server.host');
    expect(result.ignored).toContain('redis.url');
    expect(result.ignored).toContain('redis.onFailure');
    expect(result.ignored).toContain('routes[0].prefix');
    expect(result.ignored).toContain('routes[0].target');
    expect(result.ignored).toContain('routes[0].stripPrefix');
    expect(result.ignored).toContain('routes[0].timeout');
  });

  it('debería no-op y retornar éxito si no hay cambios en la configuración', async () => {
    const originalYaml = `
server:
  port: 3000
  host: "0.0.0.0"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "info"
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    rateLimit:
      maxRequests: 100
      windowSeconds: 60
`;
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(originalYaml as unknown as ReturnType<typeof fs.readFileSync>);

    const reloader = new ConfigReloader('config.yaml', snapshotRef, logger);
    const result = await reloader.reload();

    expect(result.success).toBe(true);
    expect(result.applied).toHaveLength(0);
  });

  it('debería fallar la recarga y mantener el snapshot anterior si el archivo es inválido', async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue('invalid-yaml-broken: { { {' as unknown as ReturnType<typeof fs.readFileSync>); // YAML roto

    const reloader = new ConfigReloader('config.yaml', snapshotRef, logger);
    const result = await reloader.reload();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Sintaxis YAML de configuración inválida');
    expect(snapshotRef.current.config.server.port).toBe(3000); // Config original mantenida
  });

  it('debería abortar la recarga si falla la validación Zod', async () => {
    const invalidYaml = `
server:
  port: 9999999 # Fuera de rango
redis:
  url: "redis://localhost:6379"
routes: [] # No vacío
`;
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(invalidYaml as unknown as ReturnType<typeof fs.readFileSync>);

    const reloader = new ConfigReloader('config.yaml', snapshotRef, logger);
    const result = await reloader.reload();

    expect(result.success).toBe(false);
    expect(result.error).toContain('La validación de la configuración falló');
    expect(snapshotRef.current.config.server.port).toBe(3000); // Original
  });

  it('debería asegurar thread-safety mediante el mutex lógico', async () => {
    const updatedYaml = `
server:
  port: 3000
  host: "0.0.0.0"
redis:
  url: "redis://localhost:6379"
  onFailure: "open"
logging:
  level: "debug"
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    rateLimit:
      maxRequests: 100
      windowSeconds: 60
`;
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(updatedYaml as unknown as ReturnType<typeof fs.readFileSync>);

    const reloader = new ConfigReloader('config.yaml', snapshotRef, logger);

    // Disparar recargas en paralelo para probar el lock/mutex lógico
    const [result1, result2] = await Promise.all([reloader.reload(), reloader.reload()]);

    // Uno debe ser exitoso y el otro debe fallar/ser ignorado por el mutex
    if (result1.success) {
      expect(result2.success).toBe(false);
      expect(result2.error).toBe('Recarga en curso');
    } else {
      expect(result2.success).toBe(true);
      expect(result1.error).toBe('Recarga en curso');
    }
  });
});
