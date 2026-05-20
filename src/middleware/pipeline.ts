import { FastifyRequest, FastifyReply } from 'fastify';
import { RouteMatch } from '../routing/types.js';

// Extensión del tipo FastifyRequest para almacenar el contexto de coincidencia de ruta
declare module 'fastify' {
  interface FastifyRequest {
    routeContext?: RouteMatch;
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
}

export class MiddlewarePipeline {
  private readonly plugins: GatewayPlugin[];

  constructor(plugins: GatewayPlugin[] = []) {
    this.plugins = plugins;
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
      const routeContext = request.routeContext;
      
      // Si no existe contexto de ruta (ej: ruta no matcheada o estática que no pasa por el gateway), omitir
      if (!routeContext) {
        return;
      }

      const ctx: RequestContext = {
        request,
        reply,
        routeMatch: routeContext,
      };

      await this.executeOnRequest(ctx);
    };
  }
}
