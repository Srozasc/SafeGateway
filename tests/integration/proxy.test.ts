import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildServer } from '../../src/server.js';
import { MiddlewarePipeline } from '../../src/middleware/pipeline.js';
import { MockBackend } from '../helpers/mock-backend.js';
import { GatewayConfig } from '../../src/config/types.js';

describe('Proxy Integration Tests', () => {
  let backend: MockBackend;
  let backendPort: number;
  let server: FastifyInstance;
  const logger = pino({ level: 'silent' }); // Silenciar logs en tests

  beforeAll(async () => {
    // 1. Iniciar backend simulado
    backend = new MockBackend();
    backendPort = await backend.start();
  });

  afterAll(async () => {
    // Apagar servidores al finalizar
    await backend.stop();
  });

  beforeEach(async () => {
    backend.clear();
  });

  it('debería reenviar peticiones GET al backend y retornar el payload intacto', async () => {
    // Configuración dinámica usando el puerto del backend simulado
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
          stripPrefix: false,
        },
      ],
    };

    const pipeline = new MiddlewarePipeline(); // Sin plugins para probar proxying puro
    server = buildServer(config, pipeline, logger);

    const response = await server.inject({
      method: 'GET',
      url: '/api/users?id=12',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('mock-backend');

    // Verificar en el backend que el request llegó
    expect(backend.lastRequestMethod).toBe('GET');
    expect(backend.lastRequestUrl).toBe('/api/users?id=12');
  });

  it('debería inyectar cabeceras de forwarding estándar al backend', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
        },
      ],
    };

    server = buildServer(config, new MiddlewarePipeline(), logger);

    await server.inject({
      method: 'GET',
      url: '/api/headers',
      headers: {
        'x-forwarded-for': '203.0.113.50',
        host: 'my-custom-gateway.com',
      },
    });

    const receivedHeaders = backend.lastRequestHeaders;
    expect(receivedHeaders).toBeDefined();
    
    // X-Forwarded-For acumulativo
    expect(receivedHeaders?.['x-forwarded-for']).toContain('203.0.113.50, 127.0.0.1');
    expect(receivedHeaders?.['x-forwarded-host']).toBe('my-custom-gateway.com');
    expect(receivedHeaders?.['x-real-ip']).toBe('127.0.0.1');
    expect(receivedHeaders?.['x-forwarded-proto']).toBe('http');
  });

  it('debería retornar HTTP 404 estructurado cuando el path no coincide con ninguna ruta', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
        },
      ],
    };

    server = buildServer(config, new MiddlewarePipeline(), logger);

    const response = await server.inject({
      method: 'GET',
      url: '/unconfigured-path',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      message: expect.stringContaining('No se encontró ninguna ruta'),
      timestamp: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it('debería reenviar peticiones POST con su payload intacto al backend', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      routes: [
        {
          prefix: '/api',
          target: `http://127.0.0.1:${backendPort}`,
        },
      ],
    };

    server = buildServer(config, new MiddlewarePipeline(), logger);

    const payload = { username: 'test-user', email: 'test@example.com' };
    const response = await server.inject({
      method: 'POST',
      url: '/api/echo',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.method).toBe('POST');
    expect(JSON.parse(body.body)).toEqual(payload);
  });

  it('debería retornar HTTP 504 o 502 (Bad Gateway) cuando se excede el timeout configurado para la respuesta', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      routes: [
        {
          prefix: '/api-timeout',
          target: `http://127.0.0.1:${backendPort}`,
          timeout: {
            response: 100, // Timeout de respuesta muy agresivo (100ms)
          },
        },
      ],
    };

    server = buildServer(config, new MiddlewarePipeline(), logger);

    // /api-timeout/timeout demorará 1000ms en el mock backend
    const response = await server.inject({
      method: 'GET',
      url: '/api-timeout/timeout',
    });

    // Fastify HTTP Proxy retorna HTTP 504 Gateway Timeout cuando ocurre un timeout
    expect(response.statusCode).toBe(504);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Gateway Timeout');
  });

  it('debería remover el prefijo de la URL al enviarla al backend si stripPrefix está habilitado', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      routes: [
        {
          prefix: '/microservice-a',
          target: `http://127.0.0.1:${backendPort}`,
          stripPrefix: true, // Habilitar remoción de prefijo
        },
      ],
    };

    server = buildServer(config, new MiddlewarePipeline(), logger);

    await server.inject({
      method: 'GET',
      url: '/microservice-a/echo',
    });

    expect(backend.lastRequestMethod).toBe('GET');
    
    // Como stripPrefix es true, /microservice-a/echo debe transformarse en /echo
    expect(backend.lastRequestUrl).toBe('/echo');
  });
});
