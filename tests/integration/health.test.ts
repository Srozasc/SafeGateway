import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { buildServer } from '../../src/server.js';
import { MiddlewarePipeline } from '../../src/middleware/pipeline.js';
import type { GatewayConfig, HealthConfig } from '../../src/config/types.js';

/**
 * Mock backend configurable para escenarios de health.
 */
class MockHealthBackend {
  public server: http.Server;
  public mode: 'ok' | 'unauthorized' | 'unavailable' | 'never' = 'ok';
  public healthPath = '/health';

  constructor() {
    this.server = http.createServer((req, res) => {
      if (req.url !== this.healthPath) {
        res.writeHead(404);
        res.end();
        return;
      }

      switch (this.mode) {
        case 'ok':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        case 'unauthorized':
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        case 'unavailable':
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'service unavailable' }));
          return;
        case 'never':
          // Nunca responde: cuelga hasta que el cliente aborte
          return;
      }
    });
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }
}

function makeConfig(
  routes: GatewayConfig['routes'],
  health: HealthConfig,
  extra: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    server: { port: 0, host: '127.0.0.1' },
    redis: { url: 'redis://localhost:6379' },
    logging: { level: 'silent' },
    metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
    routes,
    health,
    ...extra,
  };
}

describe('Health Aggregation Integration', () => {
  let okBackend: MockHealthBackend;
  let degradedBackend: MockHealthBackend;
  let downBackend: MockHealthBackend;

  beforeAll(async () => {
    okBackend = new MockHealthBackend();
    degradedBackend = new MockHealthBackend();
    downBackend = new MockHealthBackend();
    await Promise.all([
      okBackend.start(),
      degradedBackend.start(),
      downBackend.start(),
    ]);
    downBackend.mode = 'never';
  }, 30000);

  afterAll(async () => {
    await Promise.all([okBackend.stop(), degradedBackend.stop(), downBackend.stop()]);
  });

  beforeEach(() => {
    okBackend.mode = 'ok';
    degradedBackend.mode = 'unauthorized';
    downBackend.mode = 'never';
  });

  it('BDD-1: retorna 200 con status=ok cuando todos los servicios responden 200', async () => {
    okBackend.mode = 'ok';
    degradedBackend.mode = 'ok';
    downBackend.mode = 'ok';

    const healthConfig: HealthConfig = {
      enabled: true,
      path: '/health',
      backendPath: '/health',
      timeoutMs: 2000,
    };

    const config = makeConfig(
      [
        {
          prefix: '/a',
          target: `http://127.0.0.1:${(okBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-a',
        },
        {
          prefix: '/b',
          target: `http://127.0.0.1:${(degradedBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-b',
        },
        {
          prefix: '/c',
          target: `http://127.0.0.1:${(downBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-c',
        },
      ],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.services).toHaveLength(3);
      expect(body.services.every((s: { status: string }) => s.status === 'ok')).toBe(true);
      expect(typeof body.timestamp).toBe('string');
    } finally {
      await server.close();
    }
  });

  it('BDD-3: retorna 503 cuando un servicio responde 5xx', async () => {
    okBackend.mode = 'ok';
    degradedBackend.mode = 'ok';
    downBackend.mode = 'unavailable'; // 503

    const healthConfig: HealthConfig = {
      enabled: true,
      path: '/health',
      backendPath: '/health',
      timeoutMs: 2000,
    };

    const config = makeConfig(
      [
        {
          prefix: '/a',
          target: `http://127.0.0.1:${(okBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-a',
        },
        {
          prefix: '/b',
          target: `http://127.0.0.1:${(degradedBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-b',
        },
        {
          prefix: '/c',
          target: `http://127.0.0.1:${(downBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-c',
        },
      ],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('down');
      const svcC = body.services.find((s: { name: string }) => s.name === 'svc-c');
      expect(svcC.status).toBe('down');
      expect(svcC.statusCode).toBe(503);
    } finally {
      await server.close();
    }
  });

  it('BDD-4: retorna 200 con status=degraded cuando un servicio responde 4xx', async () => {
    okBackend.mode = 'ok';
    degradedBackend.mode = 'ok';
    downBackend.mode = 'unauthorized'; // 401

    const healthConfig: HealthConfig = {
      enabled: true,
      path: '/health',
      backendPath: '/health',
      timeoutMs: 2000,
    };

    const config = makeConfig(
      [
        {
          prefix: '/a',
          target: `http://127.0.0.1:${(okBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-a',
        },
        {
          prefix: '/b',
          target: `http://127.0.0.1:${(degradedBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-b',
        },
        {
          prefix: '/c',
          target: `http://127.0.0.1:${(downBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-c',
        },
      ],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('degraded');
      const svcC = body.services.find((s: { name: string }) => s.name === 'svc-c');
      expect(svcC.status).toBe('degraded');
      expect(svcC.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('BDD-2: marca un servicio como down con error de timeout cuando excede timeoutMs', async () => {
    okBackend.mode = 'ok';
    degradedBackend.mode = 'ok';
    downBackend.mode = 'never'; // nunca responde

    const healthConfig: HealthConfig = {
      enabled: true,
      path: '/health',
      backendPath: '/health',
      timeoutMs: 200, // timeout corto para que el test sea rápido
    };

    const config = makeConfig(
      [
        {
          prefix: '/a',
          target: `http://127.0.0.1:${(okBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-a',
        },
        {
          prefix: '/c',
          target: `http://127.0.0.1:${(downBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-c',
        },
      ],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      const svcC = body.services.find((s: { name: string }) => s.name === 'svc-c');
      expect(svcC.status).toBe('down');
      expect(svcC.error).toBe('timeout after 200ms');
      expect(svcC.latencyMs).toBeGreaterThanOrEqual(180);
    } finally {
      await server.close();
    }
  });

  it('BDD-7: el endpoint /health NO se proxia a un backend (verifica que no se invoca el proxy)', async () => {
    const okPort = (okBackend.server.address() as AddressInfo).port;
    okBackend.mode = 'ok';

    const healthConfig: HealthConfig = {
      enabled: true,
      path: '/health',
      backendPath: '/health',
      timeoutMs: 2000,
    };

    // Definimos un route con prefix="/health" que NO debería activarse,
    // porque el endpoint nativo de health se registra antes de las rutas de proxy.
    const config = makeConfig(
      [
        {
          prefix: '/health',
          target: `http://127.0.0.1:${okPort}`,
          backendName: 'should-not-be-called',
        },
      ],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      // La respuesta debe ser JSON del aggregator, no la del backend
      expect(response.headers['content-type']).toContain('application/json');
      const body = JSON.parse(response.body);
      expect(body.status).toBeDefined();
      expect(body.services).toBeDefined();
      expect(body.timestamp).toBeDefined();
      // Si se hubiera proxiado, la respuesta sería {status: 'ok'} (del backend),
      // pero el aggregator envuelve con su propio envelope.
    } finally {
      await server.close();
    }
  });

  it('BDD-8: retorna 404 cuando health.enabled=false', async () => {
    const healthConfig: HealthConfig = {
      enabled: false,
      path: '/health',
      backendPath: '/health',
      timeoutMs: 2000,
    };

    const config = makeConfig(
      [{ prefix: '/a', target: 'http://127.0.0.1:1', backendName: 'svc-a' }],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('BDD-9: usa el backendPath configurado al consultar cada servicio', async () => {
    okBackend.mode = 'ok';
    okBackend.healthPath = '/internal/health';

    const port = (okBackend.server.address() as AddressInfo).port;

    const healthConfig: HealthConfig = {
      enabled: true,
      path: '/health',
      backendPath: '/internal/health',
      timeoutMs: 2000,
    };

    const config = makeConfig(
      [{ prefix: '/a', target: `http://127.0.0.1:${port}`, backendName: 'svc-a' }],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
    } finally {
      await server.close();
      okBackend.healthPath = '/health'; // reset
    }
  });

  it('BDD-10: marca un servicio como down con error "connection failed" ante ECONNREFUSED', async () => {
    okBackend.mode = 'ok';

    // Puerto cerrado: garantizamos ECONNREFUSED en fetch
    const healthConfig: HealthConfig = {
      enabled: true,
      path: '/health',
      backendPath: '/health',
      timeoutMs: 500,
    };

    const config = makeConfig(
      [
        {
          prefix: '/a',
          target: `http://127.0.0.1:${(okBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-a',
        },
        // Puerto 1 está reservado como "no listening": generará connection refused
        {
          prefix: '/b',
          target: 'http://127.0.0.1:1',
          backendName: 'svc-b',
        },
      ],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      const svcB = body.services.find((s: { name: string }) => s.name === 'svc-b');
      // ECONNREFUSED puede llegar como error genérico de red o como timeout local;
      // aceptamos cualquiera de los dos normalizados: "connection failed" o "timeout after Xms"
      expect(['connection failed']).toContain(svcB.error);
    } finally {
      await server.close();
    }
  });

  it('acepta path personalizado (BDD-9 parte 2): health.path=/status responde solo en /status', async () => {
    okBackend.mode = 'ok';

    const healthConfig: HealthConfig = {
      enabled: true,
      path: '/status',
      backendPath: '/health',
      timeoutMs: 2000,
    };

    const config = makeConfig(
      [
        {
          prefix: '/a',
          target: `http://127.0.0.1:${(okBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-a',
        },
      ],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      const responseAtStatus = await server.inject({ method: 'GET', url: '/status' });
      expect(responseAtStatus.statusCode).toBe(200);
      expect(JSON.parse(responseAtStatus.body).status).toBe('ok');

      // /health NO debe estar registrado en este escenario
      const responseAtHealth = await server.inject({ method: 'GET', url: '/health' });
      expect(responseAtHealth.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('NO requiere autenticación: el endpoint responde sin Authorization header', async () => {
    okBackend.mode = 'ok';

    const healthConfig: HealthConfig = {
      enabled: true,
      path: '/health',
      backendPath: '/health',
      timeoutMs: 2000,
    };

    // Configuramos un route con jwt habilitado para /secure/*
    // y verificamos que /health sigue respondiendo sin Authorization header.
    const config = makeConfig(
      [
        {
          prefix: '/secure',
          target: `http://127.0.0.1:${(okBackend.server.address() as AddressInfo).port}`,
          backendName: 'secure-svc',
          jwt: {
            enabled: true,
            secret: 'test-secret-de-32-caracteres-ok!!!',
            algorithm: 'HS256',
            forwardClaims: ['sub'],
          },
        },
        {
          prefix: '/api',
          target: `http://127.0.0.1:${(okBackend.server.address() as AddressInfo).port}`,
          backendName: 'svc-a',
        },
      ],
      healthConfig,
    );

    const server = buildServer(config, new MiddlewarePipeline(), pino({ level: 'silent' }));
    try {
      // Sin Authorization header, /health debe responder (no se aplica JWT)
      const response = await server.inject({
        method: 'GET',
        url: '/health',
        headers: {},
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
    } finally {
      await server.close();
    }
  });
});