import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { FastifyRequest, FastifyReply } from 'fastify';
import {
  MiddlewarePipeline,
  GatewayPlugin,
  RequestContext,
  ResponseContext,
} from '../../../src/middleware/pipeline.js';
import { RouteMatch } from '../../../src/routing/types.js';

describe('MiddlewarePipeline', () => {
  let mockRequest: Mocked<FastifyRequest>;
  let mockReply: Mocked<FastifyReply>;
  let mockRouteMatch: RouteMatch;

  beforeEach(() => {
    mockRequest = {
      headers: {},
    } as unknown as Mocked<FastifyRequest>;

    mockReply = {
      sent: false,
      send: vi.fn().mockImplementation(function (this: { sent: boolean }) {
        this.sent = true;
        return this;
      }),
    } as unknown as Mocked<FastifyReply>;

    mockRouteMatch = {
      route: { prefix: '/api', target: 'http://localhost' },
      override: null,
      effectiveRateLimit: null,
      effectiveCors: null,
    };
  });

  it('debería inicializarse con una lista vacía de plugins por defecto', async () => {
    const pipeline = new MiddlewarePipeline();
    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await expect(pipeline.executeOnRequest(ctx)).resolves.not.toThrow();
  });

  it('debería ejecutar los plugins en orden secuencial', async () => {
    const orderOfExecution: string[] = [];

    const pluginA: GatewayPlugin = {
      name: 'plugin-a',
      onRequest: async () => {
        orderOfExecution.push('A');
      },
    };

    const pluginB: GatewayPlugin = {
      name: 'plugin-b',
      onRequest: async () => {
        orderOfExecution.push('B');
      },
    };

    const pipeline = new MiddlewarePipeline([pluginA, pluginB]);
    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await pipeline.executeOnRequest(ctx);

    expect(orderOfExecution).toEqual(['A', 'B']);
  });

  it('debería hacer short-circuit si un plugin envía una respuesta (reply.sent es true)', async () => {
    const executed: string[] = [];

    const plugin1: GatewayPlugin = {
      name: 'plugin-1',
      onRequest: async () => {
        executed.push('1');
      },
    };

    const plugin2: GatewayPlugin = {
      name: 'plugin-2',
      onRequest: async (ctx) => {
        executed.push('2');
        ctx.reply.send({ message: 'Bloqueado' }); // Esto marca reply.sent = true
      },
    };

    const plugin3: GatewayPlugin = {
      name: 'plugin-3',
      onRequest: async () => {
        executed.push('3');
      },
    };

    const pipeline = new MiddlewarePipeline([plugin1, plugin2, plugin3]);
    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await pipeline.executeOnRequest(ctx);

    // Debe detenerse en el 2 y NO ejecutar el plugin 3
    expect(executed).toEqual(['1', '2']);
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Bloqueado' });
    expect(mockReply.sent).toBe(true);
  });

  it('debería ignorar plugins que no implementen el hook onRequest', async () => {
    const executed: string[] = [];

    const pluginWithOnRequest: GatewayPlugin = {
      name: 'with-hook',
      onRequest: async () => {
        executed.push('with');
      },
    };

    const pluginWithoutOnRequest: GatewayPlugin = {
      name: 'without-hook',
      // No implementa onRequest
    };

    const pipeline = new MiddlewarePipeline([pluginWithOnRequest, pluginWithoutOnRequest]);
    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await expect(pipeline.executeOnRequest(ctx)).resolves.not.toThrow();
    expect(executed).toEqual(['with']);
  });

  it('debería ejecutar secuencialmente los hooks onResponse en executeOnResponse', async () => {
    const orderOfExecution: string[] = [];

    const plugin1: GatewayPlugin = {
      name: 'plugin-1',
      onResponse: async () => {
        orderOfExecution.push('R1');
      },
    };

    const plugin2: GatewayPlugin = {
      name: 'plugin-2',
      onResponse: async () => {
        orderOfExecution.push('R2');
      },
    };

    const pipeline = new MiddlewarePipeline([plugin1, plugin2]);
    const ctx: ResponseContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
      payload: { data: 'test' },
    };

    await pipeline.executeOnResponse(ctx);

    expect(orderOfExecution).toEqual(['R1', 'R2']);
  });

  describe('getPreHandler', () => {
    it('debería omitir la ejecución si request.gatewayContext no está presente', async () => {
      const onRequestSpy = vi.fn<() => Promise<void>>();
      const plugin: GatewayPlugin = {
        name: 'test-plugin',
        onRequest: onRequestSpy,
      };

      const pipeline = new MiddlewarePipeline([plugin]);
      const preHandler = pipeline.getPreHandler();

      // Request sin 'gatewayContext'
      const req = {} as unknown as FastifyRequest;

      await preHandler(req, mockReply);

      expect(onRequestSpy).not.toHaveBeenCalled();
    });

    it('debería ejecutar el pipeline si request.gatewayContext está presente', async () => {
      const onRequestSpy = vi.fn<(context: RequestContext) => Promise<void>>().mockResolvedValue(undefined);
      const plugin: GatewayPlugin = {
        name: 'test-plugin',
        onRequest: onRequestSpy,
      };

      const pipeline = new MiddlewarePipeline([plugin]);
      const preHandler = pipeline.getPreHandler();

      // Request con 'gatewayContext'
      const req = {
        gatewayContext: {
          routeMatch: mockRouteMatch,
        },
      } as unknown as FastifyRequest;

      await preHandler(req, mockReply);

      expect(onRequestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          request: req,
          reply: mockReply,
          routeMatch: mockRouteMatch,
        }),
      );
    });

    it('debería propagar cualquier excepción lanzada dentro del pipeline', async () => {
      const plugin: GatewayPlugin = {
        name: 'error-plugin',
        onRequest: async () => {
          throw new Error('Database connection failed');
        },
      };

      const pipeline = new MiddlewarePipeline([plugin]);
      const preHandler = pipeline.getPreHandler();

      const req = {
        gatewayContext: {
          routeMatch: mockRouteMatch,
        },
      } as unknown as FastifyRequest;

      await expect(preHandler(req, mockReply)).rejects.toThrow('Database connection failed');
    });
  });
});
