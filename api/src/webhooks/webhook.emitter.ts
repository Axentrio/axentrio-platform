import { randomUUID } from 'crypto';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { logger } from '../utils/logger';
import { deliverWebhook } from './webhook.dispatcher';
import { getAutomationEngine } from '../automations';
import type { EventWebhookConfig, WebhookEvent, WebhookEventBase, WebhookEventType } from './webhook.types';

export function buildEventBase(
  type: WebhookEventType,
  tenantId: string,
  session: { id: string; channel: string; visitorId: string; startedAt: string; messageCount: number; tags?: string[] }
): WebhookEventBase {
  return {
    id: randomUUID(),
    type,
    tenantId,
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    session: {
      channel: session.channel,
      visitorId: session.visitorId,
      startedAt: session.startedAt,
      messageCount: session.messageCount,
      tags: session.tags,
    },
  };
}

export function emitWebhookEvent(event: WebhookEvent): void {
  // Fire-and-forget — never awaited by caller
  void (async () => {
    try {
      const tenantRepo = AppDataSource.getRepository(Tenant);
      const tenant = await tenantRepo.findOne({ where: { id: event.tenantId } });

      if (!tenant) {
        logger.warn('emitWebhookEvent: tenant not found', { tenantId: event.tenantId });
        return;
      }

      const webhooks: EventWebhookConfig[] = (tenant.settings as any)?.eventWebhooks ?? [];

      const matching = webhooks.filter(
        (cfg) => cfg.enabled && cfg.events.includes(event.type)
      );

      if (matching.length > 0) {
        await Promise.allSettled(matching.map((cfg) => deliverWebhook(cfg, event)));
      }

      const engine = getAutomationEngine();
      if (engine) {
        engine.process(event, tenant).catch((err) => {
          logger.error('AutomationEngine.process failed', {
            tenantId: event.tenantId,
            eventId: event.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      logger.error('emitWebhookEvent: unexpected error', {
        tenantId: event.tenantId,
        eventId: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
