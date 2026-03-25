/**
 * Circuit Breaker Pattern Implementation
 * Prevents cascading failures when n8n is down or slow
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failure threshold reached, requests fail fast
 * - HALF_OPEN: Testing if service has recovered
 */

import { logger } from '../utils/logger';
import { CircuitState, CircuitBreakerState } from './types';
import { EventEmitter } from '../utils/event-emitter';

export interface CircuitBreakerConfig {
  failureThreshold: number;        // Number of failures before opening circuit
  successThreshold: number;        // Number of successes in HALF_OPEN to close circuit
  timeout: number;                 // Time in ms before attempting recovery (HALF_OPEN)
  monitoringPeriod?: number;       // Time window for counting failures
  name?: string;                   // Circuit breaker identifier
  onStateChange?: (state: CircuitState, previousState: CircuitState) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface CircuitBreakerStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  rejectedRequests: number;  // Requests rejected due to OPEN circuit
  stateChanges: number;
  lastStateChangeTime?: string;
  averageResponseTime: number;
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;
  private stats: CircuitBreakerStats;
  private failureTimestamps: number[];
  private responseTimes: number[];
  private eventEmitter: EventEmitter;

  constructor(config: CircuitBreakerConfig) {
    this.config = {
      monitoringPeriod: 60000, // 1 minute
      name: 'default',
      ...config,
    };

    this.state = {
      state: 'CLOSED',
      failures: 0,
      successCount: 0,
    };

    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rejectedRequests: 0,
      stateChanges: 0,
      averageResponseTime: 0,
    };

    this.failureTimestamps = [];
    this.responseTimes = [];
    this.eventEmitter = new EventEmitter();

