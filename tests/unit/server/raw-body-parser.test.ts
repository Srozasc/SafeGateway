import { describe, it, expect } from 'vitest';
import fastify from 'fastify';
import { registerRawBodyParsers } from '../../../src/server/raw-body-parser.js';

/**
 * Tests for the raw-body content-type parser helper.
 *
 * Initially RED — `registerRawBodyParsers` does not exist yet. After T6
 * implementation these must turn GREEN.
 *
 * Behavior contract:
 *   - For registered content-types (multipart/*, application/octet-stream,
 *     application/x-www-form-urlencoded, plus a wildcard fallback), accumulate
 *     the request body as a `Buffer` and pass it to `req.body`.
 *   - Respect the configured `bodyLimit`: reject with HTTP 413 if the body
 *     exceeds it.
 *   - Do NOT intercept `application/json`: Fastify's default JSON parser must
 *     still produce a parsed object (regression check).
 */
describe('registerRawBodyParsers', () => {
  describe('multipart/form-data', () => {
    it('accumulates the body into a Buffer without parsing structure', async () => {
      const app = fastify({ logger: false });
      registerRawBodyParsers(app, 10 * 1024 * 1024);
      let captured: unknown;
      app.post('/capture', async (req, reply) => {
        captured = req.body;
        await reply.send({ ok: true });
      });

      const boundary = '----TestBoundary123';
      const mpPayload = [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="hello.txt"\r\n`,
        `Content-Type: text/plain\r\n`,
        `\r\n`,
        `hello multipart world\r\n`,
        `--${boundary}--\r\n`,
      ].join('');

      const res = await app.inject({
        method: 'POST',
        url: '/capture',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: mpPayload,
      });

      expect(res.statusCode).toBe(200);
      expect(Buffer.isBuffer(captured)).toBe(true);
      // Boundary and metadata preserved as raw bytes (no structurparse)
      expect((captured as Buffer).toString('utf8')).toContain('hello multipart world');
      expect((captured as Buffer).toString('utf8')).toContain(`--${boundary}`);
    });
  });

  describe('application/octet-stream', () => {
    it('passes binary bytes through as Buffer (bytes-preserved, not identity)', async () => {
      const app = fastify({ logger: false });
      registerRawBodyParsers(app, 10 * 1024 * 1024);
      let captured: unknown;
      app.post('/capture', async (req, reply) => {
        captured = req.body;
        await reply.send({ ok: true });
      });

      // Fake JPEG header bytes — must reach handler unchanged, no JSON stringification.
      const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

      const res = await app.inject({
        method: 'POST',
        url: '/capture',
        headers: {
          'content-type': 'application/octet-stream',
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(Buffer.isBuffer(captured)).toBe(true);
      // Bytes-preserved comparison. Reference identity is NOT guaranteed
      // because Fastify's HTTP layer re-buffers the stream before the
      // parser callback runs (intrinsic to Node.js HTTP). The end-to-end
      // contract is byte-preservation, which the proxy engine handles
      // identity-preserving for the in-process leg (see engine.body.test.ts).
      expect(captured as Buffer).toStrictEqual(payload);
      expect((captured as Buffer).equals(payload)).toBe(true);
    });
  });

  describe('application/x-www-form-urlencoded', () => {
    it('accumulates form data as raw Buffer (no key/value parsing)', async () => {
      const app = fastify({ logger: false });
      registerRawBodyParsers(app, 10 * 1024 * 1024);
      let captured: unknown;
      app.post('/capture', async (req, reply) => {
        captured = req.body;
        await reply.send({ ok: true });
      });

      const payload = 'foo=bar&baz=qux&x=1';

      const res = await app.inject({
        method: 'POST',
        url: '/capture',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(Buffer.isBuffer(captured)).toBe(true);
      expect((captured as Buffer).toString('utf8')).toBe(payload);
    });
  });

  describe('bodyLimit enforcement', () => {
    it('returns 413 when the body exceeds the configured bodyLimit', async () => {
      const app = fastify({ logger: false });
      registerRawBodyParsers(app, 100); // 100 bytes
      app.post('/capture', async (_req, reply) => {
        await reply.send({ ok: true });
      });

      const payload = Buffer.alloc(200, 0xab);

      const res = await app.inject({
        method: 'POST',
        url: '/capture',
        headers: {
          'content-type': 'application/octet-stream',
        },
        payload,
      });

      expect(res.statusCode).toBe(413);
    });
  });

  describe('JSON regression (must NOT be intercepted)', () => {
    it('leaves application/json to Fastify default parser (parsed object)', async () => {
      const app = fastify({ logger: false });
      registerRawBodyParsers(app, 10 * 1024 * 1024);
      let captured: unknown;
      app.post('/capture', async (req, reply) => {
        captured = req.body;
        await reply.send({ ok: true });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/capture',
        headers: {
          'content-type': 'application/json',
        },
        payload: { foo: 'bar', n: 42 },
      });

      expect(res.statusCode).toBe(200);
      expect(captured).toEqual({ foo: 'bar', n: 42 });
      expect(Buffer.isBuffer(captured)).toBe(false);
    });
  });
});
