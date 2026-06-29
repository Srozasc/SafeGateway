import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pino from 'pino';
import { SignJWT } from 'jose';
import { buildServer } from '../../src/server.js';
import { MiddlewarePipeline } from '../../src/middleware/pipeline.js';
import { MockBackend } from '../helpers/mock-backend.js';
import { JwtAuthPlugin } from '../../src/middleware/jwt-auth/plugin.js';
import type { GatewayConfig } from '../../src/config/types.js';

describe('JWT Authentication Integration Tests', () => {
  let backend: MockBackend;
  let backendPort: number;
  let server: FastifyInstance;
  const logger = pino({ level: 'silent' });

  const SECRET_KEY = 'integration-test-secret-key-32-chars!!!';

  beforeAll(async () => {
    // 1. Iniciar backend simulado
    backend = new MockBackend();
    backendPort = await backend.start();
  });

  afterAll(async () => {
    // 2. Apagar servidores al finalizar
    await backend.stop();
  });

  beforeEach(async () => {
    backend.clear();
  });

  // Auxiliar para firmar tokens JWT
  async function generateToken(payload: Record<string, unknown>, secret: string = SECRET_KEY): Promise<string> {
    const encodedSecret = new TextEncoder().encode(secret);
    return await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(encodedSecret);
  }

  it('debería rechazar con HTTP 401 si se consulta una ruta protegida sin token', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/protected',
          target: `http://127.0.0.1:${backendPort}`,
          stripPrefix: true,
          jwt: {
            enabled: true,
            secret: SECRET_KEY,
            algorithm: 'HS256',
            forwardClaims: ['sub', 'role'],
          },
        },
      ],
    };

    const jwtPlugin = new JwtAuthPlugin(logger);
    const pipeline = new MiddlewarePipeline([jwtPlugin]);
    server = buildServer(config, pipeline, logger);

    const response = await server.inject({
      method: 'GET',
      url: '/protected/users',
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      error: 'Unauthorized',
      message: 'token de autenticación requerido',
      statusCode: 401,
    });

    // Validar que el request no llegó al backend
    expect(backend.lastRequestUrl).toBeNull();
  });

  it('debería permitir el acceso, inyectar claims e ignorar claims inválidos si el token es correcto', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/protected',
          target: `http://127.0.0.1:${backendPort}`,
          stripPrefix: true,
          jwt: {
            enabled: true,
            secret: SECRET_KEY,
            algorithm: 'HS256',
            forwardClaims: ['sub', 'role', 'non-existent-claim'],
          },
        },
      ],
    };

    const jwtPlugin = new JwtAuthPlugin(logger);
    const pipeline = new MiddlewarePipeline([jwtPlugin]);
    server = buildServer(config, pipeline, logger);

    const token = await generateToken({ sub: 'alice', role: 'developer' });

    const response = await server.inject({
      method: 'GET',
      url: '/protected/users',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');

    // Verificar en el backend que llegó el request y las cabeceras inyectadas
    expect(backend.lastRequestUrl).toBe('/users');
    const receivedHeaders = backend.lastRequestHeaders;
    expect(receivedHeaders).toBeDefined();
    expect(receivedHeaders?.['x-jwt-claim-sub']).toBe('alice');
    expect(receivedHeaders?.['x-jwt-claim-role']).toBe('developer');
    // Claim no existente no debe estar inyectada
    expect(receivedHeaders?.['x-jwt-claim-non-existent-claim']).toBeUndefined();
  });

  it('debería remover headers de suplantación (spoofing) enviados por el cliente y preservar solo los válidos del token', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/protected',
          target: `http://127.0.0.1:${backendPort}`,
          stripPrefix: true,
          jwt: {
            enabled: true,
            secret: SECRET_KEY,
            algorithm: 'HS256',
            forwardClaims: ['sub', 'role'],
          },
        },
      ],
    };

    const jwtPlugin = new JwtAuthPlugin(logger);
    const pipeline = new MiddlewarePipeline([jwtPlugin]);
    server = buildServer(config, pipeline, logger);

    const token = await generateToken({ sub: 'bob', role: 'user' });

    const response = await server.inject({
      method: 'GET',
      url: '/protected/users',
      headers: {
        authorization: `Bearer ${token}`,
        'x-jwt-claim-sub': 'spoofed-admin',
        'X-JWT-Claim-Role': 'superadmin',
        'x-jwt-claim-custom': 'hacker',
      },
    });

    expect(response.statusCode).toBe(200);

    // El backend debe recibir exclusivamente los datos legítimos del token, los spoofed se eliminan
    const receivedHeaders = backend.lastRequestHeaders;
    expect(receivedHeaders).toBeDefined();
    expect(receivedHeaders?.['x-jwt-claim-sub']).toBe('bob');
    expect(receivedHeaders?.['x-jwt-claim-role']).toBe('user');
    expect(receivedHeaders?.['x-jwt-claim-custom']).toBeUndefined();
  });

  it('debería permitir paso directo sin autenticación a rutas que no tienen bloque jwt', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
      routes: [
        {
          prefix: '/public',
          target: `http://127.0.0.1:${backendPort}`,
          stripPrefix: true,
        },
      ],
    };

    const jwtPlugin = new JwtAuthPlugin(logger);
    const pipeline = new MiddlewarePipeline([jwtPlugin]);
    server = buildServer(config, pipeline, logger);

    const response = await server.inject({
      method: 'GET',
      url: '/public/users',
    });

    expect(response.statusCode).toBe(200);
    expect(backend.lastRequestUrl).toBe('/users');
    expect(backend.lastRequestHeaders?.['x-jwt-claim-sub']).toBeUndefined();
  });
});
