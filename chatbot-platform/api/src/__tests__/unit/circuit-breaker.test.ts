import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from '../../n8n/circuit-breaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 1000,
      monitoringPeriod: 60000,
      name: 'test',
    });
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(breaker.getState().state).toBe('CLOSED');
      expect(breaker.isClosed()).toBe(true);
      expect(breaker.isOpen()).toBe(false);
    });
  });

  describe('CLOSED -> OPEN transition', () => {
    it('should open after reaching failure threshold', () => {
      breaker.recordFailure('err1');
      breaker.recordFailure('err2');
      breaker.recordFailure('err3');
      expect(breaker.isOpen()).toBe(true);
    });

    it('should track failure count in stats', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      const stats = breaker.getStats();
      expect(stats.failedRequests).toBe(2);
      expect(stats.totalRequests).toBe(2);
    });
  });

  describe('OPEN -> HALF_OPEN transition', () => {
    it('should transition to HALF_OPEN after timeout', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);

      vi.advanceTimersByTime(1100);

      expect(breaker.getState().state).toBe('HALF_OPEN');
      vi.useRealTimers();
    });
  });

  describe('HALF_OPEN -> CLOSED transition', () => {
    it('should close after reaching success threshold in HALF_OPEN', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      vi.advanceTimersByTime(1100);
      breaker.getState();

      breaker.recordSuccess();
      expect(breaker.getState().state).toBe('HALF_OPEN');

      breaker.recordSuccess();
      expect(breaker.isClosed()).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('HALF_OPEN -> OPEN transition', () => {
    it('should reopen on any failure in HALF_OPEN', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      vi.advanceTimersByTime(1100);
      breaker.getState();

      breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('execute()', () => {
    it('should return result on success', async () => {
      const result = await breaker.execute(() => Promise.resolve(42));
      expect(result).toBe(42);
    });

    it('should propagate errors', async () => {
      await expect(
        breaker.execute(() => Promise.reject(new Error('fail'))),
      ).rejects.toThrow('fail');
    });

    it('should call fallback when circuit is open', async () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      const result = await breaker.execute(
        () => Promise.resolve('should not run'),
        () => 'fallback',
      );
      expect(result).toBe('fallback');
      vi.useRealTimers();
    });

    it('should throw when circuit is open and no fallback', async () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      await expect(
        breaker.execute(() => Promise.resolve('nope')),
      ).rejects.toThrow("Circuit breaker 'test' is OPEN");
      vi.useRealTimers();
    });
  });

  describe('stats', () => {
    it('should track request counts', () => {
      breaker.recordSuccess();
      breaker.recordSuccess();
      breaker.recordFailure();

      const stats = breaker.getStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.successfulRequests).toBe(2);
      expect(stats.failedRequests).toBe(1);
    });

    it('should track rejected requests', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      breaker.recordRejection();
      vi.useRealTimers();

      expect(breaker.getStats().rejectedRequests).toBe(1);
    });
  });

  describe('reset', () => {
    it('should return to CLOSED state', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);

      breaker.reset();
      expect(breaker.isClosed()).toBe(true);
      expect(breaker.getState().failures).toBe(0);
      vi.useRealTimers();
    });
  });

  describe('forceOpen', () => {
    it('should force the circuit open', () => {
      breaker.forceOpen();
      expect(breaker.isOpen()).toBe(true);
    });
  });
});
