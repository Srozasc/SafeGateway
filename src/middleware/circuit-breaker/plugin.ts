/**
 * Circuit Breaker Plugin
 *
 * Integrates circuit breaker and retry logic into the gateway middleware pipeline.
 * Acts as a GatewayPlugin that hooks into onRequest/onResponse.
 */

import { Logger } from 'pino';
import type { GatewayPlugin, RequestContext, ResponseContext } from '../pipeline.js';
import {
  CircuitState,
  CircuitBreakerConfig,
  CircuitBreakerMetrics,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from './types.js';
import { CircuitBreakerRegistry } from './state.js';
import { RetryInterceptor } from './retry.js';

export interface CircuitBreakerPluginConfig {
  circuitBreaker: Partial<CircuitBreakerConfig>;
  retryConfig: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

export interface CircuitBreakerPluginOptions {
  config: CircuitBreakerPluginConfig;
  logger: Logger;
}

export class CircuitBreakerPlugin implements GatewayPlugin {
  public readonly name = 'circuit-breaker';
  private readonly registry: CircuitBreakerRegistry;
  private readonly retryInterceptors: Map<string, RetryInterceptor> = new Map();
  private readonly config: CircuitBreakerPluginConfig;
  private readonly logger: Logger;

  constructor(options: CircuitBreakerPluginOptions) {
    this.config = options.config;
    this.logger = options.logger;

    // Create registry with default config
    this.registry = new CircuitBreakerRegistry(options.config.circuitBreaker, this.logger);
  }

  /**
   * Hook executed before request is forwarded to backend.
   * Checks circuit state and returns 503 if OPEN.
   */
  async onRequest(context: RequestContext): Promise<void> {
    const { routeMatch } = context;
    const routeKey = routeMatch.route.prefix;
    const backend = routeMatch.route.target;

    // Get or create circuit for this route
    const circuit = this.registry.getCircuit(routeKey, backend);

    // Get circuit-level config (can override defaults per route)
    const routeConfig = routeMatch.route as { circuitBreaker?: Partial<CircuitBreakerConfig> };
    if (routeConfig.circuitBreaker?.enabled === false) {
      return; // Circuit breaker disabled for this route
    }

    // Check if circuit allows execution
    if (!circuit.canExecute()) {
      const retryAfterSeconds = Math.ceil(circuit.getTimeUntilRetry() / 1000);

      this.logger.warn(
        { route: routeKey, backend, retryAfterSeconds },
        'Circuit breaker OPEN - returning 503'
      );

      context.reply
        .status(503)
        .header('Retry-After', String(retryAfterSeconds))
        .send({
          error: 'Circuit Open',
          message: `The circuit breaker for ${backend} is open. Please retry after ${retryAfterSeconds} seconds.`,
          statusCode: 503,
          retryAfter: retryAfterSeconds,
          timestamp: new Date().toISOString(),
        });
      return;
    }

    // Store retry context on request for later use
    const retryConfig = routeConfig.circuitBreaker?.maxRetries !== undefined
      ? routeConfig.circuitBreaker
      : this.config.retryConfig;

    (context.request as any).circuitRetryContext = {
      attempt: 0,
      maxAttempts: (retryConfig.maxRetries ?? 3) + 1,
      circuit,
    };
  }

  /**
   * Hook executed after response is received from backend.
   * Updates circuit state based on success/failure.
   */
  async onResponse(context: ResponseContext): Promise<void> {
    const { routeMatch, payload } = context;
    const routeKey = routeMatch.route.prefix;
    const backend = routeMatch.route.target;

    // Get circuit for this route
    const circuit = this.registry.getCircuit(routeKey, backend);

    // Check if this was a successful response
    const statusCode = (payload as { statusCode?: number })?.statusCode;

    if (statusCode && statusCode >= 200 && statusCode < 300) {
      circuit.recordSuccess();
      this.logger.debug(
        { route: routeKey, backend, statusCode },
        'Circuit breaker recorded success'
      );
    } else if (statusCode && statusCode >= 500) {
      circuit.recordFailure();
      this.logger.warn(
        { route: routeKey, backend, statusCode },
        'Circuit breaker recorded failure'
      );
    }
    // 4xx errors don't affect circuit state
  }

  /**
   * Gets metrics for a specific route's circuit.
   */
  getMetrics(routePrefix: string): CircuitBreakerMetrics | undefined {
    const circuits = this.registry.getAllMetrics();
    return circuits.get(routePrefix);
  }

  /**
   * Gets the current state of a circuit.
   */
  getState(routePrefix: string): CircuitState | undefined {
    // We need to expose getState from registry
    // For now, get from metrics
    const metrics = this.getMetrics(routePrefix);
    return metrics?.state;
  }

  /**
   * Forces a circuit to a specific state.
   */
  forceState(routePrefix: string, backend: string, state: CircuitState): void {
    const circuit = this.registry.getCircuit(routePrefix, backend);
    circuit.forceState(state);
  }

  /**
   * Gets retry interceptor for a route.
   */
  getRetryInterceptor(routePrefix: string): RetryInterceptor {
    if (!this.retryInterceptors.has(routePrefix)) {
      this.retryInterceptors.set(
        routePrefix,
        new RetryInterceptor(this.config.retryConfig, this.logger)
      );
    }
    return this.retryInterceptors.get(routePrefix)!;
  }

  /**
   * Gets all circuit metrics.
   */
  getAllMetrics(): Map<string, CircuitBreakerMetrics> {
    return this.registry.getAllMetrics();
  }
}

/**
 * Creates a circuit breaker plugin with default configuration.
 */
export function createCircuitBreakerPlugin(
  logger: Logger,
  config?: Partial<CircuitBreakerPluginConfig>
): CircuitBreakerPlugin {
  return new CircuitBreakerPlugin(
    {
      config: {
        circuitBreaker: config?.circuitBreaker ?? DEFAULT_CIRCUIT_BREAKER_CONFIG,
        retryConfig: config?.retryConfig ?? {
          maxRetries: 3,
          baseDelayMs: 100,
          maxDelayMs: 5000,
        },
      },
      logger,
    }
  );
}