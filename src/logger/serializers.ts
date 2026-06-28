
export const reqSerializer = (req: {
  method?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}) => {
  // Manejar si el objeto request es el nativo de Node o la abstracción de Fastify
  const headers = req.headers || {};
  return {
    method: req.method,
    url: req.url,
    remoteAddress: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: headers['user-agent'] || 'unknown',
  };
};

export const resSerializer = (res: {
  statusCode?: number;
  raw?: { statusCode?: number };
}) => {
  return {
    statusCode: res.statusCode || res.raw?.statusCode,
  };
};

export const errSerializer = (err: unknown) => {
  if (!err) {
    return err;
  }

  const errorObj = err instanceof Error ? err : new Error(String(err));
  const isProd = process.env['NODE_ENV'] === 'production';
  return {
    type: errorObj.constructor?.name || errorObj.name || 'Error',
    message: errorObj.message,
    stack: isProd ? undefined : errorObj.stack, // Ocultar stack trace en producción para evitar filtraciones
  };
};
