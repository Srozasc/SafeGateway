import { FastifyRequest, FastifyReply } from 'fastify';

export const reqSerializer = (req: FastifyRequest | any) => {
  // Manejar si el objeto request es el nativo de Node o la abstracción de Fastify
  const headers = req.headers || {};
  return {
    method: req.method,
    url: req.url,
    remoteAddress: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: headers['user-agent'] || 'unknown',
  };
};

export const resSerializer = (res: FastifyReply | any) => {
  return {
    statusCode: res.statusCode || res.raw?.statusCode,
  };
};

export const errSerializer = (err: any) => {
  if (!err) {
    return err;
  }
  
  const isProd = process.env['NODE_ENV'] === 'production';
  return {
    type: err.constructor?.name || err.name || 'Error',
    message: err.message,
    stack: isProd ? undefined : err.stack, // Ocultar stack trace en producción para evitar filtraciones
  };
};
