import { Redis } from 'ioredis';
import { FastifyInstance } from 'fastify';
import { loadConfig } from './config/loader.js';
import { createLogger } from './logger/setup.js';
import { RedisRateLimitStore } from './middleware/rate-limit/store.js';
import { RateLimitPlugin } from './middleware/rate-limit/plugin.js';
import { JwtAuthPlugin } from './middleware/jwt-auth/plugin.js';
import { JwtAuthRegistry } from './middleware/jwt-auth/registry.js';
import { MiddlewarePipeline, GatewayPlugin } from './middleware/pipeline.js';
import { buildServer } from './server.js';
import { RouteRegistry } from './routing/registry.js';
import { ConfigSnapshot } from './config/types.js';
import { ConfigReloader } from './config/reloader.js';
import { MetricsPlugin } from './middleware/metrics/plugin.js';
import { createCircuitBreakerPlugin } from './middleware/circuit-breaker/index.js';
import { CorsPlugin } from './middleware/cors/plugin.js';

let server: FastifyInstance | undefined;
let redis: Redis | undefined;
let snapshotRef: { current: ConfigSnapshot } | undefined;
let reloader: ConfigReloader | undefined;

/**
 * Función principal de arranque (bootstrap) del API Gateway.
 * Realiza las operaciones en secuencia estricta para garantizar un startup estable.
 */
async function bootstrap(): Promise<void> {
  // 1. Cargar e interpolar la configuración
  const config = loadConfig();

  // 2. Inicializar el logger estructurado con el nivel de log configurado
  const logger = createLogger(config.logging.level);
  logger.info('Iniciando proceso de bootstrap del API Gateway...');

  try {
    // 3. Conexión robusta a Redis con reintentos
    let isConnected = false;
    const redisUrl = config.redis.url;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logger.info(`Conectando a Redis en ${redisUrl} (Intento ${attempt}/3)...`);

        // Crear instancia de ioredis configurada con timeouts cortos para fallar rápido en el startup
        const tempRedis = new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          connectTimeout: 2000,
        });

        // Probar conexión atómicamente con ping
        await tempRedis.ping();
        redis = tempRedis;
        isConnected = true;
        logger.info('Conexión con Redis establecida exitosamente.');
        break;
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          `Intento ${attempt}/3 de conexión a Redis fallido`,
        );
        if (attempt < 3) {
          // Esperar 1 segundo antes de reintentar
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    if (!isConnected || !redis) {
      throw new Error('No se pudo establecer conexión con el servidor de Redis tras 3 intentos.');
    }

    // 4. Crear el snapshot de configuración inicial inmutable
    logger.info('Creando snapshot de configuración inicial...');
    const registry = new RouteRegistry(config);
    const jwtRegistry = new JwtAuthRegistry(config.jwt, logger);
    jwtRegistry.startAll();
    snapshotRef = {
      current: {
        config,
        registry,
        jwtRegistry,
        createdAt: new Date().toISOString(),
      },
    };

    // 5. Configurar los módulos de Rate Limiting y Autenticación JWT
    logger.info('Configurando módulo de Rate Limiting...');
    const rateLimitStore = new RedisRateLimitStore(redis);
    const rateLimitPlugin = new RateLimitPlugin(rateLimitStore, logger, config.redis.onFailure);

    logger.info('Configurando módulo de Autenticación JWT...');
    const jwtAuthPlugin = new JwtAuthPlugin(logger);
    jwtAuthPlugin.registry = jwtRegistry;

    // Configurar módulo CORS (PRIMER plugin en el pipeline, antes de rate-limit/auth/circuit-breaker)
    logger.info('Configurando módulo CORS...');
    const corsPlugin = new CorsPlugin(logger);

    // Configurar módulo de Métricas Prometheus
    let metricsPlugin: MetricsPlugin | undefined;
    const pluginsList: GatewayPlugin[] = [corsPlugin, rateLimitPlugin, jwtAuthPlugin];
    //                                                        ↑ CORS primero

    // Configurar Circuit Breaker
    const circuitBreakerPlugin = createCircuitBreakerPlugin(logger);
    pluginsList.push(circuitBreakerPlugin);

    if (config.metrics.enabled) {
      logger.info('Configurando módulo de Métricas Prometheus...');
      // Excluir el endpoint de health de las métricas HTTP para no contaminar
      // la observabilidad del tráfico proxied con requests de health checks.
      const excludedMetricPaths = config.health?.enabled ? [config.health.path] : [];
      metricsPlugin = new MetricsPlugin(config, logger, excludedMetricPaths);
      pluginsList.push(metricsPlugin);
    }

    // 6. Configurar e instanciar la Middleware Pipeline
    logger.info('Inicializando orquestador de Middleware Pipeline...');
    const pipeline = new MiddlewarePipeline(pluginsList);

    // 7. Construir e inicializar el servidor Fastify
    logger.info('Construyendo instancia del servidor Fastify...');
    server = buildServer(config, pipeline, logger, snapshotRef, metricsPlugin);

    // 8. Inicializar el módulo de recarga (ConfigReloader)
    const configPath = process.env['CONFIG_PATH'] || './config/gateway.yaml';
    reloader = new ConfigReloader(configPath, snapshotRef!, logger);

    // 9. Levantar el puerto y host del servidor de forma asíncrona
    const { port, host } = config.server;
    await server.listen({ port, host });

    logger.info(`API Gateway levantado y escuchando en http://${host}:${port}`);
  } catch (error) {
    logger.fatal(
      { err: error instanceof Error ? { message: error.message, stack: error.stack } : error },
      'Excepción fatal ocurrida durante el arranque (bootstrap) del API Gateway. Deteniendo el proceso...',
    );

    // Garantizar liberación de recursos en fallo de startup
    if (redis) {
      try {
        await redis.quit();
      } catch (_) {}
    }
    process.exit(1);
  }
}

