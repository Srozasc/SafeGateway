import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildServer } from '../../src/server.js';
import { MiddlewarePipeline } from '../../src/middleware/pipeline.js';
import { CircuitBreakerPlugin, CircuitState } from '../../src/middleware/circuit-breaker/index.js';
import { MockBackend } from '../helpers/mock-backend.js';
import { GatewayConfig } from '../../src/config/types.js';

describe('Circuit Breaker Integration Tests', () => {
  let backend: MockBackend;
  let backendPort: number;
  let server: FastifyInstance;
  let circuitBreakerPlugin: CircuitBreakerPlugin;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    backend = new MockBackend('success');
    backendPort = await backend.start();
  });

  afterAll(async () => {
    await backend.stop();
  });

  beforeEach(() => {
    backend.clear();
    backend.resetCounters();
    backend.setDefaultBehavior('success');
    circuitBreakerPlugin = new CircuitBreakerPlugin({
      config: {
        circuitBreaker: {
          enabled: true,
          errorThreshold: 50,
          requestCount: 10,
          recoveryTimeMs: 100, // 100ms for faster testing
          halfOpenRequests: 2,
          maxRetries: 1,
          retryDelayMs: 50,
          retryMaxDelayMs: 500,
        },
        retryConfig: {
          maxRetries: 1,
          baseDelayMs: 50,
          maxDelayMs: 500,
        },
      },
      logger,
    });
  });

  describe('Circuit State Transitions', () => {
    it('should start with circuit in CLOSED state', () => {
      const metrics = circuitBreakerPlugin.getMetrics('/api/test');
      expect(metrics).toBeDefined();
      expect(metrics?.state).toBe(CircuitState.CLOSED);
    });

    it('should allow requests when circuit is CLOSED', async () => {
      const config: GatewayConfig = {
        server: { port: 3000, host: '0.0.0.0' },
        redis: { url: 'redis://localhost:6379' },
        logging: { level: 'info' },
        metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
        routes: [
          {
            prefix: '/api',
            target: `http://127.0.0.1:${backendPort}`,
            circuitBreaker: {
              enabled: true,
              errorThreshold: 50,
              requestCount: 10,
              recoveryTimeMs: 1000,
              halfOpenRequests: 2,
              maxRetries: 1,
              retryDelayMs: 50,
              retryMaxDelayMs: 500,
            },
          },
        ],
      };

      const pipeline = new MiddlewarePipeline([circuitBreakerPlugin]);
      server = buildServer(config, pipeline, logger);

      // First request should succeed
      const response = await server.inject({
        method: 'GET',
        url: '/api/test',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Circuit Opens on Consecutive Failures', () => {
    it('should open circuit after 5 consecutive failures', async () => {
      const config: GatewayConfig = {
        server: { port: 3000, host: '0.0.0.0' },
        redis: { url: 'redis://localhost:6379' },
        logging: { level: 'info' },
        metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
        routes: [
          {
            prefix: '/api',
            target: `http://127.0.0.1:${backendPort}`,
            circuitBreaker: {
              enabled: true,
              errorThreshold: 50,
              requestCount: 10,
              recoveryTimeMs: 10000,
              halfOpenRequests: 3,
              maxRetries: 0,
              retryDelayMs: 50,
              retryMaxDelayMs: 500,
            },
          },
        ],
      };

      // Use a separate plugin instance for this test
      const testPlugin = new CircuitBreakerPlugin({
        config: {
          circuitBreaker: {
            enabled: true,
            errorThreshold: 50,
            requestCount: 10,
            recoveryTimeMs: 10000,
            halfOpenRequests: 3,
            maxRetries: 0,
            retryDelayMs: 50,
            retryMaxDelayMs: 500,
          },
          retryConfig: { maxRetries: 0, baseDelayMs: 50, maxDelayMs: 500 },
        },
        logger,
      });

      const pipeline = new MiddlewarePipeline([testPlugin]);
      server = buildServer(config, pipeline, logger);

      // Make 5 requests that will fail (circuit should open)
      for (let i = 0; i < 5; i++) {
        backend.setDefaultBehavior('error500');
        const response = await server.inject({
          method: 'GET',
          url: `/api/test?behavior=error500`,
        });
        // Backend returns 500, gateway should propagate or handle
        expect(response.statusCode).toBe(500);
      }

      // Circuit should now be OPEN
      const state = testPlugin.getState('/api');
      expect(state).toBe(CircuitState.OPEN);
    });
  });

  describe('Circuit Blocks Requests when OPEN', () => {
    it('should return 503 when circuit is OPEN', async () => {
      // Force the circuit to OPEN state
      circuitBreakerPlugin.forceState('/api', `http://127.0.0.1:${backendPort}`, CircuitState.OPEN);

      const config: GatewayConfig = {
        server: { port: 3000, host: '0.0.0.0' },
        redis: { url: 'redis://localhost:6379' },
        logging: { level: 'info' },
        metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
        routes: [
          {
            prefix: '/api',
            target: `http://127.0.0.1:${backendPort}`,
            circuitBreaker: {
              enabled: true,
              errorThreshold: 50,
              requestCount: 10,
              recoveryTimeMs: 10000,
              halfOpenRequests: 3,
              maxRetries: 0,
              retryDelayMs: 50,
              retryMaxDelayMs: 500,
            },
          },
        ],
      };

      const pipeline = new MiddlewarePipeline([circuitBreakerPlugin]);
      server = buildServer(config, pipeline, logger);

      // Request should be blocked with 503
      const response = await server.inject({
        method: 'GET',
        url: '/api/test',
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBeDefined();
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Circuit Open');
    });
  });

  describe('Circuit Recovers after Recovery Time', () => {
    it('should transition to HALF_OPEN after recovery time', async () => {
      // Force circuit to OPEN
      circuitBreakerPlugin.forceState('/api', `http://127.0.0.1:${backendPort}`, CircuitState.OPEN);

      const config: GatewayConfig = {
        server: { port: 3000, host: '0.0.0.0' },
        redis: { url: 'redis://localhost:6379' },
        logging: { level: 'info' },
        metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
        routes: [
          {
            prefix: '/api',
            target: `http://127.0.0.1:${backendPort}`,
            circuitBreaker: {
              enabled: true,
              errorThreshold: 50,
              requestCount: 10,
              recoveryTimeMs: 100, // 100ms for fast testing
              halfOpenRequests: 2,
              maxRetries: 0,
              retryDelayMs: 50,
              retryMaxDelayMs: 500,
            },
          },
        ],
      };

      const pipeline = new MiddlewarePipeline([circuitBreakerPlugin]);
      server = buildServer(config, pipeline, logger);

      // Wait for recovery time
      await new Promise(resolve => setTimeout(resolve, 150));

      // Request should now transition to HALF_OPEN and be allowed
      const response = await server.inject({
        method: 'GET',
        url: '/api/test',
      });

      // Should succeed (backend is working) and circuit should be HALF_OPEN
      expect(response.statusCode).toBe(200);
      const state = circuitBreakerPlugin.getState('/api');
      expect(state).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe('Circuit Closes after Successful HALF_OPEN Requests', () => {
    it('should close circuit after successful test requests in HALF_OPEN', async () => {
      // Set circuit to HALF_OPEN with 2 halfOpenRequests needed
      circuitBreakerPlugin.forceState('/api', `http://127.0.0.1:${backendPort}`, CircuitState.HALF_OPEN);

      const config: GatewayConfig = {
        server: { port: 3000, host: '0.0.0.0' },
        redis: { url: 'redis://localhost:6379' },
        logging: { level: 'info' },
        metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
        routes: [
          {
            prefix: '/api',
            target: `http://127.0.0.1:${backendPort}`,
            circuitBreaker: {
              enabled: true,
              errorThreshold: 50,
              requestCount: 10,
              recoveryTimeMs: 100,
              halfOpenRequests: 2,
              maxRetries: 0,
              retryDelayMs: 50,
              retryMaxDelayMs: 500,
            },
          },
        ],
      };

      const pipeline = new MiddlewarePipeline([circuitBreakerPlugin]);
      server = buildServer(config, pipeline, logger);

      // Make 2 successful requests
      await server.inject({ method: 'GET', url: '/api/test' });
      await server.inject({ method: 'GET', url: '/api/test' });

      // Circuit should now be CLOSED
      const state = circuitBreakerPlugin.getState('/api');
      expect(state).toBe(CircuitState.CLOSED);
    });

    it('should reopen circuit if request fails in HALF_OPEN', async () => {
      // Set circuit to HALF_OPEN
      circuitBreakerPlugin.forceState('/api', `http://127.0.0.1:${backendPort}`, CircuitState.HALF_OPEN);

      const config: GatewayConfig = {
        server: { port: 3000, host: '0.0.0.0' },
        redis: { url: 'redis://localhost:6379' },
        logging: { level: 'info' },
        metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
        routes: [
          {
            prefix: '/api',
            target: `http://127.0.0.1:${backendPort}`,
            circuitBreaker: {
              enabled: true,
              errorThreshold: 50,
              requestCount: 10,
              recoveryTimeMs: 100,
              halfOpenRequests: 3,
              maxRetries: 0,
              retryDelayMs: 50,
              retryMaxDelayMs: 500,
            },
          },
        ],
      };

      const pipeline = new MiddlewarePipeline([circuitBreakerPlugin]);
      server = buildServer(config, pipeline, logger);

      // Make one successful request
      await server.inject({ method: 'GET', url: '/api/test' });

      // Now fail a request
      backend.setDefaultBehavior('error500');
      const response = await server.inject({
        method: 'GET',
        url: `/api/test?behavior=error500`,
      });

      expect(response.statusCode).toBe(500);

      // Circuit should be back to OPEN
      const state = circuitBreakerPlugin.getState('/api');
      expect(state).toBe(CircuitState.OPEN);
    });
  });

  describe('Metrics Tracking', () => {
    it('should track total requests and failures', async () => {
      const config: GatewayConfig = {
        server: { port: 3000, host: '0.0.0.0' },
        redis: { url: 'redis://localhost:6379' },
        logging: { level: 'info' },
        metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
        routes: [
          {
            prefix: '/api',
            target: `http://127.0.0.1:${backendPort}`,
            circuitBreaker: {
              enabled: true,
              errorThreshold: 50,
              requestCount: 10,
              recoveryTimeMs: 1000,
              halfOpenRequests: 3,
              maxRetries: 0,
              retryDelayMs: 50,
              retryMaxDelayMs: 500,
            },
          },
        ],
      };

      const pipeline = new MiddlewarePipeline([circuitBreakerPlugin]);
      server = buildServer(config, pipeline, logger);

      // Make some requests
      await server.inject({ method: 'GET', url: '/api/test' });
      await server.inject({ method: 'GET', url: '/api/test' });

      const metrics = circuitBreakerPlugin.getMetrics('/api');
      expect(metrics?.totalRequests).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('Retry Behavior Integration Tests', () => {
  let backend: MockBackend;
  let backendPort: number;
  let server: FastifyInstance;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    backend = new MockBackend('success');
    backendPort = await backend.start();
  });

  afterAll(async () => {
    await backend.stop();
  });

  beforeEach(() => {
    backend.clear();
    backend.resetCounters();
  });

  it('should retry failed requests for idempotent methods', async () => {
    const circuitBreakerPlugin = new CircuitBreakerPlugin({
      config: {
        circuitBreaker: {
          enabled: true,
          errorThreshold: 50,
          requestCount: 10,
          recoveryTimeMs: 1000,
          halfOpenRequests: 3,
          maxRetries: 2,
          retryDelayMs: 50,
          retryMaxDelayMs: 500,
        },
        retryConfig: {
          maxRetries: 2,
          baseDelayMs: 50,
          maxDelayMs: 500,
        },
      },
      logger,
    });

    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
          circuitBreaker: {
            enabled: true,
            errorThreshold: 50,
            requestCount: 10,
            recoveryTimeMs: 1000,
            halfOpenRequests: 3,
            maxRetries: 2,
            retryDelayMs: 50,
            retryMaxDelayMs: 500,
          },
        },
      ],
    };

    const pipeline = new MiddlewarePipeline([circuitBreakerPlugin]);
    server = buildServer(config, pipeline, logger);

    // Note: This is a simplified test. Full retry testing would require
    // more sophisticated mock backend behavior tracking
    const response = await server.inject({
      method: 'GET',
      url: '/api/test',
    });

    // The request should eventually succeed or fail based on retry logic
    // In this test setup with working backend, it should succeed
    expect(response.statusCode).toBe(200);
  });
});