import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import pino from 'pino';
import { register } from 'prom-client';
import { MetricsPlugin } from '../../../../src/middleware/metrics/plugin.js';
import { GatewayConfig } from '../../../../src/config/types.js';
import { RouteMatch } from '../../../../src/routing/types.js';

describe('MetricsPlugin', () => {
  let mockRequest: any;
  let mockReply: any;
  let mockSocket: any;
  let config: GatewayConfig;
  const logger = pino({ level: 'silent' });

  beforeEach(() => {
    // Limpiar el registro global de prom-client antes de cada test para evitar errores de duplicación de métricas
    register.clear();

    config = {
      server: { port: 3000, host: '0.0.0.0' },
      metrics: {
        enabled: true,
        path: '/metrics',
        defaultLabels: { env: 'test' },
      },
      routes: [],
    };

    mockSocket = {
      once: jest.fn<any>().mockImplementation((event: string, callback: any) => {
        mockSocket.listeners[event] = callback;
        return mockSocket;
      }),
      emit(event: string, ...args: any[]) {
        if (this.listeners[event]) {
          this.listeners[event](...args);
        }
      },
      listeners: {} as Record<string, Function>,
    };

    mockRequest = {
      method: 'GET',
      url: '/api/v1/users?active=true',
      headers: {},
      raw: {
        socket: mockSocket,
      },
      gatewayContext: {
        routeMatch: {
          route: {
            prefix: '/api/v1',
            target: 'http://users-service:8080',
            metricsLabel: 'users-api',
            backendName: 'users-backend',
          },
          override: null,
          effectiveRateLimit: null,
        } as RouteMatch,
      },
    };

    mockReply = {
      statusCode: 200,
    };
  });

  it('debería inicializar las métricas con labels globales y registrar default metrics', async () => {
    const plugin = new MetricsPlugin(config, logger);
    expect(plugin.name).toBe('metrics');

    const metricsList = await register.getMetricsAsJSON();
    const hasRequestsTotal = metricsList.some((m) => m.name === 'gateway_http_requests_total');
    const hasRequestsInFlight = metricsList.some(
      (m) => m.name === 'gateway_http_requests_in_flight',
    );
    const hasRequestDuration = metricsList.some(
      (m) => m.name === 'gateway_http_request_duration_seconds',
    );
    const hasRateLimitHits = metricsList.some((m) => m.name === 'gateway_rate_limit_hits_total');

    expect(hasRequestsTotal).toBe(true);
    expect(hasRequestsInFlight).toBe(true);
    expect(hasRequestDuration).toBe(true);
    expect(hasRateLimitHits).toBe(true);
  });

  it('debería omitir el registro de métricas si la ruta coincide con metricsPath', async () => {
    const plugin = new MetricsPlugin(config, logger);
    mockRequest.url = '/metrics';

    await plugin.onRequestHook(mockRequest, mockReply);
    const inFlightMetric = register.getSingleMetric('gateway_http_requests_in_flight') as any;
    const inFlightData = await inFlightMetric.get();
    expect(inFlightData.values.length).toBe(0); // No incrementado
  });

  it('debería incrementar in_flight en onRequestHook y decrementar en onResponseHook', async () => {
    const plugin = new MetricsPlugin(config, logger);

    await plugin.onRequestHook(mockRequest, mockReply);

    const inFlightMetric = register.getSingleMetric('gateway_http_requests_in_flight') as any;
    let inFlightData = await inFlightMetric.get();
    expect(inFlightData.values[0].value).toBe(1);
    expect(inFlightData.values[0].labels).toEqual({
      method: 'GET',
      route: 'users-api',
    });

    await plugin.onResponseHook(mockRequest, mockReply);

    inFlightData = await inFlightMetric.get();
    expect(inFlightData.values[0].value).toBe(0);

    const requestsTotalMetric = register.getSingleMetric('gateway_http_requests_total') as any;
    const requestsTotalData = await requestsTotalMetric.get();
    expect(requestsTotalData.values[0].value).toBe(1);
    expect(requestsTotalData.values[0].labels).toEqual({
      method: 'GET',
      route: 'users-api',
      status_code: '200',
      backend: 'users-backend',
    });
  });

  it('debería finalizar a través del event listener del socket en caso de desconexión prematura', async () => {
    const plugin = new MetricsPlugin(config, logger);

    await plugin.onRequestHook(mockRequest, mockReply);

    const inFlightMetric = register.getSingleMetric('gateway_http_requests_in_flight') as any;
    let inFlightData = await inFlightMetric.get();
    expect(inFlightData.values[0].value).toBe(1);

    // Simular que el socket se cierra de forma abrupta
    mockSocket.emit('close');

    inFlightData = await inFlightMetric.get();
    expect(inFlightData.values[0].value).toBe(0);

    const requestsTotalMetric = register.getSingleMetric('gateway_http_requests_total') as any;
    const requestsTotalData = await requestsTotalMetric.get();
    expect(requestsTotalData.values[0].value).toBe(1);
    expect(requestsTotalData.values[0].labels.status_code).toBe('499');
  });

  it('debería manejar errores en onErrorHook y finalizar con el status code correcto', async () => {
    const plugin = new MetricsPlugin(config, logger);

    await plugin.onRequestHook(mockRequest, mockReply);

    const errorMock = {
      statusCode: 503,
      message: 'Service Unavailable',
    } as any;

    await plugin.onErrorHook(mockRequest, mockReply, errorMock);

    const requestsTotalMetric = register.getSingleMetric('gateway_http_requests_total') as any;
    const requestsTotalData = await requestsTotalMetric.get();
    expect(requestsTotalData.values[0].labels.status_code).toBe('503');
  });

  it('debería finalizar con 500 en onErrorHook si no hay statusCode en el error ni en la respuesta', async () => {
    const plugin = new MetricsPlugin(config, logger);

    await plugin.onRequestHook(mockRequest, mockReply);

    const errorMock = {
      message: 'Unknown error',
    } as any;

    // mockReply no tiene statusCode establecido o está indefinido
    delete mockReply.statusCode;

    await plugin.onErrorHook(mockRequest, mockReply, errorMock);

    const requestsTotalMetric = register.getSingleMetric('gateway_http_requests_total') as any;
    const requestsTotalData = await requestsTotalMetric.get();
    expect(requestsTotalData.values[0].labels.status_code).toBe('500');
  });

  it('debería manejar abortos en onAbortHook con status code 499', async () => {
    const plugin = new MetricsPlugin(config, logger);

    await plugin.onRequestHook(mockRequest, mockReply);
    await plugin.onAbortHook(mockRequest);

    const requestsTotalMetric = register.getSingleMetric('gateway_http_requests_total') as any;
    const requestsTotalData = await requestsTotalMetric.get();
    expect(requestsTotalData.values[0].labels.status_code).toBe('499');
  });

  it('debería registrar hits de rate limiting si el status code final es 429', async () => {
    const plugin = new MetricsPlugin(config, logger);

    await plugin.onRequestHook(mockRequest, mockReply);
    mockReply.statusCode = 429;
    await plugin.onResponseHook(mockRequest, mockReply);

    const rateLimitHitsMetric = register.getSingleMetric('gateway_rate_limit_hits_total') as any;
    const rateLimitHitsData = await rateLimitHitsMetric.get();
    expect(rateLimitHitsData.values[0].value).toBe(1);
    expect(rateLimitHitsData.values[0].labels).toEqual({
      route: 'users-api',
    });
  });

  it('debería garantizar que finalize se ejecuta exactamente una vez por request', async () => {
    const plugin = new MetricsPlugin(config, logger);

    await plugin.onRequestHook(mockRequest, mockReply);

    // Llamar primero a response hook
    await plugin.onResponseHook(mockRequest, mockReply);

    // Llamar luego a error hook (por ejemplo, si ocurren ambos eventos en cascada)
    const errorMock = { statusCode: 500 } as any;
    await plugin.onErrorHook(mockRequest, mockReply, errorMock);

    // Simular también cierre de socket
    mockSocket.emit('close');

    // Comprobar que requestsTotal es exactamente 1 y el status_code final es '200'
    const requestsTotalMetric = register.getSingleMetric('gateway_http_requests_total') as any;
    const requestsTotalData = await requestsTotalMetric.get();
    expect(requestsTotalData.values.length).toBe(1);
    expect(requestsTotalData.values[0].value).toBe(1);
    expect(requestsTotalData.values[0].labels.status_code).toBe('200');
  });
});
