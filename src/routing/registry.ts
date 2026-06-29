import { GatewayConfig, RouteConfig, OverrideConfig, CorsConfig, JwtAuthConfig, JwtGlobalConfig } from '../config/types.js';
import { RouteMatch } from './types.js';
import { mergeCorsConfigs } from '../middleware/cors/merge.js';
import { mergeJwtAuth, indexJwtOverrides } from '../middleware/jwt-auth/merge.js';

export class RouteRegistry {
  private readonly routes: RouteConfig[];
  private readonly overrides: Map<string, OverrideConfig>;
  private readonly corsOverrides: Map<string, CorsConfig>;
  private readonly jwtOverrides: Map<string, JwtAuthConfig>;
  private readonly globalCors: CorsConfig | undefined;
  private readonly globalJwt: JwtGlobalConfig | undefined;

  constructor(config: GatewayConfig) {
    // Ordenar las rutas por longitud de prefijo de forma descendente (el prefijo más largo primero)
    // Esto asegura que la coincidencia de prefijos encuentre el más específico primero
    this.routes = [...config.routes].sort((a, b) => b.prefix.length - a.prefix.length);

    // Almacenar los overrides en un Map para búsquedas de alta performance en O(1)
    this.overrides = new Map<string, OverrideConfig>();
    if (config.overrides) {
      for (const override of config.overrides) {
        this.overrides.set(override.path, override);
      }
    }

    // CORS path-exact overrides (corsOverrides[])
    this.corsOverrides = new Map<string, CorsConfig>();
    if (config.corsOverrides) {
      for (const override of config.corsOverrides) {
        this.corsOverrides.set(override.path, override.cors);
      }
    }

    // JWT path-exact overrides (jwtOverrides[])
    this.jwtOverrides = indexJwtOverrides(config.jwtOverrides);

    // CORS global (puede ser undefined)
    this.globalCors = config.cors;

    // JWT global (puede ser undefined)
    this.globalJwt = config.jwt;
  }

  /**
   * Resuelve el matching de ruta para una URL de petición entrante.
   * Prioridad: Override exacto -> Prefijo más específico (largo).
   *
   * @param url URL de la petición entrante (puede contener query params).
   * @returns El RouteMatch correspondiente o null si ninguna ruta coincide.
   */
  public match(url: string): RouteMatch | null {
    // 1. Limpiar el path removiendo query params
    const pathWithoutQuery = url.split('?')[0] || '/';

    // 2. Buscar override exacto (rate-limit)
    const override = this.overrides.get(pathWithoutQuery) || null;

    // 3. Buscar override exacto de CORS
    const corsOverride = this.corsOverrides.get(pathWithoutQuery) || null;

    // 3.1. Buscar override exacto de JWT
    const jwtOverride = this.jwtOverrides.get(pathWithoutQuery) || null;

    // 4. Buscar la ruta correspondiente por prefijo
    // Como las rutas están ordenadas de mayor a menor longitud, la primera coincidencia es la más específica
    const route = this.routes.find((r) => {
      if (r.prefix === '/') {
        return true; // Prefijo raíz coincide con todo
      }

      // Debe coincidir exactamente con el prefijo o ser seguido por una barra diagonal
      // Ej: prefijo /api debe coincidir con /api o /api/users, pero NO con /apiv2
      return pathWithoutQuery === r.prefix || pathWithoutQuery.startsWith(`${r.prefix}/`);
    });

    // Si encontramos un override pero no hay ruta padre que abarque este path, no podemos enrutar
    if (override && !route) {
      return null;
    }

    // Si no hay ruta ni override coincidente
    if (!route) {
      return null;
    }

    // Determinar el rate limit efectivo
    // Prioridad: 1. Override Rate Limit, 2. Route Rate Limit, 3. null (sin límite)
    const effectiveRateLimit = override ? override.rateLimit : route.rateLimit || null;

    // Determinar el CORS efectivo
    // Prioridad (mayor a menor): corsOverrides[path] > route.cors > globalCors
    // mergeCorsConfigs itera y asigna, así que pasamos de menor a mayor prioridad
    // para que el último argumento (mayor prioridad) gane.
    const effectiveCors =
      corsOverride || route.cors || this.globalCors
        ? mergeCorsConfigs(this.globalCors, route.cors, corsOverride)
        : null;

    // Determinar el JWT efectivo (precedencia 3 niveles)
    const effectiveJwt = mergeJwtAuth(route.jwt, jwtOverride, this.globalJwt);

    return {
      route,
      override,
      effectiveRateLimit,
      effectiveCors,
      effectiveJwt,
      jwtOverride,
      globalJwt: this.globalJwt,
    };
  }

  /**
   * Obtiene la lista interna de rutas ordenadas (útil para inspección y debugging).
   */
  public getRoutes(): ReadonlyArray<RouteConfig> {
    return this.routes;
  }

  /**
   * Obtiene el mapa interno de overrides (útil para inspección y debugging).
   */
  public getOverrides(): ReadonlyMap<string, OverrideConfig> {
    return this.overrides;
  }

  /**
   * Obtiene el mapa interno de corsOverrides (útil para inspección y debugging).
   */
  public getCorsOverrides(): ReadonlyMap<string, CorsConfig> {
    return this.corsOverrides;
  }

  /**
   * Obtiene el mapa interno de jwtOverrides (útil para inspección y debugging).
   */
  public getJwtOverrides(): ReadonlyMap<string, JwtAuthConfig> {
    return this.jwtOverrides;
  }

  /**
   * Obtiene todos los matches de rutas ordenados de más específico a menos específico.
   * Útil para registrar todas las rutas en el servidor.
   */
  public getAllMatches(): RouteMatch[] {
    return this.routes.map((route) => ({
      route,
      override: this.overrides.get(route.prefix) || null,
      effectiveRateLimit: route.rateLimit || null,
      effectiveCors: route.cors || this.globalCors ? mergeCorsConfigs(this.globalCors, route.cors) : null,
      effectiveJwt: mergeJwtAuth(route.jwt, null, this.globalJwt),
      jwtOverride: null,
      globalJwt: this.globalJwt,
    }));
  }
}