    logger.info(`CircuitBreaker '${this.config.name}' initialized`, {
      failureThreshold: this.config.failureThreshold,
      successThreshold: this.config.successThreshold,
      timeout: this.config.timeout,
    });
  }

  /**
   * Get current circuit state
   */
  public getState(): CircuitBreakerState {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state.state === 'OPEN' && this.state.nextAttemptTime) {
      if (Date.now() >= this.state.nextAttemptTime) {
        this.transitionTo('HALF_OPEN');
      }
    }

    return { ...this.state };
  }

  /**
   * Check if circuit is open (requests should fail fast)
   */
  public isOpen(): boolean {
    const currentState = this.getState();
    return currentState.state === 'OPEN';
  }

  /**
   * Check if circuit is closed (normal operation)
   */
  public isClosed(): boolean {
    return this.state.state === 'CLOSED';
  }

  /**
   * Check if circuit is half-open (testing recovery)
   */
  public isHalfOpen(): boolean {
    return this.state.state === 'HALF_OPEN';
  }

  /**
   * Record a successful request
   */
  public recordSuccess(responseTime?: number): void {
    this.stats.totalRequests++;
    this.stats.successfulRequests++;

    if (responseTime) {
      this.responseTimes.push(responseTime);
      this.updateAverageResponseTime();
    }

    switch (this.state.state) {
      case 'CLOSED':
        // Reset failure count on success in closed state
        this.state.failures = 0;
        this.cleanOldFailures();
        break;

      case 'HALF_OPEN':
        this.state.successCount++;
        logger.debug(`HALF_OPEN success count: ${this.state.successCount}/${this.config.successThreshold}`);

        // If we've reached success threshold, close the circuit
        if (this.state.successCount >= this.config.successThreshold) {
          this.transitionTo('CLOSED');
        }
        break;

      case 'OPEN':
        // Shouldn't happen, but log it
        logger.warn('Success recorded while circuit was OPEN');
        break;
    }
  }

  /**
   * Record a failed request
   */
  public recordFailure(_error?: string): void {
    this.stats.totalRequests++;
    this.stats.failedRequests++;

    const now = Date.now();
    this.failureTimestamps.push(now);
    this.cleanOldFailures();

    switch (this.state.state) {
      case 'CLOSED':
        this.state.failures++;
        logger.debug(`Failure count: ${this.state.failures}/${this.config.failureThreshold}`);

        // Check if we should open the circuit
        if (this.state.failures >= this.config.failureThreshold) {
          logger.warn(`Failure threshold reached (${this.config.failureThreshold}), opening circuit`);
          this.transitionTo('OPEN');
        }
        break;

      case 'HALF_OPEN':
        // Any failure in HALF_OPEN immediately opens the circuit again
        logger.warn('Failure during HALF_OPEN, reopening circuit');
        this.transitionTo('OPEN');
        break;

      case 'OPEN':
        // Update next attempt time
        this.state.nextAttemptTime = now + this.config.timeout;
        break;
    }
  }

  /**
   * Record a rejected request (circuit was open)
   */
  public recordRejection(): void {
    this.stats.rejectedRequests++;
  }

  /**
   * Manually reset the circuit breaker
   */
  public reset(): void {
    logger.info('Manually resetting circuit breaker');
    
    this.state = {
      state: 'CLOSED',
      failures: 0,
      successCount: 0,
    };

    this.failureTimestamps = [];
    this.responseTimes = [];
  }

  /**
   * Force open the circuit (for maintenance/testing)
   */
  public forceOpen(): void {
    logger.info('Manually opening circuit breaker');
    this.transitionTo('OPEN');
  }

  /**
   * Get circuit breaker statistics
   */
  public getStats(): CircuitBreakerStats {
    return { ...this.stats };
  }

  /**
   * Get detailed status report
   */
  public getStatus(): {
    name: string;
    state: CircuitState;
    config: CircuitBreakerConfig;
    currentState: CircuitBreakerState;
    stats: CircuitBreakerStats;
    failureRate: number;
    recentFailures: number;
  } {
    const failureRate = this.stats.totalRequests > 0
      ? (this.stats.failedRequests / this.stats.totalRequests) * 100
      : 0;

    return {
      name: this.config.name || 'default',
      state: this.state.state,
      config: this.config,
      currentState: { ...this.state },
      stats: { ...this.stats },
      failureRate: Math.round(failureRate * 100) / 100,
      recentFailures: this.failureTimestamps.length,
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  public async execute<T>(
    fn: () => Promise<T>,
    fallbackFn?: () => T
  ): Promise<T> {
    // Check if circuit is open
    if (this.isOpen()) {
      this.recordRejection();
      
      if (fallbackFn) {
        logger.debug('Circuit open, executing fallback');
        return fallbackFn();
      }
      
      throw new Error(`Circuit breaker '${this.config.name}' is OPEN`);
    }

    const startTime = Date.now();

    try {
      const result = await fn();
      const responseTime = Date.now() - startTime;
      this.recordSuccess(responseTime);
      return result;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Subscribe to state change events
   */
  public onStateChange(callback: (state: CircuitState, previousState: CircuitState) => void): void {
    this.eventEmitter.on('stateChange', callback);
  }

  /**
   * Subscribe to circuit open event
   */
  public onOpen(callback: () => void): void {
    this.eventEmitter.on('open', callback);
  }

  /**
   * Subscribe to circuit close event
   */
  public onClose(callback: () => void): void {
    this.eventEmitter.on('close', callback);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const previousState = this.state.state;

    if (previousState === newState) {
      return;
    }

    logger.info(`Circuit state transition: ${previousState} -> ${newState}`);

    this.state.state = newState;
    this.stats.stateChanges++;
    this.stats.lastStateChangeTime = new Date().toISOString();

    switch (newState) {
      case 'CLOSED':
        this.state.failures = 0;
        this.state.successCount = 0;
        this.state.nextAttemptTime = undefined;
        this.state.lastSuccessTime = Date.now();
        this.config.onClose?.();
        this.eventEmitter.emit('close');
        break;

      case 'OPEN':
        this.state.nextAttemptTime = Date.now() + this.config.timeout;
        this.state.lastFailureTime = Date.now();
        this.config.onOpen?.();
        this.eventEmitter.emit('open');
        break;

      case 'HALF_OPEN':
        this.state.successCount = 0;
        break;
    }

    this.config.onStateChange?.(newState, previousState);
    this.eventEmitter.emit('stateChange', newState, previousState);
  }

  /**
   * Clean up old failure timestamps outside monitoring period
   */
  private cleanOldFailures(): void {
    const cutoff = Date.now() - (this.config.monitoringPeriod || 60000);
    this.failureTimestamps = this.failureTimestamps.filter(ts => ts > cutoff);
    this.state.failures = this.failureTimestamps.length;
  }

  /**
   * Update average response time
   */
  private updateAverageResponseTime(): void {
    if (this.responseTimes.length === 0) {
      this.stats.averageResponseTime = 0;
      return;
    }

    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    this.stats.averageResponseTime = Math.round(sum / this.responseTimes.length);

    // Keep only last 100 response times to prevent memory growth
    if (this.responseTimes.length > 100) {
      this.responseTimes = this.responseTimes.slice(-100);
    }
  }
}

export default CircuitBreaker;
