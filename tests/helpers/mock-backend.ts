import http from 'http';
import { AddressInfo } from 'net';

export type MockBackendBehavior = 'success' | 'error500' | 'error502' | 'error503' | 'timeout' | 'slow';

export class MockBackend {
  private server: http.Server;
  public lastRequestHeaders: http.IncomingHttpHeaders | null = null;
  public lastRequestBody: string | null = null;
  public lastRequestMethod: string | null = null;
  public lastRequestUrl: string | null = null;
  private defaultBehavior: MockBackendBehavior = 'success';
  private errorCount = 0;
  private successCount = 0;
  private requestCount = 0;

  constructor(defaultBehavior: MockBackendBehavior = 'success') {
    this.defaultBehavior = defaultBehavior;
    this.server = http.createServer((req, res) => {
      this.lastRequestHeaders = req.headers;
      this.lastRequestMethod = req.method || null;
      this.lastRequestUrl = req.url || null;
      this.requestCount++;

      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        this.lastRequestBody = body;
        const url = req.url || '';
        const behavior = this.getBehaviorFromUrl(url);

        this.handleResponse(res, behavior, url, req);
      });
    });
  }

  private getBehaviorFromUrl(url: string): MockBackendBehavior {
    // Check query parameters for behavior override
    if (url.includes('?behavior=error500')) {return 'error500';}
    if (url.includes('?behavior=error502')) {return 'error502';}
    if (url.includes('?behavior=error503')) {return 'error503';}
    if (url.includes('?behavior=timeout')) {return 'timeout';}
    if (url.includes('?behavior=slow')) {return 'slow';}
    if (url.includes('?behavior=success')) {return 'success';}
    return this.defaultBehavior;
  }

  private handleResponse(res: http.ServerResponse, behavior: MockBackendBehavior, url: string, req: http.IncomingMessage): void {
    switch (behavior) {
      case 'error500':
        this.errorCount++;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal server error', code: 'ERR_500' }));
        break;
      case 'error502':
        this.errorCount++;
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad gateway', code: 'ERR_502' }));
        break;
      case 'error503':
        this.errorCount++;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'service unavailable', code: 'ERR_503' }));
        break;
      case 'timeout':
        // Just don't respond - client will timeout
        break;
      case 'slow':
        setTimeout(() => {
          this.successCount++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: 'mock-backend', delay: 'slow' }));
        }, 2000);
        break;
      case 'success':
      default:
        this.successCount++;
        if (url.includes('/echo')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              method: req.method,
              url: url,
              headers: this.lastRequestHeaders,
              body: this.lastRequestBody,
            }),
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: 'mock-backend' }));
        }
        break;
    }
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
        if (err) {return reject(err);}
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

  public resetCounters(): void {
    this.errorCount = 0;
    this.successCount = 0;
    this.requestCount = 0;
  }

  public getErrorCount(): number {
    return this.errorCount;
  }

  public getSuccessCount(): number {
    return this.successCount;
  }

  public getRequestCount(): number {
    return this.requestCount;
  }

  public setDefaultBehavior(behavior: MockBackendBehavior): void {
    this.defaultBehavior = behavior;
  }
}
