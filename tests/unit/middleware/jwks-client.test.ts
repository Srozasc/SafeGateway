import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { JwksClient } from '../../../src/middleware/jwt-auth/jwks-client.js';
import type { JwtIssuerConfig } from '../../../src/config/types.js';

function makeConfig(overrides: Partial<JwtIssuerConfig> = {}): JwtIssuerConfig {
  return {
    name: 'test-issuer',
    jwksUri: 'https://auth.example.com/jwks.json',
    issuer: 'https://auth.example.com',
    audience: 'api',
    cacheTtlSeconds: 3600,
    staleGracePeriodSeconds: 1800,
    refreshCooldownSeconds: 30,
    refreshOnMiss: true,
    timeoutMs: 100,
    ...overrides,
  };
}

const VALID_KEYS = {
  keys: [
    { kty: 'RSA', kid: 'key-1', use: 'sig', alg: 'RS256', n: 'abc', e: 'AQAB' },
  ],
};

describe('JwksClient', () => {
  let logger = pino({ level: 'silent' });

  beforeEach(() => {
    logger = pino({ level: 'silent' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('arranca en estado empty', () => {
      const client = new JwksClient(makeConfig(), logger);
      expect(client.getState()).toBe('empty');
      expect(client.getStats().keyCount).toBe(0);
    });
  });

  describe('resolveKey con fetch síncrono', () => {
    it('cache hit: sirve la clave sin fetch si está fresh', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(VALID_KEYS), { status: 200 }),
      );
      const client = new JwksClient(makeConfig(), logger);
      const resolution = await client.resolveKey('key-1');

      expect(resolution.state).toBe('fresh');
      expect(resolution.foundKid).toBe('key-1');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('cache miss con refresh on miss: trigger fetch (sin cooldown)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(VALID_KEYS), { status: 200 }),
      );
      // cooldown: 0 para que el refresh on miss no sea bloqueado
      const client = new JwksClient(makeConfig({ refreshCooldownSeconds: 0 }), logger);
      // Primer populate vía primera call
      await client.resolveKey('key-1');

      // Resetear mock y forzar miss con kid distinto
      vi.spyOn(globalThis, 'fetch').mockClear();
      const resolution = await client.resolveKey('key-2');

      expect(globalThis.fetch).toHaveBeenCalledTimes(1); // refresh on miss triggered
      // key-2 no está, retornamos foundKid null
      expect(resolution.foundKid).toBeNull();
    });

    it('refresh on miss con kid encontrado: refresca y encuentra', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(VALID_KEYS), { status: 200 }),
      );
      const client = new JwksClient(makeConfig({ refreshCooldownSeconds: 0 }), logger);
      await client.resolveKey('other');

      // Segundo call con kid que SÍ está — debería devolver fresh
      vi.spyOn(globalThis, 'fetch').mockClear();
      const resolution = await client.resolveKey('key-1');
      expect(resolution.foundKid).toBe('key-1');
    });
  });

  describe('manejo de errores', () => {
    it('retorna null jwkSet y state empty ante fetch fail con cache vacía', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      const client = new JwksClient(makeConfig(), logger);
      const resolution = await client.resolveKey('key-1');

      expect(resolution.jwkSet).toBeNull();
      expect(resolution.state).toBe('empty');
    });

    it('incrementa error counter en refresh failures', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      const client = new JwksClient(makeConfig(), logger);
      await client.resolveKey('key-1');

      const stats = client.getStats();
      expect(stats.lastErrorAt).toBeGreaterThan(0);
    });

    it('retorna null ante status 500', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('internal error', { status: 500 }),
      );
      const client = new JwksClient(makeConfig(), logger);
      const resolution = await client.resolveKey('key-1');
      expect(resolution.jwkSet).toBeNull();
    });

    it('retorna null ante payload sin keys array', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
      );
      const client = new JwksClient(makeConfig(), logger);
      const resolution = await client.resolveKey('key-1');
      expect(resolution.jwkSet).toBeNull();
    });
  });

  describe('cooldown gating', () => {
    it('respeta refreshCooldownSeconds: segundo fetch rápido no reintenta', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(VALID_KEYS), { status: 200 }),
      );
      const client = new JwksClient(
        makeConfig({ refreshCooldownSeconds: 60 }),
        logger,
      );

      await client.resolveKey('key-1');
      vi.spyOn(globalThis, 'fetch').mockClear();

      // Segunda llamada dentro del cooldown debe saltar el fetch
      const resolution = await client.resolveKey('key-2');
      expect(globalThis.fetch).not.toHaveBeenCalled();
      // Como la cache anterior tiene key-1 y pedimos key-2, jwkSet es el viejo (null hit), state ya no es fresh
      expect(resolution.foundKid).toBeNull();
    });
  });

  describe('background refresh con fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('ensureStarted agenda un timer', async () => {
      const client = new JwksClient(makeConfig({ cacheTtlSeconds: 1 }), logger);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(VALID_KEYS), { status: 200 }),
      );
      client.ensureStarted();
      expect(fetchSpy).not.toHaveBeenCalled();

      // Avanzar más allá del TTL y flush de microtasks
      await vi.advanceTimersByTimeAsync(1100);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await client.stop();
    });

    it('stop() limpia el timer', async () => {
      const client = new JwksClient(makeConfig({ cacheTtlSeconds: 1 }), logger);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(VALID_KEYS), { status: 200 }),
      );
      client.ensureStarted();
      await client.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('stale grace period', () => {
    it('sirve stale si kid en cache y refresh falla', async () => {
      const client = new JwksClient(
        makeConfig({ cacheTtlSeconds: 1, staleGracePeriodSeconds: 5, refreshCooldownSeconds: 0 }),
        logger,
      );

      // Primer fetch OK
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_KEYS), { status: 200 }),
      );
      await client.resolveKey('key-1');

      // Esperar a stale
      await new Promise((r) => setTimeout(r, 1100));
      expect(client.getState()).toBe('stale');

      // Segundo fetch falla — debe servir stale si el kid está
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      const resolution = await client.resolveKey('key-1');
      expect(resolution.foundKid).toBe('key-1');
      expect(resolution.state).toBe('stale');
    });
  });
});
