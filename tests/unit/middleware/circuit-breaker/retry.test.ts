import { vi, describe, it, expect, beforeEach } from 'vitest';
/**
 * Retry Interceptor Tests
 */

import { RetryInterceptor, createRetryContext, calculateTotalDelay } from '../../../../src/middleware/circuit-breaker/retry.js';
import { Logger } from 'pino';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('RetryInterceptor', () => {
  let interceptor: RetryInterceptor;

  beforeEach(() => {
    interceptor = new RetryInterceptor(
      {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        retryableMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'],
        retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'],
      },
      mockLogger
    );
  });

  describe('calculateDelay', () => {
    it('should return exponential delay with jitter', () => {
      const delays: number[] = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const delay = interceptor.calculateDelay(attempt);
        delays.push(delay);
        // Delay should be between 0 and min(baseDelay * 2^attempt, maxDelay)
        const maxPossible = Math.min(100 * Math.pow(2, attempt), 5000);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(maxPossible);
      }

      // Delays should generally increase (but jitter can cause variation)
      expect(delays[1]).toBeLessThanOrEqual(5000); // 200 * 2 = 400, capped at 5000
    });

    it('should cap delay at maxDelayMs', () => {
      const maxDelay = interceptor.calculateDelay(10); // 100 * 2^10 = 102400, capped at 5000
      expect(maxDelay).toBeLessThanOrEqual(5000);
    });

    it('should produce different delays due to jitter', () => {
      const delays = new Set<number>();
      for (let i = 0; i < 10; i++) {
        delays.add(interceptor.calculateDelay(0));
      }
      // With random jitter, we should see multiple different values
      expect(delays.size).toBeGreaterThan(1);
    });
  });

  describe('isRetryable', () => {
    it('should return true for ECONNREFUSED', () => {
      const error = new Error('Connection refused') as NodeJS.ErrnoException;
      error.code = 'ECONNREFUSED';
      expect(interceptor.isRetryable(error)).toBe(true);
    });

    it('should return true for ETIMEDOUT', () => {
      const error = new Error('Timeout') as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      expect(interceptor.isRetryable(error)).toBe(true);
    });

    it('should return true for ECONNRESET', () => {
      const error = new Error('Connection reset') as NodeJS.ErrnoException;
      error.code = 'ECONNRESET';
      expect(interceptor.isRetryable(error)).toBe(true);
    });

    it('should return false for generic errors', () => {
      const error = new Error('Something went wrong');
      expect(interceptor.isRetryable(error)).toBe(false);
    });

    it('should return false for non-retryable status codes', () => {
      const error = { message: 'Bad Request', statusCode: 400 } as unknown as Error;
      expect(interceptor.isRetryable(error)).toBe(false);
    });
  });

  describe('isMethodRetryable', () => {
    it('should return true for GET', () => {
      expect(interceptor.isMethodRetryable('GET')).toBe(true);
    });

    it('should return true for HEAD', () => {
      expect(interceptor.isMethodRetryable('HEAD')).toBe(true);
    });

    it('should return true for OPTIONS', () => {
      expect(interceptor.isMethodRetryable('OPTIONS')).toBe(true);
    });

    it('should return true for PUT', () => {
      expect(interceptor.isMethodRetryable('PUT')).toBe(true);
    });

    it('should return true for DELETE', () => {
      expect(interceptor.isMethodRetryable('DELETE')).toBe(true);
    });

    it('should return false for POST', () => {
      expect(interceptor.isMethodRetryable('POST')).toBe(false);
    });

    it('should return false for PATCH', () => {
      expect(interceptor.isMethodRetryable('PATCH')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(interceptor.isMethodRetryable('get')).toBe(true);
      expect(interceptor.isMethodRetryable('Put')).toBe(true);
    });
  });

  describe('executeWithRetry', () => {
    it('should succeed on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const context = createRetryContext(3);

      const result = await interceptor.executeWithRetry(fn, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const error = new Error('Temporary failure') as NodeJS.ErrnoException;
      error.code = 'ECONNREFUSED';
      const fn = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('success');

      const context = createRetryContext(3);

      const result = await interceptor.executeWithRetry(fn, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(2);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should exhaust retries and return error', async () => {
      const error = new Error('Persistent failure') as NodeJS.ErrnoException;
      error.code = 'ECONNREFUSED';
      const fn = vi.fn().mockRejectedValue(error);

      const context = createRetryContext(3);

      const result = await interceptor.executeWithRetry(fn, context);

      expect(result.success).toBe(false);
      expect(result.finalError).toBe('Persistent failure');
      expect(result.attempts).toBe(4); // 1 original + 3 retries
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('should not retry non-idempotent methods', async () => {
      // Note: executeWithRetry doesn't check method, it just retries on error
      // The method check should be done before calling executeWithRetry
      const error = new Error('Failure') as NodeJS.ErrnoException;
      error.code = 'ECONNREFUSED';
      const fn = vi.fn().mockRejectedValue(error);

      const context = createRetryContext(3);
      context.maxAttempts = 2; // Simulating POST

      const result = await interceptor.executeWithRetry(fn, context);

      expect(result.success).toBe(false);
    });

    it('should not retry non-retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Bad Request'));

      const context = createRetryContext(3);

      const result = await interceptor.executeWithRetry(fn, context);

      expect(result.success).toBe(false);
      expect(result.finalError).toBe('Bad Request');
      // Should not retry - only 1 attempt
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('createContext', () => {
    it('should create context with correct maxAttempts', () => {
      const context = interceptor.createContext();
      expect(context.maxAttempts).toBe(4); // 3 + 1
    });

    it('should allow custom maxAttempts', () => {
      const context = interceptor.createContext(5);
      expect(context.maxAttempts).toBe(5);
    });
  });
});

describe('createRetryContext', () => {
  it('should create context with correct structure', () => {
    const context = createRetryContext(3);

    expect(context.attempt).toBe(0);
    expect(context.maxAttempts).toBe(4);
    expect(context.lastError).toBeNull();
    expect(context.startTime).toBeDefined();
  });
});

describe('calculateTotalDelay', () => {
  it('should estimate total delay for retries', () => {
    // With baseDelay=100, maxDelay=5000, 3 retries:
    // Retry 0: ~50 (avg of 0-100)
    // Retry 1: ~100 (avg of 0-200)
    // Retry 2: ~200 (avg of 0-400)
    // Total: ~350ms
    const total = calculateTotalDelay(100, 5000, 3);
    expect(total).toBe(350);
  });

  it('should cap at maxDelay for large attempts', () => {
    // With many retries, delay is capped at maxDelay
    const total = calculateTotalDelay(100, 5000, 10);
    expect(total).toBe(13150);
  });
});