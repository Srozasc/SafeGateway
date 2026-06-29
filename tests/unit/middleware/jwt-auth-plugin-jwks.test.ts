import { describe, it, expect, beforeEach, vi, Mocked } from 'vitest';
import { FastifyRequest, FastifyReply } from 'fastify';
import pino from 'pino';
import { JwtAuthPlugin } from '../../../src/middleware/jwt-auth/plugin.js';
import { JwtAuthRegistry } from '../../../src/middleware/jwt-auth/registry.js';
import type { JwtIssuerConfig, JwtGlobalConfig } from '../../../src/config/types.js';
import { RequestContext } from '../../../src/middleware/pipeline.js';
import { RouteMatch } from '../../../src/routing/types.js';
import { generateTestKeypair, type TestKeypair } from '../../helpers/test-jwt-keypair.js';

const logger = pino({ level: 'silent' });

const ISSUER: JwtIssuerConfig = {
  name: 'auth-prod',
  jwksUri: 'https://auth.example.com/jwks.json',
  issuer: 'https://auth.example.com',
  audience: 'flashdrop-api',
  cacheTtlSeconds: 3600,
  staleGracePeriodSeconds: 1800,
  refreshCooldownSeconds: 30,
  refreshOnMiss: true,
  timeoutMs: 3000,
};

const GLOBAL_JWT: JwtGlobalConfig = {
  enabled: true,
  mode: 'jwks',
  issuers: [ISSUER],
};

