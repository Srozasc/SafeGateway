import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { JwtAuthRegistry } from '../../../src/middleware/jwt-auth/registry.js';
import type { JwtGlobalConfig } from '../../../src/config/types.js';

const logger = pino({ level: 'silent' });

describe('JwtAuthRegistry', () => {
  describe('sin global config', () => {
    it('crea registry vacío si globalConfig es undefined', () => {
      const registry = new JwtAuthRegistry(undefined, logger);
      expect(registry.listIssuerNames()).toEqual([]);
      expect(registry.getClient('any')).toBeUndefined();
    });
  });

  describe('con global config', () => {
    const global: JwtGlobalConfig = {
      enabled: true,
      mode: 'jwks',
      issuers: [
        {
          name: 'auth-prod',
          jwksUri: 'https://auth.example.com/jwks.json',
          issuer: 'https://auth.example.com',
          audience: 'flashdrop-api',
          cacheTtlSeconds: 3600,
          staleGracePeriodSeconds: 1800,
          refreshCooldownSeconds: 30,
          refreshOnMiss: true,
          timeoutMs: 3000,
        },
        {
          name: 'auth-stg',
          jwksUri: 'https://auth-stg.example.com/jwks.json',
          issuer: 'https://auth-stg.example.com',
          audience: 'flashdrop-api',
          cacheTtlSeconds: 600,
          staleGracePeriodSeconds: 300,
          refreshCooldownSeconds: 30,
          refreshOnMiss: true,
          timeoutMs: 3000,
        },
      ],
    };

    it('registra un cliente por cada issuer', () => {
      const registry = new JwtAuthRegistry(global, logger);
      expect(registry.listIssuerNames()).toEqual(['auth-prod', 'auth-stg']);
    });

    it('getClient retorna cliente por nombre', () => {
      const registry = new JwtAuthRegistry(global, logger);
      expect(registry.getClient('auth-prod')).toBeDefined();
      expect(registry.getClient('auth-stg')).toBeDefined();
      expect(registry.getClient('nonexistent')).toBeUndefined();
    });

    it('resolveByIssClaim mapea claim iss a cliente', () => {
      const registry = new JwtAuthRegistry(global, logger);
      expect(registry.resolveByIssClaim('https://auth.example.com')).toBeDefined();
      expect(registry.resolveByIssClaim('https://unknown.com')).toBeNull();
    });

    it('getIssuerConfig retorna config por nombre', () => {
      const registry = new JwtAuthRegistry(global, logger);
      expect(registry.getIssuerConfig('auth-prod')?.audience).toBe('flashdrop-api');
      expect(registry.getIssuerConfig('nonexistent')).toBeUndefined();
    });

    it('startAll y stopAll no lanzan', async () => {
      const registry = new JwtAuthRegistry(global, logger);
      registry.startAll();
      await registry.stopAll();
    });

    it('stopAll con registry vacío es no-op', async () => {
      const registry = new JwtAuthRegistry(undefined, logger);
      await registry.stopAll();
    });
  });
});
