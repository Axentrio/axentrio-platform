/**
 * Inbound Queue Processor
 * Bull queue processor for channel inbound events.
 * Provides reliable, retryable processing of webhook events with
 * fallback to inline processing when Redis is unavailable.
 */

import Queue from 'bull';
import { AppDataSource } from '../database/data-source';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { processInboundEvent } from './inbound-pipeline';
import { NormalizedEvent } from './types';
import { logger } from '../utils/logger';

let channelInboundQueue: Queue.Queue | null = null;

interface InboundJobData {
  eventDedupeKey: string;
  connectionId: string;
  event: NormalizedEvent;
}

export function initializeChannelInboundQueue(redisUrl: string): Queue.Queue {
  channelInboundQueue = new Queue<InboundJobData>('channel-inbound', {
    redis: redisUrl,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  channelInboundQueue.process('channel-inbound', 5, async (job) => {
    const { connectionId, event } = job.data;

    const connectionRepo = AppDataSource.getRepository(ChannelConnection);
    const connection = await connectionRepo.findOne({ where: { id: connectionId } });

    if (!connection) {
      logger.error(`[channel-inbound] Connection ${connectionId} not found, skipping`);
      return;
    }

    const normalizedEvent: NormalizedEvent = {
      ...event,
      timestamp: new Date(event.timestamp),
    };

    await processInboundEvent(normalizedEvent, connection);
  });

  channelInboundQueue.on('failed', (job, err) => {
    logger.error(`[channel-inbound] Job ${job.id} failed: ${err.message}`);
  });

  channelInboundQueue.on('stalled', (jobId) => {
    logger.warn(`[channel-inbound] Job ${jobId} stalled`);
  });

  logger.info('[channel-inbound] Queue processor initialized');
  return channelInboundQueue;
}

export function getChannelInboundQueue(): Queue.Queue | null {
  return channelInboundQueue;
}
