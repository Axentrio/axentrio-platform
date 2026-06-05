/**
 * Message Queue System
 * Bull-based queue with Redis backend
 */

import Bull, { Job, Queue, JobOptions } from 'bull';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { IMessageProcessJob, IWebhookJob } from '../types';

// Queue instances
let messageQueue: Queue | null = null;
let webhookQueue: Queue | null = null;
let notificationQueue: Queue | null = null;
let fileQueue: Queue | null = null;
let knowledgeQueue: Queue | null = null;
let bookingReminderQueue: Queue | null = null;
let deadLetterQueue: Queue | null = null;

// Fallback flag: when true, jobs are processed synchronously (no Redis)
let syncFallback = false;

// Job processors registry
const jobProcessors = new Map<string, (job: Job) => Promise<void>>();

export function isQueueSyncFallback(): boolean {
  return syncFallback;
}

/**
 * Create queue options
 */
const createQueueOptions = (_queueName: string): Bull.QueueOptions => {
  const redisOpts: Bull.QueueOptions['redis'] = config.redis.url
    ? config.redis.url
    : {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password || undefined,
        db: config.redis.db,
      };

  return {
    prefix: config.queue.prefix,
    defaultJobOptions: {
      attempts: config.queue.maxAttempts,
      backoff: {
        type: 'exponential',
        delay: config.queue.backoffDelay,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
    redis: redisOpts,
    settings: {
      lockDuration: 30000,
      stalledInterval: 30000,
      maxStalledCount: 2,
      guardInterval: 5000,
    },
  };
};

/**
 * Initialize all queues
 */
export const initializeQueues = async (): Promise<void> => {
  try {
    // Message processing queue
    messageQueue = new Bull('message-processing', createQueueOptions('message-processing'));

    // Webhook queue
    webhookQueue = new Bull('webhook-delivery', createQueueOptions('webhook-delivery'));

    // Notification queue
    notificationQueue = new Bull('notifications', createQueueOptions('notifications'));

    // File processing queue
    fileQueue = new Bull('file-processing', createQueueOptions('file-processing'));

    // Knowledge processing queue
    knowledgeQueue = new Bull('knowledge-processing', createQueueOptions('knowledge-processing'));

    bookingReminderQueue = new Bull('booking-reminders', createQueueOptions('booking-reminders'));

    // Dead letter queue for failed jobs
    deadLetterQueue = new Bull('dead-letter', createQueueOptions('dead-letter'));

    // Set up event handlers for all queues
    [messageQueue, webhookQueue, notificationQueue, fileQueue, knowledgeQueue, deadLetterQueue].forEach(
      (queue) => {
        if (!queue) return;

        queue.on('completed', (job: Job) => {
          logger.info(`Job completed`, {
            queue: queue.name,
            jobId: job.id,
            type: job.data.type,
          });
        });

        queue.on('failed', (job: Job, err: Error) => {
          logger.error(`Job failed`, {
            queue: queue.name,
            jobId: job.id,
            type: job.data.type,
            error: err.message,
            attempts: job.attemptsMade,
          });

          // Move to dead letter queue after max attempts
          if (job.attemptsMade >= (job.opts.attempts || config.queue.maxAttempts)) {
            moveToDeadLetter(job, err);
          }
        });

        queue.on('stalled', (job: Job) => {
          logger.warn(`Job stalled`, {
            queue: queue.name,
            jobId: job.id,
            type: job.data.type,
          });
        });

        queue.on('progress', (job: Job, progress: number) => {
          logger.debug(`Job progress`, {
            queue: queue.name,
            jobId: job.id,
            progress,
          });
        });
      }
    );

    logger.info('Message queues initialized successfully');
  } catch (error) {
    logger.warn('Failed to initialize queues — falling back to sync processing', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    syncFallback = true;
    // Clean up any partially created queues
    messageQueue = null;
    webhookQueue = null;
    notificationQueue = null;
    fileQueue = null;
    knowledgeQueue = null;
    bookingReminderQueue = null;
    deadLetterQueue = null;
  }
};

/**
 * Move failed job to dead letter queue
 */
const moveToDeadLetter = async (job: Job, error: Error): Promise<void> => {
  try {
    if (!deadLetterQueue) return;

    await deadLetterQueue.add(
      {
        originalQueue: job.queue.name,
        originalJobId: job.id,
        type: job.data.type,
        data: job.data,
        failedAt: new Date(),
        error: {
          message: error.message,
          stack: error.stack,
        },
        attempts: job.attemptsMade,
      },
      {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    logger.info('Job moved to dead letter queue', {
      originalQueue: job.queue.name,
      jobId: job.id,
    });
  } catch (err) {
    logger.error('Failed to move job to dead letter queue', {
      jobId: job.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
};

/**
 * Add job to message queue
 */
export const addMessageJob = async (
  data: IMessageProcessJob,
  options?: JobOptions
): Promise<Job> => {
  if (!messageQueue) {
    throw new Error('Message queue not initialized');
  }

  return messageQueue.add(
    {
      ...data,
      type: 'message_process' as const,
    },
    {
      priority: 1,
      ...options,
    }
  );
};

/**
 * Add job to webhook queue
 */
export const addWebhookJob = async (
  data: IWebhookJob,
  options?: JobOptions
): Promise<Job> => {
  if (!webhookQueue) {
    throw new Error('Webhook queue not initialized');
  }

  return webhookQueue.add(
    {
      type: 'webhook_send',
      ...data,
    },
    {
      priority: 2,
      delay: 1000, // Slight delay for batching
      ...options,
    }
  );
};

/**
 * Add job to notification queue
 */
export const addNotificationJob = async (
  data: Record<string, unknown>,
  options?: JobOptions
): Promise<Job> => {
  if (!notificationQueue) {
    throw new Error('Notification queue not initialized');
  }

  return notificationQueue.add(
    {
      type: 'notification_send',
      ...data,
    },
    {
      priority: 3,
      ...options,
    }
  );
};

/**
 * Add job to file processing queue
 */
export const addFileJob = async (
  data: Record<string, unknown>,
  options?: JobOptions
): Promise<Job> => {
  if (!fileQueue) {
    throw new Error('File queue not initialized');
  }

  return fileQueue.add(
    {
      type: 'file_process',
      ...data,
    },
    {
      priority: 2,
      ...options,
    }
  );
};

/**
 * Add job to any named queue
 */
export async function addJob(
  queueName: string,
  data: any,
  options?: { jobId?: string; delay?: number; attempts?: number }
): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue) throw new Error(`Queue ${queueName} not available`);
  await queue.add(data, {
    jobId: options?.jobId,
    attempts: options?.attempts ?? 3,
    backoff: { type: 'exponential', delay: 1000 },
    ...(options?.delay != null ? { delay: options.delay } : {}),
  });
}

/** Remove a queued job by id (best-effort; no-op if missing). */
export async function removeJob(queueName: string, jobId: string): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue) return;
  try {
    const job = await queue.getJob(jobId);
    if (job) await job.remove();
  } catch (err) {
    logger.warn('[Queue] removeJob failed', { queueName, jobId, error: err });
  }
}

/**
 * Register job processor
 */
export const registerProcessor = (
  queueName: string,
  processor: (job: Job) => Promise<void>
): void => {
  jobProcessors.set(queueName, processor);

  let queue: Queue | null = null;
  switch (queueName) {
    case 'message-processing':
      queue = messageQueue;
      break;
    case 'webhook-delivery':
      queue = webhookQueue;
      break;
    case 'notifications':
      queue = notificationQueue;
      break;
    case 'file-processing':
      queue = fileQueue;
      break;
    case 'knowledge-processing':
      queue = knowledgeQueue;
      break;
    case 'booking-reminders':
      queue = bookingReminderQueue;
      break;
  }

  if (queue) {
    queue.process(config.queue.concurrency, async (job: Job) => {
      const jobLogger = logger.child({
        jobId: job.id,
        queue: queueName,
        type: job.data.type,
      });

      jobLogger.info('Processing job');

      try {
        await processor(job);
        jobLogger.info('Job processed successfully');
      } catch (error) {
        jobLogger.error('Job processing failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    });

    logger.info(`Processor registered for queue: ${queueName}`);
  }
};

/**
 * Get queue by name
 */
export const getQueue = (queueName: string): Queue | null => {
  switch (queueName) {
    case 'message-processing':
      return messageQueue;
    case 'webhook-delivery':
      return webhookQueue;
    case 'notifications':
      return notificationQueue;
    case 'file-processing':
      return fileQueue;
    case 'knowledge-processing':
      return knowledgeQueue;
    case 'booking-reminders':
      return bookingReminderQueue;
    case 'dead-letter':
      return deadLetterQueue;
    default:
      return null;
  }
};

/**
 * Get queue metrics
 */
export const getQueueMetrics = async (queueName: string): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> => {
  const queue = getQueue(queueName);
  if (!queue) {
    throw new Error(`Queue not found: ${queueName}`);
  }

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
  };
};

/**
 * Clean completed jobs from queue
 */
export const cleanCompletedJobs = async (
  queueName: string,
  gracePeriodMs: number = 24 * 60 * 60 * 1000
): Promise<void> => {
  const queue = getQueue(queueName);
  if (!queue) {
    throw new Error(`Queue not found: ${queueName}`);
  }

  await queue.clean(gracePeriodMs, 'completed');
  logger.info(`Cleaned completed jobs from queue: ${queueName}`);
};

/**
 * Retry failed job
 */
export const retryFailedJob = async (
  queueName: string,
  jobId: string
): Promise<void> => {
  const queue = getQueue(queueName);
  if (!queue) {
    throw new Error(`Queue not found: ${queueName}`);
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  await job.retry();
  logger.info(`Retried job: ${jobId}`);
};

/**
 * Pause queue
 */
export const pauseQueue = async (queueName: string): Promise<void> => {
  const queue = getQueue(queueName);
  if (!queue) {
    throw new Error(`Queue not found: ${queueName}`);
  }

  await queue.pause();
  logger.info(`Paused queue: ${queueName}`);
};

/**
 * Resume queue
 */
export const resumeQueue = async (queueName: string): Promise<void> => {
  const queue = getQueue(queueName);
  if (!queue) {
    throw new Error(`Queue not found: ${queueName}`);
  }

  await queue.resume();
  logger.info(`Resumed queue: ${queueName}`);
};

/**
 * Close all queues
 */
export const closeQueues = async (): Promise<void> => {
  const queues = [messageQueue, webhookQueue, notificationQueue, fileQueue, knowledgeQueue, bookingReminderQueue, deadLetterQueue];

  await Promise.all(
    queues.map(async (queue) => {
      if (queue) {
        await queue.close();
      }
    })
  );

  logger.info('All queues closed');
};

export default {
  initializeQueues,
  addMessageJob,
  addWebhookJob,
  addNotificationJob,
  addFileJob,
  addJob,
  registerProcessor,
  getQueue,
  getQueueMetrics,
  cleanCompletedJobs,
  retryFailedJob,
  pauseQueue,
  resumeQueue,
  closeQueues,
};
