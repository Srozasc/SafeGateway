import { describe, it, expect, beforeEach, vi, Mocked } from 'vitest';
import { pino } from 'pino';
import { FastifyRequest, FastifyReply } from 'fastify';
import { CorsPlugin } from '../../../../src/middleware/cors/plugin.js';
import type { RequestContext } from '../../../../src/middleware/pipeline.js';
import { resetCorsMetrics } from '../../../../src/middleware/cors/metrics.js';
import type { CorsConfig } from '../../../../src/config/types.js';
import type { RouteMatch } from '../../../../src/routing/types.js';

// Logger silencioso para tests
const silentLogger = pino({ level: 'silent' });

const defaultCors: CorsConfig = {
  enabled: true,
  origins: ['https://app.flashdrop.cl'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: [],
  credentials: false,
  maxAge: 86400,
};

describe('CorsPlugin', () => {
  let mockReply: Mocked<FastifyReply> & {
    sent: boolean;
    statusCode: number;
  };
  let mockRequest: FastifyRequest & {
    method: string;
    headers: Record<string, string | string[] | undefined>;
    gatewayContext: {
      routeMatch?: RouteMatch;
      corsDecision?: {
        kind: string;
        origin?: string;
        effectiveCors?: CorsConfig;
        allowedOrigin?: string;
      };
    };
  };

  beforeEach(() => {
    resetCorsMetrics();
    mockReply = {
      header: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      sent: false,
      statusCode: 200,
    } as unknown as Mocked<FastifyReply> & { sent: boolean; statusCode: number };
    mockRequest = {
      method: 'GET',
      headers: {},
      gatewayContext: { routeMatch: undefined },
    } as unknown as FastifyRequest & {
      method: string;
      headers: Record<string, string | string[] | undefined>;
      gatewayContext: {
        routeMatch?: RouteMatch;
        corsDecision?: {
          kind: string;
          origin?: string;
          effectiveCors?: CorsConfig;
          allowedOrigin?: string;
        };
      };
    };
  });

  function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
    return {
      request: mockRequest,
      reply: mockReply,
      routeMatch: {
        route: { prefix: '/api', target: 'http://backend' },
        override: null,
        effectiveRateLimit: null,
        effectiveCors: defaultCors,
        ...(overrides.routeMatch || {}),
      },
      ...overrides,
    } as RequestContext;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 1: Request normal desde origin permitido
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 1: Request normal desde origin permitido', () => {
    it('debería almacenar decisión "allowed" en gatewayContext', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(ctx.request.gatewayContext?.corsDecision?.kind).toBe('allowed');
      expect(ctx.request.gatewayContext?.corsDecision?.allowedOrigin).toBe('https://app.flashdrop.cl');
    });

    it('NO debería responder directamente (deja pasar al backend)', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(mockReply.send).not.toHaveBeenCalled();
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it('onResponse es un no-op (los headers se aplican via lifecycle hook onBeforeResponse)', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      await plugin.onResponse();

      // onResponse NO agrega headers — eso lo hace el lifecycle hook
      expect(mockReply.header).not.toHaveBeenCalled();
    });

    it('getLifecycleHooks().onBeforeResponse debería agregar headers CORS a la respuesta del backend', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      // Simular el lifecycle hook con headers de respuesta del backend
      const responseHeaders: Record<string, string | string[]> = {};
      const hooks = plugin.getLifecycleHooks();
      if (hooks.onBeforeResponse) {
        await hooks.onBeforeResponse(
          { statusCode: 200, headers: responseHeaders, backend: 'http://backend' },
          {
            request: ctx.request,
            routeMatch: ctx.routeMatch,
            startTime: BigInt(0),
          },
        );
      }

      expect(responseHeaders['Access-Control-Allow-Origin']).toBe('https://app.flashdrop.cl');
      expect(responseHeaders['Access-Control-Allow-Methods']).toEqual(expect.any(String));
      expect(responseHeaders['Access-Control-Allow-Headers']).toEqual(expect.any(String));
      expect(responseHeaders['Vary']).toBe('Origin');
    });

    it('NO debería emitir Access-Control-Allow-Credentials cuando credentials=false (A15)', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      // Verificar via lifecycle hook
      const responseHeaders: Record<string, string | string[]> = {};
      const hooks = plugin.getLifecycleHooks();
      if (hooks.onBeforeResponse) {
        await hooks.onBeforeResponse(
          { statusCode: 200, headers: responseHeaders, backend: 'http://backend' },
          {
            request: ctx.request,
            routeMatch: ctx.routeMatch,
            startTime: BigInt(0),
          },
        );
      }

      expect(responseHeaders['Access-Control-Allow-Credentials']).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 2: Request desde origin NO permitido
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 2: Request desde origin NO permitido', () => {
    it('NO debería agregar headers CORS', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://malicious.com' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(ctx.request.gatewayContext?.corsDecision).toBeUndefined();
      expect(mockReply.header).not.toHaveBeenCalled();
    });

    it('debería pasar al backend normalmente (no short-circuit)', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://malicious.com' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(mockReply.send).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 3: Preflight request (OPTIONS)
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 3: Preflight request (OPTIONS)', () => {
    it('debería responder 204 con headers CORS', async () => {
      mockRequest.method = 'OPTIONS';
      mockRequest.headers = {
        origin: 'https://app.flashdrop.cl',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Content-Type, Authorization',
      };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(mockReply.status).toHaveBeenCalledWith(204);
      expect(mockReply.send).toHaveBeenCalled();
      expect(mockReply.header).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://app.flashdrop.cl');
      expect(mockReply.header).toHaveBeenCalledWith('Access-Control-Allow-Methods', expect.any(String));
      expect(mockReply.header).toHaveBeenCalledWith('Access-Control-Allow-Headers', expect.any(String));
      expect(mockReply.header).toHaveBeenCalledWith('Access-Control-Max-Age', '86400');
      expect(mockReply.header).toHaveBeenCalledWith('Vary', 'Origin');
    });

    it('NO debería incluir Access-Control-Expose-Headers en preflights (A13)', async () => {
      mockRequest.method = 'OPTIONS';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext({
        routeMatch: {
          route: { prefix: '/api', target: 'http://backend' },
          override: null,
          effectiveRateLimit: null,
          effectiveCors: { ...defaultCors, exposedHeaders: ['X-Request-ID'] },
        } as unknown as RouteMatch,
      });

      await plugin.onRequest(ctx);

      const calls = mockReply.header.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain('Access-Control-Expose-Headers');
    });

    it('NO debería incluir Access-Control-Allow-Credentials cuando credentials=false (A15)', async () => {
      mockRequest.method = 'OPTIONS';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      const calls = mockReply.header.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain('Access-Control-Allow-Credentials');
    });

    it('debería incluir Allow-Credentials=true solo si credentials=true', async () => {
      mockRequest.method = 'OPTIONS';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext({
        routeMatch: {
          route: { prefix: '/api', target: 'http://backend' },
          override: null,
          effectiveRateLimit: null,
          effectiveCors: { ...defaultCors, credentials: true },
        } as unknown as RouteMatch,
      });

      await plugin.onRequest(ctx);

      expect(mockReply.header).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 5: Override por ruta con policy wildcard
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 5: Override por ruta con policy wildcard', () => {
    it('debería usar "*" como allowedOrigin', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://anywhere.com' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext({
        routeMatch: {
          route: { prefix: '/api/dev', target: 'http://backend' },
          override: null,
          effectiveRateLimit: null,
          effectiveCors: { ...defaultCors, origins: ['*'] },
        } as unknown as RouteMatch,
      });

      await plugin.onRequest(ctx);

      expect(ctx.request.gatewayContext?.corsDecision?.allowedOrigin).toBe('*');
    });

    it('NO debería agregar Vary: Origin con wildcard (A14)', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://anywhere.com' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext({
        routeMatch: {
          route: { prefix: '/api/dev', target: 'http://backend' },
          override: null,
          effectiveRateLimit: null,
          effectiveCors: { ...defaultCors, origins: ['*'] },
        } as unknown as RouteMatch,
      });

      await plugin.onRequest(ctx);

      const responseHeaders: Record<string, string | string[]> = {};
      const hooks = plugin.getLifecycleHooks();
      if (hooks.onBeforeResponse) {
        await hooks.onBeforeResponse(
          { statusCode: 200, headers: responseHeaders, backend: 'http://backend' },
          {
            request: ctx.request,
            routeMatch: ctx.routeMatch,
            startTime: BigInt(0),
          },
        );
      }

      expect(responseHeaders['Vary']).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 6: Override por ruta con CORS deshabilitado
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 6: Override por ruta con CORS deshabilitado', () => {
    it('NO debería agregar headers CORS cuando effectiveCors.enabled=false', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext({
        routeMatch: {
          route: { prefix: '/internal', target: 'http://backend' },
          override: null,
          effectiveRateLimit: null,
          effectiveCors: { ...defaultCors, enabled: false },
        } as unknown as RouteMatch,
      });

      await plugin.onRequest(ctx);

      expect(mockReply.header).not.toHaveBeenCalled();
      expect(ctx.request.gatewayContext?.corsDecision).toBeUndefined();
    });

    it('debería ser no-op si effectiveCors es null', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext({
        routeMatch: {
          route: { prefix: '/api', target: 'http://backend' },
          override: null,
          effectiveRateLimit: null,
          effectiveCors: null,
        } as unknown as RouteMatch,
      });

      await plugin.onRequest(ctx);

      expect(mockReply.header).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 8: Request sin header Origin (server-to-server)
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 8: Request sin header Origin', () => {
    it('NO debería agregar headers CORS', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = {};
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(mockReply.header).not.toHaveBeenCalled();
      expect(ctx.request.gatewayContext?.corsDecision).toBeUndefined();
    });

    it('NO debería responder directamente (pasa al backend)', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = {};
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(mockReply.send).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 10: Preflight sin Access-Control-Request-Method
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 10: Preflight sin Access-Control-Request-Method', () => {
    it('debería tratar OPTIONS + Origin como preflight igual (A10)', async () => {
      mockRequest.method = 'OPTIONS';
      mockRequest.headers = { origin: 'https://app.flashdrop.cl' };
      // Sin Access-Control-Request-Method ni Access-Control-Request-Headers
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(mockReply.status).toHaveBeenCalledWith(204);
      expect(mockReply.send).toHaveBeenCalled();
      expect(mockReply.header).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://app.flashdrop.cl');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 11: Origin vacío o "null"
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 11: Origin vacío o "null"', () => {
    it('debería tratar Origin vacío como ausente', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: '' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(mockReply.header).not.toHaveBeenCalled();
    });

    it('debería tratar Origin="null" como ausente', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'null' };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(mockReply.header).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 12: Múltiples headers Origin
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 12: Múltiples headers Origin', () => {
    it('debería tomar el primer valor', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = {
        origin: ['https://app.flashdrop.cl', 'https://other.flashdrop.cl'] as unknown as string,
      };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext();

      await plugin.onRequest(ctx);

      expect(ctx.request.gatewayContext?.corsDecision?.allowedOrigin).toBe('https://app.flashdrop.cl');
    });

    it('debería loguear warning solo una vez (incluso con múltiples requests)', async () => {
      const warnLogger = pino({ level: 'warn' });
      // Spy
      const warnSpy = vi.spyOn(warnLogger, 'warn');

      mockRequest.method = 'GET';
      mockRequest.headers = {
        origin: ['https://app.flashdrop.cl', 'https://other.flashdrop.cl'] as unknown as string,
      };
      const plugin = new CorsPlugin(warnLogger);
      const ctx1 = makeContext();
      await plugin.onRequest(ctx1);

      // Segundo request con múltiples origins
      mockReply = { header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis(), sent: false, statusCode: 200 } as unknown as Mocked<FastifyReply> & { sent: boolean; statusCode: number };
      mockRequest = {
        method: 'GET',
        headers: { origin: ['https://x.com', 'https://y.com'] as unknown as string },
        gatewayContext: { routeMatch: undefined as unknown as RouteMatch },
      } as unknown as FastifyRequest & {
        method: string;
        headers: Record<string, string | string[] | undefined>;
        gatewayContext: {
          routeMatch?: RouteMatch;
          corsDecision?: {
            kind: string;
            origin?: string;
            effectiveCors?: CorsConfig;
            allowedOrigin?: string;
          };
        };
      };
      const ctx2 = makeContext();
      await plugin.onRequest(ctx2);

      // Solo debe haber logueado una vez
      const multiOriginCalls = warnSpy.mock.calls.filter((c) =>
        c[1]?.includes?.('multiple Origin headers detected'),
      );
      expect(multiOriginCalls).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Escenario 13: Preflight con header solicitado no permitido
  // ─────────────────────────────────────────────────────────────────────
  describe('Escenario 13: Preflight con header solicitado no permitido', () => {
    it('debería reflejar solo los headers permitidos en Allow-Headers', async () => {
      mockRequest.method = 'OPTIONS';
      mockRequest.headers = {
        origin: 'https://app.flashdrop.cl',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Content-Type, X-Custom-Hdr',
      };
      const plugin = new CorsPlugin(silentLogger);
      const ctx = makeContext({
        routeMatch: {
          route: { prefix: '/api', target: 'http://backend' },
          override: null,
          effectiveRateLimit: null,
          effectiveCors: { ...defaultCors, allowedHeaders: ['Content-Type', 'Authorization'] },
        } as unknown as RouteMatch,
      });

      await plugin.onRequest(ctx);

      expect(mockReply.header).toHaveBeenCalledWith('Access-Control-Allow-Headers', 'content-type');
      // X-Custom-Hdr no debe estar en los headers emitidos
      const allHeaderValues = mockReply.header.mock.calls.map((c) => c[1]).join(',');
      expect(allHeaderValues).not.toContain('X-Custom-Hdr');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // onResponse: comportamiento
  // ─────────────────────────────────────────────────────────────────────
  describe('onResponse', () => {
    it('NO debería agregar headers si no hay corsDecision (e.g., preflight)', async () => {
      mockRequest.method = 'OPTIONS';
      mockRequest.gatewayContext = { routeMatch: undefined as unknown as RouteMatch };
      const plugin = new CorsPlugin(silentLogger);

      await plugin.onResponse();

      expect(mockReply.header).not.toHaveBeenCalled();
    });

    it('NO debería agregar headers si corsDecision.kind=blocked', async () => {
      mockRequest.method = 'GET';
      mockRequest.headers = { origin: 'https://malicious.com' };
      mockRequest.gatewayContext = {
        routeMatch: undefined as unknown as RouteMatch,
        corsDecision: {
          kind: 'blocked',
          origin: 'https://malicious.com',
          effectiveCors: defaultCors,
        },
      };
      const plugin = new CorsPlugin(silentLogger);

      await plugin.onResponse();

      expect(mockReply.header).not.toHaveBeenCalled();
    });
  });
});