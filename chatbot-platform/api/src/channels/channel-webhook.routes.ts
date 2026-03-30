import { Router, Request, Response } from 'express';
import { getRepository } from '../database/data-source';
import { WebhookEventLog } from '../database/entities/WebhookEventLog';
import { getChannelAdapter } from './channel-registry';
import { ChannelType } from '../database/entities/ChannelConnection';
import { processInboundEvent } from './inbound-pipeline';
import { getChannelInboundQueue } from './inbound-queue.processor';

const router = Router();

router.all('/channels/:channel/webhook', async (req: Request, res: Response) => {
  const channel = req.params.channel as ChannelType;
  const adapter = getChannelAdapter(channel);

  if (!adapter) {
    return res.status(404).json({ error: `Channel ${channel} not supported` });
  }

  // Handle GET verification challenges (Meta requires this)
  if (req.method === 'GET') {
    try {
      const connection = await adapter.connectionResolver.resolve(req);
      if (!connection) {
        return res.status(404).json({ error: 'No matching channel connection' });
      }
      const challenge = adapter.webhookVerifier.handleVerificationChallenge(req, connection);
      if (challenge !== null) {
        return res.status(200).send(challenge);
      }
    } catch {
      // Fall through
    }
    return res.status(400).json({ error: 'Invalid verification request' });
  }

  // Resolve which tenant/connection this webhook belongs to
  const connection = await adapter.connectionResolver.resolve(req);
  if (!connection) {
    return res.status(404).json({ error: 'No matching channel connection' });
  }

  // Verify webhook signature
  if (!adapter.webhookVerifier.verifySignature(req, connection)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Normalize into events
  const events = adapter.eventNormalizer.normalize(req.body, connection);
  if (events.length === 0) {
    return res.status(200).json({ ok: true });
  }

  // Persist raw events for idempotency, then process
  const eventLogRepo = getRepository(WebhookEventLog);

  for (const event of events) {
    try {
      const logEntry = eventLogRepo.create({
        channelConnectionId: connection.id,
        channel: connection.channel,
        dedupeKey: event.dedupeKey,
        eventType: event.rawEventType,
        rawPayload: req.body,
        status: 'received',
      });
      await eventLogRepo.save(logEntry);

      // Try Bull queue first; fall back to inline processing if unavailable
      const queue = getChannelInboundQueue();
      if (queue) {
        await queue.add('channel-inbound', {
          eventDedupeKey: event.dedupeKey,
          connectionId: connection.id,
          event,
        }, {
          jobId: event.dedupeKey, // Idempotent by dedupe key
        });
      } else {
        await processInboundEvent(event, connection);
      }
    } catch (error: any) {
      if (error?.code === '23505') continue; // Duplicate dedupe key
      console.error(`[channel-webhook] Error processing ${channel} event:`, error);
    }
  }

  return res.status(200).json({ ok: true });
});

export default router;
