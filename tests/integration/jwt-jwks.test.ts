import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { buildServer } from '../../src/server.js';
import { MiddlewarePipeline } from '../../src/middleware/pipeline.js';
import { JwtAuthPlugin } from '../../src/middleware/jwt-auth/plugin.js';
import { JwtAuthRegistry } from '../../src/middleware/jwt-auth/registry.js';
import { MockBackend } from '../helpers/mock-backend.js';
import { MockJwksServer } from '../helpers/mock-jwks-server.js';
import { generateTestKeypair, type TestKeypair } from '../helpers/test-jwt-keypair.js';
import type { GatewayConfig, ConfigSnapshot } from '../../src/config/types.js';

const logger = pino({ level: 'silent' });

describe('JWT JWKS Integration Tests', () => {
  let backend: MockBackend;
  let jwksServer: MockJwksServer;
  let keypair: TestKeypair;
  let snapshotRef: { current: ConfigSnapshot };
  let backendPort: number;

  beforeAll(async () => {
    backend = new MockBackend();
    backendPort = await backend.start();
    jwksServer = new MockJwksServer();
    await jwksServer.start();

    keypair = await generateTestKeypair('key-1');
    jwksServer.setKeys([keypair.publicJwk]);
  });

  afterAll(async () => {
    await backend.stop();
    await jwksServer.stop();
  });

  function makeConfig(extra: Partial<GatewayConfig> = {}): GatewayConfig {
    return {
      server: { port: 0, host: '127.0.0.1' },
      redis: { url: 'redis://localhost:6379', onFailure: 'open' },
      logging: { level: 'silent' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
          stripPrefix: false,
        },
      ],
      jwt: {
        enabled: true,
        mode: 'jwks',
        issuers: [
          {
            name: 'auth-prod',
            jwksUri: jwksServer.getJwksUri(),
            issuer: 'https://auth.test.com',
            audience: 'flashdrop-api',
            cacheTtlSeconds: 3600,
            staleGracePeriodSeconds: 1800,
            refreshCooldownSeconds: 0, // sin cooldown para tests
            refreshOnMiss: true,
            timeoutMs: 1000,
          },
        ],
      },
      ...extra,
    };
  }

  function buildWithRoute(config: GatewayConfig, routeJwt: unknown) {
    const routeConfig = {
      ...config.routes[0]!,
      jwt: routeJwt,
    };
    const finalConfig = { ...config, routes: [routeConfig] };
    const registry = new RouteRegistry(finalConfig);
    const jwtRegistry = new JwtAuthRegistry(finalConfig.jwt, logger);
    jwtRegistry.startAll();
    snapshotRef = { current: { config: finalConfig, registry, jwtRegistry, createdAt: new Date().toISOString() } };
    const jwtPlugin = new JwtAuthPlugin(logger);
    jwtPlugin.registry = jwtRegistry;
    const pipeline = new MiddlewarePipeline([jwtPlugin]);
    return buildServer(finalConfig, pipeline, logger, snapshotRef);
  }

  describe('BDD 1: Token válido con kid en cache', () => {
    it('permite el paso si el token está firmado con la clave cacheada', async () => {
      const config = makeConfig();
      const server = buildWithRoute(config, { mode: 'jwks' as const, issuer: 'auth-prod', enabled: true, forwardClaims: ['sub'] });
      const token = await keypair.signToken({
        sub: 'user-1',
        iss: 'https://auth.test.com',
        aud: 'flashdrop-api',
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      await server.close();
    });
  });

  describe('BDD 3: kid desconocido después de refresh', () => {
    it('rechaza 401 si kid no aparece en JWKS', async () => {
      const config = makeConfig();
      const server = buildWithRoute(config, { mode: 'jwks' as const, issuer: 'auth-prod', enabled: true, forwardClaims: [] });

      // Firmar con un kid que NO está publicado en JWKS
      const unknownKeypair = await generateTestKeypair('unknown-kid');
      const token = await unknownKeypair.signToken({
        sub: 'user-1',
        iss: 'https://auth.test.com',
        aud: 'flashdrop-api',
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('unknown signing key');
      await server.close();
    });
  });

  describe('BDD 4: Token expirado', () => {
    it('rechaza 401 con mensaje "token de autenticación inválido o expirado"', async () => {
      const config = makeConfig();
      const server = buildWithRoute(config, { mode: 'jwks' as const, issuer: 'auth-prod', enabled: true, forwardClaims: [] });

      const token = await keypair.signToken({
        sub: 'user-1',
        iss: 'https://auth.test.com',
        aud: 'flashdrop-api',
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600, // expirado hace 1h
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(401);
      await server.close();
    });
  });

  describe('BDD 5: Issuer incorrecto', () => {
    it('rechaza 401 cuando iss no coincide', async () => {
      const config = makeConfig();
      const server = buildWithRoute(config, { mode: 'jwks' as const, issuer: 'auth-prod', enabled: true, forwardClaims: [] });

      const token = await keypair.signToken({
        sub: 'user-1',
        iss: 'https://other-issuer.com', // iss distinto al configurado
        aud: 'flashdrop-api',
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(401);
      await server.close();
    });
  });

  describe('BDD 6: Audience incorrecto', () => {
    it('rechaza 401 cuando aud no coincide', async () => {
      const config = makeConfig();
      const server = buildWithRoute(config, { mode: 'jwks' as const, issuer: 'auth-prod', enabled: true, forwardClaims: [] });

      const token = await keypair.signToken({
        sub: 'user-1',
        iss: 'https://auth.test.com',
        aud: 'wrong-api',
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(401);
      await server.close();
    });
  });

  describe('BDD 9: Ruta con jwt deshabilitado', () => {
    it('permite acceso sin token', async () => {
      const config = makeConfig();
      const server = buildWithRoute(config, { enabled: false });

      const response = await server.inject({
        method: 'GET',
        url: '/api',
      });

      expect(response.statusCode).toBe(200);
      await server.close();
    });
  });

  describe('BDD 15: Token sin kid', () => {
    it('rechaza 401 si token RS256 no tiene kid header', async () => {
      const config = makeConfig();
      const server = buildWithRoute(config, { mode: 'jwks' as const, issuer: 'auth-prod', enabled: true, forwardClaims: [] });

      // Generar token sin kid (signJWT.setProtectedHeader sin kid)
      const { SignJWT } = await import('jose');
      const token = await new SignJWT({ sub: 'user-1', iss: 'https://auth.test.com', aud: 'flashdrop-api' })
        .setProtectedHeader({ alg: 'RS256' }) // sin kid
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign((keypair as unknown as { privateKey: CryptoKey }).privateKey);

      const response = await server.inject({
        method: 'GET',
        url: '/api',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('missing kid header');
      await server.close();
    });
  });
});

// Re-import RouteRegistry aquí para no contaminar el describe de arriba
import { RouteRegistry } from '../../src/routing/registry.js';