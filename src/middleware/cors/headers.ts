import type { CorsDecision } from './types.js';

/**
 * Construye los headers CORS para una respuesta de preflight (HTTP 204).
 *
 * Headers siempre incluidos (si el campo está configurado):
 * - Access-Control-Allow-Origin
 * - Access-Control-Allow-Methods
 * - Access-Control-Allow-Headers
 * - Access-Control-Max-Age
 *
 * Header condicional:
 * - Access-Control-Allow-Credentials (solo si credentials=true)
 *
 * NO se incluye Access-Control-Expose-Headers en preflights (A13).
 *
 * @param decision Decisión CORS con origin permitido y config efectiva.
 * @returns Map de headers CORS a aplicar.
 */
export function buildPreflightHeaders(decision: CorsDecision): Record<string, string> {
  const cors = decision.effectiveCors;
  const headers: Record<string, string> = {};

  if (!decision.allowedOrigin) {
    return headers;
  }

  headers['Access-Control-Allow-Origin'] = decision.allowedOrigin;

  if (cors.methods && cors.methods.length > 0) {
    headers['Access-Control-Allow-Methods'] = cors.methods.join(', ');
  }

  if (cors.allowedHeaders && cors.allowedHeaders.length > 0) {
    // Si hay headers solicitados por el browser, reflejar solo los permitidos (A16)
    // Si no hay (caso A10), emitir todos los headers permitidos como fallback
    const allowHeadersValue = decision.requestedHeaders
      ? filterRequestedHeaders(decision.requestedHeaders, cors.allowedHeaders)
      : cors.allowedHeaders.join(', ');

    if (allowHeadersValue) {
      headers['Access-Control-Allow-Headers'] = allowHeadersValue;
    }
  }

  if (typeof cors.maxAge === 'number' && cors.maxAge > 0) {
    headers['Access-Control-Max-Age'] = String(cors.maxAge);
  }

  // Solo emitir Allow-Credentials si credentials=true (A15)
  if (cors.credentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  // Vary: Origin solo si el origin reflejado es específico (no '*') (A14)
  if (decision.allowedOrigin !== '*') {
    headers['Vary'] = 'Origin';
  }

  return headers;
}

/**
 * Construye los headers CORS para una respuesta real del backend.
 *
 * Headers siempre incluidos:
 * - Access-Control-Allow-Origin
 * - Access-Control-Allow-Methods
 * - Access-Control-Allow-Headers
 * - Access-Control-Expose-Headers (si hay)
 *
 * Header condicional:
 * - Access-Control-Allow-Credentials (solo si credentials=true)
 *
 * @param decision Decisión CORS con origin permitido y config efectiva.
 * @returns Map de headers CORS a aplicar.
 */
export function buildActualResponseHeaders(decision: CorsDecision): Record<string, string> {
  const cors = decision.effectiveCors;
  const headers: Record<string, string> = {};

  if (!decision.allowedOrigin) {
    return headers;
  }

  headers['Access-Control-Allow-Origin'] = decision.allowedOrigin;

  if (cors.methods && cors.methods.length > 0) {
    headers['Access-Control-Allow-Methods'] = cors.methods.join(', ');
  }

  if (cors.allowedHeaders && cors.allowedHeaders.length > 0) {
    headers['Access-Control-Allow-Headers'] = cors.allowedHeaders.join(', ');
  }

  // Expose-Headers solo en respuestas reales (A13), nunca en preflights
  if (cors.exposedHeaders && cors.exposedHeaders.length > 0) {
    headers['Access-Control-Expose-Headers'] = cors.exposedHeaders.join(', ');
  }

  // Solo emitir Allow-Credentials si credentials=true (A15)
  if (cors.credentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  // Vary: Origin solo si el origin reflejado es específico (A14)
  if (decision.allowedOrigin !== '*') {
    headers['Vary'] = 'Origin';
  }

  return headers;
}

/**
 * Filtra los headers solicitados por el browser (Access-Control-Request-Headers)
 * para devolver solo los que están en allowedHeaders.
 *
 * Comportamiento:
 * - Si allowedHeaders contiene '*', refleja todos los headers solicitados.
 * - Si no, refleja solo los intersección.
 *
 * @param requestedHeaders Headers solicitados por el browser (puede ser comma-separated string).
 * @param allowedHeaders Lista de headers permitidos.
 * @returns String con headers filtrados (comma-separated) o string vacío.
 */
export function filterRequestedHeaders(requestedHeaders: string | undefined, allowedHeaders: string[]): string {
  if (!requestedHeaders) {
    return '';
  }

  const requested = requestedHeaders
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (requested.length === 0) {
    return '';
  }

  if (allowedHeaders.includes('*')) {
    return requested.join(', ');
  }

  const allowedLower = allowedHeaders.map((h) => h.toLowerCase());
  const filtered = requested.filter((h) => allowedLower.includes(h));

  return filtered.join(', ');
}

/**
 * Extrae el header Access-Control-Request-Method del preflight.
 * Devuelve el método en uppercase o undefined si no está presente.
 */
export function extractRequestedMethod(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers['access-control-request-method'] ?? headers['Access-Control-Request-Method'];
  if (!value) {
    return undefined;
  }
  const str = Array.isArray(value) ? value[0] : value;
  return str?.trim().toUpperCase();
}

/**
 * Extrae el header Access-Control-Request-Headers del preflight.
 * Devuelve el string crudo (puede ser comma-separated) o undefined.
 */
export function extractRequestedHeaders(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers['access-control-request-headers'] ?? headers['Access-Control-Request-Headers'];
  if (!value) {
    return undefined;
  }
  return Array.isArray(value) ? value.join(', ') : value;
}