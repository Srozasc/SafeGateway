import { describe, it, expect } from 'vitest';
import {
  normalizeOrigin,
  matchOrigin,
  extractOrigin,
  validateCorsCombination,
} from '../../../../src/middleware/cors/index.js';

describe('CORS origins', () => {
  describe('normalizeOrigin', () => {
    it('debería normalizar scheme y host a lowercase', () => {
      expect(normalizeOrigin('HTTPS://Example.COM')).toBe('https://example.com');
    });

    it('debería mantener el puerto normalizado', () => {
      expect(normalizeOrigin('https://app.flashdrop.cl:8080')).toBe('https://app.flashdrop.cl:8080');
    });

    it('debería devolver el input en lowercase si no es una URL válida', () => {
      expect(normalizeOrigin('NOT-A-URL')).toBe('not-a-url');
    });

    it('debería manejar origins con paths (URL completa)', () => {
      // A24: paths no se incluyen en Origin pero por seguridad validamos que la URL sea completa
      expect(normalizeOrigin('https://app.flashdrop.cl')).toBe('https://app.flashdrop.cl');
    });

    it('debería manejar origins con paths y query (no debería llegar pero defensivo)', () => {
      // URL constructor ignora path, así que devolvemos scheme+host
      expect(normalizeOrigin('https://app.flashdrop.cl/path?q=1')).toBe('https://app.flashdrop.cl');
    });
  });

  describe('matchOrigin', () => {
    it('debería retornar "blocked" si allowedOrigins está vacío', () => {
      expect(matchOrigin('https://app.flashdrop.cl', [])).toBe('blocked');
    });

    it('debería retornar "wildcard" si allowedOrigins contiene "*"', () => {
      expect(matchOrigin('https://app.flashdrop.cl', ['*'])).toBe('wildcard');
    });

    it('debería retornar "allowed" si el origin está exactamente en la allowlist', () => {
      expect(matchOrigin('https://app.flashdrop.cl', ['https://app.flashdrop.cl'])).toBe('allowed');
    });

    it('debería retornar "allowed" para match case-insensitive', () => {
      expect(matchOrigin('https://APP.FLASHDROP.CL', ['https://app.flashdrop.cl'])).toBe('allowed');
      expect(matchOrigin('https://app.flashdrop.cl', ['HTTPS://APP.FLASHDROP.CL'])).toBe('allowed');
    });

    it('debería retornar "blocked" si el origin no está en la allowlist', () => {
      expect(matchOrigin('https://malicious.com', ['https://app.flashdrop.cl'])).toBe('blocked');
    });

    it('debería retornar "allowed" si hay múltiples origins y uno coincide', () => {
      const allowed = ['https://admin.flashdrop.cl', 'https://app.flashdrop.cl', 'https://staging.flashdrop.cl'];
      expect(matchOrigin('https://app.flashdrop.cl', allowed)).toBe('allowed');
    });

    it('debería priorizar wildcard si está presente junto a otros origins', () => {
      expect(matchOrigin('https://anywhere.com', ['https://app.flashdrop.cl', '*'])).toBe('wildcard');
    });

    it('debería diferenciar puertos (A24: scheme+host+port)', () => {
      expect(matchOrigin('https://app.flashdrop.cl:8080', ['https://app.flashdrop.cl'])).toBe('blocked');
      expect(matchOrigin('https://app.flashdrop.cl:8080', ['https://app.flashdrop.cl:8080'])).toBe('allowed');
    });
  });

  describe('extractOrigin', () => {
    it('debería devolver null si no hay header Origin', () => {
      expect(extractOrigin({})).toBeNull();
    });

    it('debería devolver null si el header Origin está vacío (A11)', () => {
      expect(extractOrigin({ origin: '' })).toBeNull();
      expect(extractOrigin({ origin: '   ' })).toBeNull();
    });

    it('debería devolver null si el header Origin es "null" literal (A11)', () => {
      expect(extractOrigin({ origin: 'null' })).toBeNull();
      expect(extractOrigin({ origin: 'NULL' })).toBeNull();
      expect(extractOrigin({ origin: 'Null' })).toBeNull();
    });

    it('debería devolver el origin normalizado si es un string válido', () => {
      expect(extractOrigin({ origin: 'https://app.flashdrop.cl' })).toBe('https://app.flashdrop.cl');
      expect(extractOrigin({ origin: '  HTTPS://APP.FLASHDROP.CL  ' })).toBe('https://app.flashdrop.cl');
    });

    it('debería tomar el primer valor si Origin es un array (A12)', () => {
      expect(extractOrigin({ origin: ['https://app.flashdrop.cl', 'https://other.flashdrop.cl'] })).toBe('https://app.flashdrop.cl');
    });

    it('debería devolver null si el array está vacío', () => {
      expect(extractOrigin({ origin: [] })).toBeNull();
    });

    it('debería soportar la variante "Origin" mayúscula del header', () => {
      // HTTP headers son case-insensitive pero el objeto headers puede tener cualquier casing
      expect(extractOrigin({ Origin: 'https://app.flashdrop.cl' })).toBe('https://app.flashdrop.cl');
    });
  });

  describe('validateCorsCombination', () => {
    it('debería retornar error si enabled=true y origins está vacío', () => {
      const result = validateCorsCombination({ enabled: true, origins: [] });
      expect(result).toContain('enabled=true requires at least one origin');
    });

    it('debería retornar null si enabled=true con origins (sin warnings)', () => {
      expect(validateCorsCombination({ enabled: true, origins: ['https://x.com'] })).toBeNull();
    });

    it('debería retornar error si origins=["*"] con credentials=true', () => {
      const result = validateCorsCombination({
        enabled: true,
        origins: ['*'],
        credentials: true,
      });
      expect(result).toContain('cannot use credentials=true with wildcard origin');
    });

    it('debería retornar error si allowedHeaders=["*"] con credentials=true', () => {
      const result = validateCorsCombination({
        enabled: true,
        origins: ['https://x.com'],
        allowedHeaders: ['*'],
        credentials: true,
      });
      expect(result).toContain('cannot use allowedHeaders=["*"] with credentials=true');
    });

    it('debería retornar null para combinaciones válidas', () => {
      expect(
        validateCorsCombination({
          enabled: true,
          origins: ['https://x.com'],
          credentials: false,
        }),
      ).toBeNull();
    });

    it('debería permitir origins=["*"] sin credentials', () => {
      expect(
        validateCorsCombination({
          enabled: true,
          origins: ['*'],
          credentials: false,
        }),
      ).toBeNull();
    });
  });
});