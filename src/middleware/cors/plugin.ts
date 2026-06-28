import type { Logger } from 'pino';
import type { GatewayPlugin, RequestContext } from '../pipeline.js';
import type { ProxyLifecycleHooks } from '../../proxy/types.js';
import { extractOrigin, matchOrigin } from './origins.js';
import {
  buildActualResponseHeaders,
  buildPreflightHeaders,
  extractRequestedHeaders,
  extractRequestedMethod,
} from './headers.js';
import { recordCorsDecision, recordCorsDecisionDuration } from './metrics.js';
import type { CorsDecision } from './types.js';

/**
 * Plugin CORS para el Gateway.
 *
 * Decisiones tomadas en onRequest, aplicadas via lifecycle hook onBeforeResponse.
 *
 * - Preflights (OPTIONS con Origin permitido) se responden 204 sin pasar al backend.
 * - Requests normales desde origins permitidos pasan al backend; los headers CORS
 *   se agregan en onBeforeResponse (lifecycle hook) para que estén listos ANTES
 *   de que el proxy envíe la respuesta al cliente.
 * - Origins no permitidos pasan al backend sin headers CORS.
 * - Requests sin Origin (server-to-server) no son afectados.
 *
 * Es el PRIMER plugin en el pipeline (ver src/index.ts) para que preflights no
 * consuman rate-limit, auth ni circuit breaker.
 */
export class CorsPlugin implements GatewayPlugin {
  public readonly name = 'cors';

  // Flag para evitar spam de logs por múltiples headers Origin (A12)
  private multiOriginWarningLogged = false;

  constructor(private readonly logger: Logger) {}

  /**
   * Hook ejecutado antes del proxy. Aquí se toman las decisiones CORS.
   */
  public async onRequest(ctx: RequestContext): Promise<void> {
    const { request, reply, routeMatch } = ctx;
    const headers = request.headers as Record<string, string | string[] | undefined>;

    // Capturar timestamp de inicio para métrica de duración
    const startTimeMs = Date.now();

    // 1. Extraer el origin (A11: null si vacío/ausente/"null")
    const origin = extractOrigin(headers);
    if (origin === null) {
      // No hay Origin → server-to-server, no hacemos nada (Escenario 8)
      recordCorsDecision('no_origin');
      recordCorsDecisionDuration('no_origin', startTimeMs);
      return;
    }

    // 1b. Detectar múltiples headers Origin (A12) y loguear warning una sola vez
    const originHeader = headers['origin'] ?? headers['Origin'];
    if (
      Array.isArray(originHeader) &&
      originHeader.length > 1 &&
      !this.multiOriginWarningLogged
    ) {
      this.logger.warn(
        { count: originHeader.length },
        'cors: multiple Origin headers detected, using first value',
      );
      this.multiOriginWarningLogged = true;
    }

    // 2. Resolver la config efectiva (puede ser null si no hay cors configurado)
    const effectiveCors = routeMatch.effectiveCors;
    if (!effectiveCors || !effectiveCors.enabled) {
      // CORS deshabilitado para esta ruta → pasar al backend sin tocar nada
      recordCorsDecision('no_origin');
      recordCorsDecisionDuration('no_origin', startTimeMs);
      return;
    }

    // 3. Verificar si el origin está permitido
    const match = matchOrigin(origin, effectiveCors.origins ?? []);

    if (match === 'blocked') {
      // Origin no permitido → pasar al backend sin agregar headers CORS (Escenario 2)
      this.logger.debug(
        { origin, prefix: routeMatch.route.prefix, decision: 'blocked' },
        `cors: blocked origin ${origin} for route ${routeMatch.route.prefix}`,
      );
      recordCorsDecision('blocked');
      recordCorsDecisionDuration('blocked', startTimeMs);
      return;
    }

    // 4. Origin permitido → decidir si es preflight o request normal
    const allowedOrigin = match === 'wildcard' ? '*' : origin;

    if (request.method === 'OPTIONS') {
      // Preflight (Escenario 3): responder 204 con headers CORS, sin pasar al backend
      const requestedMethod = extractRequestedMethod(headers);
      const requestedHeaders = extractRequestedHeaders(headers);

      const decision: CorsDecision = {
        kind: 'preflight',
        origin,
        allowedOrigin,
        effectiveCors,
        requestedMethod,
        requestedHeaders,
      };

      const corsHeaders = buildPreflightHeaders(decision);
      for (const [name, value] of Object.entries(corsHeaders)) {
        reply.header(name, value);
      }

      this.logger.debug(
        { origin, prefix: routeMatch.route.prefix, decision: 'preflight', requestedMethod },
        `cors: preflight ${origin} → 204`,
      );

      recordCorsDecision('preflight');
      recordCorsDecisionDuration('preflight', startTimeMs);
      reply.status(204).send();
      return;
    }

    // 5. Request normal con origin permitido → guardar decisión para onBeforeResponse
    const decision: CorsDecision = {
      kind: 'allowed',
      origin,
      allowedOrigin,
      effectiveCors,
      startTimeMs,
    };

    if (request.gatewayContext) {
      request.gatewayContext.corsDecision = decision;
    }

    this.logger.debug(
      { origin, prefix: routeMatch.route.prefix, decision: 'allowed' },
      `cors: allowed origin ${origin} for route ${routeMatch.route.prefix}`,
    );

    recordCorsDecision('allowed');
    // NO enviar respuesta: el pipeline continúa hacia rate-limit, jwt-auth y el proxy
  }

  /**
   * Hook ejecutado después del proxy. El pipeline del proxy ya llamó
   * `reply.send()` antes de invocar onResponse, por lo que este hook es
   * un no-op para CORS — los headers se agregan en onBeforeResponse (lifecycle hook).
   * Se mantiene por contrato de la interfaz GatewayPlugin.
   */
  public async onResponse(): Promise<void> {
    // No-op: los headers CORS se aplican en getLifecycleHooks().onBeforeResponse,
    // que se ejecuta ANTES de que el proxy envíe la respuesta al cliente.
  }

  /**
   * Lifecycle hooks del proxy. Se usan para:
   * - onBeforeResponse: agregar headers CORS a la respuesta del backend ANTES
   *   de que se envíe al cliente (el onResponse del plugin se llama demasiado tarde).
   */
  public getLifecycleHooks(): ProxyLifecycleHooks {
    return {
      onBeforeResponse: async ({ headers }, context) => {
        const decision = context.request.gatewayContext?.corsDecision;
        if (!decision || decision.kind !== 'allowed') {
          return;
        }
        const corsHeaders = buildActualResponseHeaders(decision);
        for (const [name, value] of Object.entries(corsHeaders)) {
          headers[name] = value;
        }
        // Métrica de duración: desde inicio de onRequest hasta este punto
        if (decision.startTimeMs !== undefined) {
          recordCorsDecisionDuration('allowed', decision.startTimeMs);
        }
      },
    };
  }
}