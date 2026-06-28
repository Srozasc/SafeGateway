import { RouteMatch } from '../../routing/types.js';

/**
 * Extrae de forma segura el hostname de una URL de target.
 *
 * @param targetUrl URL del target del backend.
 * @returns El hostname extraído, o 'unknown' en caso de error.
 */
export function extractHostname(targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl);
    return parsed.hostname;
  } catch (_error) {
    return 'unknown';
  }
}

/**
 * Resuelve el label 'route' para una petición dada.
 *
 * Prioridades:
 * 1. metricsLabel de la ruta.
 * 2. prefix de la ruta (prefijo lógico).
 * 3. Fallback: "unmatched".
 *
 * @param routeMatch Coincidencia de ruta obtenida en la petición.
 * @returns El valor del label 'route'.
 */
export function resolveRouteLabel(routeMatch?: RouteMatch | null): string {
  if (!routeMatch || !routeMatch.route) {
    return 'unmatched';
  }

  const { route } = routeMatch;
  return route.metricsLabel || route.prefix || 'unmatched';
}

/**
 * Resuelve el label 'backend' para una petición dada.
 *
 * Prioridades:
 * 1. backendName de la ruta.
 * 2. Hostname extraído del target de la ruta.
 * 3. Fallback: "unknown".
 *
 * @param routeMatch Coincidencia de ruta obtenida en la petición.
 * @returns El valor del label 'backend'.
 */
export function resolveBackendLabel(routeMatch?: RouteMatch | null): string {
  if (!routeMatch || !routeMatch.route) {
    return 'unknown';
  }

  const { route } = routeMatch;
  if (route.backendName) {
    return route.backendName;
  }

  if (route.target) {
    return extractHostname(route.target);
  }

  return 'unknown';
}
