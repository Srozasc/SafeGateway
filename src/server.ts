import fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import httpProxy from '@fastify/http-proxy';
import { Logger } from 'pino';
import { GatewayConfig } from './config/types.js';
import { RouteRegistry } from './routing/registry.js';
import { MiddlewarePipeline } from './middleware/pipeline.js';
import { registerErrorHandler } from './errors/handler.js';
import { buildForwardingHeaders } from './proxy/headers.js';

// Declarar el decorator en el tipo FastifyInstance
declare module 'fastify' {
  interface FastifyInstance {
    routeRegistry: RouteRegistry;
  }
}

/**
 * Registra de manera dinámica y reactiva los plugins de `@fastify/http-proxy` para cada ruta
 * especificada en la configuración del Gateway.
 * 
 * @param server Instancia de Fastify.
 * @param config Configuración del Gateway.
 * @param pipeline Orquestador de middlewares.
 */
export function registerProxyRoutes(
  server: FastifyInstance,
  config: GatewayConfig,
  pipeline: MiddlewarePipeline
): void {
  // Registrar los proxies de forma invertida o según el matching (de más específico a menos específico)
  // para que Fastify haga match correcto del prefijo en cascada
  const sortedRoutes = [...config.routes].sort((a, b) => b.prefix.length - a.prefix.length);

  for (const route of sortedRoutes) {
    const rewritePrefix = route.stripPrefix ? '' : route.prefix;

    const replyOptions: any = {
      rewriteRequestHeaders: (request: FastifyRequest, headers: Record<string, string | string[] | undefined>) => {
        const forwarding = buildForwardingHeaders(request);
        return {
          ...headers,
          ...forwarding,
        };
      },
    };

    // Configurar timeouts si se especifican
    if (route.timeout?.response) {
      replyOptions.timeout = route.timeout.response;
    }

    server.log.info(
      { prefix: route.prefix, target: route.target, stripPrefix: route.stripPrefix },
      `Registrando proxy inverso para prefijo: ${route.prefix} -> ${route.target}`
    );

    server.register(httpProxy, {
      upstream: route.target,
      prefix: route.prefix,
      rewritePrefix,
      preHandler: pipeline.getPreHandler(),
      replyOptions,
      // undiciOptions adicionales en caso de timeouts de conexión
      undici: route.timeout?.connect ? {
        connectTimeout: route.timeout.connect,
      } : undefined,
    });
  }
}

/**
 * Construye e inicializa el servidor Fastify unificando ruteo, middlewares y políticas de error.
 * 
 * @param config Configuración del Gateway cargada e inmutable.
 * @param pipeline Orquestador del pipeline de middlewares.
 * @param logger Instancia compartida de Logger Pino.
 * @returns Instancia configurada del servidor Fastify.
 */
export function buildServer(
  config: GatewayConfig,
  pipeline: MiddlewarePipeline,
  logger: Logger
): FastifyInstance {
  const server = fastify({
    logger: {
      level: logger.level || 'info',
    },
    disableRequestLogging: true, // Desactivar logs por defecto de Fastify para usar nuestro sistema customizado
  });

  // 1. Registrar manejador de errores y no encontrados globales
  registerErrorHandler(server);

  // 2. Instanciar y almacenar el RouteRegistry en la instancia del servidor
  const registry = new RouteRegistry(config);
  server.decorate('routeRegistry', registry);

  // 3. Agregar hook onRequest global para matchear la ruta y guardar el contexto en la petición
  server.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    const match = registry.match(request.url);
    if (match) {
      request.routeContext = match;
    }
  });

  // 4. Registrar los proxies de microservicios basados en la configuración
  registerProxyRoutes(server, config, pipeline);

  return server;
}
