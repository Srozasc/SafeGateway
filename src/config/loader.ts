import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { GatewayConfigSchema } from './schema.js';
import { GatewayConfig } from './types.js';
import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  MissingEnvVarError,
} from '../errors/types.js';
import { validateCorsCombination } from '../middleware/cors/origins.js';
import { applyDefaults } from '../middleware/cors/merge.js';

// Helper recursivo para congelar objetos y asegurar inmutabilidad
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj as Readonly<T>;
  }

  const propNames = Reflect.ownKeys(obj);
  for (const name of propNames) {
    const value = (obj as Record<string | symbol, unknown>)[name];
    if (value !== null && typeof value === 'object') {
      deepFreeze(value);
    }
  }

  return Object.freeze(obj);
}

// Interpolar variables de entorno con la sintaxis ${VAR_NAME}
export function interpolateEnvVars(rawContent: string): string {
  return rawContent.replace(/\$\{([^}]+)\}/g, (_match, envVarName) => {
    const value = process.env[envVarName];
    if (value === undefined) {
      throw new MissingEnvVarError(envVarName);
    }
    return value;
  });
}

// Cargar, procesar y validar la configuración
export function loadConfig(configPathOverride?: string): Readonly<GatewayConfig> {
  // Buscar el path en la variable de entorno CONFIG_PATH o el parámetro, con fallback a `./config/gateway.yaml`
  const resolvedPath = path.resolve(
    configPathOverride || process.env['CONFIG_PATH'] || './config/gateway.yaml',
  );

  // 1. Validar que el archivo exista
  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigFileNotFoundError(resolvedPath);
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigFileNotFoundError(`${resolvedPath} (no se pudo leer: ${message})`);
  }

  // 2. Interpolar variables de entorno
  const interpolated = interpolateEnvVars(rawContent);

  // 3. Parsear el archivo YAML
  let parsed: unknown;
  try {
    parsed = yaml.load(interpolated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigParseError(message);
  }

  // 4. Validar el esquema usando Zod
  const result = GatewayConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errorDetails = result.error.issues.map((err) => {
      const fieldPath = err.path.join('.');
      return `Campo "${fieldPath}": ${err.message}`;
    });
    throw new ConfigValidationError(errorDetails);
  }

  // 5. Validar combinaciones CORS inválidas (solo para el config global)
  const config = result.data as GatewayConfig;
  if (config.cors) {
    const mergedGlobal = applyDefaults(config.cors);
    const validationError = validateCorsCombination(mergedGlobal);
    if (validationError) {
      throw new ConfigValidationError([validationError]);
    }
  }

  // 5.1. Validar referencias cruzadas de JWT (issuers desconocidos fallan al arranque)
  validateJwtReferences(config);

  // 6. Devolver la configuración congelada de forma inmutable
  return deepFreeze(config);
}

/**
 * Valida que cada ruta que use modo JWKS (`jwt.issuer`) referencie un issuer
 * declarado en `jwt.issuers[]` o sea exactamente "any".
 * Falla rápido con ConfigValidationError para detectar typos antes del arranque.
 */
function validateJwtReferences(config: GatewayConfig): void {
  const globalIssuers = new Set((config.jwt?.issuers ?? []).map((i) => i.name));
  const errors: string[] = [];

  const checkJwt = (jwt: { mode?: 'shared-secret' | 'jwks'; issuer?: string } | undefined, ref: string): void => {
    if (!jwt) {return;}
    // shared-secret: no necesita issuer global
    if (jwt.mode !== 'jwks') {return;}
    const refIssuer = jwt.issuer;
    if (!refIssuer) {
      errors.push(`${ref}: jwt.mode="jwks" requiere definir jwt.issuer`);
      return;
    }
    if (refIssuer === 'any') {
      if (!config.jwt || globalIssuers.size === 0) {
        errors.push(`${ref}: jwt.issuer="any" requiere que jwt.issuers[] tenga al menos un issuer`);
      }
      return;
    }
    if (!globalIssuers.has(refIssuer)) {
      errors.push(`${ref}: jwt.issuer="${refIssuer}" no existe en jwt.issuers[] (disponibles: ${[...globalIssuers].join(', ') || 'ninguno'})`);
    }
  };

  for (const [i, route] of config.routes.entries()) {
    checkJwt(route.jwt, `routes[${i}] (prefix="${route.prefix}").jwt`);
  }

  for (const [i, override] of (config.jwtOverrides ?? []).entries()) {
    checkJwt(override.jwt, `jwtOverrides[${i}] (path="${override.path}").jwt`);
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }
}
