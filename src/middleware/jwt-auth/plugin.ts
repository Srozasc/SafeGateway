import { jwtVerify, createLocalJWKSet, decodeJwt, decodeProtectedHeader, errors as joseErrors, JSONWebKeySet, JWTPayload } from 'jose';
import { Logger } from 'pino';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { GatewayPlugin, RequestContext } from '../pipeline.js';
import {
  JWT_CLAIM_HEADER_PREFIX,
  DEFAULT_FORWARD_CLAIMS,
} from './types.js';
import { recordJwtValidation } from './metrics.js';
import { buildErrorResponse } from '../../errors/responses.js';
import type { JwtAuthRegistry } from './registry.js';
import type { JwtIssuerConfig } from '../../config/types.js';

const CLOCK_TOLERANCE_SECONDS = 60;

/**
 * Plugin JWT con soporte dual:
 *  - Modo shared-secret: HS256/HS384/HS512 con secreto local (legacy/compat)
 *  - Modo JWKS: RS256 contra endpoint remoto (múltiples issuers, cache con TTL)
 *
 * El plugin NO firma tokens — solo valida.
 *
 * El `registry` se inyecta como getter/setter para reflejar el snapshot vivo
 * (recargas SIGHUP reconstruyen el JwtAuthRegistry completo).
 */
export class JwtAuthPlugin implements GatewayPlugin {
  public readonly name = 'jwt-auth';
  private readonly logger: Logger;

  /**
   * Registry inyectado. Por defecto es undefined — el bootstrap debe setearlo
   * antes del primer request. Se accede vía getter para reflejar snapshots vivos.
   */
  private _registry: JwtAuthRegistry | undefined;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  public set registry(r: JwtAuthRegistry | undefined) {
    this._registry = r;
  }

  public get registry(): JwtAuthRegistry | undefined {
    return this._registry;
  }

  /**
   * Hook ejecutado antes de reenviar la petición al proxy.
   */
  public async onRequest(ctx: RequestContext): Promise<void> {
    const { request, reply, routeMatch } = ctx;
    const effective = routeMatch.effectiveJwt;

    // Rutas públicas: bypass total (no `jwt` block o `enabled=false`)
    if (effective.kind === 'public') {
      return;
    }

    // Sanitizar cabeceras entrantes para prevenir spoofing de claims
    this.sanitizeClaimHeaders(request);

    // Extraer token del header Authorization
    const token = this.extractBearerToken(request);
    if (!token) {
      recordJwtValidation('missing_token');
      this.logger.warn(
        { url: request.url },
        'Petición rechazada: Cabecera Authorization no encontrada o malformada',
      );
      return this.sendUnauthorized(reply, request.id, 'token de autenticación requerido');
    }

    if (effective.kind === 'shared-secret') {
      return this.verifySharedSecret(request, reply, token, effective.config);
    }

    // jwks-specific | jwks-any
    return this.verifyJwks(request, reply, token, effective);
  }

  // --- Modo shared-secret (HS256/HS384/HS512) ---

