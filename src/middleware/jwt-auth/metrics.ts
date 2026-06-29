import { Counter, register } from 'prom-client';
import type { JwtValidationResult } from './types.js';

/**
 * Idempotente: retorna un counter existente si ya está registrado, o crea uno nuevo.
 * Evita colisiones cuando el plugin se reinstala o los tests importan múltiples veces.
 */
function getOrCreateCounter(
  name: string,
  help: string,
  labelNames: readonly string[],
): Counter<string> {
  const existing = register.getSingleMetric(name) as Counter<string> | undefined;
  if (existing) {return existing;}
  return new Counter({ name, help, labelNames: [...labelNames], registers: [register] });
}

/**
 * Total de validaciones JWT procesadas por el Gateway.
 * Cardinalidad baja (~10 valores en `result`).
 * @label result `ok | missing_token | unknown_kid | missing_kid | expired | invalid_issuer | invalid_audience | invalid_claims | invalid_signature | service_unavailable`
 */
export const jwtValidationsTotal: Counter<string> = getOrCreateCounter(
  'gateway_jwt_validations_total',
  'Total de validaciones JWT procesadas por el Gateway.',
  ['result'],
);

/**
 * Total de refrescos del JWKS remoto.
 * @label result `ok | error | cooldown`
 */
export const jwksRefreshTotal: Counter<string> = getOrCreateCounter(
  'gateway_jwks_refresh_total',
  'Total de refrescos del JWKS remoto.',
  ['result'],
);

export type JwksRefreshResult = 'ok' | 'error' | 'cooldown';

export function recordJwtValidation(result: JwtValidationResult): void {
  jwtValidationsTotal.labels(result).inc();
}

export function recordJwksRefresh(result: JwksRefreshResult): void {
  jwksRefreshTotal.labels(result).inc();
}

/** Resetea todos los counters de JWT — usado por tests. */
export function resetJwtMetrics(): void {
  jwtValidationsTotal.reset();
  jwksRefreshTotal.reset();
}
