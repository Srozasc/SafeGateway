/**
 * Circuit Breaker State Machine Tests
 */

import { CircuitState, CircuitStateMachine, CircuitBreakerRegistry } from '../../src/middleware/circuit-breaker/state.js';
import { Logger } from 'pino';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;

describe('CircuitStateMachine', () => {
  let machine: CircuitStateMachine;

  beforeEach(() => {
    machine = new CircuitStateMachine('/api/users', 'http://users-backend:8080', {}, mockLogger);
  });

  describe('Initial State', () => {
    it('should start in CLOSED state', () => {
      expect(machine.getState()).toBe(CircuitState.CLOSED);
    });

    it('should allow requests when CLOSED', () => {
      expect(machine.canExecute()).toBe(true);
    });
  });

  describe('CLOSED -> OPEN Transitions', () => {
    it('should open after 5 consecutive failures', () => {
      for (let i = 0; i < 5; i++) {
        machine.recordFailure();
      }
      expect(machine.getState()).toBe(CircuitState.OPEN);
    });

    it('should open when error threshold is exceeded', () => {
      // With default config: 50% error threshold, 100 request count
      // Record 50 failures in a window
      for (let i = 0; i < 50; i++) {
        machine.recordFailure();
      }
      // Need to also fill the window
      for (let i = 0; i < 50; i++) {
        machine.recordSuccess();
      }
      // Now record failures to trigger threshold
      for (let i = 0; i < 51; i++) {
        machine.recordFailure();
      }
      // The issue is that success resets failure count, so let's be more precise
      const machine2 = new CircuitStateMachine(
        '/api/test',
        'http://test:8080',
        { errorThreshold: 50, requestCount: 10 },
        mockLogger
      );
      // Record 6 failures out of 10 requests = 60% > 50%
      for (let i = 0; i < 6; i++) {
        machine2.recordFailure();
        // Add success to complete the window
        machine2.recordSuccess();
      }
      expect(machine2.getState()).toBe(CircuitState.OPEN);
    });

    it('should reset failure count on success in CLOSED', () => {
      for (let i = 0; i < 4; i++) {
        machine.recordFailure();
      }
      expect(machine.getState()).toBe(CircuitState.CLOSED);
      machine.recordSuccess();
      expect(machine.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('OPEN -> HALF_OPEN Transitions', () => {
    it('should transition to HALF_OPEN after recovery time', () => {
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        machine.recordFailure();
      }
      expect(machine.getState()).toBe(CircuitState.OPEN);

      // Fast forward by using a short recovery time
      const fastMachine = new CircuitStateMachine(
        '/api/fast',
        'http://fast:8080',
        { recoveryTimeMs: 1 },
        mockLogger
      );
      for (let i = 0; i < 5; i++) {
        fastMachine.recordFailure();
      }
      expect(fastMachine.getState()).toBe(CircuitState.OPEN);

      // Wait for recovery time
      jest.sleep(10);

      // Request should transition to HALF_OPEN
      expect(fastMachine.canExecute()).toBe(true);
      expect(fastMachine.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should block requests when OPEN and before recovery time', () => {
      for (let i = 0; i < 5; i++) {
        machine.recordFailure();
      }
      expect(machine.getState()).toBe(CircuitState.OPEN);
      expect(machine.canExecute()).toBe(false);
    });
  });

  describe('HALF_OPEN -> CLOSED/OPEN Transitions', () => {
    it('should close after halfOpenRequests successful requests', () => {
      const machine = new CircuitStateMachine(
        '/api/test',
        'http://test:8080',
        { recoveryTimeMs: 1, halfOpenRequests: 3 },
        mockLogger
      );

      // Open the circuit
      for (let i = 0; i < 5; i++) {
        machine.recordFailure();
      }
      expect(machine.getState()).toBe(CircuitState.OPEN);

      // Wait and trigger transition to HALF_OPEN
      jest.sleep(10);
      machine.canExecute(); // This should transition

      expect(machine.getState()).toBe(CircuitState.HALF_OPEN);

      // Record successful requests
      machine.recordSuccess();
      machine.recordSuccess();
      expect(machine.getState()).toBe(CircuitState.HALF_OPEN);

      machine.recordSuccess();
      expect(machine.getState()).toBe(CircuitState.CLOSED);
    });

    it('should reopen on any failure in HALF_OPEN', () => {
      const machine = new CircuitStateMachine(
        '/api/test',
        'http://test:8080',
        { recoveryTimeMs: 1, halfOpenRequests: 3 },
        mockLogger
      );

      // Open and transition to HALF_OPEN
      for (let i = 0; i < 5; i++) {
        machine.recordFailure();
      }
      jest.sleep(10);
      machine.canExecute();

      expect(machine.getState()).toBe(CircuitState.HALF_OPEN);

      // Record one success then a failure
      machine.recordSuccess();
      machine.recordFailure();

      expect(machine.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('Metrics', () => {
    it('should track total requests and failures', () => {
      machine.recordSuccess();
      machine.recordSuccess();
      machine.recordFailure();
      machine.recordFailure();
      machine.recordFailure();

      const metrics = machine.getMetrics();
      expect(metrics.totalRequests).toBe(5);
      expect(metrics.totalFailures).toBe(3);
      expect(metrics.failures).toBe(3);
    });

    it('should track last failure timestamp', () => {
      machine.recordFailure();
      const metrics = machine.getMetrics();
      expect(metrics.lastFailure).toBeDefined();
    });
  });

  describe('Force State', () => {
    it('should allow forcing to any state', () => {
      machine.forceState(CircuitState.OPEN);
      expect(machine.getState()).toBe(CircuitState.OPEN);

      machine.forceState(CircuitState.HALF_OPEN);
      expect(machine.getState()).toBe(CircuitState.HALF_OPEN);

      machine.forceState(CircuitState.CLOSED);
      expect(machine.getState()).toBe(CircuitState.CLOSED);
    });
  });
});

describe('CircuitBreakerRegistry', () => {
  let registry: CircuitBreakerRegistry;

  beforeEach(() => {
    registry = new CircuitBreakerRegistry({}, mockLogger);
  });

  it('should create circuits per route', () => {
    const circuit1 = registry.getCircuit('/api/users', 'http://users:8080');
    const circuit2 = registry.getCircuit('/api/orders', 'http://orders:8080');

    expect(circuit1).toBeDefined();
    expect(circuit2).toBeDefined();
    expect(circuit1).not.toBe(circuit2);
  });

  it('should return the same circuit for the same route', () => {
    const circuit1 = registry.getCircuit('/api/users', 'http://users:8080');
    const circuit2 = registry.getCircuit('/api/users', 'http://users:8080');

    expect(circuit1).toBe(circuit2);
  });

  it('should return all metrics', () => {
    registry.getCircuit('/api/users', 'http://users:8080').recordFailure();
    registry.getCircuit('/api/orders', 'http://orders:8080').recordSuccess();

    const allMetrics = registry.getAllMetrics();
    expect(allMetrics.size).toBe(2);
  });
});