import { Counter, Gauge, Histogram } from 'prom-client';

/**
 * Interfaz que agrupa las métricas personalizadas recolectadas por el API Gateway.
 */
export interface GatewayMetrics {
  /**
   * Total acumulado de peticiones procesadas (exitosas y fallidas).
   */
  requestsTotal: Counter<'method' | 'route' | 'status_code' | 'backend'>;

  /**
   * Histograma de la latencia de las peticiones en segundos.
   */
  requestDuration: Histogram<'method' | 'route' | 'status_code' | 'backend'>;

  /**
   * Gauge que indica la cantidad de peticiones activas/en curso.
   */
  requestsInFlight: Gauge<'method' | 'route'>;

  /**
   * Total de peticiones bloqueadas por rate limit (HTTP 429).
   */
  rateLimitHits: Counter<'route'>;
}
