import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from '../../../src/config/loader.js';

describe('Config Loader — JWT cross-references (fail-fast)', () => {
  let tmpDir: string;
  let tmpConfigPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-loader-jwt-'));
    tmpConfigPath = path.join(tmpDir, 'gateway.yaml');
    process.env['CONFIG_PATH'] = tmpConfigPath;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['CONFIG_PATH'];
  });

  function writeYaml(content: string): void {
    fs.writeFileSync(tmpConfigPath, content, 'utf8');
  }

  it('BDD 11: falla al startup si jwksUri no es una URL válida', () => {
    writeYaml(`
server: { port: 3000, host: "0.0.0.0" }
redis: { url: "redis://localhost:6379" }
logging: { level: "info" }
routes:
  - prefix: "/api"
    target: "http://backend:8080"
jwt:
  enabled: true
  mode: jwks
  issuers:
    - name: bad
      jwksUri: "not-a-url"
      issuer: "https://auth.example.com"
`);

    expect(() => loadConfig()).toThrow();
  });

  it('BDD 12: falla al startup si hay nombres de issuer duplicados', () => {
    writeYaml(`
server: { port: 3000, host: "0.0.0.0" }
redis: { url: "redis://localhost:6379" }
logging: { level: "info" }
routes:
  - prefix: "/api"
    target: "http://backend:8080"
jwt:
  enabled: true
  mode: jwks
  issuers:
    - name: auth
      jwksUri: "https://auth1.example.com/jwks.json"
      issuer: "https://auth1.example.com"
    - name: auth
      jwksUri: "https://auth2.example.com/jwks.json"
      issuer: "https://auth2.example.com"
`);

    expect(() => loadConfig()).toThrow(/duplicate issuer name/);
  });

  it('falla si routes[].jwt.issuer referencia un issuer desconocido', () => {
    writeYaml(`
server: { port: 3000, host: "0.0.0.0" }
redis: { url: "redis://localhost:6379" }
logging: { level: "info" }
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    jwt:
      mode: jwks
      issuer: "auth-service-typo"
jwt:
  enabled: true
  mode: jwks
  issuers:
    - name: auth-service-prod
      jwksUri: "https://auth.example.com/jwks.json"
      issuer: "https://auth.example.com"
`);

    expect(() => loadConfig()).toThrow(/jwt\.issuer="auth-service-typo" no existe/);
  });

  it('falla si routes[].jwt.issuer="any" sin issuers configurados', () => {
    writeYaml(`
server: { port: 3000, host: "0.0.0.0" }
redis: { url: "redis://localhost:6379" }
logging: { level: "info" }
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    jwt:
      mode: jwks
      issuer: "any"
jwt:
  enabled: true
  mode: jwks
  issuers: []
`);

    // jwt.mode="jwks" con issuers vacíos ya es rechazado por la superRefine del schema
    expect(() => loadConfig()).toThrow();
  });

  it('acepta config válida: issuer por nombre', () => {
    writeYaml(`
server: { port: 3000, host: "0.0.0.0" }
redis: { url: "redis://localhost:6379" }
logging: { level: "info" }
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    jwt:
      mode: jwks
      issuer: "auth-service-prod"
jwt:
  enabled: true
  mode: jwks
  issuers:
    - name: auth-service-prod
      jwksUri: "https://auth.example.com/jwks.json"
      issuer: "https://auth.example.com"
`);

    expect(() => loadConfig()).not.toThrow();
  });

  it('acepta config válida: issuer "any" con issuers[] poblado', () => {
    writeYaml(`
server: { port: 3000, host: "0.0.0.0" }
redis: { url: "redis://localhost:6379" }
logging: { level: "info" }
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    jwt:
      mode: jwks
      issuer: "any"
jwt:
  enabled: true
  mode: jwks
  issuers:
    - name: auth-prod
      jwksUri: "https://auth.example.com/jwks.json"
      issuer: "https://auth.example.com"
`);

    expect(() => loadConfig()).not.toThrow();
  });

  it('preserva compatibilidad HS256 (shared-secret sin sección global)', () => {
    writeYaml(`
server: { port: 3000, host: "0.0.0.0" }
redis: { url: "redis://localhost:6379" }
logging: { level: "info" }
routes:
  - prefix: "/api"
    target: "http://backend:8080"
    jwt:
      enabled: true
      secret: "my-hs256-secret"
      algorithm: "HS256"
`);

    expect(() => loadConfig()).not.toThrow();
  });
});