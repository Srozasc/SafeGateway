import { RouteConfig, OverrideConfig, RateLimitConfig, CorsConfig } from '../config/types.js';

export interface RouteMatch {
  /**
   * Ruta padre del proxy que coincidió con la petición.
   */
  route: RouteConfig;

  /**
   * Override específico que coincidió con el path exacto de la petición, si aplica.
   */
  override: OverrideConfig | null;

  /**
   * Configuración de Rate Limit efectiva a aplicar (de override si existe, si no, de la ruta).
   */
  effectiveRateLimit: RateLimitConfig | null;

  /**
   * Configuración CORS efectiva aplicada con precedencia:
   * corsOverrides[path] > routes[].cors > cors (global). Todos los campos
   * están poblados con defaults si la config parcial no los especifica.
   * null si no hay CORS configurado para esta ruta.
   */
  effectiveCors: CorsConfig | null;
}
