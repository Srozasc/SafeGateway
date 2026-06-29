import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { createHealthHandler } from '../../../../src/middleware/health/handler.js';
import { ConfigSnapshot } from '../../../../src/config/types.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as aggregatorModule from '../../../../src/middleware/health/aggregator.js';

const logger = pino({ level: 'silent' });

interface MockReply {
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  statusCode: number;
  body: unknown;
}

function makeReply(): MockReply {
  const reply: MockReply = {
    statusCode: 200,
    body: undefined,
    status: vi.fn(),
    send: vi.fn(),
  };
  reply.status.mockImplementation((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send.mockImplementation((body: unknown) => {
    reply.body = body;
    return reply;
  });
  return reply;
}

function makeSnapshot(overrides: Partial<ConfigSnapshot> = {}): { current: ConfigSnapshot } {
  const config = {
    server: { port: 3000, host: '0.0.0.0' },
    redis: { url: 'redis://localhost:6379' },
    logging: { level: 'info' as const },
    metrics: { enabled: true, path: '/metrics', defaultLabels: {} },
    routes: [],
    health: {
      enabled: true,
      path: '/health',
      backendPath: '/health',
      timeoutMs: 2000,
    },
    ...(overrides as { health?: unknown }).config,
  } as ConfigSnapshot['config'];

  return {
    current: {
      config,
      registry: {} as ConfigSnapshot['registry'],
      createdAt: new Date().toISOString(),
      ...overrides,
    },
  };
}

describe('createHealthHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responde 200 con status=ok cuando todos los servicios están healthy', async () => {
    const snapshotRef = makeSnapshot();
    snapshotRef.current.config.routes = [
      { prefix: '/auth', target: 'http://auth:8080', backendName: 'auth' },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      ok: true,
    } as Response);

    const handler = createHealthHandler(snapshotRef, logger);
    const reply = makeReply();
    const req = {} as FastifyRequest;

    await handler(req, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toMatchObject({
      status: 'ok',
      services: [{ name: 'auth', status: 'ok', statusCode: 200 }],
    });
  });

  it('responde 503 con status=down cuando hay servicios caídos', async () => {
    const snapshotRef = makeSnapshot();
    snapshotRef.current.config.routes = [
      { prefix: '/auth', target: 'http://auth:8080', backendName: 'auth' },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 503,
      ok: false,
    } as Response);

    const handler = createHealthHandler(snapshotRef, logger);
    const reply = makeReply();

    await handler({} as FastifyRequest, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(503);
    expect((reply.body as { status: string }).status).toBe('down');
  });

  it('responde 200 con status=degraded cuando hay servicios con 4xx', async () => {
    const snapshotRef = makeSnapshot();
    snapshotRef.current.config.routes = [
      { prefix: '/auth', target: 'http://auth:8080', backendName: 'auth' },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 401,
      ok: false,
    } as Response);

    const handler = createHealthHandler(snapshotRef, logger);
    const reply = makeReply();

    await handler({} as FastifyRequest, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(200);
    expect((reply.body as { status: string }).status).toBe('degraded');
  });

  it('lee la lista de servicios desde el snapshot vivo (refleja SIGHUP)', async () => {
    const snapshotRef = makeSnapshot();
    snapshotRef.current.config.routes = [
      { prefix: '/v1', target: 'http://svc1:8080', backendName: 'svc1' },
    ];

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ status: 200, ok: true } as Response);

    const handler = createHealthHandler(snapshotRef, logger);

    // Primer request: 1 servicio
    await handler({} as FastifyRequest, makeReply() as unknown as FastifyReply);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Swap atómico del snapshot (simula SIGHUP que añade una ruta)
    snapshotRef.current = {
      ...snapshotRef.current,
      config: {
        ...snapshotRef.current.config,
        routes: [
          { prefix: '/v1', target: 'http://svc1:8080', backendName: 'svc1' },
          { prefix: '/v2', target: 'http://svc2:8080', backendName: 'svc2' },
        ],
      },
    };

    await handler({} as FastifyRequest, makeReply() as unknown as FastifyReply);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 nuevas
  });

  it('responde 503 con services vacío si el snapshot no tiene health configurado (fallback)', async () => {
    const snapshotRef = makeSnapshot();
    // Forzamos health a undefined para simular configuración inválida en runtime
    snapshotRef.current.config.health = undefined;

    const handler = createHealthHandler(snapshotRef, logger);
    const reply = makeReply();

    await handler({} as FastifyRequest, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(503);
    expect(reply.body).toMatchObject({
      status: 'down',
      services: [],
    });
  });

  it('maneja por-servicio los errores de red (fetch throw → service "down", handler responde 503)', async () => {
    const snapshotRef = makeSnapshot();
    snapshotRef.current.config.routes = [{ prefix: '/a', target: 'http://a', backendName: 'a' }];

    // Forzamos un error dentro del fetch (será capturado por el try/catch interno del aggregator)
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('unexpected boom');
    });

    const handler = createHealthHandler(snapshotRef, logger);
    const reply = makeReply();

    await handler({} as FastifyRequest, reply as unknown as FastifyReply);

    // El aggregator captura el error por servicio → 1 servicio "down", httpStatus 503
    expect(reply.statusCode).toBe(503);
    expect(reply.body).toMatchObject({
      status: 'down',
      services: [{ name: 'a', status: 'down', error: 'connection failed' }],
    });
  });

  it('responde 503 con services vacío si aggregate lanza una excepción inesperada (fallback de red de seguridad)', async () => {
    const snapshotRef = makeSnapshot();
    snapshotRef.current.config.routes = [{ prefix: '/a', target: 'http://a', backendName: 'a' }];

    // Forzamos que aggregate mismo lance (no los fetch internos)
    vi.spyOn(aggregatorModule, 'aggregate').mockRejectedValue(
      new Error('aggregator crashed unexpectedly'),
    );

    const handler = createHealthHandler(snapshotRef, logger);
    const reply = makeReply();

    await handler({} as FastifyRequest, reply as unknown as FastifyReply);

    // El handler convierte el error en fallback down/503 con services vacío
    expect(reply.statusCode).toBe(503);
    expect(reply.body).toMatchObject({ status: 'down', services: [] });
  });
});