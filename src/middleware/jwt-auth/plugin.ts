import { jwtVerify } from 'jose';
import { Logger } from 'pino';
import { GatewayPlugin, RequestContext } from '../pipeline.js';
import { type JwtAuthConfig, JWT_CLAIM_HEADER_PREFIX, DEFAULT_FORWARD_CLAIMS } from './types.js';

export class JwtAuthPlugin implements GatewayPlugin {
  public readonly name = 'jwt-auth';
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Middleware hook ejecutado antes de reenviar la petición al proxy.
   */
  public async onRequest(ctx: RequestContext): Promise<void> {
    const { request, reply, routeMatch } = ctx;

    // 1. Obtener configuración JWT de la ruta matcheada
    const jwtConfig = routeMatch.route.jwt as JwtAuthConfig | undefined;
    if (!jwtConfig || jwtConfig.enabled === false) {
      return; // Ruta pública o autenticación JWT deshabilitada
    }

    // 2. Sanitizar cabeceras entrantes para prevenir spoofing
    this.sanitizeClaimHeaders(request);

    // 3. Extraer token del header Authorization
    const token = this.extractBearerToken(request);
    if (!token) {
      this.logger.warn({ url: request.url }, 'Petición rechazada: Cabecera Authorization no encontrada o malformada');
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Token de autenticación requerido.',
        statusCode: 401,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 4. Verificar firma y expiración del token
    try {
      const secretKey = new TextEncoder().encode(jwtConfig.secret);
      const algorithm = jwtConfig.algorithm || 'HS256';
      
      const { payload } = await jwtVerify(token, secretKey, {
        algorithms: [algorithm],
      });

      // 5. Almacenar claims en el contexto interno del request
      if (request.gatewayContext) {
        request.gatewayContext.jwtClaims = payload;
      }

      // 6. Inyectar claims como headers para el backend
      const claimsToForward = jwtConfig.forwardClaims || DEFAULT_FORWARD_CLAIMS;
      this.injectClaimHeaders(request, payload, claimsToForward);

    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), url: request.url },
        'Token JWT inválido, expirado o malformado'
      );

      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Token de autenticación inválido o expirado.',
        statusCode: 401,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Extrae el token JWT del header Authorization (Bearer <token>).
   */
  private extractBearerToken(request: any): string | null {
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
   * Esto previene ataques de suplantación (spoofing) de claims.
   */
  private sanitizeClaimHeaders(request: any): void {
    const headers = request.headers;
    const headerKeys = Object.keys(headers);
    
    for (const key of headerKeys) {
      if (key.toLowerCase().startsWith(JWT_CLAIM_HEADER_PREFIX)) {
        delete headers[key];
      }
    }
  }

  /**
   * Inyecta los claims decodificados como headers normalizados en lowercase para el backend.
   * Solo inyecta valores escalares (string, number, boolean).
   */
  private injectClaimHeaders(request: any, payload: any, claimsToForward: string[]): void {
    for (const claim of claimsToForward) {
      const value = payload[claim];
      if (value !== undefined && value !== null) {
        const valueType = typeof value;
        if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
          // Normalizar el nombre de la cabecera en lowercase
          const headerName = `${JWT_CLAIM_HEADER_PREFIX}${claim.toLowerCase()}`;
          request.headers[headerName] = String(value);
        }
      }
    }
  }
}
