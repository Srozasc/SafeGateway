import { describe, it, expect } from 'vitest';
import {
  buildPreflightHeaders,
  buildActualResponseHeaders,
  filterRequestedHeaders,
  extractRequestedMethod,
  extractRequestedHeaders,
} from '../../../../src/middleware/cors/index.js';
import type { CorsDecision } from '../../../../src/middleware/cors/index.js';

const baseCors = {
  enabled: true,
  origins: ['https://app.flashdrop.cl'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: [],
  credentials: false,
  maxAge: 86400,
};

describe('CORS headers', () => {
  describe('buildPreflightHeaders', () => {
    it('debería incluir Access-Control-Allow-Origin con el origin específico', () => {
      const decision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: baseCors,
      };
      const headers = buildPreflightHeaders(decision);
      expect(headers['Access-Control-Allow-Origin']).toBe('https://app.flashdrop.cl');
    });

    it('debería usar "*" cuando allowedOrigin es wildcard', () => {
      const decision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://anywhere.com',
        allowedOrigin: '*',
        effectiveCors: { ...baseCors, origins: ['*'] },
      };
      const headers = buildPreflightHeaders(decision);
      expect(headers['Access-Control-Allow-Origin']).toBe('*');
    });

    it('debería incluir Access-Control-Allow-Methods comma-separated', () => {
      const decision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: baseCors,
      };
      const headers = buildPreflightHeaders(decision);
      expect(headers['Access-Control-Allow-Methods']).toBe(
        'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
      );
    });

    it('debería incluir Access-Control-Allow-Headers', () => {
      const decision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: baseCors,
      };
      const headers = buildPreflightHeaders(decision);
      expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    });

    it('debería incluir Access-Control-Max-Age', () => {
      const decision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: baseCors,
      };
      const headers = buildPreflightHeaders(decision);
      expect(headers['Access-Control-Max-Age']).toBe('86400');
    });

    it('NO debería incluir Access-Control-Allow-Credentials si credentials=false (A15)', () => {
      const decision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: { ...baseCors, credentials: false },
      };
      const headers = buildPreflightHeaders(decision);
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    });

    it('debería incluir Access-Control-Allow-Credentials solo si credentials=true', () => {
      const decision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: { ...baseCors, credentials: true },
      };
      const headers = buildPreflightHeaders(decision);
      expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    });

    it('NO debería incluir Access-Control-Expose-Headers en preflights (A13)', () => {
      const decision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: { ...baseCors, exposedHeaders: ['X-Request-ID', 'X-RateLimit-Remaining'] },
      };
      const headers = buildPreflightHeaders(decision);
      expect(headers['Access-Control-Expose-Headers']).toBeUndefined();
    });

    it('debería incluir Vary: Origin solo cuando allowedOrigin es específico (A14)', () => {
      const specificDecision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: baseCors,
      };
      expect(buildPreflightHeaders(specificDecision)['Vary']).toBe('Origin');

      const wildcardDecision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://anywhere.com',
        allowedOrigin: '*',
        effectiveCors: { ...baseCors, origins: ['*'] },
      };
      expect(buildPreflightHeaders(wildcardDecision)['Vary']).toBeUndefined();
    });

    it('debería devolver {} si allowedOrigin es undefined', () => {
      const decision: CorsDecision = {
        kind: 'preflight',
        origin: 'https://app.flashdrop.cl',
        effectiveCors: baseCors,
      };
      expect(buildPreflightHeaders(decision)).toEqual({});
    });
  });

  describe('buildActualResponseHeaders', () => {
    it('debería incluir Access-Control-Allow-Origin', () => {
      const decision: CorsDecision = {
        kind: 'allowed',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: baseCors,
      };
      const headers = buildActualResponseHeaders(decision);
      expect(headers['Access-Control-Allow-Origin']).toBe('https://app.flashdrop.cl');
    });

    it('debería incluir Access-Control-Expose-Headers en respuestas reales (A13)', () => {
      const decision: CorsDecision = {
        kind: 'allowed',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: { ...baseCors, exposedHeaders: ['X-Request-ID', 'X-RateLimit-Remaining'] },
      };
      const headers = buildActualResponseHeaders(decision);
      expect(headers['Access-Control-Expose-Headers']).toBe('X-Request-ID, X-RateLimit-Remaining');
    });

    it('NO debería incluir Access-Control-Max-Age en respuestas reales', () => {
      // Max-Age solo aplica a preflights
      const decision: CorsDecision = {
        kind: 'allowed',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: baseCors,
      };
      const headers = buildActualResponseHeaders(decision);
      expect(headers['Access-Control-Max-Age']).toBeUndefined();
    });

    it('debería incluir Vary: Origin cuando origin es específico', () => {
      const decision: CorsDecision = {
        kind: 'allowed',
        origin: 'https://app.flashdrop.cl',
        allowedOrigin: 'https://app.flashdrop.cl',
        effectiveCors: baseCors,
      };
      const headers = buildActualResponseHeaders(decision);
      expect(headers['Vary']).toBe('Origin');
    });

    it('NO debería incluir Vary: Origin cuando origin es wildcard', () => {
      const decision: CorsDecision = {
        kind: 'allowed',
        origin: 'https://anywhere.com',
        allowedOrigin: '*',
        effectiveCors: { ...baseCors, origins: ['*'] },
      };
      const headers = buildActualResponseHeaders(decision);
      expect(headers['Vary']).toBeUndefined();
    });
  });

  describe('filterRequestedHeaders', () => {
    it('debería devolver string vacío si no hay headers solicitados', () => {
      expect(filterRequestedHeaders(undefined, ['Content-Type'])).toBe('');
      expect(filterRequestedHeaders('', ['Content-Type'])).toBe('');
    });

    it('debería devolver todos los solicitados si allowedHeaders incluye "*"', () => {
      expect(filterRequestedHeaders('Content-Type, X-Custom', ['*'])).toBe('content-type, x-custom');
    });

    it('debería filtrar solo los headers permitidos', () => {
      expect(filterRequestedHeaders('Content-Type, X-Custom, Authorization', ['Content-Type', 'Authorization']))
        .toBe('content-type, authorization');
    });

    it('debería ser case-insensitive', () => {
      expect(filterRequestedHeaders('CONTENT-TYPE, content-type', ['Content-Type'])).toBe('content-type, content-type');
    });

    it('debería devolver string vacío si ninguno de los solicitados está permitido', () => {
      expect(filterRequestedHeaders('X-Banned', ['Content-Type'])).toBe('');
    });

    it('debería trimear whitespace en los headers solicitados', () => {
      expect(filterRequestedHeaders(' Content-Type , Authorization ', ['Content-Type', 'Authorization']))
        .toBe('content-type, authorization');
    });
  });

  describe('extractRequestedMethod', () => {
    it('debería devolver undefined si no hay header', () => {
      expect(extractRequestedMethod({})).toBeUndefined();
    });

    it('debería devolver el método en uppercase', () => {
      expect(extractRequestedMethod({ 'access-control-request-method': 'post' })).toBe('POST');
      expect(extractRequestedMethod({ 'access-control-request-method': 'PUT' })).toBe('PUT');
    });

    it('debería soportar el header en formato Title-Case', () => {
      expect(extractRequestedMethod({ 'Access-Control-Request-Method': 'DELETE' })).toBe('DELETE');
    });
  });

  describe('extractRequestedHeaders', () => {
    it('debería devolver undefined si no hay header', () => {
      expect(extractRequestedHeaders({})).toBeUndefined();
    });

    it('debería devolver el string crudo tal cual', () => {
      expect(extractRequestedHeaders({ 'access-control-request-headers': 'Content-Type, Authorization' }))
        .toBe('Content-Type, Authorization');
    });

    it('debería juntar valores de array con ", "', () => {
      expect(extractRequestedHeaders({ 'access-control-request-headers': ['Content-Type', 'Authorization'] }))
        .toBe('Content-Type, Authorization');
    });
  });
});