export interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  requestId?: string;
  timestamp: string;
  stack?: string;
}

const HTTP_STATUS_TEXTS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * Construye un objeto estructurado de respuesta de error JSON uniforme.
 * Filtra de manera segura detalles de infraestructura o stack traces en producción.
 *
 * @param error Objeto de error capturado.
 * @param requestId Identificador único de la petición de Fastify.
 * @param timestamp Marca de tiempo en formato ISO.
 * @returns Estructura de respuesta estandarizada.
 */
export function buildErrorResponse(
  error: Error & { statusCode?: number; status?: number },
  requestId?: string,
  timestamp: string = new Date().toISOString(),
): ErrorResponse {
  const statusCode = error.statusCode || error.status || 500;
  const errorName = HTTP_STATUS_TEXTS[statusCode] || 'Internal Server Error';

  const response: ErrorResponse = {
    statusCode,
    error: errorName,
    message: error.message || 'Ha ocurrido un error interno en el servidor.',
    timestamp,
  };

  if (requestId) {
    response.requestId = requestId;
  }

  // Ocultar stack trace en producción para evitar fugas de información
  if (process.env.NODE_ENV !== 'production' && error.stack) {
    response.stack = error.stack;
  }

  return response;
}
