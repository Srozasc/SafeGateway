import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import http from 'node:http';
import { buildServer } from '../../src/server.js';
import { MiddlewarePipeline } from '../../src/middleware/pipeline.js';
import pino from 'pino';
import type { GatewayConfig } from '../../src/config/types.js';

/**
 * Integration tests for binary-upload passthrough.
 *
 * Cover the full path: client POST → Fastify body parser → proxy engine → Undici
 * pool → mock backend. Verifies:
 *
 *   - multipart/form-data bodies reach the backend with bytes intact (no JSON
 *     stringification).
 *   - application/octet-stream bodies reach the backend with bytes intact.
 *   - bodies larger than `server.bodyLimit` are rejected by Fastify with 413
 *     before reaching the proxy.
 *   - JSON bodies continue to be parsed by Fastify and forwarded as JSON strings
 *     (regression: the application's JSON parser is not intercepted).
 */

/** Captures bytes received by the mock backend so tests can assert byte equality. */
class MockBackend {
  public lastBody: Buffer = Buffer.alloc(0);
  public lastHeaders: http.IncomingHttpHeaders = {};
  public lastMethod: string = '';
  public lastUrl: string = '';

  private server: http.Server;

  constructor() {
    this.server = http.createServer((req, res) => {
      this.lastHeaders = req.headers;
      this.lastMethod = req.method || '';
      this.lastUrl = req.url || '';
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        this.lastBody = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            receivedBytes: this.lastBody.length,
            contentType: this.lastHeaders['content-type'] ?? '',
            contentLength: this.lastHeaders['content-length'] ?? '',
          }),
        );
      });
    });
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as { port: number };
        resolve(address.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  clear(): void {
    this.lastBody = Buffer.alloc(0);
    this.lastHeaders = {};
    this.lastMethod = '';
    this.lastUrl = '';
  }
}

describe('Binary upload integration (binary passthrough via gateway)', () => {
  let backend: MockBackend;
  let backendPort: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeAll(async () => {
    backend = new MockBackend();
    backendPort = await backend.start();

    const config: GatewayConfig = {
      server: { port: 3000, host: '127.0.0.1', bodyLimit: 6 * 1024 * 1024 },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'silent' },
      metrics: { enabled: false, path: '/metrics' },
      routes: [
        {
          prefix: '/catalog',
          target: `http://127.0.0.1:${backendPort}`,
          stripPrefix: true,
        },
      ],
    };
    const logger = pino({ level: 'silent' });
    const pipeline = new MiddlewarePipeline();
    server = buildServer(config, pipeline, logger);
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
    await backend.stop();
  });

  beforeEach(() => {
    backend.clear();
  });

  it('forwards multipart/form-data with binary file content intact', async () => {
    const boundary = '----TestBoundary987';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="test.bin"\r\n`),
      Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`),
      // Random binary bytes simulating a real uploaded asset.
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await server.inject({
      method: 'POST',
      url: '/catalog/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body) as {
      receivedBytes: number;
      contentType: string;
    };
    expect(json.receivedBytes).toBe(payload.length);
    expect(json.contentType).toBe(`multipart/form-data; boundary=${boundary}`);
    // CRITICAL: backend must receive exactly the bytes the client sent. If the
    // engine JSON.stringify'd the body, we'd get `{"type":"Buffer","data":[...]}`
    // here and this assertion would fail.
    expect(backend.lastBody.equals(payload)).toBe(true);
  });

  it('forwards application/octet-stream bytes intact', async () => {
    const payload = Buffer.from([
      0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x81, 0x82, 0x83,
    ]);

    const response = await server.inject({
      method: 'POST',
      url: '/catalog/raw',
      headers: {
        'content-type': 'application/octet-stream',
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(backend.lastBody.equals(payload)).toBe(true);
    expect(backend.lastHeaders['content-type']).toBe('application/octet-stream');
  });

  it('rejects payloads exceeding server.bodyLimit with HTTP 413', async () => {
    // bodyLimit was set to 6 MiB in beforeAll, so a 7 MiB body should be rejected.
    const oversized = Buffer.alloc(7 * 1024 * 1024, 0xab);

    const response = await server.inject({
      method: 'POST',
      url: '/catalog/too-big',
      headers: {
        'content-type': 'application/octet-stream',
      },
      payload: oversized,
    });

    expect(response.statusCode).toBe(413);
    // Backend must NOT have been called for an over-limit payload.
    expect(backend.lastBody.length).toBe(0);
  });

  it('regression: application/json still parsed and forwarded as JSON string', async () => {
    const jsonBody = { foo: 'bar', n: 42 };
    const jsonString = JSON.stringify(jsonBody);

    const response = await server.inject({
      method: 'POST',
      url: '/catalog/echo',
      headers: {
        'content-type': 'application/json',
      },
      payload: jsonString,
    });

    expect(response.statusCode).toBe(200);
    expect(backend.lastBody.toString('utf8')).toBe(jsonString);
    expect(backend.lastHeaders['content-type']).toBe('application/json');
  });
});
