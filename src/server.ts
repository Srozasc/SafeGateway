import fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Logger } from 'pino';
import { register } from 'prom-client';
import { GatewayConfig, ConfigSnapshot } from './config/types.js';
import { RouteRegistry } from './routing/registry.js';
import { JwtAuthRegistry } from './middleware/jwt-auth/registry.js';
import { MiddlewarePipeline, createProxyHandler } from './middleware/pipeline.js';
import { registerErrorHandler } from './errors/handler.js';
import { MetricsPlugin } from './middleware/metrics/plugin.js';
import { ConnectionPoolManager } from './proxy/pool.js';
import { createHealthHandler } from './middleware/health/index.js';

// Declarar el decorator en el tipo FastifyInstance
declare module 'fastify' {
  interface FastifyInstance {
    routeRegistry: RouteRegistry;
    jwtAuthRegistry: JwtAuthRegistry;
  }
}

/**
 * Construye e inicializa el servidor Fastify unificando ruteo, middlewares y políticas de error.
 * Usa ProxyEngine (undici) para el forwarding de requests.
 *
 * @param config Configuración del Gateway cargada e inmutable.
 * @param pipeline Orquestador del pipeline de middlewares.
 * @param logger Instancia compartida de Logger Pino.
 * @param snapshotRef Referencia mutable opcional al snapshot de configuración activo.
 * @returns Instancia configurada del servidor Fastify.
 */
export function buildServer(
  config: GatewayConfig,
  pipeline: MiddlewarePipeline,
  logger: Logger,
  snapshotRef?: { current: ConfigSnapshot },
  metricsPlugin?: MetricsPlugin,
): FastifyInstance {
  const server = fastify({
    logger: {
      level: logger.level || 'info',
    },
    disableRequestLogging: true, // Desactivar logs por defecto de Fastify para usar nuestro sistema customizado
  });

  // 1. Registrar manejador de errores y no encontrados globales
  registerErrorHandler(server);

  // Asegurar retrocompatibilidad: crear un snapshotRef local si no fue provisto
  const finalSnapshotRef = snapshotRef || {
    current: {
      config,
      registry: new RouteRegistry(config),
      jwtRegistry: new JwtAuthRegistry(config.jwt, logger),
      createdAt: new Date().toISOString(),
    },
  };

  // 2. Almacenar el RouteRegistry de forma reactiva en la instancia del servidor
  Object.defineProperty(server, 'routeRegistry', {
    get: () => finalSnapshotRef.current.registry,
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(server, 'jwtAuthRegistry', {
    get: () => finalSnapshotRef.current.jwtRegistry,
    enumerable: true,
    configurable: true,
  });

  // 3. Agregar hook onRequest global para matchear la ruta y guardar el contexto en la petición
  server.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    const match = finalSnapshotRef.current.registry.match(request.url);
    if (match) {
      request.gatewayContext = {
        routeMatch: match,
      };
    }
  });

  // 3.1. Registrar ganchos globales de métricas si están habilitados
  if (config.metrics?.enabled && metricsPlugin) {
    server.addHook('onRequest', metricsPlugin.onRequestHook);
    server.addHook('onResponse', metricsPlugin.onResponseHook);
    server.addHook('onError', metricsPlugin.onErrorHook);
    server.addHook('onRequestAbort', metricsPlugin.onAbortHook);
  }

  // 3.2. Registrar endpoint /metrics nativo (no-proxy) antes de las rutas proxy
  if (config.metrics?.enabled) {
    const metricsPath = config.metrics.path || '/metrics';
    server.get(metricsPath, async (_request, reply) => {
      reply.header('Content-Type', register.contentType).send(await register.metrics());
    });
  }

  // 3.3. Registrar endpoint /health nativo (no-proxy) antes de las rutas proxy
  // Se registra como ruta nativa (no como GatewayPlugin) para que:
  //  - bypassa el pipeline de middlewares (auth, rate-limit, circuit-breaker)
  //  - nunca se proxia a un backend
  //  - lee `routes[]` del snapshot vivo, por lo que respeta SIGHUP
  if (config.health?.enabled) {
    const healthPath = config.health.path || '/health';
    server.get(healthPath, createHealthHandler(finalSnapshotRef, logger));
  }

  // 4. Crear el ConnectionPoolManager para los backends
  const poolManager = new ConnectionPoolManager(logger);

  // 5. Crear el handler de proxy usando el pipeline con sus lifecycle hooks
  const proxyHandler = createProxyHandler(
    poolManager,
    logger,
    pipeline.getLifecycleHooks(),
    pipeline
  );

  // 6. Registrar las rutas usando el preHandler del pipeline + proxy handler
  const sortedRoutes = [...finalSnapshotRef.current.config.routes].sort(
    (a, b) => b.prefix.length - a.prefix.length
  );

  for (const routeConfig of sortedRoutes) {
    logger.info(
      { prefix: routeConfig.prefix, target: routeConfig.target, stripPrefix: routeConfig.stripPrefix },
      `Registrando proxy para prefijo: ${routeConfig.prefix} -> ${routeConfig.target}`
    );

    // Append wildcard to match all subpaths under this prefix
    // E.g., '/api' becomes '/api*' to match '/api', '/api/users', '/api/items'
    // We use /prefix* syntax which matches the prefix followed by anything
    // If prefix ends with /, append just * (e.g., '/api/' -> '/api/*')
    // If prefix doesn't end with /, append * (e.g., '/api' -> '/api*')
    const routeUrl = `${routeConfig.prefix}*`;

    // Register the route with preHandler (middleware pipeline) and the actual handler (proxy)
    server.route({
      method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
      url: routeUrl,
      preHandler: pipeline.getPreHandler(),
      handler: proxyHandler,
    });
  }

  // 7. Almacenar el poolManager para poder cerrarlo en shutdown
  (server as unknown as { poolManager: typeof poolManager }).poolManager = poolManager;

  return server;
}