import { FastifyRequest, FastifyReply } from 'fastify';
import type { RouteMatch } from '../routing/types.js';
import type { GatewayContext } from '../config/types.js';
import { ProxyEngine } from '../proxy/engine.js';
import { ConnectionPoolManager } from '../proxy/pool.js';
import { NOOP_HOOKS } from '../proxy/hooks.js';
import type { ProxyLifecycleHooks } from '../proxy/types.js';
import { Logger } from 'pino';

// Extensión del tipo FastifyRequest para almacenar el contexto global del Gateway
declare module 'fastify' {
  interface FastifyRequest {
    gatewayContext?: GatewayContext;
  }
}

export interface RequestContext {
  request: FastifyRequest;
  reply: FastifyReply;
  routeMatch: RouteMatch;
}

export interface ResponseContext {
  request: FastifyRequest;
  reply: FastifyReply;
  routeMatch: RouteMatch;
  payload: unknown;
}

export interface GatewayPlugin {
  name: string;
  onRequest?(context: RequestContext): Promise<void>;
  onResponse?(context: ResponseContext): Promise<void>;
  getLifecycleHooks?(): ProxyLifecycleHooks;
}

export class MiddlewarePipeline {
  private readonly plugins: GatewayPlugin[];
  private lifecycleHooks: ProxyLifecycleHooks = {};

  constructor(plugins: GatewayPlugin[] = []) {
    this.plugins = plugins;
    this.collectLifecycleHooks();
  }

  /**
   * Collects lifecycle hooks from all plugins that implement getLifecycleHooks().
   */
  private collectLifecycleHooks(): void {
    for (const plugin of this.plugins) {
      if (plugin.getLifecycleHooks) {
        const hooks = plugin.getLifecycleHooks();
        this.lifecycleHooks = {
          ...this.lifecycleHooks,
          ...hooks,
        };
      }
    }
  }

  /**
   * Registers lifecycle hooks that integrate with the ProxyEngine.
   * These hooks are called by the proxy during request/response cycles.
   */
  public setLifecycleHooks(hooks: ProxyLifecycleHooks): void {
    this.lifecycleHooks = hooks;
  }

  /**
   * Gets the registered lifecycle hooks for ProxyEngine integration.
   */
  public getLifecycleHooks(): ProxyLifecycleHooks {
    return this.lifecycleHooks;
  }

  /**
   * Ejecuta secuencialmente el gancho `onRequest` de todos los plugins registrados.
   * Si un plugin invoca un short-circuit (ej. respondiendo la petición directamente
   * mediante `reply.send`), detiene inmediatamente la ejecución del pipeline.
   *
   * @param ctx Contexto de la petición HTTP actual.
   */
  public async executeOnRequest(ctx: RequestContext): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onRequest) {
        await plugin.onRequest(ctx);
        // Short-circuit: Si el plugin envió una respuesta al cliente, detener ejecución
        if (ctx.reply.sent) {
          break;
        }
      }
    }
  }

  /**
   * Ejecuta secuencialmente el gancho `onResponse` de todos los plugins registrados.
   *
   * @param ctx Contexto de la respuesta HTTP actual.
   */
  public async executeOnResponse(ctx: ResponseContext): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onResponse) {
        await plugin.onResponse(ctx);
      }
    }
  }

  /**
   * Genera una función de hook compatible con la firma `preHandler` de Fastify.
   * Recupera el contexto de ruteo y orquesta la ejecución del pipeline.
   */
  public getPreHandler() {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const gatewayContext = request.gatewayContext;

      // Si no existe contexto del gateway o coincidencia de ruta, omitir
      if (!gatewayContext || !gatewayContext.routeMatch) {
        return;
      }

      const ctx: RequestContext = {
        request,
        reply,
        routeMatch: gatewayContext.routeMatch,
      };

      await this.executeOnRequest(ctx);
    };
  }
}

/**
 * Creates a proxy handler that integrates with the middleware pipeline.
 * The proxy is the LAST step after all middleware plugins have run.
 */
export function createProxyHandler(
  poolManager: ConnectionPoolManager,
  logger: Logger,
  lifecycleHooks: ProxyLifecycleHooks = NOOP_HOOKS,
  pipeline?: MiddlewarePipeline
) {
  const proxyEngine = new ProxyEngine(poolManager, lifecycleHooks, logger);

  return async function proxyHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const gatewayContext = request.gatewayContext;
    if (!gatewayContext?.routeMatch) {
      // No route matched - let Fastify handle 404
      reply.status(404).send({
        error: 'Not Found',
        message: 'No route matched',
        statusCode: 404,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Forward to backend using the proxy engine
    try {
      await proxyEngine.forward(request, reply, gatewayContext.routeMatch);

      // Execute onResponse hook for all plugins after successful response
      if (pipeline) {
        const responseContext: ResponseContext = {
          request,
          reply,
          routeMatch: gatewayContext.routeMatch,
          payload: { statusCode: reply.statusCode },
        };
        await pipeline.executeOnResponse(responseContext);
      }
    } catch (error) {
      // Execute onResponse hook with error payload
      if (pipeline) {
        const responseContext: ResponseContext = {
          request,
          reply,
          routeMatch: gatewayContext.routeMatch,
          payload: { error: true },
        };
        await pipeline.executeOnResponse(responseContext);
      }
      throw error;
    }
  };
}