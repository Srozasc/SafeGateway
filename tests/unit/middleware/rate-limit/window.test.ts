import { describe, it, expect } from 'vitest';
import {
  getCurrentWindow,
  buildRateLimitKey,
} from '../../../../src/middleware/rate-limit/window.js';

describe('Rate Limit Window & Keys', () => {
  describe('getCurrentWindow', () => {
    it('debería calcular correctamente el inicio de la ventana y el reset', () => {
      // 10:00:05 AM -> 1763114405
      const nowMs = 1763114405 * 1000;
      const windowSeconds = 60; // 1 minuto

      const window = getCurrentWindow(windowSeconds, nowMs);

      // Inicio de la ventana debe ser 10:00:00 AM -> 1763114400
      expect(window.windowStart).toBe(1763114400);
      // El reset debe ser a las 10:01:00 AM -> 1763114460
      expect(window.resetAt).toBe(1763114460);
    });

    it('debería funcionar con una ventana no estándar (ej. 15 segundos)', () => {
      // 10:00:23 AM -> 1763114423
      const nowMs = 1763114423 * 1000;
      const windowSeconds = 15;

      const window = getCurrentWindow(windowSeconds, nowMs);

      // Inicio de la ventana debe ser a los 15s (10:00:15) -> 1763114415
      expect(window.windowStart).toBe(1763114415);
      // Reset a los 30s (10:00:30) -> 1763114430
      expect(window.resetAt).toBe(1763114430);
    });

    it('debería utilizar Date.now() por defecto si no se pasa nowMs', () => {
      const windowSeconds = 10;
      const start = Math.floor(Date.now() / 1000);

      const window = getCurrentWindow(windowSeconds);

      expect(window.windowStart).toBeLessThanOrEqual(start);
      expect(window.resetAt).toBeGreaterThan(start);
    });
  });

  describe('buildRateLimitKey', () => {
    it('debería estructurar la clave en formato ratelimit:{ip}:{prefix}:{windowStart}', () => {
      const ip = '192.168.1.1';
      const prefix = '/api/v1';
      const windowStart = 1763114400;

      const key = buildRateLimitKey(ip, prefix, windowStart);

      expect(key).toBe('ratelimit:192.168.1.1:/api/v1:1763114400');
    });

    it('debería sanitizar los dos puntos en el prefijo para no romper la estructura de Redis', () => {
      const ip = '10.0.0.1';
      const prefix = '/api:v2:special';
      const windowStart = 123456789;

      const key = buildRateLimitKey(ip, prefix, windowStart);

      // Los ":" dentro del prefijo deben transformarse en "_"
      expect(key).toBe('ratelimit:10.0.0.1:/api_v2_special:123456789');
    });
  });
});
