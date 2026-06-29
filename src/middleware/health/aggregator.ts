import { Logger } from 'pino';
import { HealthConfig, RouteConfig } from '../../config/types.js';
import {
  AggregatedHealthResponse,
  GlobalHealthStatus,
  HttpStatusPair,
  ServiceHealthResult,
  ServiceHealthStatus,
} from './types.js';

/**
 * Lógica pura del endpoint de Health Aggregation.
 *
 * Consulta en paralelo el `backendPath` configurado en cada `routes[]`,
 * clasifica el resultado por servicio (ok / degraded / down) y agrega un
 * estado global con el código HTTP correspondiente.
 *
 * Usa `fetch` nativo de Node.js 20+ aislado del pool de Undici del proxy.
 * El timeout se aplica vía `AbortSignal.timeout(timeoutMs)` para garantizar
 * el SLA del endpoint independientemente de los timeouts del runtime/OS.
 *
 * Spec de referencia: specs/safegateway-health-aggregation.md
 */

/**
 * Resuelve el nombre del servicio para mostrar en la respuesta.
 *
 * Prioridad: route.backendName > hostname(target) > route.prefix.
 */
export function resolveServiceName(route: RouteConfig): string {
  if (route.backendName && route.backendName.length > 0) {
    return route.backendName;
  }
  try {
    const hostname = new URL(route.target).hostname;
    if (hostname) {
      return hostname;
    }
  } catch {
    // target no es una URL válida: caemos al fallback por prefix
  }
  return route.prefix;
}

/**
 * Construye la URL del health check para un servicio.
 * Remueve la barra final del target y concatena el backendPath.
 */
export function buildHealthUrl(target: string, backendPath: string): string {
  const normalizedTarget = target.replace(/\/+$/, '');
  const normalizedPath = backendPath.startsWith('/') ? backendPath : `/${backendPath}`;
  return `${normalizedTarget}${normalizedPath}`;
}

/**
 * Clasifica el status code HTTP en estado de salud.
 * - 2xx/3xx → ok
 * - 4xx → degraded
 * - 5xx → down
 */
export function classifyStatusCode(statusCode: number): ServiceHealthStatus {
  if (statusCode >= 500) {
    return 'down';
  }
  if (statusCode >= 400) {
    return 'degraded';
  }
  return 'ok';
}

/**
 * Determina el estado global a partir de los resultados por servicio.
 * - Algún "down" → global down
 * - Algún "degraded" (y ningún down) → global degraded
 * - Todos "ok" → global ok
 */
export function computeGlobalStatus(services: ServiceHealthResult[]): GlobalHealthStatus {
  if (services.some((s) => s.status === 'down')) {
    return 'down';
  }
  if (services.some((s) => s.status === 'degraded')) {
    return 'degraded';
  }
  return 'ok';
}

/**
 * Ejecuta un health check contra un único servicio downstream.
 */
async function checkService(
  route: RouteConfig,
  config: HealthConfig,
  logger: Logger,
): Promise<ServiceHealthResult> {
  const name = resolveServiceName(route);
  const url = buildHealthUrl(route.target, config.backendPath);
  const t0 = performance.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const latencyMs = Math.round(performance.now() - t0);
    const status = classifyStatusCode(response.status);

    if (status === 'down') {
      logger.debug(
        { service: name, statusCode: response.status, latencyMs },
        'health check down (5xx)',
      );
      return { name, status, latencyMs, statusCode: response.status };
    }
    if (status === 'degraded') {
      logger.debug(
        { service: name, statusCode: response.status, latencyMs },
        'health check degraded (4xx)',
      );
      return {
        name,
        status,
        latencyMs,
        statusCode: response.status,
        error: `backend returned ${response.status}`,
      };
    }
    logger.debug(
      { service: name, statusCode: response.status, latencyMs },
      'health check ok',
    );
    return { name, status, latencyMs, statusCode: response.status };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const error = err as { name?: string; message?: string };

    // fetch envuelve los timeouts en TimeoutError o AbortError según versión.
    // Normalizamos ambos casos al mismo mensaje.
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      logger.debug(
        { service: name, latencyMs, timeoutMs: config.timeoutMs },
        'health check down (timeout)',
      );
      return {
        name,
        status: 'down',
        latencyMs,
        error: `timeout after ${config.timeoutMs}ms`,
      };
    }

    // Fallos de socket / DNS / conexión rechazada → connection failed
    logger.debug(
      { service: name, latencyMs, err: error?.message ?? 'unknown' },
      'health check down (connection)',
    );
    return {
      name,
      status: 'down',
      latencyMs,
      error: 'connection failed',
    };
  }
}

/**
 * Agrega el estado de todos los servicios declarados en `routes[]`.
 *
 * Devuelve el cuerpo JSON y el HTTP status code a aplicar:
 * - 503 si global = down
 * - 200 si global = ok o degraded
 */
export async function aggregate(
  routes: ReadonlyArray<RouteConfig>,
  config: HealthConfig,
  logger: Logger,
): Promise<HttpStatusPair> {
  const start = Date.now();
  const services = await Promise.all(
    routes.map((route) => checkService(route, config, logger)),
  );

  const status = computeGlobalStatus(services);
  const httpStatus = status === 'down' ? 503 : 200;

  const body: AggregatedHealthResponse = {
    status,
    timestamp: new Date().toISOString(),
    services,
  };

  logger.debug(
    { durationMs: Date.now() - start, globalStatus: status, serviceCount: services.length },
    'Health aggregation completada',
  );

  return { httpStatus, body };
}