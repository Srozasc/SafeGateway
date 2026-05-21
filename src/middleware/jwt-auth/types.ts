import type { JwtAuthConfig } from '../../config/types.js';

export type { JwtAuthConfig };

// Claims por defecto a inyectar como headers
export const DEFAULT_FORWARD_CLAIMS: string[] = [
  'sub',
  'iss',
  'aud',
  'exp',
  'iat',
  'jti',
];

// Prefijo estándar para headers de claims en lowercase
export const JWT_CLAIM_HEADER_PREFIX = 'x-jwt-claim-';
