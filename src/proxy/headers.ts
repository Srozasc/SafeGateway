import type { FastifyRequest } from 'fastify';
import type { ProxyForwardingHeaders } from './types.js';

/**
 * Construye de manera segura y estándar las cabeceras de reenvío HTTP (forwarding)
 * que informan al servicio de destino (backend) sobre el origen real de la petición.
 *
 * @param request Objeto de petición HTTP de Fastify.
 * @returns Diccionario de cabeceras de reenvío formateadas.
 */
export function buildForwardingHeaders(request: FastifyRequest): ProxyForwardingHeaders {
  const clientIp = request.ip || '127.0.0.1';

  // 1. Calcular X-Forwarded-For acumulativo
  const existingXFF = request.headers['x-forwarded-for'];
  let xForwardedFor: string;

  if (existingXFF) {
    const xffStr = typeof existingXFF === 'string' ? existingXFF : existingXFF.join(', ');
    xForwardedFor = `${xffStr.trim()}, ${clientIp}`;
  } else {
    xForwardedFor = clientIp;
  }

  // 2. Calcular X-Forwarded-Host (El host que solicitó originalmente el cliente)
  const xForwardedHost = request.headers.host || 'localhost';

  // 3. Calcular X-Forwarded-Proto (El esquema original de conexión http / https)
  const xForwardedProto =
    request.protocol || (request.headers['x-forwarded-proto'] as string) || 'http';

  // 4. Calcular X-Real-IP (La IP directa conectada al Gateway)
  const xRealIp = clientIp;

  return {
    'x-forwarded-for': xForwardedFor,
    'x-forwarded-host': xForwardedHost,
    'x-forwarded-proto': xForwardedProto,
    'x-real-ip': xRealIp,
  };
}