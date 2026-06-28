import { describe, it, expect, beforeEach, vi } from 'vitest';
import { register } from 'prom-client';
import {
  recordCorsDecision,
  recordCorsDecisionDuration,
  resetCorsMetrics,
  corsRequestsTotal,
  corsDecisionDurationSeconds,
} from '../../../../src/middleware/cors/metrics.js';

describe('CORS metrics', () => {
  beforeEach(() => {
    resetCorsMetrics();
    vi.useRealTimers();
  });

  describe('counter (gateway_cors_requests_total)', () => {
    it('debería incrementar el counter para decision="allowed"', async () => {
      recordCorsDecision('allowed');
      recordCorsDecision('allowed');
      const value = await corsRequestsTotal.get();
      const allowed = value.values.find((v) => v.labels.decision === 'allowed');
      expect(allowed?.value).toBe(2);
    });

    it('debería incrementar el counter para decision="blocked"', async () => {
      recordCorsDecision('blocked');
      const value = await corsRequestsTotal.get();
      const blocked = value.values.find((v) => v.labels.decision === 'blocked');
      expect(blocked?.value).toBe(1);
    });

    it('debería incrementar el counter para decision="preflight"', async () => {
      recordCorsDecision('preflight');
      const value = await corsRequestsTotal.get();
      const preflight = value.values.find((v) => v.labels.decision === 'preflight');
      expect(preflight?.value).toBe(1);
    });

    it('debería incrementar el counter para decision="no_origin"', async () => {
      recordCorsDecision('no_origin');
      const value = await corsRequestsTotal.get();
      const noOrigin = value.values.find((v) => v.labels.decision === 'no_origin');
      expect(noOrigin?.value).toBe(1);
    });
  });

  describe('histogram (gateway_cors_decision_duration_seconds)', () => {
    it('debería estar registrado en el register global de prom-client', async () => {
      const metrics = await register.metrics();
      expect(metrics).toContain('gateway_cors_decision_duration_seconds');
    });

    it('debería observar la duración calculada entre dos timestamps', async () => {
      // Usar un start time en el pasado para forzar una duración medible
      const startTimeMs = Date.now() - 10; // 10ms atrás
      recordCorsDecisionDuration('allowed', startTimeMs);

      const value = await corsDecisionDurationSeconds.get();
      // Histogram expone _sum (suma de observaciones) y _count (cantidad) además de buckets
      const sumEntry = value.values.find((v) => v.metricName === 'gateway_cors_decision_duration_seconds_sum');
      const countEntry = value.values.find((v) => v.metricName === 'gateway_cors_decision_duration_seconds_count');
      // La suma de observaciones debe ser >= 10ms
      expect(sumEntry?.value).toBeGreaterThanOrEqual(0.01);
      expect(countEntry?.value).toBe(1);
    });

    it('debería trackear decisiones de diferentes tipos por separado', async () => {
      // Preflight con duración 1ms, blocked con duración 5ms
      recordCorsDecisionDuration('preflight', Date.now() - 1);
      recordCorsDecisionDuration('blocked', Date.now() - 5);

      const value = await corsDecisionDurationSeconds.get();
      const sums = value.values.filter((v) => v.metricName === 'gateway_cors_decision_duration_seconds_sum');
      const preflightSum = sums.find((v) => v.labels.decision === 'preflight');
      const blockedSum = sums.find((v) => v.labels.decision === 'blocked');
      expect(preflightSum).toBeDefined();
      expect(blockedSum).toBeDefined();
      expect(blockedSum?.value).toBeGreaterThan(preflightSum?.value ?? 0);
    });

    it('debería usar buckets de baja latencia para decisiones rápidas', async () => {
      const histogram = corsDecisionDurationSeconds as unknown as { upperBounds: number[] };
      // Verificar que los buckets están definidos y son razonables para decisiones CORS
      // (esperamos buckets en el rango 0.1ms - 1s)
      expect(histogram.upperBounds).toBeDefined();
      expect(histogram.upperBounds.length).toBeGreaterThan(0);
      // El bucket más pequeño debe ser 0.0001 (100 microsegundos)
      expect(histogram.upperBounds[0]).toBe(0.0001);
    });
  });

  describe('resetCorsMetrics', () => {
    it('debería resetear el counter', async () => {
      recordCorsDecision('allowed');
      recordCorsDecision('blocked');
      recordCorsDecision('preflight');
      resetCorsMetrics();

      const value = await corsRequestsTotal.get();
      for (const v of value.values) {
        expect(v.value).toBe(0);
      }
    });

    it('debería resetear el histogram', async () => {
      recordCorsDecisionDuration('allowed', Date.now() - 5);
      recordCorsDecisionDuration('preflight', Date.now() - 10);
      resetCorsMetrics();

      const value = await corsDecisionDurationSeconds.get();
      // Después del reset, todas las sums y counts deben ser 0
      for (const v of value.values) {
        expect(v.value).toBe(0);
      }
    });
  });
});