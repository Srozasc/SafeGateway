import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import {
  aggregate,
  buildHealthUrl,
  classifyStatusCode,
  computeGlobalStatus,
  resolveServiceName,
} from '../../../../src/middleware/health/aggregator.js';
import { HealthConfig, RouteConfig } from '../../../../src/config/types.js';

const logger = pino({ level: 'silent' });

/**
 * Helper para construir una respuesta mock de fetch.
 */
function mockResponse(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
  } as Response;
}

const defaultConfig: HealthConfig = {
  enabled: true,
  path: '/health',
  backendPath: '/health',
  timeoutMs: 2000,
};

describe('resolveServiceName', () => {
  it('prioriza route.backendName cuando está definido', () => {
    const route: RouteConfig = {
      prefix: '/api',
      target: 'http://backend:3000',
      backendName: 'my-backend',
    };
    expect(resolveServiceName(route)).toBe('my-backend');
  });

  it('usa hostname(target) cuando no hay backendName', () => {
    const route: RouteConfig = {
      prefix: '/api',
      target: 'http://catalog-service:8083',
    };
    expect(resolveServiceName(route)).toBe('catalog-service');
  });

  it('usa hostname sin puerto cuando el target tiene :port', () => {
    const route: RouteConfig = {
      prefix: '/api',
      target: 'https://api.example.com:8443/v1',
    };
    expect(resolveServiceName(route)).toBe('api.example.com');
  });

  it('cae al prefix cuando target no es una URL válida', () => {
    const route: RouteConfig = {
      prefix: '/api/products',
      target: 'not-a-valid-url',
    };
    expect(resolveServiceName(route)).toBe('/api/products');
  });
});

describe('buildHealthUrl', () => {
  it('concatena target y backendPath sin duplicar slashes', () => {
    expect(buildHealthUrl('http://backend:3000', '/health')).toBe('http://backend:3000/health');
    expect(buildHealthUrl('http://backend:3000/', '/health')).toBe('http://backend:3000/health');
    expect(buildHealthUrl('http://backend:3000//', '/health')).toBe('http://backend:3000/health');
  });

  it('normaliza backendPath sin slash inicial', () => {
    expect(buildHealthUrl('http://backend:3000', 'health')).toBe('http://backend:3000/health');
  });
});

describe('classifyStatusCode', () => {
  it.each([
    [200, 'ok'],
    [201, 'ok'],
    [204, 'ok'],
    [301, 'ok'],
    [302, 'ok'],
    [400, 'degraded'],
    [401, 'degraded'],
    [404, 'degraded'],
    [499, 'degraded'],
    [500, 'down'],
    [502, 'down'],
    [503, 'down'],
    [599, 'down'],
  ])('status %i → %s', (code, expected) => {
    expect(classifyStatusCode(code)).toBe(expected);
  });
});

describe('computeGlobalStatus', () => {
  it('retorna "down" si algún servicio está down', () => {
    expect(
      computeGlobalStatus([
        { name: 'a', status: 'ok', latencyMs: 1 },
        { name: 'b', status: 'down', latencyMs: 1 },
        { name: 'c', status: 'degraded', latencyMs: 1 },
      ]),
    ).toBe('down');
  });

  it('retorna "degraded" si no hay down pero hay degraded', () => {
    expect(
      computeGlobalStatus([
        { name: 'a', status: 'ok', latencyMs: 1 },
        { name: 'b', status: 'degraded', latencyMs: 1 },
      ]),
    ).toBe('degraded');
  });

  it('retorna "ok" si todos están ok', () => {
    expect(
      computeGlobalStatus([
        { name: 'a', status: 'ok', latencyMs: 1 },
        { name: 'b', status: 'ok', latencyMs: 1 },
      ]),
    ).toBe('ok');
  });

  it('maneja lista vacía como ok', () => {
    expect(computeGlobalStatus([])).toBe('ok');
  });
});

