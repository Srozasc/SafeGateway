/**
 * Circuit Breaker Module
 *
 * Exports all circuit breaker related types, classes, and utilities.
 */

// Types
export type {
  CircuitBreakerConfig,
  CircuitBreakerMetrics,
  RetryConfig,
  RetryContext,
  RetryResult,
} from './types.js';
export {
  CircuitState,
  IDEMPOTENT_METHODS,
  RETRYABLE_ERROR_CODES,
  RETRYABLE_STATUS_CODES,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_RETRY_CONFIG,
  isRetryableMethod,
  isRetryableErrorCode,
  isRetryableStatusCode,
} from './types.js';

// State Machine
export { CircuitStateMachine, CircuitBreakerRegistry, type CircuitBreakerState } from './state.js';

// Retry Interceptor
export { RetryInterceptor, createRetryContext, calculateTotalDelay } from './retry.js';

// Plugin
export { CircuitBreakerPlugin, createCircuitBreakerPlugin, type CircuitBreakerPluginConfig, type CircuitBreakerPluginOptions } from './plugin.js';

// Metrics
export {
  createCircuitBreakerMetrics,
  CircuitBreakerMetricsRecorder,
  stateToMetricValue,
  CircuitStateMetricValue,
  type CircuitBreakerMetricsRegistry,
} from './metrics.js';