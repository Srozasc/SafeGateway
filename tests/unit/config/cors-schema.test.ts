import { describe, it, expect } from 'vitest';
import { CorsConfigSchema } from '../../../src/config/schema.js';

describe('CorsConfigSchema (Zod validation)', () => {
  describe('schema es permisivo (campos opcionales para permitir overrides parciales)', () => {
    it('debería pasar con config vacía (todos los campos son opcionales)', () => {
      const result = CorsConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('debería pasar con solo enabled=true', () => {
      const result = CorsConfigSchema.safeParse({ enabled: true });
      expect(result.success).toBe(true);
    });

    it('debería pasar con solo origins especificados', () => {
      const result = CorsConfigSchema.safeParse({ origins: ['https://x.com'] });
      expect(result.success).toBe(true);
    });
  });

  describe('validaciones de tipos (a nivel de schema)', () => {
    it('debería fallar si origins contiene strings vacíos', () => {
      const result = CorsConfigSchema.safeParse({ origins: [''] });
      expect(result.success).toBe(false);
    });

    it('debería fallar si maxAge es negativo', () => {
      const result = CorsConfigSchema.safeParse({ maxAge: -1 });
      expect(result.success).toBe(false);
    });

    it('debería fallar si maxAge es 0', () => {
      const result = CorsConfigSchema.safeParse({ maxAge: 0 });
      expect(result.success).toBe(false);
    });
  });
});