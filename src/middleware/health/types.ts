/**
 * Tipos del módulo de Health Aggregation.
 *
 * Define los estados posibles (per-service y global) y las estructuras de
 * respuesta que entrega el endpoint `GET /health`.
 *
 * Spec de referencia: specs/safegateway-health-aggregation.md
 */

export type ServiceHealthStatus = 'ok' | 'degraded' | 'down';
export type GlobalHealthStatus = 'ok' | 'degraded' | 'down';

/**
 * Resultado del health check de un único servicio downstream.
 *
 * - `statusCode` se incluye cuando el servicio respondió (incluso si es 4xx/5xx).
 * - `error` se incluye cuando el servicio no respondió (timeout, ECONNREFUSED,
 *   ENOTFOUND, etc.) o cuando respondió con 4xx (mensaje descriptivo).
 */
export interface ServiceHealthResult {
  name: string;
  status: ServiceHealthStatus;
  latencyMs: number;
  statusCode?: number;
  error?: string;
}

/**
 * Cuerpo de respuesta del endpoint agregado de health.
 */
export interface AggregatedHealthResponse {
  status: GlobalHealthStatus;
  timestamp: string;
  services: ServiceHealthResult[];
}

/**
 * Resultado del aggregator: cuerpo JSON + código HTTP a aplicar.
 *
 * - 200 si global = ok o degraded (mantiene al gateway en balanceadores).
 * - 503 si global = down.
 */
export interface HttpStatusPair {
  httpStatus: number;
  body: AggregatedHealthResponse;
}