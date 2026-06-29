import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { FastifyRequest, FastifyReply } from 'fastify';
import pino from 'pino';
import { SignJWT } from 'jose';
import { JwtAuthPlugin } from '../../../src/middleware/jwt-auth/plugin.js';
import { RequestContext } from '../../../src/middleware/pipeline.js';
import { RouteMatch } from '../../../src/routing/types.js';

describe('JwtAuthPlugin', () => {
  let mockRequest: FastifyRequest & { gatewayContext: NonNullable<FastifyRequest['gatewayContext']> };
  let mockReply: Mocked<FastifyReply> & { body?: { message?: string; error?: string; statusCode?: number } };
  let mockRouteMatch: RouteMatch;
  const logger = pino({ level: 'silent' });
  const plugin = new JwtAuthPlugin(logger);

  const SECRET_KEY = 'test-secret-key-min-32-chars!!!';

  beforeEach(() => {
    mockRequest = {
      url: '/api/users',
      headers: {},
      gatewayContext: {
        routeMatch: null as unknown as RouteMatch,
      },
    } as unknown as FastifyRequest & { gatewayContext: NonNullable<FastifyRequest['gatewayContext']> };

    mockReply = {
      sent: false,
      statusCode: 200,
      status(this: { statusCode: number }, code: number) {
        this.statusCode = code;
        return this;
      },
      send: vi.fn().mockImplementation(function (this: { sent: boolean; body: unknown }, body: unknown) {
        this.sent = true;
        this.body = body;
        return this;
      }),
    } as unknown as Mocked<FastifyReply> & { body?: { message?: string; error?: string; statusCode?: number } };

    mockRouteMatch = {
      route: {
        prefix: '/api',
        target: 'http://localhost:8080',
        jwt: {
          enabled: true,
          secret: SECRET_KEY,
          algorithm: 'HS256',
          forwardClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'jti', 'role', 'tenant_id'],
        },
      },
      override: null,
      effectiveRateLimit: null,
      effectiveCors: null,
      effectiveJwt: {
        kind: 'shared-secret',
        config: {
          enabled: true,
          secret: SECRET_KEY,
          algorithm: 'HS256',
          forwardClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'jti', 'role', 'tenant_id'],
        },
      },
      jwtOverride: null,
      globalJwt: undefined,
    };

    mockRequest.gatewayContext.routeMatch = mockRouteMatch;
  });

  // Auxiliar para firmar tokens JWT en los tests usando jose
  async function generateToken(
    payload: Record<string, unknown>,
    secret: string = SECRET_KEY,
    algorithm: string = 'HS256',
    expiration: string | number = '2h',
  ): Promise<string> {
    const encodedSecret = new TextEncoder().encode(secret);
    return await new SignJWT(payload)
      .setProtectedHeader({ alg: algorithm })
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(encodedSecret);
  }

  it('debería ser un no-op si la ruta no tiene configuración JWT', async () => {
    delete mockRouteMatch.route.jwt;
    mockRouteMatch.effectiveJwt = { kind: 'public' };
    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(false);
    expect(mockRequest.gatewayContext.jwtClaims).toBeUndefined();
  });

  it('debería ser un no-op si JWT está explícitamente deshabilitado', async () => {
    if (mockRouteMatch.route.jwt) {
      mockRouteMatch.route.jwt.enabled = false;
    }
    mockRouteMatch.effectiveJwt = { kind: 'public' };
    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(false);
    expect(mockRequest.gatewayContext.jwtClaims).toBeUndefined();
  });

  it('debería retornar HTTP 401 si no hay cabecera Authorization', async () => {
    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(true);
    expect(mockReply.statusCode).toBe(401);
    expect(mockReply.body).toMatchObject({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'token de autenticación requerido',
    });
  });

  it('debería retornar HTTP 401 si la cabecera Authorization no usa el esquema Bearer', async () => {
    mockRequest.headers['authorization'] = 'Basic abc123def';
    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(true);
    expect(mockReply.statusCode).toBe(401);
    expect(mockReply.body?.message).toBe('token de autenticación requerido');
  });

  it('debería retornar HTTP 401 si el token tiene una firma inválida', async () => {
    const token = await generateToken(
      { sub: 'user-1' },
      'different-secret-key-32-chars-at-least!!!',
    );
    mockRequest.headers['authorization'] = `Bearer ${token}`;

    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(true);
    expect(mockReply.statusCode).toBe(401);
    expect(mockReply.body?.message).toBe('token de autenticación inválido o expirado');
  });

  it('debería retornar HTTP 401 si el token está expirado', async () => {
    // Generar token con tiempo de expiración en el pasado
    const token = await generateToken({ sub: 'user-1' }, SECRET_KEY, 'HS256', -10); // Expirado hace 10 segundos
    mockRequest.headers['authorization'] = `Bearer ${token}`;

    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(true);
    expect(mockReply.statusCode).toBe(401);
    expect(mockReply.body?.message).toBe('token de autenticación inválido o expirado');
  });

  it('debería retornar HTTP 401 si el token usa un algoritmo diferente al configurado', async () => {
    // Token firmado con HS384 pero configurado con HS256
    const token = await generateToken({ sub: 'user-1' }, SECRET_KEY, 'HS384');
    mockRequest.headers['authorization'] = `Bearer ${token}`;

    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(true);
    expect(mockReply.statusCode).toBe(401);
  });

  it('debería pasar de largo, guardar claims en gatewayContext e inyectar cabeceras si el token es válido', async () => {
    const payload = { sub: 'user-123', role: 'admin', tenant_id: 'tenant-456' };
    const token = await generateToken(payload);
    mockRequest.headers['authorization'] = `Bearer ${token}`;

    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(false);
    expect(mockRequest.gatewayContext.jwtClaims).toBeDefined();
    expect(mockRequest.gatewayContext.jwtClaims!.sub).toBe('user-123');
    expect(mockRequest.gatewayContext.jwtClaims!.role).toBe('admin');

    // Comprobar inyección de cabeceras en lowercase
    expect(mockRequest.headers['x-jwt-claim-sub']).toBe('user-123');
    expect(mockRequest.headers['x-jwt-claim-role']).toBe('admin');
    expect(mockRequest.headers['x-jwt-claim-tenant_id']).toBe('tenant-456');
  });

  it('debería sanitizar/remover las cabeceras x-jwt-claim-* entrantes del cliente para evitar spoofing', async () => {
    const payload = { sub: 'real-user-123' };
    const token = await generateToken(payload);

    mockRequest.headers['authorization'] = `Bearer ${token}`;
    // Headers maliciosos enviados por el cliente
    mockRequest.headers['x-jwt-claim-sub'] = 'spoofed-user';
    mockRequest.headers['X-JWT-Claim-Role'] = 'admin';
    mockRequest.headers['x-jwt-claim-custom'] = 'malicious-data';

    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(false);
    // Deben haberse borrado del cliente y solo estar la inyectada por el plugin
    expect(mockRequest.headers['x-jwt-claim-sub']).toBe('real-user-123');
    expect(mockRequest.headers['x-jwt-claim-role']).toBeUndefined(); // No está en el token
    expect(mockRequest.headers['x-jwt-claim-custom']).toBeUndefined(); // Borrada
  });

  it('debería ignorar claims de tipo objeto o array para la inyección de cabeceras', async () => {
    const payload = {
      sub: 'user-123',
      metadata: { department: 'IT' },
      roles: ['admin', 'billing'],
    };
    const token = await generateToken(payload);
    mockRequest.headers['authorization'] = `Bearer ${token}`;

    const ctx: RequestContext = {
      request: mockRequest,
      reply: mockReply,
      routeMatch: mockRouteMatch,
    };

    await plugin.onRequest(ctx);

    expect(mockReply.sent).toBe(false);
    expect(mockRequest.headers['x-jwt-claim-sub']).toBe('user-123');
    // Metadatos complejos no se inyectan como cabeceras
    expect(mockRequest.headers['x-jwt-claim-metadata']).toBeUndefined();
    expect(mockRequest.headers['x-jwt-claim-roles']).toBeUndefined();
  });
});
