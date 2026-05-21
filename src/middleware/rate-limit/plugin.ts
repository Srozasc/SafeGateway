import { FastifyRequest } from 'fastify';
import { Logger } from 'pino';
import { GatewayPlugin, RequestContext } from '../pipeline.js';
import { RateLimitStore } from './types.js';
import { getCurrentWindow, buildRateLimitKey } from './window.js';

export class RateLimitPlugin implements GatewayPlugin {
  public readonly name = 'rate-limit';
  private readonly store: RateLimitStore;
  private readonly logger: Logger;
  private readonly onFailure: 'open' | 'closed';

  constructor(store: RateLimitStore, logger: Logger, onFailure: 'open' | 'closed' = 'open') {
    this.store = store;
    this.logger = logger;
    this.onFailure = onFailure;
  }

  /**
   * Extrae la IP de origen de la petición de forma segura.
   */
  public extractIp(request: FastifyRequest): string {
    const xForwardedFor = request.headers['x-forwarded-for'];
    if (xForwardedFor) {
      const ipList = typeof xForwardedFor === 'string' ? xForwardedFor : xForwardedFor[0];
      if (ipList) {
        // Tomar la primera IP de la lista si hay varias (ej: "client, proxy1, proxy2")
        const clientIp = ipList.split(',')[0]?.trim();
        if (clientIp) {
          return clientIp;
        }
      }
    }

    return request.ip || 'unknown';
  }

  /**
   * Middleware hook ejecutado antes de reenviar el request al proxy.
   */
  public async onRequest(ctx: RequestContext): Promise<void> {
    const { request, reply, routeMatch } = ctx;
    const { effectiveRateLimit, route } = routeMatch;

    // 1. Si no hay configuración de rate limiting para esta ruta/override, omitir (no-op)
    if (!effectiveRateLimit) {
      return;
    }

    const { maxRequests, windowSeconds } = effectiveRateLimit;
    const ip = this.extractIp(request);
    const prefix = routeMatch.override ? routeMatch.override.path : route.prefix;

    // 2. Obtener la ventana temporal actual
    const nowMs = Date.now();
    const { windowStart, resetAt } = getCurrentWindow(windowSeconds, nowMs);
    const key = buildRateLimitKey(ip, prefix, windowStart);

    try {
      // 3. Incrementar atómicamente el contador en el store
      const { count } = await this.store.increment(key, windowSeconds);

      const remaining = Math.max(0, maxRequests - count);

      // 4. Inyectar headers informativos de Rate Limiting
      reply.header('X-RateLimit-Limit', maxRequests);
      reply.header('X-RateLimit-Remaining', remaining);
      reply.header('X-RateLimit-Reset', resetAt);

      // 5. Bloquear petición si se excede el límite (HTTP 429)
      if (count > maxRequests) {
        const secondsRemaining = Math.max(0, resetAt - Math.floor(nowMs / 1000));

        reply.header('Retry-After', secondsRemaining);
        reply.status(429).send({
          error: 'Too Many Requests',
          message: `Límite de peticiones excedido. Inténtalo de nuevo en ${secondsRemaining} segundos.`,
          retryAfter: secondsRemaining,
        });

        this.logger.warn(
          { ip, prefix, count, maxRequests, secondsRemaining },
          'Rate limit superado para la IP',
        );
      }
    } catch (error) {
      // 6. Manejo de caídas de Redis
      this.logger.warn({ err: error, ip, prefix }, 'Fallo al conectar con el store de Rate Limit');

      if (this.onFailure === 'closed') {
        // Comportamiento "fail-closed": bloquear petición con 503 si el rate limiter está inaccesible
        reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Servicio temporalmente no disponible debido a fallas en el rate limiter.',
        });
      }
      // Comportamiento "fail-open": omitir silenciosamente el error y permitir el request
    }
  }
}
