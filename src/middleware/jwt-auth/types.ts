import type {
  JwtAuthConfig,
  JwtGlobalConfig,
  JwtIssuerConfig,
  JwtSharedSecretConfig,
} from '../../config/types.js';

export type { JwtAuthConfig, JwtGlobalConfig, JwtIssuerConfig, JwtSharedSecretConfig };

// Modo de validación JWT: secreto compartido (HS256/384/512) o JWKS remoto (RS256)
export type JwtMode = 'shared-secret' | 'jwks';

// Claims por defecto a inyectar como headers
export const DEFAULT_FORWARD_CLAIMS: string[] = ['sub', 'iss', 'aud', 'exp', 'iat', 'jti'];

// Prefijo estándar para headers de claims en lowercase
export const JWT_CLAIM_HEADER_PREFIX = 'x-jwt-claim-';

/**
 * Resolución de la configuración JWT efectiva para una ruta.
 * - 'public': ruta sin autenticación JWT (no hay `jwt` block o `enabled=false`)
 * - 'shared-secret': ruta con HS256/HS384/HS512 usando secreto local
 * - 'jwks-specific': ruta vinculada a un issuer específico por nombre
 * - 'jwks-any': ruta que acepta cualquier issuer registrado (mapeo por `iss` claim)
 *
 * Cada variante lleva la `config`/`cfg` ya estrechada al tipo concreto para
 * evitar casts manuales en los consumidores.
 */
export type ResolvedJwtAuth =
  | { kind: 'public' }
  | { kind: 'shared-secret'; config: JwtSharedSecretConfig }
  | { kind: 'jwks-specific'; issuerName: string; config: JwtGlobalConfig }
  | { kind: 'jwks-any'; issuerNames: string[]; config: JwtGlobalConfig };

/**
 * Resultado de una validación JWT para métricas y logging estructurado.
 * Cardinalidad baja: ~9 valores.
 */
export type JwtValidationResult =
  | 'ok'
  | 'missing_token'
  | 'unknown_kid'
  | 'missing_kid'
  | 'expired'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'invalid_claims'
  | 'invalid_signature'
  | 'service_unavailable';

/**
 * Estado del cache JWKS por issuer.
 * - empty: nunca se hizo fetch exitoso
 * - fresh: dentro del TTL configurado
 * - stale: pasó el TTL pero dentro del staleGracePeriodSeconds
 * - expired: pasó el TTL + staleGracePeriodSeconds
 */
export type JwksCacheState = 'empty' | 'fresh' | 'stale' | 'expired';

/**
 * Resultado de `JwksClient.resolveKey()`.
 * - `jwkSet` es null si el kid no se encontró (cache miss + refresh sin éxito)
 * - `state` siempre refleja el estado actual del cache
 */
export interface JwkResolution {
  jwkSet: unknown | null;
  state: JwksCacheState;
  foundKid: string | null;
}
