import { describe, it, expect } from 'vitest';
import { RouteRegistry } from '../../../src/routing/registry.js';
import { GatewayConfig } from '../../../src/config/types.js';

describe('Route Matcher & Registry', () => {
  // Configuración de prueba simulada
  const mockConfig: GatewayConfig = {
    server: { port: 3000, host: '0.0.0.0' },
    redis: { url: 'redis://localhost:6379' },
    logging: { level: 'info' },
    metrics: { enabled: false, path: '/metrics', defaultLabels: {} },
    routes: [
      {
        prefix: '/api',
        target: 'http://backend-general:8080',
        rateLimit: { maxRequests: 100, windowSeconds: 60 },
      },
      {
        prefix: '/api/v2',
        target: 'http://backend-v2:9090',
        rateLimit: { maxRequests: 500, windowSeconds: 60 },
      },
      {
        prefix: '/admin',
        target: 'http://admin-service:7070',
      },
      {
        prefix: '/',
        target: 'http://static-site:5050',
      },
    ],
    overrides: [
      {
        path: '/api/login',
        rateLimit: { maxRequests: 5, windowSeconds: 60 },
      },
      {
        path: '/api/v2/special',
        rateLimit: { maxRequests: 10, windowSeconds: 10 },
      },
    ],
  };

  const registry = new RouteRegistry(mockConfig);

  it('debería ordenar las rutas por longitud de prefijo descendente al instanciarse', () => {
    const routes = registry.getRoutes();
    expect(routes[0]?.prefix).toBe('/api/v2'); // El más largo primero
    expect(routes[1]?.prefix).toBe('/admin'); // Longitud 6
    expect(routes[2]?.prefix).toBe('/api'); // Longitud 4
    expect(routes[3]?.prefix).toBe('/'); // Longitud 1 (el más corto)
  });

  it('debería coincidir con el prefijo más largo (más específico) disponible', () => {
    const match = registry.match('/api/v2/users/profile');

    expect(match).not.toBeNull();
    expect(match?.route.prefix).toBe('/api/v2');
    expect(match?.route.target).toBe('http://backend-v2:9090');
    expect(match?.effectiveRateLimit?.maxRequests).toBe(500);
    expect(match?.override).toBeNull();
  });

  it('debería coincidir con el prefijo general cuando no hay uno más específico', () => {
    const match = registry.match('/api/users/profile');

    expect(match).not.toBeNull();
    expect(match?.route.prefix).toBe('/api');
    expect(match?.route.target).toBe('http://backend-general:8080');
    expect(match?.effectiveRateLimit?.maxRequests).toBe(100);
    expect(match?.override).toBeNull();
  });

  it('debería coincidir con el prefijo raíz (/) como último recurso', () => {
    const match = registry.match('/unmatched-path');

    expect(match).not.toBeNull();
    expect(match?.route.prefix).toBe('/');
    expect(match?.route.target).toBe('http://static-site:5050');
    expect(match?.effectiveRateLimit).toBeNull(); // La ruta / no tiene rate limit
  });

  it('debería ignorar los query params al realizar el matching', () => {
    const match = registry.match('/api/users/profile?id=45&sort=desc');

    expect(match).not.toBeNull();
    expect(match?.route.prefix).toBe('/api');
    expect(match?.route.target).toBe('http://backend-general:8080');
  });

  it('debería resolver overrides exactos con su rate limit prioritario y conservar el target del backend', () => {
    const match = registry.match('/api/login');

    expect(match).not.toBeNull();
    expect(match?.route.prefix).toBe('/api');
    expect(match?.route.target).toBe('http://backend-general:8080'); // Mantiene el target de la ruta padre
    expect(match?.override).not.toBeNull();
    expect(match?.override?.path).toBe('/api/login');
    expect(match?.effectiveRateLimit?.maxRequests).toBe(5); // Aplica el límite estricto del override
  });

  it('debería ignorar query params en overrides exactos', () => {
    const match = registry.match('/api/login?attempt=2');

    expect(match).not.toBeNull();
    expect(match?.route.prefix).toBe('/api');
    expect(match?.override).not.toBeNull();
    expect(match?.override?.path).toBe('/api/login');
    expect(match?.effectiveRateLimit?.maxRequests).toBe(5);
  });

  it('debería aplicar el override incluso si se encuentra dentro de un prefijo específico', () => {
    const match = registry.match('/api/v2/special');

    expect(match).not.toBeNull();
    expect(match?.route.prefix).toBe('/api/v2');
    expect(match?.route.target).toBe('http://backend-v2:9090');
    expect(match?.override?.path).toBe('/api/v2/special');
    expect(match?.effectiveRateLimit?.maxRequests).toBe(10);
  });

  it('NO debería coincidir por prefijo si la ruta es sólo una coincidencia parcial de palabra (evitar falsos positivos)', () => {
    // Si tenemos /api, no debe coincidir con /apiv2 (debe caer en la raíz /)
    const match = registry.match('/apiv2/users');

    expect(match).not.toBeNull();
    expect(match?.route.prefix).toBe('/'); // Cae en /
    expect(match?.route.target).toBe('http://static-site:5050');
  });

  it('debería retornar null si ninguna ruta coincide (cuando no hay ruta raíz configurada)', () => {
    // Instanciar un registro sin ruta raíz (/)
    const registryWithoutRoot = new RouteRegistry({
      ...mockConfig,
      routes: mockConfig.routes.filter((r) => r.prefix !== '/'),
    });

    const match = registryWithoutRoot.match('/unmatched-path');
    expect(match).toBeNull();
  });
});