describe('aggregate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('BDD-1: retorna status=ok + httpStatus=200 cuando todos los servicios responden 2xx', async () => {
    const routes: RouteConfig[] = [
      { prefix: '/auth', target: 'http://auth:8080', backendName: 'auth-service' },
      { prefix: '/catalog', target: 'http://catalog:8080', backendName: 'catalog-service' },
      { prefix: '/orders', target: 'http://orders:8080', backendName: 'orders-service' },
    ];

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse(200));

    const result = await aggregate(routes, defaultConfig, logger);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.httpStatus).toBe(200);
    expect(result.body.status).toBe('ok');
    expect(result.body.services).toHaveLength(3);
    expect(result.body.services.every((s) => s.status === 'ok')).toBe(true);
    expect(result.body.services.every((s) => s.statusCode === 200)).toBe(true);
    expect(typeof result.body.timestamp).toBe('string');
    // Validar formato ISO 8601
    expect(() => new Date(result.body.timestamp)).not.toThrow();
    // Validar que la URL construida es correcta
    expect(fetchMock).toHaveBeenCalledWith(
      'http://auth:8080/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('BDD-2: marca un servicio como "down" con latencyMs ≈ timeoutMs cuando hay timeout', async () => {
    const routes: RouteConfig[] = [
      { prefix: '/auth', target: 'http://auth:8080', backendName: 'auth' },
      { prefix: '/catalog', target: 'http://catalog:8080', backendName: 'catalog' },
      { prefix: '/orders', target: 'http://orders:8080', backendName: 'orders' },
    ];

    const timeoutError = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      // Solo catalog hace timeout (espera el signal para lanzar)
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(timeoutError);
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
      throw timeoutError;
    });

    // Config con timeout muy corto para que el test sea rápido pero detectable
    const result = await aggregate(routes, { ...defaultConfig, timeoutMs: 50 }, logger);

    expect(result.httpStatus).toBe(503);
    expect(result.body.status).toBe('down');
    const catalog = result.body.services.find((s) => s.name === 'catalog');
    expect(catalog?.status).toBe('down');
    expect(catalog?.error).toBe('timeout after 50ms');
    expect(catalog?.latencyMs).toBeGreaterThanOrEqual(45);
  });

  it('BDD-3: marca un servicio como "down" cuando responde 5xx y retorna http 503', async () => {
    const routes: RouteConfig[] = [
      { prefix: '/auth', target: 'http://auth:8080', backendName: 'auth' },
      { prefix: '/orders', target: 'http://orders:8080', backendName: 'orders' },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url.toString();
      if (u.includes('orders')) {
        return mockResponse(503);
      }
      return mockResponse(200);
    });

    const result = await aggregate(routes, defaultConfig, logger);

    expect(result.httpStatus).toBe(503);
    expect(result.body.status).toBe('down');
    const orders = result.body.services.find((s) => s.name === 'orders');
    expect(orders?.status).toBe('down');
    expect(orders?.statusCode).toBe(503);
  });

  it('BDD-4: marca un servicio como "degraded" cuando responde 4xx y retorna http 200', async () => {
    const routes: RouteConfig[] = [
      { prefix: '/auth', target: 'http://auth:8080', backendName: 'auth' },
      { prefix: '/catalog', target: 'http://catalog:8080', backendName: 'catalog' },
      { prefix: '/orders', target: 'http://orders:8080', backendName: 'orders' },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url.toString();
      if (u.includes('catalog')) {
        return mockResponse(401);
      }
      return mockResponse(200);
    });

    const result = await aggregate(routes, defaultConfig, logger);

    expect(result.httpStatus).toBe(200);
    expect(result.body.status).toBe('degraded');
    const catalog = result.body.services.find((s) => s.name === 'catalog');
    expect(catalog?.status).toBe('degraded');
    expect(catalog?.statusCode).toBe(401);
    expect(catalog?.error).toContain('401');
    // El resto debe estar ok
    const others = result.body.services.filter((s) => s.name !== 'catalog');
    expect(others.every((s) => s.status === 'ok')).toBe(true);
  });

  it('BDD-9: usa el backendPath configurado al construir la URL', async () => {
    const routes: RouteConfig[] = [
      { prefix: '/api', target: 'http://backend:8080', backendName: 'svc' },
    ];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse(200));

    await aggregate(
      routes,
      { ...defaultConfig, backendPath: '/internal/health' },
      logger,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend:8080/internal/health',
      expect.any(Object),
    );
  });

  it('BDD-10: marca un servicio como "down" con error "connection failed" ante errores de red', async () => {
    const routes: RouteConfig[] = [
      { prefix: '/orders', target: 'http://orders:8080', backendName: 'orders' },
    ];

    // fetch rechaza con un error de red genérico (p.ej. ECONNREFUSED se envuelve en TypeError)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    );

    const result = await aggregate(routes, defaultConfig, logger);

    expect(result.httpStatus).toBe(503);
    expect(result.body.status).toBe('down');
    expect(result.body.services[0]?.status).toBe('down');
    expect(result.body.services[0]?.error).toBe('connection failed');
  });

  it('realiza las consultas en paralelo (latencia total ≤ 2 × timeoutMs con N servicios)', async () => {
    const routes: RouteConfig[] = Array.from({ length: 5 }, (_, i) => ({
      prefix: `/svc${i}`,
      target: `http://svc${i}:8080`,
      backendName: `svc${i}`,
    }));

    let activeCalls = 0;
    let maxConcurrent = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      activeCalls++;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      await new Promise((r) => setTimeout(r, 50));
      activeCalls--;
      return mockResponse(200);
    });

    const t0 = Date.now();
    const result = await aggregate(routes, defaultConfig, logger);
    const elapsed = Date.now() - t0;

    expect(result.httpStatus).toBe(200);
    // Si fuera secuencial, 5 × 50ms = 250ms. Paralelo ≈ 50ms + overhead.
    expect(elapsed).toBeLessThan(200);
    expect(maxConcurrent).toBe(routes.length);
  });

  it('incluye timestamp ISO 8601 y nombre correcto por servicio', async () => {
    const routes: RouteConfig[] = [
      { prefix: '/api', target: 'http://my-service.local:8080', backendName: 'my-service' },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200));

    const result = await aggregate(routes, defaultConfig, logger);

    expect(result.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.body.services[0]?.name).toBe('my-service');
    // latencyMs debe ser un entero no-negativo
    expect(result.body.services[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.body.services[0]?.latencyMs)).toBe(true);
  });
});