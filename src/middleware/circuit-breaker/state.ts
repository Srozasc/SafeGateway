/**
 * Circuit Breaker State Machine
 *
 * Implements the state machine for the circuit breaker pattern.
 * States: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
 */

import { Logger } from 'pino';
import {
  CircuitState,
  CircuitBreakerConfig,
  CircuitBreakerMetrics,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from './types.js';

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  requestsInWindow: number;
  lastFailureTime: number | null;
  totalRequests: number;
  totalFailures: number;
  totalRetries: number;
  totalSuccessAfterRetry: number;
  lastStateChangeTime: number;
}

export class CircuitStateMachine {
  private readonly routePrefix: string;
  private readonly backend: string;
  private readonly config: CircuitBreakerConfig;
  private readonly logger: Logger;

  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private consecutiveFailures: number = 0;
  private successCount: number = 0;
  private requestsInWindow: number = 0;
  private windowStartTime: number = Date.now();
  private lastFailureTime: number | null = null;
  private totalRequests: number = 0;
  private totalFailures: number = 0;
  private totalRetries: number = 0;
  private totalSuccessAfterRetry: number = 0;

  constructor(
    routePrefix: string,
    backend: string,
    config: Partial<CircuitBreakerConfig> = {},
    logger: Logger
  ) {
    this.routePrefix = routePrefix;
    this.backend = backend;
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Determines if a request should be allowed through.
   * Returns true if circuit is CLOSED or HALF_OPEN (testing).
   * Returns false if circuit is OPEN.
   */
  canExecute(): boolean {
    if (this.state === CircuitState.OPEN) {
      // Check if recovery time has elapsed
      if (this.lastFailureTime !== null) {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.config.recoveryTimeMs) {
          this.transitionTo(CircuitState.HALF_OPEN);
          return true;
        }
      }
      return false;
    }
    return true;
  }

  /**
   * Records a successful request completion.
   */
  recordSuccess(): void {
    this.totalRequests++;
    this.requestsInWindow++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      this.totalSuccessAfterRetry++;

      // Check if we should transition to CLOSED
      if (this.successCount >= this.config.halfOpenRequests) {
        this.transitionTo(CircuitState.CLOSED);
      }
    } else {
      // Reset consecutive failure count on success in CLOSED
      this.consecutiveFailures = 0;
    }

    this.resetWindowIfNeeded();
  }

  /**
   * Records a failed request.
   */
  recordFailure(): void {
    this.totalRequests++;
    this.totalFailures++;
    this.requestsInWindow++;
    this.failureCount++;
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in HALF_OPEN reopens the circuit
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED) {
      // Check consecutive failures threshold
      if (this.consecutiveFailures >= 5) {
        this.logger.warn(
          { route: this.routePrefix, backend: this.backend, failures: this.consecutiveFailures },
          'Circuit breaker opened after 5 consecutive failures'
        );
        this.transitionTo(CircuitState.OPEN);
      } else {
        // Check error threshold percentage
        this.checkErrorThreshold();
      }
    }

    this.resetWindowIfNeeded();
  }

  /**
   * Increments the retry counter.
   */
  recordRetry(): void {
    this.totalRetries++;
  }

  /**
   * Gets the current state of the circuit.
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Gets the time remaining until the circuit can try recovery.
   */
  getTimeUntilRetry(): number {
    if (this.state !== CircuitState.OPEN || this.lastFailureTime === null) {
      return 0;
    }
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.config.recoveryTimeMs - elapsed);
  }

  /**
   * Gets current metrics for this circuit.
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failures: this.failureCount,
      successCount: this.successCount,
      lastFailure: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalRetries: this.totalRetries,
      totalSuccessAfterRetry: this.totalSuccessAfterRetry,
      requestsInWindow: this.requestsInWindow,
    };
  }

  /**
   * Forces the circuit to a specific state (for testing/admin).
   */
  forceState(state: CircuitState): void {
    this.transitionTo(state);
  }

  /**
   * Transitions to a new state and logs the transition.
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    // Reset relevant counters based on new state
    switch (newState) {
      case CircuitState.CLOSED:
        this.failureCount = 0;
        this.consecutiveFailures = 0;
        this.successCount = 0;
        break;
      case CircuitState.OPEN:
        this.lastFailureTime = Date.now();
        // Reset window for fresh start
        this.resetWindow();
        break;
      case CircuitState.HALF_OPEN:
        this.successCount = 0;
        break;
    }

    this.logger.info(
      {
        route: this.routePrefix,
        backend: this.backend,
        from: oldState,
        to: newState,
      },
      `Circuit breaker state transition: ${oldState} -> ${newState}`
    );
  }

  /**
   * Checks if the error threshold has been exceeded.
   */
  private checkErrorThreshold(): void {
    if (this.requestsInWindow >= this.config.requestCount) {
      const errorRate = (this.failureCount / this.requestsInWindow) * 100;
      if (errorRate >= this.config.errorThreshold) {
        this.logger.warn(
          {
            route: this.routePrefix,
            backend: this.backend,
            errorRate: errorRate.toFixed(1),
            failures: this.failureCount,
            requests: this.requestsInWindow,
          },
          `Circuit breaker opened after ${errorRate.toFixed(1)}% error rate`
        );
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }

  /**
   * Resets the window if enough time has passed.
   */
  private resetWindowIfNeeded(): void {
    const windowDuration = Date.now() - this.windowStartTime;
    if (windowDuration >= this.config.recoveryTimeMs * 2) {
      this.resetWindow();
    }
  }

  /**
   * Resets the sliding window counters.
   */
  private resetWindow(): void {
    this.requestsInWindow = 0;
    this.failureCount = 0;
    this.windowStartTime = Date.now();
  }
}

/**
 * Manages circuit breakers for all routes.
 */
export class CircuitBreakerRegistry {
  private readonly circuits: Map<string, CircuitStateMachine> = new Map();
  private readonly config: Partial<CircuitBreakerConfig>;
  private readonly logger: Logger;

  constructor(config: Partial<CircuitBreakerConfig>, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Gets or creates a circuit breaker for a route.
   */
  getCircuit(routePrefix: string, backend: string): CircuitStateMachine {
    const key = this.getKey(routePrefix);
    if (!this.circuits.has(key)) {
      this.circuits.set(key, new CircuitStateMachine(routePrefix, backend, this.config, this.logger));
    }
    return this.circuits.get(key)!;
  }

  /**
   * Gets metrics for all circuits.
   */
  getAllMetrics(): Map<string, CircuitBreakerMetrics> {
    const metrics = new Map<string, CircuitBreakerMetrics>();
    for (const [key, circuit] of this.circuits) {
      metrics.set(key, circuit.getMetrics());
    }
    return metrics;
  }

  private getKey(routePrefix: string): string {
    return routePrefix;
  }
}