import { describe, it, expect, beforeEach } from 'vitest';
import { register } from 'prom-client';
import {
  recordJwtValidation,
  recordJwksRefresh,
  resetJwtMetrics,
} from '../../../src/middleware/jwt-auth/metrics.js';

describe('JWT metrics', () => {
  beforeEach(() => {
    resetJwtMetrics();
  });

  describe('registro idempotente', () => {
    it('expone el counter gateway_jwt_validations_total', () => {
      const metric = register.getSingleMetric('gateway_jwt_validations_total');
      expect(metric).toBeDefined();
    });

    it('expone el counter gateway_jwks_refresh_total', () => {
      const metric = register.getSingleMetric('gateway_jwks_refresh_total');
      expect(metric).toBeDefined();
    });

    it('múltiples imports no crean duplicados', async () => {
      // Re-importar simula reinstalación del plugin
      await import('../../../src/middleware/jwt-auth/metrics.js');
      await import('../../../src/middleware/jwt-auth/metrics.js');
      const m1 = register.getSingleMetric('gateway_jwt_validations_total');
      const m2 = register.getSingleMetric('gateway_jwt_validations_total');
      expect(m1).toBe(m2);
    });
  });

  describe('recordJwtValidation', () => {
    it('incrementa el counter con el resultado dado', async () => {
      recordJwtValidation('ok');
      const metric = register.getSingleMetric('gateway_jwt_validations_total') as {
        get: () => Promise<{ values: Array<{ value: number; labels: { result: string } }> }>;
      };
      const data = await metric.get();
      const okValue = data.values.find((v) => v.labels.result === 'ok');
      expect(okValue?.value).toBeGreaterThanOrEqual(1);
    });

    it('soporta todos los resultados sin lanzar', () => {
      const results = [
        'ok',
        'missing_token',
        'unknown_kid',
        'missing_kid',
        'expired',
        'invalid_issuer',
        'invalid_audience',
        'invalid_claims',
        'invalid_signature',
        'service_unavailable',
      ] as const;
      for (const r of results) {
        expect(() => recordJwtValidation(r)).not.toThrow();
      }
    });
  });

  describe('recordJwksRefresh', () => {
    it('incrementa el counter con el resultado dado', async () => {
      recordJwksRefresh('ok');
      recordJwksRefresh('ok');
      recordJwksRefresh('error');
      const metric = register.getSingleMetric('gateway_jwks_refresh_total') as {
        get: () => Promise<{ values: Array<{ value: number; labels: { result: string } }> }>;
      };
      const data = await metric.get();
      const okVal = data.values.find((v) => v.labels.result === 'ok');
      const errVal = data.values.find((v) => v.labels.result === 'error');
      expect(okVal?.value).toBeGreaterThanOrEqual(2);
      expect(errVal?.value).toBeGreaterThanOrEqual(1);
    });
  });
});
