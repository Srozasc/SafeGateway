/**
 * Retry Interceptor
 *
 * Implements exponential backoff with full jitter for retries.
 * Only retries idempotent methods and eligible errors.
 */

import { Logger } from 'pino';
import {
  RetryConfig,
  RetryContext,
  RetryResult,
  isRetryableMethod,
  isRetryableErrorCode,
  isRetryableStatusCode,
  DEFAULT_RETRY_CONFIG,
} from './types.js';

export class RetryInterceptor {
  private readonly config: RetryConfig;
  private readonly logger: Logger;

  constructor(config: Partial<RetryConfig> = {}, logger: Logger) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Executes a function with automatic retries on failure.
   *
   * @param fn - The async function to execute
   * @param context - Retry context with attempt tracking
   * @returns The result of the function or the final error
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    context: RetryContext
  ): Promise<RetryResult & { result?: T }> {
    let totalRetryDelay = 0;

    while (context.attempt < context.maxAttempts) {
      try {
        const result = await fn();

        // Success - return result if this was a retry
        if (context.attempt > 0) {
          this.logger.debug(
            { attempt: context.attempt, totalRetryDelay },
            'Retry succeeded'
          );
        }

        return {
          success: true,
          result,
          attempts: context.attempt + 1,
          totalRetryDelayMs: totalRetryDelay,
        };
      } catch (error) {
        const errorInfo = this.extractErrorInfo(error);
        context.lastError = errorInfo.message;

        // Check if we should retry
        if (!this.shouldRetry(errorInfo)) {
          this.logger.debug(
            { errorCode: errorInfo.code, statusCode: errorInfo.statusCode, attempt: context.attempt },
            'Error is not retryable'
          );
          return {
            success: false,
            finalError: errorInfo.message,
            attempts: context.attempt + 1,
            totalRetryDelayMs: totalRetryDelay,
          };
        }

        // Check if we have retries remaining
        if (context.attempt >= context.maxAttempts - 1) {
          this.logger.warn(
            { errorCode: errorInfo.code, attempts: context.attempt + 1 },
            'Max retries exceeded'
          );
          return {
            success: false,
            finalError: errorInfo.message,
            attempts: context.attempt + 1,
            totalRetryDelayMs: totalRetryDelay,
          };
        }

        // Calculate delay for next retry
        const delay = this.calculateDelay(context.attempt);
        totalRetryDelay += delay;

        this.logger.debug(
          {
            attempt: context.attempt,
            nextAttempt: context.attempt + 1,
            delay,
            errorCode: errorInfo.code,
          },
          `Scheduling retry in ${delay}ms`
        );

        // Wait before next attempt
        await this.sleep(delay);
        context.attempt++;
      }
    }

    return {
      success: false,
      finalError: context.lastError || 'Max retries exceeded',
      attempts: context.maxAttempts,
      totalRetryDelayMs: totalRetryDelay,
    };
  }

  /**
   * Calculates the delay for a retry attempt using exponential backoff with full jitter.
   * Formula: random(0, min(baseDelay * 2^attempt, maxDelay))
   *
   * @param attempt - Current attempt number (0 = first retry)
   * @returns Delay in milliseconds
   */
  calculateDelay(attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * Math.pow(2, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
    // Full jitter: random value between 0 and cappedDelay
    const jitter = Math.random() * cappedDelay;
    return Math.floor(jitter);
  }

  /**
   * Determines if an error is eligible for retry.
   */
  isRetryable(error: unknown): boolean {
    const errorInfo = this.extractErrorInfo(error);
    return this.shouldRetry(errorInfo);
  }

  /**
   * Checks if a method is eligible for retry.
   */
  isMethodRetryable(method: string): boolean {
    return isRetryableMethod(method);
  }

  /**
   * Should retry based on error info.
   */
  private shouldRetry(errorInfo: { code?: string; statusCode?: number }): boolean {
    // Check if it's a network error
    if (errorInfo.code && isRetryableErrorCode(errorInfo.code)) {
      return true;
    }
    // Check if it's a retryable HTTP status code
    if (errorInfo.statusCode && isRetryableStatusCode(errorInfo.statusCode)) {
      return true;
    }
    return false;
  }

  /**
   * Extracts error information from an error.
   */
  private extractErrorInfo(error: unknown): { code?: string; statusCode?: number; message: string } {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      const statusCode = (error as { statusCode?: number }).statusCode;
      return {
        code,
        statusCode,
        message: error.message,
      };
    }
    return { message: String(error) };
  }

  /**
   * Sleeps for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Creates a new retry context.
   */
  createContext(maxAttempts?: number): RetryContext {
    return {
      attempt: 0,
      maxAttempts: maxAttempts ?? this.config.maxRetries + 1, // +1 because attempt 0 is the original request
      startTime: process.hrtime.bigint(),
      lastError: null,
    };
  }

  /**
   * Gets the current configuration.
   */
  getConfig(): RetryConfig {
    return { ...this.config };
  }
}

/**
 * Helper function to create a retry context with default values.
 */
export function createRetryContext(maxRetries: number): RetryContext {
  return {
    attempt: 0,
    maxAttempts: maxRetries + 1,
    startTime: process.hrtime.bigint(),
    lastError: null,
  };
}

/**
 * Calculates the total delay for a given number of retry attempts.
 * Useful for testing and debugging.
 */
export function calculateTotalDelay(baseDelayMs: number, maxDelayMs: number, maxRetries: number): number {
  let total = 0;
  for (let i = 0; i < maxRetries; i++) {
    const exponentialDelay = baseDelayMs * Math.pow(2, i);
    const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
    // Use average jitter (cappedDelay / 2) for estimation
    total += cappedDelay / 2;
  }
  return Math.floor(total);
}