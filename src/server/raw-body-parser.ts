import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Registers content-type parsers on a Fastify instance that keep the request
 * body as a raw `Buffer` and forward it to backends without parsing structure.
 * This unblocks binary uploads (multipart/form-data, application/octet-stream)
 * through the gateway so the proxy can forward bytes intact to downstream
 * services like catalog-service.
 *
 * Covered content-types (specific — no wildcard):
 *   - `multipart/form-data`, `multipart/mixed`
 *   - `application/octet-stream`
 *   - `application/x-www-form-urlencoded`
 *
 * NOT intercepted:
 *   - `application/json` — Fastify's default parser continues to produce a
 *     parsed object; existing JSON routes remain unaffected (regression check
 *     in `tests/unit/server/raw-body-parser.test.ts`).
 *
 * Why no `'*'` wildcard: a catch-all registration accepts every content-type,
 * which is convenient but enlarges attack surface (any media type can now
 * trigger a 50+ MiB buffer on the gateway). For the catalog-service use case
 * the four specific types above are sufficient; future binary uploads in
 * other formats should add a targeted entry here.
 *
 * `bodyLimitBytes` is enforced at the Fastify layer via the `bodyLimit` option
 * passed to each `addContentTypeParser` call (the parser uses
 * `parseAs: 'buffer'`). When the body would exceed the limit (based on
 * Content-Length or chunked transfer), Fastify responds with HTTP 413 before
 * the parser callback runs. The parser itself just hands the Buffer through
 * to the handler by reference (identity preserved).
 *
 * @param server Fastify instance to register the parsers on.
 * @param bodyLimitBytes Maximum body size in bytes (default 6 MiB at config level).
 */
export function registerRawBodyParsers(server: FastifyInstance, bodyLimitBytes: number): void {
  const identityBufferParser = (
    _req: FastifyRequest,
    payload: Buffer,
    done: (err: Error | null, body?: Buffer) => void,
  ): void => {
    // `parseAs: 'buffer'` delivers the body as a Buffer (after Fastify's
    // bodyLimit enforcement). Pass through by reference to preserve identity
    // — important for tests and for any downstream code that compares
    // buffer references to detect raw-passthrough vs accumulated copies.
    if (Buffer.isBuffer(payload)) {
      done(null, payload);
    } else {
      // Defensive: if Fastify hands us something other than a Buffer, fail
      // loudly with a parser error rather than silently dropping bytes.
      done(new Error(`Expected Buffer body, got ${typeof payload}`));
    }
  };

  const contentTypes = [
    'multipart/form-data',
    'multipart/mixed',
    'application/octet-stream',
    'application/x-www-form-urlencoded',
  ];

  for (const contentType of contentTypes) {
    server.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: bodyLimitBytes },
      identityBufferParser,
    );
  }
}
