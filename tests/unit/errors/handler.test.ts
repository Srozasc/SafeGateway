import { describe, it, expect, vi, beforeEach, afterEach, Mocked } from 'vitest';
import { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import {
  GatewayError,
  RouteNotFoundError,
  RateLimitError,
  BackendError,
} from '../../../src/errors/types.js';
import { buildErrorResponse } from '../../../src/errors/responses.js';
import { registerErrorHandler } from '../../../src/errors/handler.js';

describe('Global Error Module', () => {
  describe('Custom Error Classes', () => {
    it('deberían inicializar sus propiedades correctamente', () => {
      const gErr = new GatewayError('Mensaje genérico', 501);
      expect(gErr.message).toBe('Mensaje genérico');
      expect(gErr.statusCode).toBe(501);
      expect(gErr.name).toBe('GatewayError');
      expect(gErr.stack).toBeDefined();

      const rErr = new RouteNotFoundError('/missing');
      expect(rErr.statusCode).toBe(404);
      expect(rErr.message).toContain('/missing');

      const rlErr = new RateLimitError();
      expect(rlErr.statusCode).toBe(429);
      expect(rlErr.message).toContain('Límite');

      const bErr = new BackendError('Timeout', 'host downstream down');
      expect(bErr.statusCode).toBe(502);
      expect(bErr.message).toContain('Timeout');
      expect(bErr.message).toContain('host downstream down');
    });
  });

  describe('buildErrorResponse', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('debería formatear un error estándar', () => {
      const error = new GatewayError('Error de prueba', 403);
      const response = buildErrorResponse(error, 'req-123', '2026-05-20T20:30:00Z');

      expect(response).toEqual({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Error de prueba',
        requestId: 'req-123',
        timestamp: '2026-05-20T20:30:00Z',
        stack: expect.any(String),
      });
    });

    it('debería omitir stack trace si process.env.NODE_ENV es "production"', () => {
      process.env.NODE_ENV = 'production';
      const error = new Error('Crítico');
      const response = buildErrorResponse(error, 'req-456', '2026-05-20T20:30:00Z');

      expect(response.stack).toBeUndefined();
      expect(response.statusCode).toBe(500); // Por defecto si no tiene statusCode
      expect(response.error).toBe('Internal Server Error');
    });
  });

  describe('registerErrorHandler', () => {
    let mockFastify: Mocked<FastifyInstance>;
    let mockRequest: Mocked<FastifyRequest>;
    let mockReply: Mocked<FastifyReply>;
    let storedErrorHandler: ((error: FastifyError & { status?: number }, request: FastifyRequest, reply: FastifyReply) => void | Promise<void>) | undefined;
    let storedNotFoundHandler: ((request: FastifyRequest, reply: FastifyReply) => void | Promise<void>) | undefined;

    beforeEach(() => {
      mockFastify = {
        setErrorHandler: vi.fn().mockImplementation((fn) => {
          storedErrorHandler = fn as unknown as typeof storedErrorHandler;
          return mockFastify;
        }),
        setNotFoundHandler: vi.fn().mockImplementation((fn) => {
          storedNotFoundHandler = fn as unknown as typeof storedNotFoundHandler;
          return mockFastify;
        }),
      } as unknown as Mocked<FastifyInstance>;

      mockRequest = {
        id: 'test-req-id',
        url: '/api/v1/test',
        method: 'POST',
        log: {
          error: vi.fn(),
          warn: vi.fn(),
          info: vi.fn(),
          debug: vi.fn(),
        },
      } as unknown as Mocked<FastifyRequest>;

      mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as unknown as Mocked<FastifyReply>;

      registerErrorHandler(mockFastify);
    });

    it('debería registrar el manejador de errores y el de rutas no encontradas', () => {
      expect(mockFastify.setErrorHandler).toHaveBeenCalled();
      expect(mockFastify.setNotFoundHandler).toHaveBeenCalled();
      expect(storedErrorHandler).toBeDefined();
      expect(storedNotFoundHandler).toBeDefined();
    });

    describe('setErrorHandler Callback', () => {
      it('debería capturar errores 5xx, responder con status y loguear en nivel error', async () => {
        const error = new Error('Base de datos inaccesible');

        await storedErrorHandler!(error as FastifyError, mockRequest, mockReply);

        expect(mockReply.status).toHaveBeenCalledWith(500);
        expect(mockReply.send).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 500,
            error: 'Internal Server Error',
            message: 'Base de datos inaccesible',
            requestId: 'test-req-id',
          }),
        );
        expect(mockRequest.log.error).toHaveBeenCalledWith(
          expect.objectContaining({ err: error, requestId: 'test-req-id' }),
          expect.stringContaining('Error del servidor de nivel 5xx'),
        );
        expect(mockRequest.log.warn).not.toHaveBeenCalled();
      });

      it('debería capturar errores 4xx, responder con status y loguear en nivel warn', async () => {
        const error = new GatewayError('Entrada no válida', 400);

        await storedErrorHandler!(error as unknown as FastifyError, mockRequest, mockReply);

        expect(mockReply.status).toHaveBeenCalledWith(400);
        expect(mockReply.send).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
            error: 'Bad Request',
            message: 'Entrada no válida',
          }),
        );
        expect(mockRequest.log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: error, statusCode: 400 }),
          expect.stringContaining('Error de nivel 4xx'),
        );
        expect(mockRequest.log.error).not.toHaveBeenCalled();
      });

      it('debería formatear errores de validación de Fastify como HTTP 400', async () => {
        const validationError = new Error('Formato email incorrecto') as Error & { validation?: boolean };
        validationError.validation = true; // Simular bandera de Fastify

        if (storedErrorHandler) {
          await storedErrorHandler(validationError as FastifyError, mockRequest, mockReply);
        }

        expect(mockReply.status).toHaveBeenCalledWith(400);
        expect(mockRequest.log.warn).toHaveBeenCalled();
      });
    });

    describe('setNotFoundHandler Callback', () => {
      it('debería responder con HTTP 404 y loguear el intento en nivel warn', async () => {
        if (storedNotFoundHandler) {
          await storedNotFoundHandler(mockRequest, mockReply);
        }

        expect(mockReply.status).toHaveBeenCalledWith(404);
        expect(mockReply.send).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 404,
            error: 'Not Found',
            message: expect.stringContaining('No se encontró ninguna ruta'),
          }),
        );
        expect(mockRequest.log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ url: '/api/v1/test', method: 'POST' }),
          expect.stringContaining('Ruta no registrada'),
        );
      });
    });
  });
});
