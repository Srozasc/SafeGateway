import http from 'http';
import { AddressInfo } from 'net';

export class MockBackend {
  private server: http.Server;
  public lastRequestHeaders: http.IncomingHttpHeaders | null = null;
  public lastRequestBody: string | null = null;
  public lastRequestMethod: string | null = null;
  public lastRequestUrl: string | null = null;

  constructor() {
    this.server = http.createServer((req, res) => {
      this.lastRequestHeaders = req.headers;
      this.lastRequestMethod = req.method || null;
      this.lastRequestUrl = req.url || null;

      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        this.lastRequestBody = body;

        // Comportamientos condicionales según el path de prueba
        if (req.url?.includes('/timeout')) {
          // Demorar respuesta para inducir timeouts en el Gateway
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'delayed success' }));
          }, 1000); // 1 segundo
        } else if (req.url?.includes('/echo')) {
          // Responder con los mismos datos recibidos para validar proxying
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: body,
            }),
          );
        } else if (req.url?.includes('/error')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error backend' }));
        } else {
          // Respuesta por defecto exitosa
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: 'mock-backend' }));
        }
      });
    });
  }

  public start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  public clear(): void {
    this.lastRequestHeaders = null;
    this.lastRequestBody = null;
    this.lastRequestMethod = null;
    this.lastRequestUrl = null;
  }
}