/**
 * Manejador de apagado limpio y seguro (Graceful Shutdown) del proceso.
 *
 * @param signal Señal del sistema operativo (SIGTERM o SIGINT)
 */
async function gracefulShutdown(signal: string): Promise<void> {
  const logger = createLogger('info');
  logger.info(`Se ha recibido señal de apagado ${signal}. Iniciando shutdown graceful...`);

  try {
    // 1. Cerrar el servidor Fastify para dejar de aceptar peticiones
    if (server) {
      logger.info('Cerrando servidor Fastify (HTTP)...');
      await server.close();
      logger.info('Servidor HTTP cerrado exitosamente.');
    }

    // 2. Cerrar los pools de conexiones undici
    const serverWithPool = server as unknown as { poolManager?: { closeAll(): Promise<void> } };
    if (serverWithPool && serverWithPool.poolManager) {
      logger.info('Cerrando connection pools de backends...');
      await serverWithPool.poolManager.closeAll();
      logger.info('Connection pools cerrados exitosamente.');
    }

    // 2.1. Cerrar el registry de JWKS (detiene background refresh)
    if (snapshotRef) {
      logger.info('Cerrando registry de JWT (background refresh)...');
      await snapshotRef.current.jwtRegistry.stopAll();
      logger.info('Registry JWT detenido exitosamente.');
    }

    // 3. Cerrar la conexión con el store de Redis
    if (redis) {
      logger.info('Cerrando conexión a Redis...');
      await redis.quit();
      logger.info('Conexión a Redis liberada exitosamente.');
    }

    logger.info('Shutdown graceful completado con éxito. Saliendo del proceso...');
    process.exit(0);
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? { message: error.message, stack: error.stack } : error },
      'Error ocurrido durante el proceso de graceful shutdown.',
    );
    process.exit(1);
  }
}

// Escuchar señales del sistema operativo
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Escuchar la señal SIGHUP para recargar la configuración en caliente
process.on('SIGHUP', async () => {
  if (reloader) {
    await reloader.reload();
  }
});

// Arrancar la aplicación
bootstrap();
