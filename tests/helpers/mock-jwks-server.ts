import http from 'http';
import { AddressInfo } from 'net';

/**
 * Mock del endpoint JWKS usado por el JwksClient en tests de integración.
 * Soporta:
 *  - setKeys(keys): define el JWKS actual que devuelve
 *  - rotateKey(newKey): añade/rota una clave (testea refresh on miss)
 *  - setFailureMode(mode): simula errores de red (timeout, 500, parse-error)
 *  - counters: getRequestCount() para verificar refresh on miss / cooldown
 */
export type MockJwksFailureMode = 'ok' | 'timeout' | 'error500' | 'parse-error';

export interface MockJwk {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
  [key: string]: unknown;
}

export class MockJwksServer {
  private server: http.Server;
  private keys: MockJwk[] = [];
  private failureMode: MockJwksFailureMode = 'ok';
  private requestCount = 0;
  private ports: number | null = null;

  constructor(initialKeys: MockJwk[] = []) {
    this.keys = initialKeys;
    this.server = http.createServer((req, res) => {
      this.requestCount++;

      if (this.failureMode === 'timeout') {
        // No respondemos — el cliente expirará por timeout
        return;
      }

      if (this.failureMode === 'error500') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal server error');
        return;
      }

      if (this.failureMode === 'parse-error') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{ invalid json');
        return;
      }

      // Modo normal — devolver JWKS
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: this.keys }));
    });
  }

  public start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo;
        this.ports = address.port;
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

  public setKeys(keys: MockJwk[]): void {
    this.keys = keys;
  }

  public rotateKey(newKey: MockJwk): void {
    if (!this.keys.some((k) => k.kid === newKey.kid)) {
      this.keys.push(newKey);
    } else {
      // Reemplazar la clave del mismo kid
      this.keys = this.keys.map((k) => (k.kid === newKey.kid ? newKey : k));
    }
  }

  public removeKey(kid: string): void {
    this.keys = this.keys.filter((k) => k.kid !== kid);
  }

  public setFailureMode(mode: MockJwksFailureMode): void {
    this.failureMode = mode;
  }

  public getRequestCount(): number {
    return this.requestCount;
  }

  public resetCounters(): void {
    this.requestCount = 0;
  }

  public getJwksUri(): string {
    if (this.ports === null) {
      throw new Error('MockJwksServer no ha sido arrancado — llama a start() primero');
    }
    return `http://127.0.0.1:${this.ports}/.well-known/jwks.json`;
  }
}
