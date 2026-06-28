import type { CorsConfig } from '../../config/types.js';

/**
 * Defaults para una configuración CORS efectiva (todos los campos poblados).
 * Se aplican cuando una CorsConfig parcial no especifica un campo.
 */
export const DEFAULT_CORS_CONFIG: Required<CorsConfig> = {
  enabled: false,
  origins: [],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: [],
  credentials: false,
  maxAge: 86400,
};

/**
 * Resuelve una wildcard "*" en `methods` a la lista completa de métodos por defecto.
 * Es la implementación de la asunción A17: methods: ["*"] == métodos completos.
 */
function expandMethodWildcard(methods: string[]): string[] {
  if (methods.length === 1 && methods[0] === '*') {
    return [...DEFAULT_CORS_CONFIG.methods];
  }
  return methods;
}

/**
 * Mergea múltiples CorsConfig parciales con precedencia.
 * El primer argumento tiene la precedencia más alta (caso típico: path override > route > global).
 * Los campos no especificados se completan con DEFAULT_CORS_CONFIG.
 *
 * @example
 *   mergeCorsConfigs(globalCors, routeCors, pathOverrideCors)
 *   // pathOverrideCors > routeCors > globalCors > defaults
 */
export function mergeCorsConfigs(...partials: Array<CorsConfig | undefined | null>): CorsConfig {
  const merged: CorsConfig = {};
  for (const partial of partials) {
    if (partial) {
      Object.assign(merged, partial);
    }
  }
  return applyDefaults(merged);
}

/**
 * Aplica los defaults a una CorsConfig (puede tener campos parciales).
 * Expande la wildcard "*" en methods (A17).
 */
export function applyDefaults(config: CorsConfig): CorsConfig {
  return {
    enabled: config.enabled ?? DEFAULT_CORS_CONFIG.enabled,
    origins: config.origins ?? DEFAULT_CORS_CONFIG.origins,
    methods: expandMethodWildcard(config.methods ?? DEFAULT_CORS_CONFIG.methods),
    allowedHeaders: config.allowedHeaders ?? DEFAULT_CORS_CONFIG.allowedHeaders,
    exposedHeaders: config.exposedHeaders ?? DEFAULT_CORS_CONFIG.exposedHeaders,
    credentials: config.credentials ?? DEFAULT_CORS_CONFIG.credentials,
    maxAge: config.maxAge ?? DEFAULT_CORS_CONFIG.maxAge,
  };
}