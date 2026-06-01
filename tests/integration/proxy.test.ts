import assert from 'node:assert';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';

// Mock backend for testing
class MockBackend {
  public lastRequestHeaders: http.IncomingHttpHeaders | null = null;
  public lastRequestBody: string | null = null;
  public lastRequestMethod: string | null = null;
  public lastRequestUrl: string | null = null;

  private server: http.Server;

  constructor() {
    this.server = http.createServer((req, res) => {
      this.lastRequestHeaders = req.headers;
      this.lastRequestMethod = req.method || null;
      this.lastRequestUrl = req.url || null;

      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        this.lastRequestBody = body;

        if (req.url?.includes('/timeout')) {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'delayed success' }));
          }, 1000);
        } else if (req.url?.includes('/echo')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: body,
            })
          );
        } else if (req.url?.includes('/error')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error backend' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: 'mock-backend' }));
        }
      });
    });
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  clear(): void {
    this.lastRequestHeaders = null;
    this.lastRequestBody = null;
    this.lastRequestMethod = null;
    this.lastRequestUrl = null;
  }
}

// Dynamic import for ES modules
async function importModules() {
  const { buildServer } = await import('../../src/server.js');
  const { MiddlewarePipeline } = await import('../../src/middleware/pipeline.js');
  const { GatewayConfig } = await import('../../src/config/types.js');
  const pino = (await import('pino')).default;

  return { buildServer, MiddlewarePipeline, GatewayConfig, pino };
}

describe('Proxy Integration Tests', () => {
  let backend: MockBackend;
  let backendPort: number;
  let buildServer: any;
  let MiddlewarePipeline: any;
  let GatewayConfig: any;
  let pino: any;

  beforeAll(async () => {
    backend = new MockBackend();
    backendPort = await backend.start();
    console.log('[beforeAll] Backend started on port:', backendPort);

    const modules = await importModules();
    buildServer = modules.buildServer;
    MiddlewarePipeline = modules.MiddlewarePipeline;
    GatewayConfig = modules.GatewayConfig;
    pino = modules.pino;
    console.log('[beforeAll] Modules imported');
  }, 30000);

  afterAll(async () => {
    await backend.stop();
  });

  beforeEach(() => {
    backend.clear();
  });

  it('should forward GET requests to backend and return payload intact', async () => {
    console.log('[TEST] Starting GET test, backendPort:', backendPort);
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
    console.log('[TEST] Config routes:', config.routes.map(r => ({ prefix: r.prefix, target: r.target })));

    const logger = pino({ level: 'silent' });
    const pipeline = new MiddlewarePipeline();
    const server = buildServer(config, pipeline, logger);
    console.log('[TEST] Server built, routes:', server.routeRegistry.getRoutes().map(r => r.prefix));

    const response = await server.inject({
      method: 'GET',
      url: '/api/users?id=12',
    });
    console.log('[TEST] Response status:', response.statusCode, 'body:', response.body);

    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'mock-backend');

    assert.strictEqual(backend.lastRequestMethod, 'GET');
    assert.strictEqual(backend.lastRequestUrl, '/api/users?id=12');

    await server.close();
  });

  it('should inject standard forwarding headers to backend', async () => {
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

    const logger = pino({ level: 'silent' });
    const server = buildServer(config, new MiddlewarePipeline(), logger);

    await server.inject({
      method: 'GET',
      url: '/api/headers',
      headers: {
        'x-forwarded-for': '203.0.113.50',
        host: 'my-custom-gateway.com',
      },
    });

    const receivedHeaders = backend.lastRequestHeaders;
    assert.ok(receivedHeaders);

    assert.ok(receivedHeaders['x-forwarded-for']?.includes('203.0.113.50'));
    assert.ok(receivedHeaders['x-forwarded-host']?.includes('my-custom-gateway.com'));

    await server.close();
  });

  it('should return structured HTTP 404 when path does not match any route', async () => {
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

    const logger = pino({ level: 'silent' });
    const server = buildServer(config, new MiddlewarePipeline(), logger);

    const response = await server.inject({
      method: 'GET',
      url: '/unconfigured-path',
    });

    assert.strictEqual(response.statusCode, 404);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.statusCode, 404);

    await server.close();
  });

  it('should forward POST requests with payload intact to backend', async () => {
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

    const logger = pino({ level: 'silent' });
    const server = buildServer(config, new MiddlewarePipeline(), logger);

    const payload = { username: 'test-user', email: 'test@example.com' };
    const response = await server.inject({
      method: 'POST',
      url: '/api/echo',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });

    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.method, 'POST');
    assert.deepStrictEqual(JSON.parse(body.body), payload);

    await server.close();
  });

  it('should remove URL prefix when stripPrefix is enabled', async () => {
    const config: GatewayConfig = {
      server: { port: 3000, host: '0.0.0.0' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      routes: [
        {
          prefix: '/microservice-a',
          target: `http://127.0.0.1:${backendPort}`,
          stripPrefix: true,
        },
      ],
    };

    const logger = pino({ level: 'silent' });
    const server = buildServer(config, new MiddlewarePipeline(), logger);

    await server.inject({
      method: 'GET',
      url: '/microservice-a/echo',
    });

    assert.strictEqual(backend.lastRequestMethod, 'GET');
    assert.strictEqual(backend.lastRequestUrl, '/echo');

    await server.close();
  });
});
