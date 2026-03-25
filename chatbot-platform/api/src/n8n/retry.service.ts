/**
 * Retry Service
 * Implements exponential backoff retry mechanism with Redis queue
 * Queues failed messages and retries with increasing delays
 */

import Queue from 'bull';
import { logger } from '../utils/logger';
import { OutboundService } from './outbound.service';
import { CircuitBreaker } from './circuit-breaker';
import { MetricsService } from '../services/metrics.service';
import { QueuedMessage, WebhookConfig, OutboundMessage } from './types';

// logger imported from utils/logger

export interface RetryServiceConfig {
  redisUrl: string;
  maxRetries?: number;
  initialDelay?: number;
  backoffMultiplier?: number;
  maxDelay?: number;
  outboundService: OutboundService;
  circuitBreaker: CircuitBreaker;
  metricsService?: MetricsService;
  queueName?: string;
}

export interface RetryJobData {
  messageId: string;
  message: OutboundMessage;
  webhookConfig: WebhookConfig;
  attempt: number;
  maxAttempts: number;
  error?: string;
}

export interface QueueStatus {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export class RetryService {
  private config: RetryServiceConfig;
  private queue: Queue.Queue<RetryJobData>;
  private isInitialized: boolean = false;

  constructor(config: RetryServiceConfig) {
    this.config = {
      maxRetries: 3,
      initialDelay: 1000, // 1 second
      backoffMultiplier: 2,
      maxDelay: 30000, // 30 seconds
      queueName: 'n8n-webhook-retries',
      ...config,
    };

    // Initialize Bull queue with Redis
    this.queue = new Queue(this.config.queueName!, {
      redis: this.config.redisUrl,
      defaultJobOptions: {
        attempts: this.config.maxRetries,
        backoff: {
          type: 'exponential',
          delay: this.config.initialDelay,
        },
        removeOnComplete: 100, // Keep last 100 completed jobs
        removeOnFail: 50, // Keep last 50 failed jobs
      },
    });

    this.setupQueueProcessors();
    this.setupQueueEventHandlers();

    logger.info('RetryService initialized', {
      queueName: this.config.queueName,
      maxRetries: this.config.maxRetries,
      initialDelay: this.config.initialDelay,
    });
  }

  /**
   * Initialize the service and queue
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Test Redis connection
      await this.queue.client.ping();
      logger.info('RetryService connected to Redis');
      this.isInitialized = true;
    } catch (error) {
      logger.error('Failed to connect to Redis', error);
      throw error;
    }
  }

  /**
   * Queue a message for retry
   */
  public async queueMessage(queuedMessage: QueuedMessage): Promise<void> {
    await this.initialize();

    const { id, message, webhookConfig, attempts, maxAttempts, error } = queuedMessage;

    // Calculate delay using exponential backoff
    const delay = this.calculateBackoffDelay(attempts);

    const jobData: RetryJobData = {
      messageId: id,
      message,
      webhookConfig,
      attempt: attempts,
      maxAttempts,
      error,
    };

    try {
      const job = await this.queue.add(jobData, {
        delay,
        jobId: id, // Use our ID as the job ID for idempotency
        priority: this.getPriority(message.event),
      });

      logger.info(`Message queued for retry`, {
        messageId: id,
        sessionId: message.sessionId,
        attempt: attempts,
        maxAttempts,
        delay,
        jobId: job.id,
      });

      this.config.metricsService?.incrementCounter('n8n_message_queued');

    } catch (error) {
      logger.error(`Failed to queue message ${id}`, error);
      throw error;
    }
  }

