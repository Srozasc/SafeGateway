import type {
  JwtAuthConfig,
  JwtGlobalConfig,
  JwtOverrideConfig,
  JwtSharedSecretConfig,
} from '../../config/types.js';
import type { ResolvedJwtAuth } from './types.js';

/**
 * Resuelve la configuración JWT efectiva para una ruta, aplicando precedencia
 * de 3 niveles (mayor a menor):
 *   1. `jwtOverrides[path=X]` (path-exact) si existe
 *   2. `routes[].jwt` (per-route)
 *   3. `jwt` (global) si `mode === 'jwks'` y la ruta referencia por nombre
 *
 * Casos especiales:
 *   - Ruta sin `jwt` block → `public`
 *   - Ruta con `jwt.enabled === false` → `public`
 *   - Ruta con `jwt.mode === 'shared-secret'` o con campo `secret` (legacy) → `shared-secret`
 *   - Ruta con `jwt.mode === 'jwks'`:
 *       - `jwt.issuer === "any"` → `jwks-any` (requiere global con issuers)
 *       - `jwt.issuer === "<name>"` → `jwks-specific` (resuelto contra global.issuers)
 *
 * Esta función es PURA y solo consulta las refs a `JwtOverrideConfig` vía Map
 * para lookup O(1). El `RouteRegistry` ya indexa `jwtOverrides` por path.
 */
export function mergeJwtAuth(
  routeJwt: JwtAuthConfig | undefined | null,
  jwtOverride: JwtAuthConfig | undefined | null,
  globalJwt: JwtGlobalConfig | undefined,
): ResolvedJwtAuth {
  // La precedencia efectiva es: override > route > global
  const effective = jwtOverride ?? routeJwt;

  if (!effective) {
    return { kind: 'public' };
  }

  if (effective.enabled === false) {
    return { kind: 'public' };
  }

  // Modo shared-secret: presencia de `secret` (legacy) o mode explícito
  const isSharedSecret = 'secret' in effective && effective.secret !== undefined;
  if (isSharedSecret) {
    return { kind: 'shared-secret', config: effective as JwtSharedSecretConfig };
  }

  // Modo JWKS: requiere sección global con issuers
  if (!globalJwt) {
    return { kind: 'public' };
  }

  // jwks-any: acepta cualquier issuer registrado
  if (effective.issuer === 'any') {
    const names = globalJwt.issuers.map((i) => i.name);
    if (names.length === 0) {
      return { kind: 'public' };
    }
    return { kind: 'jwks-any', issuerNames: names, config: globalJwt };
  }

  // jwks-specific: referencia por nombre
  if (!globalJwt.issuers.some((i) => i.name === effective.issuer)) {
    return { kind: 'public' };
  }

  // narrow: a esta altura effective es JwtJwksConfig y .issuer está definido
  const issuerName = effective.issuer as string;
  return { kind: 'jwks-specific', issuerName, config: globalJwt };
}

/** Type guard para identificar ramas de la unión discriminated. */
export function isJwksRoute(
  resolved: ResolvedJwtAuth,
): resolved is
  | { kind: 'jwks-specific'; issuerName: string; config: JwtGlobalConfig }
  | { kind: 'jwks-any'; issuerNames: string[]; config: JwtGlobalConfig } {
  return resolved.kind === 'jwks-specific' || resolved.kind === 'jwks-any';
}

/** Indexa `jwtOverrides[]` por path para lookup O(1) en RouteRegistry. */
export function indexJwtOverrides(overrides: JwtOverrideConfig[] | undefined): Map<string, JwtAuthConfig> {
  const map = new Map<string, JwtAuthConfig>();
  if (!overrides) {return map;}
  for (const o of overrides) {
    map.set(o.path, o.jwt);
  }
  return map;
}