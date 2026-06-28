import { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { buildErrorResponse } from './responses.js';
import { RouteNotFoundError } from './types.js';

/**
 * Registra los manejadores globales de error y no encontrado en la instancia de Fastify.
 * Centraliza el formateo de respuestas JSON y la escritura de logs estructurados.
 *
 * @param fastify Instancia del servidor Fastify.
 */
export function registerErrorHandler(fastify: FastifyInstance): void {
  // 1. Manejador de errores global
  fastify.setErrorHandler((error: FastifyError & { status?: number }, request: FastifyRequest, reply: FastifyReply) => {
    // Si es un error de validación de Fastify/Zod, forzar un statusCode de 400
    if (error.validation) {
      error.statusCode = 400;
    }

    const statusCode = error.statusCode || error.status || 500;
    const requestId = request.id || 'system';
    const timestamp = new Date().toISOString();

    // Logs estructurados diferenciados por severidad técnica
    if (statusCode >= 500) {
      request.log.error(
        { err: error, requestId, url: request.url, method: request.method },
        `Error del servidor de nivel 5xx capturado: ${error.message}`,
      );
    } else {
      request.log.warn(
        { err: error, requestId, url: request.url, method: request.method, statusCode },
        `Error de nivel 4xx capturado (${statusCode}): ${error.message}`,
      );
    }

    const response = buildErrorResponse(error, requestId, timestamp);

    reply.status(statusCode).send(response);
  });

  // 2. Manejador de rutas no encontradas (HTTP 404)
  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const error = new RouteNotFoundError(request.url);
    const requestId = request.id || 'system';
    const timestamp = new Date().toISOString();

    // Loguear el intento fallido de acceso
    request.log.warn(
      { url: request.url, method: request.method, requestId },
      `Ruta no registrada en el Gateway: ${request.url}`,
    );

    const response = buildErrorResponse(error, requestId, timestamp);

    reply.status(404).send(response);
  });
}
