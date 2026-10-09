import { describe, it, expect } from 'vitest';
import { buildRequestBody } from '../../../src/proxy/engine.js';

/**
 * Tests for the body-dispatch helper used by ProxyEngine.forward().
 *
 * The function MUST:
 *   - pass `Buffer` through to Undici as Buffer (no JSON.stringify wrapping)
 *   - pass `string` through as-is
 *   - pass `AsyncIterable<unknown>` (streams) through as-is
 *   - JSON.stringify plain objects (parsed JSON bodies) for backward compat
 *   - return `undefined` for GET/HEAD methods regardless of body
 *   - return `undefined` for null/undefined input
 *
 * Initially RED — buildRequestBody is not exported yet. After T4 implementation
 * these must turn GREEN.
 */
describe('buildRequestBody (engine body dispatch)', () => {
  describe('scalar inputs', () => {
    it('returns null (no body) when body is undefined', () => {
      expect(buildRequestBody(undefined, 'POST')).toBeNull();
    });

    it('returns null (no body) when body is null', () => {
      expect(buildRequestBody(null, 'POST')).toBeNull();
    });

    it('returns string as-is (no transformation)', () => {
      const s = 'hello world';
      expect(buildRequestBody(s, 'POST')).toBe(s);
    });
  });

  describe('binary inputs', () => {
    it('returns Buffer as-is (no JSON.stringify wrapping)', () => {
      const buf = Buffer.from([1, 2, 3, 4, 5]);
      const result = buildRequestBody(buf, 'POST');
      expect(result).toBe(buf);
      // Negative assertion: must NOT be the JSON-wrapped form
      expect(result).not.toBe(JSON.stringify(buf));
    });

    it('preserves empty Buffer identity', () => {
      const buf = Buffer.alloc(0);
      expect(buildRequestBody(buf, 'POST')).toBe(buf);
    });

    it('handles large Buffer (passes through reference)', () => {
      const buf = Buffer.alloc(1024 * 1024, 0xab); // 1 MiB
      expect(buildRequestBody(buf, 'POST')).toBe(buf);
    });
  });

  describe('stream inputs', () => {
    it('returns AsyncIterable as-is', async () => {
      async function* gen() {
        yield Buffer.from('chunk-1');
        yield Buffer.from('chunk-2');
      }
      const stream = gen();
      const result = buildRequestBody(stream, 'POST');
      expect(result).toBe(stream);
    });
  });

  describe('object inputs (legacy JSON path)', () => {
    it('JSON.stringifies a plain object', () => {
      const obj = { foo: 'bar', n: 42 };
      expect(buildRequestBody(obj, 'POST')).toBe(JSON.stringify(obj));
    });

    it('JSON.stringifies an array', () => {
      const arr = [1, 2, 3];
      expect(buildRequestBody(arr, 'POST')).toBe(JSON.stringify(arr));
    });

    it('JSON.stringifies nested object', () => {
      const obj = { a: { b: { c: [1, 2] } } };
      expect(buildRequestBody(obj, 'POST')).toBe(JSON.stringify(obj));
    });
  });

  describe('method-based filtering', () => {
    it('returns null (no body) for GET even when body is a Buffer', () => {
      const buf = Buffer.from('x');
      expect(buildRequestBody(buf, 'GET')).toBeNull();
    });

    it('returns null (no body) for HEAD even when body is a string', () => {
      expect(buildRequestBody('x', 'HEAD')).toBeNull();
    });

    it('returns Buffer for POST (not undefined)', () => {
      const buf = Buffer.from('data');
      expect(buildRequestBody(buf, 'POST')).toBe(buf);
    });

    it('returns Buffer for PUT', () => {
      const buf = Buffer.from('data');
      expect(buildRequestBody(buf, 'PUT')).toBe(buf);
    });

    it('returns Buffer for DELETE', () => {
      const buf = Buffer.from('data');
      expect(buildRequestBody(buf, 'DELETE')).toBe(buf);
    });

    it('returns Buffer for PATCH', () => {
      const buf = Buffer.from('data');
      expect(buildRequestBody(buf, 'PATCH')).toBe(buf);
    });
  });
});
