export interface TimeWindow {
  windowStart: number;
  resetAt: number;
}

/**
 * Calcula la ventana de tiempo fija para el algoritmo de rate limiting.
 *
 * @param windowSeconds Duración de la ventana en segundos.
 * @param nowMs Opcional. Timestamp actual en milisegundos (útil para pruebas unitarias).
 * @returns La ventana actual y el Unix timestamp en el que se reiniciará la misma.
 */
export function getCurrentWindow(windowSeconds: number, nowMs: number = Date.now()): TimeWindow {
  const nowSeconds = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const resetAt = windowStart + windowSeconds;

  return {
    windowStart,
    resetAt,
  };
}

/**
 * Construye la clave estructurada de Redis para el rate limiter.
 * Formato: ratelimit:{ip}:{prefix}:{windowStart}
 *
 * @param ip IP remota de origen de la petición.
 * @param prefix Prefijo de la ruta que coincide con la petición.
 * @param windowStart Timestamp de inicio de la ventana actual.
 * @returns Clave única de Redis.
 */
export function buildRateLimitKey(ip: string, prefix: string, windowStart: number): string {
  // Asegurar que caracteres especiales o espacios en los prefijos no rompan el formato de claves en Redis
  const sanitizedPrefix = prefix.replace(/:/g, '_');
  return `ratelimit:${ip}:${sanitizedPrefix}:${windowStart}`;
}
