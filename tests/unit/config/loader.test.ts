import fs from 'fs';
import { vi, describe, it, expect, beforeEach, afterAll, MockInstance } from 'vitest';
import { loadConfig, interpolateEnvVars } from '../../../src/config/loader.js';
import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  MissingEnvVarError,
} from '../../../src/errors/types.js';

describe('Config Loader & Interpolator', () => {
  const originalEnv = { ...process.env };
  let existsSpy: MockInstance<typeof fs.existsSync>;
  let readSpy: MockInstance<typeof fs.readFileSync>;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };

    // Crear espías limpios sobre fs
    existsSpy = vi.spyOn(fs, 'existsSync') as MockInstance<typeof fs.existsSync>;
    readSpy = vi.spyOn(fs, 'readFileSync') as unknown as MockInstance<
      typeof fs.readFileSync
    >;
  });

  afterAll(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('interpolateEnvVars', () => {
    it('debería interpolar correctamente variables de entorno existentes', () => {
      process.env['REDIS_URL'] = 'redis://localhost:6379';
      process.env['PORT'] = '3000';

      const rawContent = 'url: ${REDIS_URL}\nport: ${PORT}';
      const result = interpolateEnvVars(rawContent);

      expect(result).toBe('url: redis://localhost:6379\nport: 3000');
    });

    it('debería lanzar MissingEnvVarError si una variable no está definida', () => {
      const rawContent = 'url: ${NON_EXISTING_VAR}';

      expect(() => interpolateEnvVars(rawContent)).toThrow(MissingEnvVarError);
      expect(() => interpolateEnvVars(rawContent)).toThrow(
        'La variable de entorno requerida no está definida en el sistema: ${NON_EXISTING_VAR}',
      );
    });
  });

  describe('loadConfig', () => {
    it('debería lanzar ConfigFileNotFoundError si el archivo no existe', () => {
      existsSpy.mockReturnValue(false);

      expect(() => loadConfig('invalid-path.yaml')).toThrow(ConfigFileNotFoundError);
    });

    it('debería lanzar ConfigParseError si el archivo tiene YAML inválido', () => {
      existsSpy.mockReturnValue(true);
      // Sintaxis YAML verdaderamente rota con llaves mal estructuradas que causa error de parseo inmediato
      readSpy.mockReturnValue('invalid: { [ } : \t tab_illegal' as unknown as ReturnType<typeof fs.readFileSync>);

      expect(() => loadConfig('invalid.yaml')).toThrow(ConfigParseError);
    });

    it('debería lanzar ConfigValidationError si la validación de Zod falla', () => {
      const invalidYamlContent = `
server:
  port: 999999 # Inválido (fuera de rango)
redis:
  url: "not-a-redis-url" # Inválido
routes: [] # Inválido (requiere al menos una ruta)
`;
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue(invalidYamlContent as unknown as ReturnType<typeof fs.readFileSync>);

      expect(() => loadConfig('invalid-schema.yaml')).toThrow(ConfigValidationError);
      expect(() => loadConfig('invalid-schema.yaml')).toThrow(
        'La validación de la configuración falló',
      );
    });

    it('debería cargar exitosamente y aplicar valores por defecto en un YAML válido', () => {
      const validYamlContent = `
redis:
  url: "redis://localhost:6379"
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    rateLimit:
      maxRequests: 100
      windowSeconds: 60
`;
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue(validYamlContent as unknown as ReturnType<typeof fs.readFileSync>);

      const config = loadConfig('valid.yaml');

      // Validar mapeo de campos
      expect(config.redis.url).toBe('redis://localhost:6379');
      expect(config.routes[0]?.prefix).toBe('/api');
      expect(config.routes[0]?.target).toBe('http://backend:8080');

      // Validar aplicación de valores por defecto
      expect(config.server.port).toBe(3000);
      expect(config.server.host).toBe('0.0.0.0');
      expect(config.redis.onFailure).toBe('open');
      expect(config.logging.level).toBe('info');
      expect(config.routes[0]?.stripPrefix).toBe(false);
    });

    it('debería retornar un objeto completamente congelado (inmutable)', () => {
      const validYamlContent = `
redis:
  url: "redis://localhost:6379"
routes:
  - prefix: "/api"
    target: "http://backend:8080"
`;
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue(validYamlContent as unknown as ReturnType<typeof fs.readFileSync>);

      const config = loadConfig('valid.yaml');

      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.server)).toBe(true);
      expect(Object.isFrozen(config.redis)).toBe(true);
      expect(Object.isFrozen(config.routes)).toBe(true);
      expect(Object.isFrozen(config.routes[0])).toBe(true);

      // Intentar mutar debería dar error en strict mode
      expect(() => {
        (config as unknown as { server: { port: number } }).server.port = 4000;
      }).toThrow();
    });
  });
});
