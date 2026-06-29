/**
 * Barrel exports del módulo de Health Aggregation.
 *
 * Spec de referencia: specs/safegateway-health-aggregation.md
 */

export {
  aggregate,
  buildHealthUrl,
  classifyStatusCode,
  computeGlobalStatus,
  resolveServiceName,
} from './aggregator.js';
export { createHealthHandler } from './handler.js';
export type {
  AggregatedHealthResponse,
  GlobalHealthStatus,
  HttpStatusPair,
  ServiceHealthResult,
  ServiceHealthStatus,
} from './types.js';