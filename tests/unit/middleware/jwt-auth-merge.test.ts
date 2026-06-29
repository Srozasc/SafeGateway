import { describe, it, expect } from 'vitest';
import { mergeJwtAuth, indexJwtOverrides } from '../../../src/middleware/jwt-auth/merge.js';
import type { JwtGlobalConfig, JwtIssuerConfig } from '../../../src/config/types.js';

const baseIssuer: JwtIssuerConfig = {
  name: 'auth-prod',
  jwksUri: 'https://auth.example.com/jwks.json',
  issuer: 'https://auth.example.com',
  audience: 'flashdrop-api',
  cacheTtlSeconds: 3600,
  staleGracePeriodSeconds: 1800,
  refreshCooldownSeconds: 30,
  refreshOnMiss: true,
  timeoutMs: 3000,
};

const globalJwt: JwtGlobalConfig = {
  enabled: true,
  mode: 'jwks',
  issuers: [baseIssuer],
};

describe('mergeJwtAuth', () => {
  describe('public routes', () => {
    it('retorna public si no hay jwt block', () => {
      const result = mergeJwtAuth(undefined, undefined, undefined);
      expect(result.kind).toBe('public');
    });

    it('retorna public si enabled=false', () => {
      const result = mergeJwtAuth({ enabled: false, secret: 'x' }, undefined, undefined);
      expect(result.kind).toBe('public');
    });
  });

  describe('shared-secret mode', () => {
    it('detecta shared-secret por presencia de secret', () => {
      const result = mergeJwtAuth(
        { enabled: true, secret: 'my-secret', algorithm: 'HS256', forwardClaims: ['sub'] },
        undefined,
        undefined,
      );
      expect(result.kind).toBe('shared-secret');
      if (result.kind === 'shared-secret') {
        expect(result.config.secret).toBe('my-secret');
      }
    });

    it('no requiere global jwt en shared-secret (compat)', () => {
      const result = mergeJwtAuth(
        { enabled: true, secret: 's', algorithm: 'HS256', forwardClaims: [] },
        undefined,
        undefined,
      );
      expect(result.kind).toBe('shared-secret');
    });
  });

  describe('jwks-specific mode', () => {
    it('resuelve issuer por nombre', () => {
      const result = mergeJwtAuth(
        { enabled: true, mode: 'jwks', issuer: 'auth-prod', forwardClaims: ['sub'] },
        undefined,
        globalJwt,
      );
      expect(result.kind).toBe('jwks-specific');
      if (result.kind === 'jwks-specific') {
        expect(result.issuerName).toBe('auth-prod');
      }
    });

    it('fallback a public si issuer no existe en global', () => {
      const result = mergeJwtAuth(
        { enabled: true, mode: 'jwks', issuer: 'unknown', forwardClaims: [] },
        undefined,
        globalJwt,
      );
      expect(result.kind).toBe('public');
    });

    it('fallback a public si no hay global jwt', () => {
      const result = mergeJwtAuth(
        { enabled: true, mode: 'jwks', issuer: 'auth-prod', forwardClaims: [] },
        undefined,
        undefined,
      );
      expect(result.kind).toBe('public');
    });
  });

  describe('jwks-any mode', () => {
    it('resuelve any a jwks-any con lista de issuers', () => {
      const multi = { ...globalJwt, issuers: [baseIssuer, { ...baseIssuer, name: 'auth-stg', issuer: 'https://stg.example.com' }] };
      const result = mergeJwtAuth(
        { enabled: true, mode: 'jwks', issuer: 'any', forwardClaims: [] },
        undefined,
        multi,
      );
      expect(result.kind).toBe('jwks-any');
      if (result.kind === 'jwks-any') {
        expect(result.issuerNames).toEqual(['auth-prod', 'auth-stg']);
      }
    });

    it('fallback a public si any sin issuers configurados', () => {
      const result = mergeJwtAuth(
        { enabled: true, mode: 'jwks', issuer: 'any', forwardClaims: [] },
        undefined,
        undefined,
      );
      expect(result.kind).toBe('public');
    });
  });

  describe('override precedence', () => {
    it('override gana sobre route', () => {
      const result = mergeJwtAuth(
        { enabled: true, mode: 'jwks', issuer: 'auth-prod', forwardClaims: [] },
        { enabled: false }, // override público
        globalJwt,
      );
      expect(result.kind).toBe('public');
    });

    it('route gana si no hay override', () => {
      const result = mergeJwtAuth(
        { enabled: true, mode: 'jwks', issuer: 'auth-prod', forwardClaims: [] },
        undefined,
        globalJwt,
      );
      expect(result.kind).toBe('jwks-specific');
    });

    it('si no hay override ni route, retorna public', () => {
      const result = mergeJwtAuth(undefined, undefined, globalJwt);
      expect(result.kind).toBe('public');
    });
  });
});

describe('indexJwtOverrides', () => {
  it('indexa overrides por path', () => {
    const map = indexJwtOverrides([
      { path: '/public', jwt: { enabled: false } },
    ]);
    expect(map.size).toBe(1);
    expect(map.get('/public')?.enabled).toBe(false);
  });

  it('retorna mapa vacío si no hay overrides', () => {
    const map = indexJwtOverrides(undefined);
    expect(map.size).toBe(0);
  });
});
