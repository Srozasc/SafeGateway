/**
 * Circuit Breaker Types
 *
 * Defines states, configuration, and metrics for the circuit breaker pattern.
 */

// ============================================
// Circuit States
// ============================================

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation - requests pass through
  OPEN = 'OPEN',         // Blocking requests - return 503 immediately
  HALF_OPEN = 'HALF_OPEN', // Testing recovery - allow limited requests
}

// ============================================
// Configuration
// ============================================

export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Percentage of errors required to open the circuit (default: 50) */
  errorThreshold: number;
  /** Number of requests in the window to evaluate (default: 100) */
  requestCount: number;
  /** Time in OPEN state before attempting HALF_OPEN (default: 30000) */
  recoveryTimeMs: number;
  /** Number of successful requests in HALF_OPEN to close the circuit (default: 3) */
  halfOpenRequests: number;
  /** Maximum number of retries when circuit is CLOSED (default: 3) */
  maxRetries: number;
  /** Base delay for exponential backoff jitter calculation (default: 100ms) */
  retryDelayMs: number;
  /** Maximum delay cap for jitter (default: 5000ms) */
  retryMaxDelayMs: number;
}

export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay in ms for calculating jitter */
  baseDelayMs: number;
  /** Maximum delay cap in ms */
  maxDelayMs: number;
  /** HTTP methods eligible for retry */
  retryableMethods: string[];
  /** Error codes that justify a retry */
  retryableErrors: string[];
}

// ============================================
// Metrics
// ============================================

export interface CircuitBreakerMetrics {
  /** Current circuit state */
  state: CircuitState;
  /** Number of failures in current window */
  failures: number;
  /** Successful requests in HALF_OPEN state */
  successCount: number;
  /** ISO timestamp of last failure */
  lastFailure: string | null;
  /** Total requests processed */
  totalRequests: number;
  /** Total requests that failed */
  totalFailures: number;
  /** Total retries performed */
  totalRetries: number;
  /** Retries that ultimately succeeded */
  totalSuccessAfterRetry: number;
  /** Requests in current window */
  requestsInWindow: number;
}

// ============================================
// Retry Context & Result
// ============================================

export interface RetryContext {
  /** Current attempt number (0 = first attempt) */
  attempt: number;
  /** Maximum attempts allowed */
  maxAttempts: number;
  /** Start time of the operation */
  startTime: bigint;
  /** Last error message if any */
  lastError: string | null;
}

export interface RetryResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Final error message if failed */
  finalError?: string;
  /** Total number of attempts made */
  attempts: number;
  /** Total delay accumulated across all retries */
  totalRetryDelayMs: number;
}

// ============================================
// Idempotent Methods
// ============================================

export const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'] as const;

/**
 * Determines if an HTTP method is idempotent and safe to retry.
 */
export function isRetryableMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.includes(method.toUpperCase() as typeof IDEMPOTENT_METHODS[number]);
}

// ============================================
// Retryable Errors
// ============================================

export const RETRYABLE_ERROR_CODES = [
  'ECONNREFUSED',  // Backend not responding
  'ETIMEDOUT',     // Connection timeout
  'ECONNRESET',    // Connection reset
  'ENOTFOUND',     // DNS resolution failed
  'EAI_AGAIN',     // Temporary DNS failure
  'EPIPE',         // Broken pipe
] as const;

export const RETRYABLE_STATUS_CODES = [500, 502, 503, 504] as const;

/**
 * Determines if an error code is eligible for retry.
 */
export function isRetryableErrorCode(code: string): boolean {
  return RETRYABLE_ERROR_CODES.includes(code as typeof RETRYABLE_ERROR_CODES[number]);
}

/**
 * Determines if an HTTP status code is eligible for retry.
 */
export function isRetryableStatusCode(statusCode: number): boolean {
  return RETRYABLE_STATUS_CODES.includes(statusCode as typeof RETRYABLE_STATUS_CODES[number]);
}

// ============================================
// Default Configuration
// ============================================

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  errorThreshold: 50,
  requestCount: 100,
  recoveryTimeMs: 30000,
  halfOpenRequests: 3,
  maxRetries: 3,
  retryDelayMs: 100,
  retryMaxDelayMs: 5000,
};

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  retryableMethods: [...IDEMPOTENT_METHODS],
  retryableErrors: [...RETRYABLE_ERROR_CODES],
};