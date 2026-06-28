import { describe, it, expect, vi } from 'vitest';
import { Redis } from 'ioredis';
import { RedisRateLimitStore } from '../../../../src/middleware/rate-limit/store.js';

describe('RedisRateLimitStore', () => {
  const mockIncr = vi.fn();
  const mockExpire = vi.fn();
  const mockExec = vi.fn();

  // Mock de ioredis pipeline
  const mockPipeline = {
    incr: mockIncr,
    expire: mockExpire,
    exec: mockExec,
  };

  // Asignar los mocks para que funcionen con encadenamiento (method chaining)
  mockIncr.mockReturnValue(mockPipeline);
  mockExpire.mockReturnValue(mockPipeline);

  // Mock del cliente Redis
  const mockRedis = {
    multi: vi.fn().mockReturnValue(mockPipeline),
  } as unknown as Redis;

  it('debería ejecutar una transacción atómica multi/exec para incrementar y expirar la clave', async () => {
    const store = new RedisRateLimitStore(mockRedis);
    const key = 'ratelimit:127.0.0.1:/api:1763114400';
    const windowSeconds = 60;

    // Simular respuesta exitosa de Redis ioredis exec()
    // Formato: [[error, resultado_incr], [error, resultado_expire]]
    mockExec.mockResolvedValue([
      [null, 5],
      [null, 1],
    ]);

    const result = await store.increment(key, windowSeconds);

    expect(mockRedis.multi).toHaveBeenCalled();
    expect(mockIncr).toHaveBeenCalledWith(key);
    expect(mockExpire).toHaveBeenCalledWith(key, windowSeconds + 1); // windowSeconds + 1 de tolerancia
    expect(mockExec).toHaveBeenCalled();
    expect(result.count).toBe(5);
  });

  it('debería lanzar un error si Redis exec() retorna nulo (transacción fallida)', async () => {
    const store = new RedisRateLimitStore(mockRedis);
    const key = 'ratelimit:127.0.0.1:/api:1763114400';

    mockExec.mockResolvedValue(null);

    await expect(store.increment(key, 60)).rejects.toThrow(
      'La transacción del rate limiter en Redis no devolvió resultados.',
    );
  });

  it('debería lanzar un error si el comando INCR no devuelve respuesta dentro de la transacción', async () => {
    const store = new RedisRateLimitStore(mockRedis);
    const key = 'ratelimit:127.0.0.1:/api:1763114400';

    mockExec.mockResolvedValue([]); // Array vacío

    await expect(store.increment(key, 60)).rejects.toThrow(
      'El comando INCR en la transacción de Redis no devolvió respuesta.',
    );
  });

  it('debería lanzar un error si la base de datos reporta un fallo en el comando INCR', async () => {
    const store = new RedisRateLimitStore(mockRedis);
    const key = 'ratelimit:127.0.0.1:/api:1763114400';

    mockExec.mockResolvedValue([[new Error('Redis is overloaded'), null]]);

    await expect(store.increment(key, 60)).rejects.toThrow('Redis is overloaded');
  });
});
