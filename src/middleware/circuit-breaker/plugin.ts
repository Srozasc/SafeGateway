/**
 * Circuit Breaker Plugin
 *
 * Integrates circuit breaker and retry logic into the gateway middleware pipeline.
 * Acts as a GatewayPlugin that hooks into onRequest/onResponse, and provides
 * lifecycle hooks for ProxyEngine integration.
 */

import { Logger } from 'pino';
import type { FastifyRequest } from 'fastify';
import type { GatewayPlugin, RequestContext, ResponseContext } from '../pipeline.js';
import type { ProxyLifecycleHooks, ProxyContext, ProxyError, ProxyResponseData } from '../../proxy/types.js';

interface RequestWithCircuitContext extends FastifyRequest {
  circuitRetryContext?: {
    attempt: number;
    maxAttempts: number;
    routeKey: string;
    backend: string;
    method: string;
    circuit: unknown;
    lastError?: string;
  };
  circuitRetryInfo?: {
    shouldRetry: boolean;
    attempt: number;
    error: ProxyError;
  };
}
import {
  CircuitState,
  CircuitBreakerConfig,
  CircuitBreakerMetrics,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from './types.js';
import { CircuitBreakerRegistry } from './state.js';
import { RetryInterceptor } from './retry.js';
import { isRetryableErrorCode, isRetryableStatusCode, isRetryableMethod } from './types.js';

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
   * Returns lifecycle hooks for ProxyEngine integration.
   * These hooks allow the circuit breaker to intercept requests before they
   * reach the backend and handle errors/retries appropriately.
   */
  public getLifecycleHooks(): ProxyLifecycleHooks {
    return {
      onBeforeRequest: this.handleOnBeforeRequest.bind(this),
      onBeforeResponse: this.handleOnBeforeResponse.bind(this),
      onError: this.handleOnError.bind(this),
    };
  }

  /**
   * Hook executed before request is forwarded to backend.
   * Checks circuit state and returns 503 if OPEN.
   */
  private async handleOnBeforeRequest(
    options: { backend: string; method: string; path: string },
    context: ProxyContext
  ): Promise<void> {
    const routeKey = context.routeMatch.route.prefix;
    const backend = options.backend;

    // Get or create circuit for this route
    const circuit = this.registry.getCircuit(routeKey, backend);

    // Get circuit-level config
    const routeConfig = context.routeMatch.route as { circuitBreaker?: Partial<CircuitBreakerConfig> };
    if (routeConfig.circuitBreaker?.enabled === false) {
      return; // Circuit breaker disabled for this route
    }

    // Check if circuit allows execution
    if (!circuit.canExecute()) {
      const retryAfterSeconds = Math.ceil(circuit.getTimeUntilRetry() / 1000);

      this.logger.warn(
        { route: routeKey, backend, retryAfterSeconds },
        'Circuit breaker OPEN - blocking request'
      );

      // Throw an error that will be caught by the proxy handler
      const error = {
        code: 'CIRCUIT_OPEN',
        message: `Circuit breaker is open for ${backend}. Retry after ${retryAfterSeconds}s`,
        statusCode: 503,
        backend,
      } as ProxyError;
      throw error;
    }

    // Store retry context for later use in onError
    const request = context.request as RequestWithCircuitContext;
    request.circuitRetryContext = {
      attempt: 0,
      maxAttempts: (routeConfig.circuitBreaker?.maxRetries ?? this.config.retryConfig.maxRetries) + 1,
      routeKey,
      backend,
      method: options.method,
      circuit,
    };
  }

  /**
   * Hook executed after receiving response from backend.
   * Updates circuit state based on success/failure.
   */
  private async handleOnBeforeResponse(
    response: ProxyResponseData,
    context: ProxyContext
  ): Promise<void> {
    const routeKey = context.routeMatch.route.prefix;
    const backend = response.backend;

    // Get circuit for this route
    const circuit = this.registry.getCircuit(routeKey, backend);

    // Record success or failure based on status code
    if (response.statusCode >= 200 && response.statusCode < 300) {
      circuit.recordSuccess();
      this.logger.debug(
        { route: routeKey, backend, statusCode: response.statusCode },
        'Circuit breaker recorded success'
      );
    } else if (response.statusCode >= 500) {
      circuit.recordFailure();
      this.logger.warn(
        { route: routeKey, backend, statusCode: response.statusCode },
        'Circuit breaker recorded failure'
      );
    }
    // 4xx errors don't affect circuit state
  }

  /**
   * Hook executed when an error occurs in the proxy.
   * Records the failure in the circuit breaker and determines if retry is possible.
   */
  private async handleOnError(error: ProxyError, context: ProxyContext): Promise<void> {
    const routeKey = context.routeMatch.route.prefix;
    const backend = error.backend;

    // Get circuit for this route
    const circuit = this.registry.getCircuit(routeKey, backend);

    // Record the failure
    circuit.recordFailure();

    // Get retry context from request
    const request = context.request as RequestWithCircuitContext;
    const retryContext = request.circuitRetryContext;
    if (!retryContext) {
      return;
    }

    // Check if we should retry
    const shouldRetry = this.shouldRetry(error, retryContext);
    if (!shouldRetry) {
      this.logger.debug(
        { route: routeKey, backend, errorCode: error.code },
        'Error is not retryable'
      );
      return;
    }

    // Update retry context
    retryContext.attempt++;
    retryContext.lastError = error.message;

    // Check if we have retries remaining
    if (retryContext.attempt >= retryContext.maxAttempts) {
      this.logger.warn(
        { route: routeKey, backend, attempts: retryContext.attempt },
        'Max retries exceeded for circuit breaker'
      );
      return;
    }

    // Store retry info for the proxy to handle
    request.circuitRetryInfo = {
      shouldRetry: true,
      attempt: retryContext.attempt,
      error,
    };
  }

  /**
   * Determines if an error should trigger a retry.
   */
  private shouldRetry(
    error: ProxyError,
    retryContext: { method: string; attempt: number; maxAttempts: number }
  ): boolean {
    // Check if method is idempotent
    if (!isRetryableMethod(retryContext.method)) {
      return false;
    }

    // Check if error is retryable
    if (error.code && isRetryableErrorCode(error.code)) {
      return true;
    }

    if (error.statusCode && isRetryableStatusCode(error.statusCode)) {
      return true;
    }

    return false;
  }

  /**
   * Hook executed before request is forwarded to backend (GatewayPlugin interface).
   * This is called by the middleware pipeline during the preHandler phase.
   * For circuit breaker, we mainly rely on the ProxyEngine lifecycle hooks.
   */
  async onRequest(context: RequestContext): Promise<void> {
    // The ProxyEngine lifecycle hooks handle circuit breaking during proxy forwarding.
    // This onRequest hook is here for completeness but primarily handles
    // cases where the request doesn't go through the proxy (e.g., early rejection).
    const { routeMatch } = context;
    const routeKey = routeMatch.route.prefix;
    const backend = routeMatch.route.target;

    const circuit = this.registry.getCircuit(routeKey, backend);
    const routeConfig = routeMatch.route as { circuitBreaker?: Partial<CircuitBreakerConfig> };

    if (routeConfig.circuitBreaker?.enabled === false) {
      return;
    }

    if (!circuit.canExecute()) {
      const retryAfterSeconds = Math.ceil(circuit.getTimeUntilRetry() / 1000);
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
    }
  }

  /**
   * Hook executed after response is received from backend (GatewayPlugin interface).
   */
  async onResponse(_context: ResponseContext): Promise<void> {
    // This is called by the pipeline after the proxy response.
    // The lifecycle hook handles this during proxy, but we keep this for
    // cases where pipeline.executeOnResponse is called directly.
  }

  /**
   * Gets metrics for a specific route's circuit.
   */
  getMetrics(routePrefix: string): CircuitBreakerMetrics | undefined {
    const circuits = this.registry.getAllMetrics();
    const metrics = circuits.get(routePrefix);
    if (!metrics) {
      return {
        state: CircuitState.CLOSED,
        failures: 0,
        successCount: 0,
        lastFailure: null,
        totalRequests: 0,
        totalFailures: 0,
        totalRetries: 0,
        totalSuccessAfterRetry: 0,
        requestsInWindow: 0,
      };
    }
    return metrics;
  }

  /**
   * Gets the current state of a circuit.
   */
  getState(routePrefix: string): CircuitState | undefined {
    const metrics = this.getMetrics(routePrefix);
    return metrics?.state ?? CircuitState.CLOSED;
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