  /**
   * Retry a specific message immediately
   */
  public async retryMessage(messageId: string): Promise<{ success: boolean; error?: string }> {
    await this.initialize();

    try {
      const job = await this.queue.getJob(messageId);

      if (!job) {
        return { success: false, error: 'Message not found in queue' };
      }

      // Move to waiting state and retry
      await job.retry();
      
      logger.info(`Message ${messageId} scheduled for immediate retry`);
      
      return { success: true };

    } catch (error) {
      logger.error(`Failed to retry message ${messageId}`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Get current queue status
   */
  public async getQueueStatus(): Promise<QueueStatus> {
    await this.initialize();

    const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
      this.queue.getPausedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused,
    };
  }

  /**
   * Get detailed job information
   */
  public async getJobDetails(jobId: string): Promise<Queue.Job<RetryJobData> | null> {
    await this.initialize();
    return this.queue.getJob(jobId);
  }

  /**
   * Get failed jobs
   */
  public async getFailedJobs(start: number = 0, end: number = 50): Promise<Queue.Job<RetryJobData>[]> {
    await this.initialize();
    return this.queue.getFailed(start, end);
  }

  /**
   * Clean up old jobs
   */
  public async cleanOldJobs(olderThan: number = 24 * 60 * 60 * 1000): Promise<void> {
    await this.initialize();

    try {
      await this.queue.clean(olderThan, 'completed');
      await this.queue.clean(olderThan, 'failed');
      
      logger.info(`Cleaned jobs older than ${olderThan}ms`);
    } catch (error) {
      logger.error('Failed to clean old jobs', error);
      throw error;
    }
  }

  /**
   * Pause the queue
   */
  public async pause(): Promise<void> {
    await this.initialize();
    await this.queue.pause();
    logger.info('Retry queue paused');
  }

  /**
   * Resume the queue
   */
  public async resume(): Promise<void> {
    await this.initialize();
    await this.queue.resume();
    logger.info('Retry queue resumed');
  }

  /**
   * Close the queue connection
   */
  public async close(): Promise<void> {
    await this.queue.close();
    logger.info('RetryService closed');
  }

  /**
   * Get retry statistics
   */
  public async getStats(): Promise<{
    totalJobs: number;
    successRate: number;
    averageAttempts: number;
  }> {
    await this.initialize();

    const [completed, failed] = await Promise.all([
      this.queue.getCompleted(),
      this.queue.getFailed(),
    ]);

    const totalJobs = completed.length + failed.length;
    const successRate = totalJobs > 0 ? (completed.length / totalJobs) * 100 : 0;
    
    const totalAttempts = [...completed, ...failed].reduce((sum, job) => {
      return sum + (job.attemptsMade || 0);
    }, 0);
    const averageAttempts = totalJobs > 0 ? totalAttempts / totalJobs : 0;

    return {
      totalJobs,
      successRate: Math.round(successRate * 100) / 100,
      averageAttempts: Math.round(averageAttempts * 100) / 100,
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Set up queue processors
   */
  private setupQueueProcessors(): void {
    this.queue.process(async (job: Queue.Job<RetryJobData>) => {
      const { messageId, message, webhookConfig, attempt, maxAttempts } = job.data;

      logger.info(`Processing retry job`, {
        messageId,
        sessionId: message.sessionId,
        attempt,
        maxAttempts,
      });

      // Check circuit breaker
      if (this.config.circuitBreaker.isOpen()) {
        logger.warn(`Circuit breaker is OPEN, delaying retry for ${messageId}`);
        throw new Error('Circuit breaker is OPEN');
      }

      try {
        // Attempt to send the message
        const result = await this.config.outboundService.sendToWebhook(
          webhookConfig,
          message,
          { skipQueue: true } // Prevent re-queueing
        );

        if (result.success) {
          logger.info(`Retry successful for message ${messageId}`);
          this.config.metricsService?.incrementCounter('n8n_retry_success');
          return { success: true, messageId };
        } else {
          throw new Error(result.error || 'Webhook returned unsuccessful response');
        }

      } catch (error) {
        logger.error(`Retry failed for message ${messageId}`, error);
        this.config.metricsService?.incrementCounter('n8n_retry_failed');
        
        // Re-throw to trigger Bull's retry mechanism
        throw error;
      }
    });
  }

  /**
   * Set up queue event handlers
   */
  private setupQueueEventHandlers(): void {
    // Job completed successfully
    this.queue.on('completed', (job: Queue.Job<RetryJobData>, _result: any) => {
      logger.info(`Retry job completed`, {
        jobId: job.id,
        messageId: job.data.messageId,
        attempts: job.attemptsMade,
      });
      this.config.metricsService?.incrementCounter('n8n_retry_job_completed');
    });

    // Job failed after all retries
    this.queue.on('failed', (job: Queue.Job<RetryJobData>, err: Error) => {
      logger.error(`Retry job failed permanently`, {
        jobId: job.id,
        messageId: job.data.messageId,
        attempts: job.attemptsMade,
        error: err.message,
      });
      this.config.metricsService?.incrementCounter('n8n_retry_job_failed_permanently');
      
      // Emit event for permanent failure handling
      this.handlePermanentFailure(job, err);
    });

    // Job progress
    this.queue.on('progress', (job: Queue.Job<RetryJobData>, progress: number) => {
      logger.debug(`Retry job progress`, {
        jobId: job.id,
        messageId: job.data.messageId,
        progress,
      });
    });

    // Job stalled
    this.queue.on('stalled', (job: Queue.Job<RetryJobData>) => {
      logger.warn(`Retry job stalled`, {
        jobId: job.id,
        messageId: job.data.messageId,
      });
      this.config.metricsService?.incrementCounter('n8n_retry_job_stalled');
    });

    // Queue error
    this.queue.on('error', (error: Error) => {
      logger.error('Queue error', error);
      this.config.metricsService?.incrementCounter('n8n_queue_error');
    });
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoffDelay(attempt: number): number {
    const { initialDelay, backoffMultiplier, maxDelay } = this.config;
    const delay = initialDelay! * Math.pow(backoffMultiplier!, attempt - 1);
    return Math.min(delay, maxDelay!);
  }

  /**
   * Get priority for message type
   */
  private getPriority(event: string): number {
    // Lower number = higher priority
    const priorities: Record<string, number> = {
      'handsoff.requested': 1,
      'handsoff.accepted': 1,
      'session.started': 2,
      'message.received': 3,
      'message.sent': 4,
      'user.typing': 5,
      'file.uploaded': 3,
      'session.ended': 5,
    };

    return priorities[event] || 3;
  }

  /**
   * Handle permanent failure (all retries exhausted)
   */
  private handlePermanentFailure(job: Queue.Job<RetryJobData>, error: Error): void {
    const { messageId, message } = job.data;

    // Log for analysis
    logger.error(`Permanent failure for message ${messageId}`, {
      sessionId: message.sessionId,
      tenantId: message.tenantId,
      event: message.event,
      attempts: job.attemptsMade,
      error: error.message,
    });

    // Could trigger:
    // - Alert to operations team
    // - Store in dead letter queue
    // - Trigger fallback response
    // - Update message status in database
  }
}

export default RetryService;
