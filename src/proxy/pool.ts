import { Pool } from 'undici';
import type { Logger } from 'pino';
import type { PoolConfig, PoolStats } from './types.js';

/**
 * Manages connection pools per backend.
 * Each backend gets its own isolated pool for better isolation.
 */
export class ConnectionPoolManager {
  private readonly pools: Map<string, Pool> = new Map();
  private readonly defaultConfig: Required<PoolConfig>;
  private readonly logger: Logger;

  constructor(logger: Logger, defaultConfig?: PoolConfig) {
    this.logger = logger;
    this.defaultConfig = {
      connections: defaultConfig?.connections ?? 100,
      keepAliveTimeout: defaultConfig?.keepAliveTimeout ?? 40000,
      connectTimeout: defaultConfig?.connectTimeout ?? 5000,
      headersTimeout: defaultConfig?.headersTimeout ?? 30000,
      bodyTimeout: defaultConfig?.bodyTimeout ?? 60000,
    };
  }

  /**
   * Gets or creates a pool for a specific backend.
   */
  getPool(backendUrl: string, config?: PoolConfig): Pool {
    const normalizedUrl = this.normalizeBackendUrl(backendUrl);

    let pool = this.pools.get(normalizedUrl);
    if (!pool) {
      pool = this.createPool(normalizedUrl, config);
      this.pools.set(normalizedUrl, pool);
      this.logger.info(
        { backend: normalizedUrl, config: { ...this.defaultConfig, ...config } },
        'Created new connection pool for backend'
      );
    }
    return pool;
  }

  /**
   * Closes all pools (used in graceful shutdown).
   */
  async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [, pool] of this.pools) {
      closePromises.push(pool.close());
    }
    await Promise.all(closePromises);
    this.pools.clear();
  }

  /**
   * Gets statistics for a specific pool.
   */
  getStats(backendUrl: string): PoolStats {
    const normalizedUrl = this.normalizeBackendUrl(backendUrl);
    if (!this.pools.has(normalizedUrl)) {
      return {
        backend: normalizedUrl,
        totalConnections: 0,
        activeConnections: 0,
        idleConnections: 0,
      };
    }

    return {
      backend: normalizedUrl,
      totalConnections: this.defaultConfig.connections,
      activeConnections: 0,
      idleConnections: 0,
    };
  }

  /**
   * Normalizes backend URL to consistent format.
   */
  private normalizeBackendUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
    } catch {
      return url;
    }
  }

  /**
   * Creates a new pool for a backend.
   */
  private createPool(backendUrl: string, config?: PoolConfig): Pool {
    const finalConfig = { ...this.defaultConfig, ...config };

    return new Pool(backendUrl, {
      connections: finalConfig.connections,
      keepAliveTimeout: finalConfig.keepAliveTimeout,
      connectTimeout: finalConfig.connectTimeout,
      headersTimeout: finalConfig.headersTimeout,
      bodyTimeout: finalConfig.bodyTimeout,
    });
  }
}