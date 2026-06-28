import { Counter, Histogram, register } from 'prom-client';
import type { CorsDecisionKind } from './types.js';

/**
 * Counter de decisiones CORS tomadas por el plugin.
 * Label `decision` con 4 valores posibles (baja cardinalidad):
 *   - 'allowed'   : Origin permitido, request normal pasa al backend
 *   - 'blocked'   : Origin NO permitido, request pasa sin headers CORS
 *   - 'preflight' : Preflight (OPTIONS) respondido con 204 sin pasar al backend
 *   - 'no_origin' : No había header Origin (server-to-server)
 */
export const corsRequestsTotal = new Counter({
  name: 'gateway_cors_requests_total',
  help: 'Total de peticiones procesadas por el plugin CORS, etiquetadas por decisión',
  labelNames: ['decision'] as const,
  registers: [register],
});

/**
 * Histogram de duración de la decisión CORS en segundos.
 * Mide desde el inicio de onRequest hasta:
 *   - el final de onBeforeResponse (para decision='allowed')
 *   - el final de onRequest (para decision='preflight' o 'blocked')
 * El label `decision` mantiene la misma baja cardinalidad que el counter.
 * Buckets optimizados para decisiones rápidas (típicamente <10ms).
 */
export const corsDecisionDurationSeconds = new Histogram({
  name: 'gateway_cors_decision_duration_seconds',
  help: 'Duración de la decisión CORS en segundos (onRequest → onBeforeResponse o short-circuit)',
  labelNames: ['decision'] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

/**
 * Incrementa el counter para una decisión CORS específica.
 * Helper para no repetir `corsRequestsTotal.labels(decision).inc()` en cada sitio.
 */
export function recordCorsDecision(kind: CorsDecisionKind): void {
  corsRequestsTotal.labels(kind).inc();
}

/**
 * Observa la duración de una decisión CORS.
 * @param kind Tipo de decisión tomada.
 * @param startTimeMs Timestamp (process.hrtime o Date.now()) del inicio de la decisión.
 */
export function recordCorsDecisionDuration(kind: CorsDecisionKind, startTimeMs: number): void {
  const durationSeconds = (Date.now() - startTimeMs) / 1000;
  corsDecisionDurationSeconds.labels(kind).observe(durationSeconds);
}

/**
 * Resetea el counter y el histogram. Útil para tests unitarios.
 */
export function resetCorsMetrics(): void {
  corsRequestsTotal.reset();
  corsDecisionDurationSeconds.reset();
}