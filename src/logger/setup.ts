import pino, { Logger } from 'pino';
import { LogLevel } from './types.js';
import { reqSerializer, resSerializer, errSerializer } from './serializers.js';

/**
 * Crea e inicializa una instancia de Pino configurada para producción y desarrollo.
 * Formato estructurado JSON Lines a stdout con serializadores personalizados y redacción de datos sensibles.
 *
 * @param level Nivel de log inicial a aplicar (debug | info | warn | error)
 * @returns Instancia configurada de pino.Logger
 */
export function createLogger(level: LogLevel): Logger {
  return pino({
    level: level || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      req: reqSerializer,
      res: resSerializer,
      err: errSerializer,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["proxy-authorization"]',
        'req.headers["set-cookie"]',
      ],
      censor: '[REDACTED]',
    },
  });
}
