import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../../config/environment';
import { logger } from '../../utils/logger';
import { resolveMetaConnection } from './connection-resolver';
import { normalizeMetaPayload } from './event-normalizer';
import { processInboundEvent } from '../inbound-pipeline';
import { AppDataSource } from '../../database/data-source';
import { WebhookEventLog } from '../../database/entities/WebhookEventLog';
import { getChannelInboundQueue } from '../inbound-queue.processor';

const router = Router();

/**
 * GET /api/v1/channels/meta/webhook
 * Meta webhook verification challenge.
 */
router.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string | undefined;
  const token = req.query['hub.verify_token'] as string | undefined;
  const challenge = req.query['hub.challenge'] as string | undefined;

  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    logger.info('[meta-webhook] Verification challenge accepted');
    return res.status(200).send(challenge);
  }

  logger.warn('[meta-webhook] Verification challenge failed', { mode, token });
  return res.status(403).send('Forbidden');
});

/**
 * POST /api/v1/channels/meta/webhook
 * Meta webhook ingress — raw body for HMAC verification.
 */
router.post('/', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;

  // 1. Verify HMAC signature
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (!signature || !config.meta.appSecret) {
    logger.warn('[meta-webhook] Missing signature or app secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', config.meta.appSecret)
    .update(rawBody)
    .digest('hex');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    logger.warn('[meta-webhook] Invalid HMAC signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Parse JSON from raw body
  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // 3. Normalize and dispatch events
  const normalizedEvents = normalizeMetaPayload(payload);

  const eventLogRepo = AppDataSource.getRepository(WebhookEventLog);
  const queue = getChannelInboundQueue();

  for (const { event, recipientId, channel } of normalizedEvents) {
    try {
      // Resolve connection by recipient ID + channel
      const connection = await resolveMetaConnection(recipientId, channel);
      if (!connection) continue;

      // Persist event for idempotency
      const logEntry = eventLogRepo.create({
        channelConnectionId: connection.id,
        channel: connection.channel,
        dedupeKey: event.dedupeKey,
        eventType: event.rawEventType,
        rawPayload: payload,
        status: 'received',
      });
      await eventLogRepo.save(logEntry);

      // Queue or process inline
      if (queue) {
        await queue.add('channel-inbound', {
          eventDedupeKey: event.dedupeKey,
          connectionId: connection.id,
          event,
        }, {
          jobId: event.dedupeKey,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        });
      } else {
        await processInboundEvent(event, connection);
      }
    } catch (error: any) {
      if (error?.code === '23505') continue; // Duplicate dedupe key
      logger.error(`[meta-webhook] Error processing ${channel} event:`, error);
    }
  }

  // 4. Return 200 fast
  return res.status(200).json({ ok: true });
});

export default router;
