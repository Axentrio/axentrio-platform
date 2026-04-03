import { createHmac } from 'crypto';
import { logger } from '../utils/logger';
import type { EventWebhookConfig, WebhookEvent } from './webhook.types';

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;

function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverWebhook(
  config: EventWebhookConfig,
  event: WebhookEvent
): Promise<void> {
  const body = JSON.stringify(event);
  const signature = signPayload(config.secret, body);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': `sha256=${signature}`,
            'X-Webhook-Event': event.type,
            'X-Webhook-Id': event.id,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        logger.info('Webhook delivered', { url: config.url, eventId: event.id, status: response.status });
        return;
      }

      // Don't retry on 4xx client errors
      if (response.status >= 400 && response.status < 500) {
        logger.warn('Webhook rejected by server (4xx), not retrying', {
          url: config.url,
          eventId: event.id,
          status: response.status,
        });
        return;
      }

      logger.warn('Webhook delivery failed (5xx), will retry', {
        url: config.url,
        eventId: event.id,
        status: response.status,
        attempt: attempt + 1,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      logger.warn('Webhook delivery error, will retry', {
        url: config.url,
        eventId: event.id,
        attempt: attempt + 1,
        error: isAbort ? 'timeout' : (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  logger.error('Webhook delivery exhausted all retries', { url: config.url, eventId: event.id });
}
