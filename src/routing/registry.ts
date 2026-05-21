import { GatewayConfig, RouteConfig, OverrideConfig } from '../config/types.js';
import { RouteMatch } from './types.js';

export class RouteRegistry {
  private readonly routes: RouteConfig[];
  private readonly overrides: Map<string, OverrideConfig>;

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

    // 2. Buscar override exacto
    const override = this.overrides.get(pathWithoutQuery) || null;

    // 3. Buscar la ruta correspondiente por prefijo
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

    return {
      route,
      override,
      effectiveRateLimit,
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
}
