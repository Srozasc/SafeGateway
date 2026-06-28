import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Logger } from 'pino';
import { RateLimitPlugin } from '../../../../src/middleware/rate-limit/plugin.js';
import { RateLimitStore } from '../../../../src/middleware/rate-limit/types.js';
import { RequestContext } from '../../../../src/middleware/pipeline.js';

describe('RateLimitPlugin', () => {
  let mockStore: Mocked<RateLimitStore>;
  let mockLogger: Mocked<Logger>;
  let mockReply: Mocked<FastifyReply>;

  beforeEach(() => {
    mockStore = {
      increment: vi.fn(),
    } as unknown as Mocked<RateLimitStore>;

    mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Mocked<Logger>;

    mockReply = {
      header: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as unknown as Mocked<FastifyReply>;
  });

  describe('extractIp', () => {
    it('debería retornar request.ip si no hay header X-Forwarded-For', () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger);
      const mockReq = {
        headers: {},
        ip: '192.168.1.10',
      } as unknown as FastifyRequest;

      const ip = plugin.extractIp(mockReq);
      expect(ip).toBe('192.168.1.10');
    });

    it('debería retornar "unknown" si no hay ip ni header', () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger);
      const mockReq = {
        headers: {},
      } as unknown as FastifyRequest;

      const ip = plugin.extractIp(mockReq);
      expect(ip).toBe('unknown');
    });

    it('debería extraer la IP del header X-Forwarded-For si es un string simple', () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger);
      const mockReq = {
        headers: {
          'x-forwarded-for': '10.0.0.5',
        },
        ip: '192.168.1.10',
      } as unknown as FastifyRequest;

      const ip = plugin.extractIp(mockReq);
      expect(ip).toBe('10.0.0.5');
    });

    it('debería tomar la primera IP si X-Forwarded-For contiene una lista', () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger);
      const mockReq = {
        headers: {
          'x-forwarded-for': '192.168.2.1, 10.0.0.1, 172.16.0.1',
        },
        ip: '192.168.1.10',
      } as unknown as FastifyRequest;

      const ip = plugin.extractIp(mockReq);
      expect(ip).toBe('192.168.2.1');
    });

    it('debería extraer la IP si X-Forwarded-For se provee como un array de strings', () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger);
      const mockReq = {
        headers: {
          'x-forwarded-for': ['203.0.113.195', '198.51.100.1'],
        },
        ip: '192.168.1.10',
      } as unknown as FastifyRequest;

      const ip = plugin.extractIp(mockReq);
      expect(ip).toBe('203.0.113.195');
    });
  });

  describe('onRequest', () => {
    it('debería omitir el proceso (no-op) si la ruta no tiene rateLimit efectivo configurado', async () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger);
      const mockReq = {
        headers: {},
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const ctx: RequestContext = {
        request: mockReq,
        reply: mockReply,
        routeMatch: {
          route: { prefix: '/api', target: 'http://localhost' },
          override: null,
          effectiveRateLimit: null, // Sin rate limit
          effectiveCors: null,
        },
      };

      await plugin.onRequest(ctx);

      expect(mockStore.increment).not.toHaveBeenCalled();
      expect(mockReply.header).not.toHaveBeenCalled();
    });

    it('debería registrar headers informativos e incrementar si está bajo el límite', async () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger);
      const mockReq = {
        headers: { 'x-forwarded-for': '8.8.8.8' },
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const ctx: RequestContext = {
        request: mockReq,
        reply: mockReply,
        routeMatch: {
          route: { prefix: '/api', target: 'http://localhost' },
          override: null,
          effectiveRateLimit: { maxRequests: 10, windowSeconds: 60 },
          effectiveCors: null,
        },
      };

      // Simular que va por la petición número 3 de 10
      mockStore.increment.mockResolvedValue({ count: 3 });

      await plugin.onRequest(ctx);

      // Debe consultar al store con la IP correcta y el prefijo
      expect(mockStore.increment).toHaveBeenCalledWith(
        expect.stringContaining('ratelimit:8.8.8.8:/api:'),
        60,
      );

      // Verificar inyección de cabeceras de límite
      expect(mockReply.header).toHaveBeenCalledWith('X-RateLimit-Limit', 10);
      expect(mockReply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', 7); // 10 - 3 = 7
      expect(mockReply.header).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));

      // No debe bloquear ni registrar warnings
      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('debería bloquear con HTTP 429 y Retry-After si excede el límite de peticiones', async () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger);
      const mockReq = {
        headers: {},
        ip: '192.168.10.15',
      } as unknown as FastifyRequest;

      const ctx: RequestContext = {
        request: mockReq,
        reply: mockReply,
        routeMatch: {
          route: { prefix: '/admin', target: 'http://localhost' },
          override: null,
          effectiveRateLimit: { maxRequests: 5, windowSeconds: 30 },
          effectiveCors: null,
        },
      };

      // Simular que va por la petición número 6 (ya excedido, porque max es 5)
      mockStore.increment.mockResolvedValue({ count: 6 });

      await plugin.onRequest(ctx);

      // Verificar inyección de cabeceras
      expect(mockReply.header).toHaveBeenCalledWith('X-RateLimit-Limit', 5);
      expect(mockReply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', 0); // Restante es 0 al exceder
      expect(mockReply.header).toHaveBeenCalledWith('Retry-After', expect.any(Number));

      // Debe bloquear con 429
      expect(mockReply.status).toHaveBeenCalledWith(429);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Too Many Requests',
          retryAfter: expect.any(Number),
        }),
      );

      // Debe registrar el incidente en el logger como advertencia
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '192.168.10.15',
          prefix: '/admin',
          count: 6,
          maxRequests: 5,
        }),
        'Rate limit superado para la IP',
      );
    });

    it('debería actuar en modo fail-open (dejar pasar) si Redis falla y onFailure es "open"', async () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger, 'open');
      const mockReq = {
        headers: {},
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const ctx: RequestContext = {
        request: mockReq,
        reply: mockReply,
        routeMatch: {
          route: { prefix: '/api', target: 'http://localhost' },
          override: null,
          effectiveRateLimit: { maxRequests: 10, windowSeconds: 60 },
          effectiveCors: null,
        },
      };

      // Simular fallo catastrófico en el Store (ej. redis desconectado)
      mockStore.increment.mockRejectedValue(new Error('Connection lost to Redis'));

      await plugin.onRequest(ctx);

      // En modo fail-open, no debe bloquear con 429 ni 503
      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();

      // Debe registrar la advertencia del fallo de conexión
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          ip: '127.0.0.1',
          prefix: '/api',
        }),
        'Fallo al conectar con el store de Rate Limit',
      );
    });

    it('debería actuar en modo fail-closed (bloquear con 503) si Redis falla y onFailure es "closed"', async () => {
      const plugin = new RateLimitPlugin(mockStore, mockLogger, 'closed');
      const mockReq = {
        headers: {},
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const ctx: RequestContext = {
        request: mockReq,
        reply: mockReply,
        routeMatch: {
          route: { prefix: '/api', target: 'http://localhost' },
          override: null,
          effectiveRateLimit: { maxRequests: 10, windowSeconds: 60 },
          effectiveCors: null,
        },
      };

      // Simular fallo catastrófico en el Store
      mockStore.increment.mockRejectedValue(new Error('Connection lost to Redis'));

      await plugin.onRequest(ctx);

      // En modo fail-closed, bloquea la petición con 503 Service Unavailable
      expect(mockReply.status).toHaveBeenCalledWith(503);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Service Unavailable',
          message: expect.stringContaining('rate limiter'),
        }),
      );

      // Debe registrar la advertencia del fallo de conexión
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          ip: '127.0.0.1',
          prefix: '/api',
        }),
        'Fallo al conectar con el store de Rate Limit',
      );
    });
  });
});
