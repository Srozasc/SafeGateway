import type { CorsConfig } from '../../config/types.js';

/**
 * Tipo de decisión que el plugin CORS toma sobre una petición.
 * - 'allowed':  Origin permitido, request normal pasa al backend, headers se agregan en onResponse
 * - 'blocked':  Origin NO permitido, request pasa al backend sin headers CORS
 * - 'preflight': Preflight (OPTIONS con Origin permitido), plugin responde 204 con short-circuit
 * - 'no_origin': No había header Origin (server-to-server), no se hace nada
 */
export type CorsDecisionKind = 'allowed' | 'blocked' | 'preflight' | 'no_origin';

/**
 * Decisión CORS tomada en onRequest, persistida en request.gatewayContext.corsDecision
 * para que onResponse pueda aplicar los headers correspondientes.
 */
export interface CorsDecision {
  kind: CorsDecisionKind;
  /** Origin normalizado que llegó en el request (null si no había Origin) */
  origin: string | null;
  /** Valor a reflejar en Access-Control-Allow-Origin ('*' o el origin específico) */
  allowedOrigin?: string;
  /** Config efectiva mergeada (todos los campos resueltos con defaults) */
  effectiveCors: CorsConfig;
  /** Headers solicitados en preflight (Access-Control-Request-Headers, comma-separated) — solo para preflight */
  requestedHeaders?: string;
  /** Método solicitado en preflight (Access-Control-Request-Method) — solo para preflight */
  requestedMethod?: string;
  /** Timestamp (ms) del inicio de onRequest — usado para métrica de duración */
  startTimeMs?: number;
}
