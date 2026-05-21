export interface RateLimitIncrementResult {
  count: number;
}

export interface RateLimitStore {
  /**
   * Incrementa atómicamente la clave en el store de rate limiting.
   * Si la clave es nueva, inicializa el contador y configura el TTL correspondiente.
   *
   * @param key Clave única en el store (formato: ratelimit:{ip}:{prefix}:{windowStart}).
   * @param windowSeconds Duración de la ventana en segundos (usado para establecer el TTL).
   * @returns El contador acumulado de peticiones en la ventana.
   */
  increment(key: string, windowSeconds: number): Promise<RateLimitIncrementResult>;
}
