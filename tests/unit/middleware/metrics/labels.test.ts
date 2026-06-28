import { describe, it, expect } from 'vitest';
import { RouteMatch } from '../../../../src/routing/types.js';
import { RouteConfig } from '../../../../src/config/types.js';
import {
  extractHostname,
  resolveRouteLabel,
  resolveBackendLabel,
} from '../../../../src/middleware/metrics/labels.js';

describe('Labels Metrics Helpers', () => {
  describe('extractHostname', () => {
    it('debería extraer el hostname de una URL válida', () => {
      expect(extractHostname('http://api.backend.local/users')).toBe('api.backend.local');
      expect(extractHostname('https://localhost:8080/v1')).toBe('localhost');
    });

    it('debería retornar "unknown" si la URL no es válida', () => {
      expect(extractHostname('not-a-url')).toBe('unknown');
      expect(extractHostname('')).toBe('unknown');
    });
  });

  describe('resolveRouteLabel', () => {
    it('debería retornar "unmatched" si routeMatch es nulo o indefinido', () => {
      expect(resolveRouteLabel(null)).toBe('unmatched');
      expect(resolveRouteLabel(undefined)).toBe('unmatched');
      expect(resolveRouteLabel({} as unknown as RouteMatch)).toBe('unmatched');
    });

    it('debería priorizar metricsLabel si está definido en la ruta', () => {
      const mockRouteMatch: RouteMatch = {
        route: {
          prefix: '/users',
          target: 'http://localhost:8080',
          metricsLabel: 'users-service',
        },
        override: null,
        effectiveRateLimit: null,
        effectiveCors: null,
      };
      expect(resolveRouteLabel(mockRouteMatch)).toBe('users-service');
    });

    it('debería usar prefix como fallback si metricsLabel no está definido', () => {
      const mockRouteMatch: RouteMatch = {
        route: {
          prefix: '/products',
          target: 'http://localhost:8080',
        },
        override: null,
        effectiveRateLimit: null,
        effectiveCors: null,
      };
      expect(resolveRouteLabel(mockRouteMatch)).toBe('/products');
    });

    it('debería retornar "unmatched" si no hay prefix ni metricsLabel', () => {
      const mockRouteMatch: RouteMatch = {
        route: {
          target: 'http://localhost:8080',
        } as unknown as RouteConfig,
        override: null,
        effectiveRateLimit: null,
        effectiveCors: null,
      };
      expect(resolveRouteLabel(mockRouteMatch)).toBe('unmatched');
    });
  });

  describe('resolveBackendLabel', () => {
    it('debería retornar "unknown" si routeMatch es nulo o indefinido', () => {
      expect(resolveBackendLabel(null)).toBe('unknown');
      expect(resolveBackendLabel(undefined)).toBe('unknown');
      expect(resolveBackendLabel({} as unknown as RouteMatch)).toBe('unknown');
    });

    it('debería priorizar backendName si está definido en la ruta', () => {
      const mockRouteMatch: RouteMatch = {
        route: {
          prefix: '/users',
          target: 'http://users-api:8080',
          backendName: 'users-backend',
        },
        override: null,
        effectiveRateLimit: null,
        effectiveCors: null,
      };
      expect(resolveBackendLabel(mockRouteMatch)).toBe('users-backend');
    });

    it('debería extraer el hostname del target como fallback si backendName no está definido', () => {
      const mockRouteMatch: RouteMatch = {
        route: {
          prefix: '/users',
          target: 'http://users-api-host:8080/v1',
        },
        override: null,
        effectiveRateLimit: null,
        effectiveCors: null,
      };
      expect(resolveBackendLabel(mockRouteMatch)).toBe('users-api-host');
    });

    it('debería retornar "unknown" si no hay backendName ni target válido', () => {
      const mockRouteMatch: RouteMatch = {
        route: {
          prefix: '/users',
        } as unknown as RouteConfig,
        override: null,
        effectiveRateLimit: null,
        effectiveCors: null,
      };
      expect(resolveBackendLabel(mockRouteMatch)).toBe('unknown');
    });
  });
});