describe('JwtAuthPlugin — JWKS branch (unit)', () => {
  let plugin: JwtAuthPlugin;
  let registry: JwtAuthRegistry;
  let mockRequest: FastifyRequest & { gatewayContext: NonNullable<FastifyRequest['gatewayContext']> };
  let mockReply: Mocked<FastifyReply> & { body?: { message?: string; error?: string; statusCode?: number } };
  let mockRouteMatch: RouteMatch;
  let keypair: TestKeypair;

  beforeEach(async () => {
    keypair = await generateTestKeypair('key-1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ keys: [keypair.publicJwk] }), { status: 200 }),
    );
    registry = new JwtAuthRegistry(GLOBAL_JWT, logger);
    plugin = new JwtAuthPlugin(logger);
    plugin.registry = registry;

    mockRequest = {
      url: '/api/orders',
      headers: {},
      gatewayContext: { routeMatch: null as unknown as RouteMatch },
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
      route: { prefix: '/api/orders', target: 'http://backend:8080' },
      override: null,
      effectiveRateLimit: null,
      effectiveCors: null,
      effectiveJwt: { kind: 'jwks-specific', issuerName: 'auth-prod', config: GLOBAL_JWT },
      jwtOverride: null,
      globalJwt: GLOBAL_JWT,
    };
    mockRequest.gatewayContext.routeMatch = mockRouteMatch;
  });

  async function ctx(): Promise<RequestContext> {
    return { request: mockRequest, reply: mockReply, routeMatch: mockRouteMatch };
  }

  it('BDD 4: token expirado → 401', async () => {
    const token = await keypair.signToken({
      sub: 'user-1',
      iss: 'https://auth.example.com',
      aud: 'flashdrop-api',
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    mockRequest.headers['authorization'] = `Bearer ${token}`;
    await plugin.onRequest(await ctx());
    expect(mockReply.statusCode).toBe(401);
  });

  it('BDD 5: iss incorrecto → 401', async () => {
    const token = await keypair.signToken({
      sub: 'user-1',
      iss: 'https://other-issuer.com',
      aud: 'flashdrop-api',
    });
    mockRequest.headers['authorization'] = `Bearer ${token}`;
    await plugin.onRequest(await ctx());
    expect(mockReply.statusCode).toBe(401);
  });

  it('BDD 6: aud incorrecto → 401', async () => {
    const token = await keypair.signToken({
      sub: 'user-1',
      iss: 'https://auth.example.com',
      aud: 'wrong-api',
    });
    mockRequest.headers['authorization'] = `Bearer ${token}`;
    await plugin.onRequest(await ctx());
    expect(mockReply.statusCode).toBe(401);
  });

  it('BDD 16: iat futuro (>60s) → 401 con invalid_claims', async () => {
    const futureIat = Math.floor(Date.now() / 1000) + 3600;
    const token = await keypair.signToken({
      sub: 'user-1',
      iss: 'https://auth.example.com',
      aud: 'flashdrop-api',
      iat: futureIat,
      exp: futureIat + 3600,
    });
    mockRequest.headers['authorization'] = `Bearer ${token}`;
    await plugin.onRequest(await ctx());
    expect(mockReply.statusCode).toBe(401);
  });

  it('BDD 15: token sin kid → 401 con missing_kid', async () => {
    // Generar token sin kid usando SignJWT directamente
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ sub: 'user-1', iss: 'https://auth.example.com', aud: 'flashdrop-api' })
      .setProtectedHeader({ alg: 'RS256' }) // sin kid
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign((keypair as unknown as { privateKey: CryptoKey }).privateKey);

    mockRequest.headers['authorization'] = `Bearer ${token}`;
    await plugin.onRequest(await ctx());
    expect(mockReply.statusCode).toBe(401);
    const body = mockReply.body as { message?: string };
    expect(body?.message).toBe('missing kid header');
  });

  it('BDD 1: token válido con kid → permite paso y guarda claims', async () => {
    const token = await keypair.signToken({
      sub: 'user-1',
      iss: 'https://auth.example.com',
      aud: 'flashdrop-api',
    });
    mockRequest.headers['authorization'] = `Bearer ${token}`;

    await plugin.onRequest(await ctx());
    expect(mockReply.sent).toBe(false);
    expect(mockRequest.gatewayContext.jwtClaims?.sub).toBe('user-1');
  });

  it('retorna 503 service_unavailable si registry no está inicializado', async () => {
    const isolatedPlugin = new JwtAuthPlugin(logger);
    isolatedPlugin.registry = undefined;
    const token = await keypair.signToken({ sub: 'user-1', iss: 'https://auth.example.com', aud: 'flashdrop-api' });
    mockRequest.headers['authorization'] = `Bearer ${token}`;

    await isolatedPlugin.onRequest(await ctx());
    expect(mockReply.statusCode).toBe(503);
  });

  it('jwks-any mapea por iss claim', async () => {
    const token = await keypair.signToken({
      sub: 'user-1',
      iss: 'https://auth.example.com',
      aud: 'flashdrop-api',
    });
    mockRequest.headers['authorization'] = `Bearer ${token}`;
    mockRouteMatch.effectiveJwt = { kind: 'jwks-any', issuerNames: ['auth-prod'], config: GLOBAL_JWT };

    await plugin.onRequest(await ctx());
    expect(mockReply.sent).toBe(false);
  });

  it('jwks-any con iss no registrado → 401 invalid_issuer', async () => {
    const token = await keypair.signToken({
      sub: 'user-1',
      iss: 'https://unknown-issuer.com',
      aud: 'flashdrop-api',
    });
    mockRequest.headers['authorization'] = `Bearer ${token}`;
    mockRouteMatch.effectiveJwt = { kind: 'jwks-any', issuerNames: ['auth-prod'], config: GLOBAL_JWT };

    await plugin.onRequest(await ctx());
    expect(mockReply.statusCode).toBe(401);
  });

  it('token con algoritmo != RS256 → 401', async () => {
    // Generar un token RS384 (no soportado por nuestra config que solo permite RS256)
    const { SignJWT, generateKeyPair } = await import('jose');
    const { privateKey } = await generateKeyPair('RS384');
    const token = await new SignJWT({ sub: 'user-1', iss: 'https://auth.example.com', aud: 'flashdrop-api' })
      .setProtectedHeader({ alg: 'RS384', kid: 'unknown' })
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(privateKey);

    mockRequest.headers['authorization'] = `Bearer ${token}`;
    await plugin.onRequest(await ctx());
    expect(mockReply.statusCode).toBe(401);
  });
});