  private async verifySharedSecret(
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
    config: { secret: string; algorithm: 'HS256' | 'HS384' | 'HS512'; forwardClaims: string[]; issuer?: string; audience?: string },
  ): Promise<void> {
    try {
      const secretKey = new TextEncoder().encode(config.secret);
      const algorithm = config.algorithm || 'HS256';

      const { payload } = await jwtVerify(token, secretKey, {
        algorithms: [algorithm],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        issuer: config.issuer,
        audience: config.audience,
      });

      // Validar iat manualmente (jose no lo valida contra futuro con tolerancia por defecto)
      this.validateIat(payload, request);

      // Almacenar claims en el contexto interno del request
      if (request.gatewayContext) {
        request.gatewayContext.jwtClaims = payload;
      }

      // Inyectar claims como headers para el backend
      const claimsToForward = config.forwardClaims || DEFAULT_FORWARD_CLAIMS;
      this.injectClaimHeaders(request, payload, claimsToForward);

      recordJwtValidation('ok');
      this.logger.debug({ url: request.url, sub: payload.sub }, 'jwt: token validated (HS)');
    } catch (error) {
      const result = this.classifyJoseError(error);
      recordJwtValidation(result);
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), url: request.url },
        'Token JWT inválido (HS)',
      );
      return this.sendUnauthorized(reply, request.id, 'token de autenticación inválido o expirado');
    }
  }

  // --- Modo JWKS (RS256 contra endpoint remoto) ---

  private async verifyJwks(
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
    effective:
      | { kind: 'jwks-specific'; issuerName: string; config: { issuers: JwtIssuerConfig[] } }
      | { kind: 'jwks-any'; issuerNames: string[]; config: { issuers: JwtIssuerConfig[] } },
  ): Promise<void> {
    const registry = this._registry;
    if (!registry) {
      recordJwtValidation('service_unavailable');
      this.logger.error('jwt: registry no inicializado — fail-closed');
      return this.sendServiceUnavailable(reply, request.id, 'jwt auth no inicializado');
    }

    // 1. Decode (sin verificar) para leer header.kid y payload.iss
    let header: { kid?: string; alg?: string };
    let payloadIss: string | undefined;
    try {
      const decodedHeader = decodeProtectedHeader(token);
      header = decodedHeader as { kid?: string; alg?: string };
      const decodedPayload = decodeJwt(token);
      payloadIss = typeof decodedPayload.iss === 'string' ? decodedPayload.iss : undefined;
    } catch {
      recordJwtValidation('invalid_signature');
      return this.sendUnauthorized(reply, request.id, 'token malformado');
    }

    // 2. Validar algoritmo
    if (header.alg && header.alg !== 'RS256') {
      recordJwtValidation('invalid_signature');
      this.logger.warn({ alg: header.alg, url: request.url }, 'jwt: algoritmo no permitido');
      return this.sendUnauthorized(reply, request.id, 'algoritmo no permitido');
    }

    // 3. Validar kid presente
    if (!header.kid) {
      recordJwtValidation('missing_kid');
      this.logger.warn({ url: request.url }, 'jwt: token sin header kid');
      return this.sendUnauthorized(reply, request.id, 'missing kid header');
    }

    // 4. Resolver el issuer concreto a usar
    let issuerName: string | undefined;
    if (effective.kind === 'jwks-specific') {
      issuerName = effective.issuerName;
    } else {
      // jwks-any: mapear por iss claim
      if (!payloadIss) {
        recordJwtValidation('invalid_issuer');
        return this.sendUnauthorized(reply, request.id, 'invalid issuer');
      }
      const client = registry.resolveByIssClaim(payloadIss);
      if (!client) {
        recordJwtValidation('invalid_issuer');
        this.logger.warn(
          { issClaim: payloadIss, url: request.url },
          'jwt: iss claim no mapea a ningún issuer registrado',
        );
        return this.sendUnauthorized(reply, request.id, 'invalid issuer');
      }
      // Encontrar el nombre del issuer config a partir del cliente
      const matchedName = registry
        .listIssuerNames()
        .find((n) => registry.getClient(n) === client);
      if (!matchedName) {
        recordJwtValidation('service_unavailable');
        return this.sendServiceUnavailable(reply, request.id, 'issuer resolution failed');
      }
      issuerName = matchedName;
    }

    // 5. Resolver el cliente y la issuer config
    const client = registry.getClient(issuerName);
    const issuerCfg = registry.getIssuerConfig(issuerName);
    if (!client || !issuerCfg) {
      recordJwtValidation('service_unavailable');
      return this.sendServiceUnavailable(reply, request.id, 'issuer no disponible');
    }

    // 6. Resolver kid (puede disparar refresh on miss)
    const resolution = await client.resolveKey(header.kid);
    if (!resolution.jwkSet || resolution.foundKid === null) {
      if (resolution.state === 'expired') {
        recordJwtValidation('service_unavailable');
        this.logger.error(
          { issuer: issuerName, kid: header.kid, url: request.url },
          'jwt: cache expirado y refresh falló — devolviendo 503',
        );
        return this.sendServiceUnavailable(reply, request.id, 'unable to verify token: auth service unreachable');
      }
      recordJwtValidation('unknown_kid');
      this.logger.warn(
        { issuer: issuerName, kid: header.kid, url: request.url },
        'jwt: unknown kid incluso después de refresh',
      );
      return this.sendUnauthorized(reply, request.id, 'unknown signing key');
    }

    // 7. Verificar firma y expiración con jose
    let payload: JWTPayload;
    try {
      const jwks = createLocalJWKSet(resolution.jwkSet as JSONWebKeySet);
      const verified = await jwtVerify(token, jwks, {
        algorithms: ['RS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        issuer: issuerCfg.issuer,
        audience: issuerCfg.audience,
      });
      payload = verified.payload;
    } catch (error) {
      const result = this.classifyJoseError(error);
      recordJwtValidation(result);
      this.logger.warn(
        {
          issuer: issuerName,
          err: error instanceof Error ? error.message : String(error),
          url: request.url,
        },
        'Token JWT inválido (JWKS)',
      );
      return this.sendUnauthorized(reply, request.id, 'token de autenticación inválido o expirado');
    }

    // 8. Validar iat manualmente
    if (!this.validateIat(payload, request)) {
      recordJwtValidation('invalid_claims');
      return this.sendUnauthorized(reply, request.id, 'token issued in the future');
    }

    // 9. Almacenar claims e inyectar headers
    if (request.gatewayContext) {
      request.gatewayContext.jwtClaims = payload;
    }

    // Para forwarClaims en JWKS mode, usar la config efectiva o default
    const claimsToForward = DEFAULT_FORWARD_CLAIMS;
    this.injectClaimHeaders(request, payload, claimsToForward);

    recordJwtValidation('ok');
    this.logger.debug(
      { issuer: issuerName, kid: header.kid, sub: payload.sub, url: request.url },
      'jwt: token validated (JWKS)',
    );
  }

  // --- Helpers ---

  /**
   * Extrae el token JWT del header Authorization (Bearer <token>).
   */
  private extractBearerToken(request: FastifyRequest): string | null {
    const authHeader = request.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2) {
      return null;
    }

    const [scheme, token] = parts;
    if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
      return null;
    }

    return token;
  }

  /**
   * Elimina cualquier header entrante del cliente con el prefijo "x-jwt-claim-".
   * Previene ataques de suplantación (spoofing) de claims.
   */
  private sanitizeClaimHeaders(request: FastifyRequest): void {
    const headers = request.headers;
    const headerKeys = Object.keys(headers);
    for (const key of headerKeys) {
      if (key.toLowerCase().startsWith(JWT_CLAIM_HEADER_PREFIX)) {
        delete headers[key];
      }
    }
  }

  /**
   * Inyecta los claims decodificados como headers normalizados en lowercase.
   * Solo inyecta valores escalares (string, number, boolean).
   */
  private injectClaimHeaders(
    request: FastifyRequest,
    payload: Record<string, unknown>,
    claimsToForward: string[],
  ): void {
    for (const claim of claimsToForward) {
      const value = payload[claim];
      if (value !== undefined && value !== null) {
        const valueType = typeof value;
        if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
          const headerName = `${JWT_CLAIM_HEADER_PREFIX}${claim.toLowerCase()}`;
          request.headers[headerName] = String(value);
        }
      }
    }
  }

  /**
   * Valida que `iat` no esté más de 60s en el futuro.
   * Retorna true si OK, false si falla.
   */
  private validateIat(payload: Record<string, unknown>, request: FastifyRequest): boolean {
    const iat = payload['iat'];
    if (typeof iat !== 'number') {return true;}
    const nowSec = Math.floor(Date.now() / 1000);
    if (iat > nowSec + CLOCK_TOLERANCE_SECONDS) {
      this.logger.warn(
        { iat, now: nowSec, url: request.url },
        'jwt: iat en el futuro, token rechazado',
      );
      return false;
    }
    return true;
  }

  /**
   * Clasifica un error de jose en una métrica de resultado.
   */
  private classifyJoseError(error: unknown): 'expired' | 'invalid_signature' | 'invalid_claims' {
    if (error instanceof joseErrors.JWTExpired) {return 'expired';}
    if (
      error instanceof joseErrors.JWTClaimValidationFailed ||
      error instanceof joseErrors.JWSSignatureVerificationFailed ||
      error instanceof joseErrors.JWSInvalid ||
      error instanceof joseErrors.JWTInvalid
    ) {
      return 'invalid_signature';
    }
    return 'invalid_claims';
  }

  private sendUnauthorized(reply: FastifyReply, requestId: string | undefined, message: string): void {
    const err = new Error(message);
    (err as Error & { statusCode: number }).statusCode = 401;
    reply.status(401).send(buildErrorResponse(err, requestId));
  }

  private sendServiceUnavailable(
    reply: FastifyReply,
    requestId: string | undefined,
    message: string,
  ): void {
    const err = new Error(message);
    (err as Error & { statusCode: number }).statusCode = 503;
    reply.status(503).send(buildErrorResponse(err, requestId));
  }
}