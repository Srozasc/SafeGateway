// Barrel exports para el módulo CORS.
export { CorsPlugin } from './plugin.js';
export {
  normalizeOrigin,
  matchOrigin,
  extractOrigin,
  validateCorsCombination,
} from './origins.js';
export {
  buildPreflightHeaders,
  buildActualResponseHeaders,
  filterRequestedHeaders,
  extractRequestedMethod,
  extractRequestedHeaders,
} from './headers.js';
export {
  corsRequestsTotal,
  corsDecisionDurationSeconds,
  recordCorsDecision,
  recordCorsDecisionDuration,
  resetCorsMetrics,
} from './metrics.js';
export {
  mergeCorsConfigs,
  applyDefaults,
  DEFAULT_CORS_CONFIG,
} from './merge.js';
export type { CorsDecision, CorsDecisionKind } from './types.js';