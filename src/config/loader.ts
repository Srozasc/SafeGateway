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
    configPathOverride || process.env['CONFIG_PATH'] || './config/gateway.yaml'
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

  // 5. Devolver la configuración congelada de forma inmutable
  return deepFreeze(result.data as GatewayConfig);
}
