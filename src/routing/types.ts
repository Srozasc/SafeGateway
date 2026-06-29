import { RouteConfig, OverrideConfig, RateLimitConfig, CorsConfig, JwtAuthConfig, JwtGlobalConfig } from '../config/types.js';
import type { ResolvedJwtAuth } from '../middleware/jwt-auth/types.js';

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

  /**
   * Configuración JWT efectiva aplicada con precedencia:
   * jwtOverrides[path] > routes[].jwt > jwt (global cuando aplica).
   * Si la ruta no requiere auth JWT, el `kind` será `'public'` y el plugin
   * hará bypass total.
   */
  effectiveJwt: ResolvedJwtAuth;

  /**
   * JWT override aplicado (path-exact). Se mantiene accesible para inspección
   * y para que tests puedan verificar la precedencia sin re-mergear.
   */
  jwtOverride: JwtAuthConfig | null;

  /**
   * Sección global `jwt` del config — expuesta en el match para que el plugin
   * pueda resolver el cliente JWKS por nombre o por claim `iss`.
   */
  globalJwt: JwtGlobalConfig | undefined;
}
