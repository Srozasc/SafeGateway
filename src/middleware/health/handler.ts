import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ConfigSnapshot } from '../../config/types.js';
import { aggregate } from './aggregator.js';
import { AggregatedHealthResponse } from './types.js';

/**
 * Crea el handler de Fastify para el endpoint `GET /health`.
 *
 * El handler se registra como ruta nativa de Fastify (no como GatewayPlugin),
 * antes de las rutas de proxy. Esto garantiza que bypassa el pipeline de
 * middlewares (auth, rate-limit, circuit-breaker) y nunca se proxia a un
 * backend.
 *
 * La lista de servicios se lee dinámicamente del snapshot activo, por lo que
 * los cambios en `routes[]` vía SIGHUP se reflejan sin re-registrar el endpoint.
 *
 * @param snapshotRef Referencia mutable al snapshot de configuración activo.
 * @param logger Instancia compartida de Logger Pino.
 */
export function createHealthHandler(
  snapshotRef: { current: ConfigSnapshot },
  logger: Logger,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function healthHandler(
    _request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const snapshot = snapshotRef.current;
    const healthConfig = snapshot.config.health;

    // Salvaguarda: si por alguna razón el snapshot no trae `health`, devolvemos down.
    if (!healthConfig || !healthConfig.enabled) {
      const fallback: AggregatedHealthResponse = {
        status: 'down',
        timestamp: new Date().toISOString(),
        services: [],
      };
      reply.status(503).send(fallback);
      return;
    }

    try {
      const { httpStatus, body } = await aggregate(
        snapshot.config.routes,
        healthConfig,
        logger,
      );
      reply.status(httpStatus).send(body);
    } catch (err) {
      // aggregate nunca debería lanzar (los errores de fetch se manejan internamente),
      // pero mantenemos este catch como red de seguridad para no tumbar el endpoint.
      logger.error(
        { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
        'Error inesperado en el health handler',
      );
      const fallback: AggregatedHealthResponse = {
        status: 'down',
        timestamp: new Date().toISOString(),
        services: [],
      };
      reply.status(503).send(fallback);
    }
  };
}