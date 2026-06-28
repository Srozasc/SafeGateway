import type { CorsConfig } from '../../config/types.js';

/**
 * Normaliza un origin para comparación case-insensitive.
 * Devuelve scheme + host + port en lowercase.
 * Si el input no es una URL válida, devuelve el input en lowercase.
 *
 * @example
 *   normalizeOrigin("HTTPS://Example.COM:443") -> "https://example.com:443"
 *   normalizeOrigin("https://app.flashdrop.cl") -> "https://app.flashdrop.cl"
 *   normalizeOrigin("not-a-url") -> "not-a-url"
 */
export function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return origin.toLowerCase();
  }
}

/**
 * Resultado de verificar un origin contra la allowlist.
 * - 'allowed': origin específico permitido
 * - 'wildcard': '*' en la allowlist (permite cualquier origin)
 * - 'blocked': origin NO está en la allowlist
 */
export type OriginMatchResult = 'allowed' | 'wildcard' | 'blocked';

/**
 * Verifica si un origin está permitido en la allowlist.
 *
 * Casos especiales:
 * - Si origins contiene '*', devuelve 'wildcard' (cualquier origin pasa).
 * - Si origins contiene el origin normalizado, devuelve 'allowed'.
 * - Si no, devuelve 'blocked'.
 *
 * @param origin Origin recibido del header Origin (ya normalizado).
 * @param allowedOrigins Lista de origins permitidos (sin normalizar).
 */
export function matchOrigin(origin: string, allowedOrigins: string[]): OriginMatchResult {
  if (allowedOrigins.length === 0) {
    return 'blocked';
  }

  if (allowedOrigins.includes('*')) {
    return 'wildcard';
  }

  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedAllowed = allowedOrigins.map(normalizeOrigin);

  if (normalizedAllowed.includes(normalizedOrigin)) {
    return 'allowed';
  }

  return 'blocked';
}

/**
 * Extrae el primer valor válido del header Origin.
 *
 * Casos manejados:
 * - Header ausente → null
 * - Header vacío ('') → null
 * - Header con valor 'null' literal → null
 * - Header como string → trimmed
 * - Header como array → primer valor no vacío
 *
 * Devuelve el valor normalizado, o null si no hay un origin válido.
 */
export function extractOrigin(headers: Record<string, string | string[] | undefined>): string | null {
  const originHeader = headers['origin'] ?? headers['Origin'];

  if (!originHeader) {
    return null;
  }

  // Header puede venir como string o como array (multi-value)
  let raw: string;
  if (Array.isArray(originHeader)) {
    raw = originHeader[0] ?? '';
  } else {
    raw = originHeader;
  }

  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') {
    return null;
  }

  return normalizeOrigin(trimmed);
}

/**
 * Determina si una combinación de origins + credentials es válida.
 * Devuelve el error si la combinación es inválida, o null si OK.
 *
 * Reglas:
 * - origins=["*"] + credentials=true → inválido (no se puede usar credentials con wildcard)
 * - allowedHeaders=["*"] + credentials=true → inválido (CORS spec no permite esto)
 * - enabled=true + origins=[] → inválido (necesita al menos un origin)
 */
export function validateCorsCombination(config: CorsConfig): string | null {
  if (config.enabled && (!config.origins || config.origins.length === 0)) {
    return 'cors: enabled=true requires at least one origin (use ["*"] for wildcard)';
  }
  if (config.origins?.includes('*') && config.credentials) {
    return 'cors: cannot use credentials=true with wildcard origin "*"';
  }
  if (config.allowedHeaders?.includes('*') && config.credentials) {
    return 'cors: cannot use allowedHeaders=["*"] with credentials=true';
  }
  return null;
}