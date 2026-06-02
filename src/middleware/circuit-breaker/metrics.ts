/**
 * Circuit Breaker Prometheus Metrics
 *
 * Exposes metrics for monitoring circuit breaker and retry behavior.
 */

import { Registry, Counter, Gauge, Histogram } from 'prom-client';

// ============================================
// Metric Registries
// ============================================

export interface CircuitBreakerMetricsRegistry {
  state: Gauge;
  failuresTotal: Counter;
  requestsTotal: Counter;
  transitionsTotal: Counter;
  openTotal: Counter;
  retriesTotal: Counter;
  retrySuccessTotal: Counter;
  retryDelay: Histogram;
}

export function createCircuitBreakerMetrics(registry: Registry): CircuitBreakerMetricsRegistry {
  return {
    state: new Gauge({
      name: 'gateway_circuit_breaker_state',
      help: 'Circuit breaker state: 0=CLOSED, 1=HALF_OPEN, 2=OPEN',
      labelNames: ['route', 'backend'],
      registers: [registry],
    }),

    failuresTotal: new Counter({
      name: 'gateway_circuit_breaker_failures_total',
      help: 'Total number of circuit breaker failures',
      labelNames: ['route', 'backend'],
      registers: [registry],
    }),

    requestsTotal: new Counter({
      name: 'gateway_circuit_breaker_requests_total',
      help: 'Total number of requests processed by circuit breaker',
      labelNames: ['route', 'backend', 'status'],
      registers: [registry],
    }),

    transitionsTotal: new Counter({
      name: 'gateway_circuit_breaker_transitions_total',
      help: 'Total number of circuit breaker state transitions',
      labelNames: ['route', 'backend', 'from_state', 'to_state'],
      registers: [registry],
    }),

    openTotal: new Counter({
      name: 'gateway_circuit_breaker_open_total',
      help: 'Total number of times circuit breaker opened',
      labelNames: ['route', 'backend'],
      registers: [registry],
    }),

    retriesTotal: new Counter({
      name: 'gateway_retries_total',
      help: 'Total number of retries performed',
      labelNames: ['route', 'backend', 'error_code'],
      registers: [registry],
    }),

    retrySuccessTotal: new Counter({
      name: 'gateway_retry_success_total',
      help: 'Total number of retries that succeeded',
      labelNames: ['route', 'backend'],
      registers: [registry],
    }),

    retryDelay: new Histogram({
      name: 'gateway_retry_delay_seconds',
      help: 'Delay between retry attempts',
      labelNames: ['route', 'attempt'],
      buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
      registers: [registry],
    }),
  };
}

// ============================================
// State Mapping
// ============================================

export enum CircuitStateMetricValue {
  CLOSED = 0,
  HALF_OPEN = 1,
  OPEN = 2,
}

export function stateToMetricValue(state: string): number {
  switch (state) {
    case 'CLOSED':
      return CircuitStateMetricValue.CLOSED;
    case 'HALF_OPEN':
      return CircuitStateMetricValue.HALF_OPEN;
    case 'OPEN':
      return CircuitStateMetricValue.OPEN;
    default:
      return CircuitStateMetricValue.CLOSED;
  }
}

// ============================================
// Metrics Recorder
// ============================================

export class CircuitBreakerMetricsRecorder {
  private readonly metrics: CircuitBreakerMetricsRegistry;

  constructor(metrics: CircuitBreakerMetricsRegistry) {
    this.metrics = metrics;
  }

  /**
   * Records the current circuit state.
   */
  recordState(route: string, backend: string, state: string): void {
    this.metrics.state.set({ route, backend }, stateToMetricValue(state));
  }

  /**
   * Records a failure increment.
   */
  recordFailure(route: string, backend: string): void {
    this.metrics.failuresTotal.inc({ route, backend });
  }

  /**
   * Records a request completion.
   */
  recordRequest(route: string, backend: string, status: 'success' | 'failure'): void {
    this.metrics.requestsTotal.inc({ route, backend, status });
  }

  /**
   * Records a state transition.
   */
  recordTransition(route: string, backend: string, fromState: string, toState: string): void {
    this.metrics.transitionsTotal.inc({ route, backend, from_state: fromState, to_state: toState });
    if (toState === 'OPEN') {
      this.metrics.openTotal.inc({ route, backend });
    }
  }

  /**
   * Records a retry attempt.
   */
  recordRetry(route: string, backend: string, errorCode: string): void {
    this.metrics.retriesTotal.inc({ route, backend, error_code: errorCode });
  }

  /**
   * Records a successful retry.
   */
  recordRetrySuccess(route: string, backend: string): void {
    this.metrics.retrySuccessTotal.inc({ route, backend });
  }

  /**
   * Records retry delay.
   */
  recordRetryDelay(route: string, attempt: number, delayMs: number): void {
    this.metrics.retryDelay.observe({ route, attempt: String(attempt) }, delayMs / 1000);
  }
}

/**
 * Creates a metrics recorder with a new registry.
 */
export function createCircuitBreakerMetricsRecorder(): CircuitBreakerMetricsRecorder {
  const registry = new Registry();
  const metrics = createCircuitBreakerMetrics(registry);
  return new CircuitBreakerMetricsRecorder(metrics);
}