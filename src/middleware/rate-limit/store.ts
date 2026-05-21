import { Redis } from 'ioredis';
import { RateLimitStore, RateLimitIncrementResult } from './types.js';

export class RedisRateLimitStore implements RateLimitStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Ejecuta operaciones atómicas INCR y EXPIRE sobre Redis usando pipeline de ioredis.
   */
  public async increment(key: string, windowSeconds: number): Promise<RateLimitIncrementResult> {
    const pipeline = this.redis.multi();

    // Incrementar el contador atómicamente
    pipeline.incr(key);
    // Establecer expiración (TTL) en segundos (+1s extra de tolerancia)
    pipeline.expire(key, windowSeconds + 1);

    const results = await pipeline.exec();

    if (!results) {
      throw new Error('La transacción del rate limiter en Redis no devolvió resultados.');
    }

    // Obtener la respuesta del primer comando (INCR)
    // El formato de respuesta en ioredis para exec es: [[err, result], [err, result]]
    const incrResult = results[0];
    if (!incrResult) {
      throw new Error('El comando INCR en la transacción de Redis no devolvió respuesta.');
    }

    const [err, count] = incrResult;
    if (err) {
      throw err;
    }

    return {
      count: Number(count),
    };
  }
}
