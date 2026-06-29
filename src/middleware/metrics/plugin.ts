import { FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { Logger } from 'pino';
import { register, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { GatewayConfig } from '../../config/types.js';
import { GatewayPlugin } from '../pipeline.js';
import { resolveRouteLabel, resolveBackendLabel } from './labels.js';
import { GatewayMetrics } from './types.js';

const METRICS_FINALIZED = Symbol('metricsFinalized');
const START_TIME = Symbol('metricsStartTime');
const INITIAL_LABELS = Symbol('metricsInitialLabels');

interface RequestWithMetrics extends FastifyRequest {
  [START_TIME]?: bigint;
  [INITIAL_LABELS]?: { method: string; route: string };
  [METRICS_FINALIZED]?: boolean;
}

export class MetricsPlugin implements GatewayPlugin {
  public readonly name = 'metrics';
  private readonly metricsPath: string;
  private readonly excludedPaths: Set<string>;
  private readonly metrics: GatewayMetrics;

  constructor(config: GatewayConfig, logger: Logger, additionalExcludedPaths: string[] = []) {
    this.metricsPath = config.metrics.path || '/metrics';
    // Construir el conjunto de paths excluidos: el endpoint de métricas +
    // cualquier path adicional (típicamente el endpoint de health aggregation)
    this.excludedPaths = new Set<string>([this.metricsPath, ...additionalExcludedPaths]);
    logger.info(
      { path: this.metricsPath, excludedPaths: Array.from(this.excludedPaths) },
      'Inicializando plugin de métricas Prometheus...',
    );

    // Configurar labels por defecto globales en el registro
    if (config.metrics.defaultLabels && Object.keys(config.metrics.defaultLabels).length > 0) {
      register.setDefaultLabels(config.metrics.defaultLabels);
    }

    // Habilitar métricas por defecto de Node.js
    collectDefaultMetrics({ register });

    // Inicializar métricas personalizadas del Gateway
    this.metrics = {
      requestsTotal: new Counter({
        name: 'gateway_http_requests_total',
        help: 'Total acumulado de requests HTTP procesados por el Gateway.',
        labelNames: ['method', 'route', 'status_code', 'backend'],
      }),
      requestDuration: new Histogram({
        name: 'gateway_http_request_duration_seconds',
        help: 'Latencia de cada request en segundos.',
        labelNames: ['method', 'route', 'status_code', 'backend'],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      }),
      requestsInFlight: new Gauge({
        name: 'gateway_http_requests_in_flight',
        help: 'Cantidad de requests activos en curso.',
        labelNames: ['method', 'route'],
      }),
      rateLimitHits: new Counter({
        name: 'gateway_rate_limit_hits_total',
        help: 'Total de requests rechazados con HTTP 429 por el módulo de Rate Limiting.',
        labelNames: ['route'],
      }),
    };
  }

  // Métodos de los Hooks Globales de Fastify

  /**
   * Determina si un request debe ser excluido de la instrumentación.
   * Excluye: /metrics, /health (u otros paths configurados).
   */
  private shouldSkip(request: FastifyRequest): boolean {
    const pathname = request.url.split('?')[0] || '/';
    return this.excludedPaths.has(pathname);
  }

  public onRequestHook = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (this.shouldSkip(request)) {
      return;
    }

    // Guardar tiempo de inicio
    (request as RequestWithMetrics)[START_TIME] = process.hrtime.bigint();

    // Resolver etiquetas iniciales para in-flight
    const route = resolveRouteLabel(request.gatewayContext?.routeMatch);
    const initialLabels = {
      method: request.method,
      route,
    };

    (request as RequestWithMetrics)[INITIAL_LABELS] = initialLabels;

    // Incrementar requests en curso
    this.metrics.requestsInFlight.inc(initialLabels);

    // Red de seguridad (safety net): listener en el socket para cierres abruptos
    request.raw.socket.once('close', () => {
      this.finalize(request, '499');
    });
  };

  public onResponseHook = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (this.shouldSkip(request)) {
      return;
    }
    this.finalize(request, reply.statusCode.toString());
  };

  public onErrorHook = async (
    request: FastifyRequest,
    reply: FastifyReply,
    error: FastifyError,
  ): Promise<void> => {
    if (this.shouldSkip(request)) {
      return;
    }
    // Usar código del error o el del reply, fallback a "500"
    const statusCode = (error.statusCode || reply.statusCode || 500).toString();
    this.finalize(request, statusCode);
  };

  public onAbortHook = async (request: FastifyRequest): Promise<void> => {
    if (this.shouldSkip(request)) {
      return;
    }
    this.finalize(request, '499');
  };

  /**
   * Finaliza el registro de métricas para una petición.
   * Garantiza ejecución EXACTAMENTE UNA VEZ por petición usando un Symbol.
   */
  private finalize(request: FastifyRequest, statusCode: string): void {
    if ((request as RequestWithMetrics)[METRICS_FINALIZED]) {
      return;
    }
    (request as RequestWithMetrics)[METRICS_FINALIZED] = true;

    // 1. Decrementar requests en curso con las mismas etiquetas iniciales
    const initialLabels = (request as RequestWithMetrics)[INITIAL_LABELS];
    if (initialLabels) {
      this.metrics.requestsInFlight.dec(initialLabels);
    }

    // 2. Registrar duración e incrementar total
    const startTime = (request as RequestWithMetrics)[START_TIME];
    const routeMatch = request.gatewayContext?.routeMatch;
    const route = resolveRouteLabel(routeMatch);
    const backend = resolveBackendLabel(routeMatch);

    const labels = {
      method: request.method,
      route,
      status_code: statusCode,
      backend,
    };

    if (startTime) {
      const diff = process.hrtime.bigint() - startTime;
      const durationSeconds = Number(diff) / 1e9;
      this.metrics.requestDuration.observe(labels, durationSeconds);
    }

    this.metrics.requestsTotal.inc(labels);

    // 3. Registrar hits de Rate Limiting
    if (statusCode === '429') {
      this.metrics.rateLimitHits.inc({ route });
    }
  }
}
