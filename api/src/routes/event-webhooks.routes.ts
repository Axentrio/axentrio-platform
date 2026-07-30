/**
 * Tenant-managed outbound event webhooks — mounted at /tenants/me/event-webhooks.
 *
 * This closes a real hole rather than adding a feature: `tenant.settings.eventWebhooks`
 * was READ by the emitter (`webhook.emitter.ts`) but written NOWHERE in api/ or
 * portal/. The Leads upsell copy already promises "send leads to your CRM", and there
 * was no way for any tenant to configure that. Everything downstream — dispatcher,
 * retry, circuit breaker, delivery log, signing — already existed and was unreachable.
 *
 * Together with `lead.updated` / `lead.deleted`, a tenant can now point Zapier / Make /
 * n8n at these events and reach HubSpot, Salesforce, Odoo, Zoho or Pipedrive today,
 * with erasure propagating. It is honestly "send your leads to your CRM", not
 * bidirectional sync.
 *
 * Security posture:
 *   - admin only (this configures egress of customer personal data)
 *   - `crm` entitlement gated — the Enterprise flag finally has a consumer
 *   - every URL passes `assertSafeOutboundUrl` (https-only, no private/link-local
 *     targets) at WRITE time, so an SSRF target is rejected when it is set rather
 *     than only when it is delivered to
 *   - secrets are never returned; the GET reports `hasSecret` instead
 *   - writes are audited
 */
import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { requireFeature } from '../billing/enforce';
import { assertSafeOutboundUrl, SsrfError } from '../security/ssrf-guard';
import { logAudit } from '../utils/audit';
import type { EventWebhookConfig, WebhookEventType } from '../webhooks/webhook.types';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/** Closed set — an unknown event name would silently never fire. */
const SUBSCRIBABLE_EVENTS: readonly WebhookEventType[] = [
  'lead.created',
  'lead.updated',
  'lead.deleted',
  'appointment.booked',
  'booking.request_created',
  'conversation.ended',
];

const MAX_ENDPOINTS = 5;

/** Redacted view. The secret is write-only — it is never echoed back. */
function toPublic(cfg: EventWebhookConfig) {
  return {
    url: cfg.url,
    events: cfg.events,
    enabled: cfg.enabled,
    hasSecret: typeof cfg.secret === 'string' && cfg.secret.length > 0,
  };
}

function readConfigs(tenant: Tenant): EventWebhookConfig[] {
  const raw = (tenant.settings as { eventWebhooks?: unknown } | null)?.eventWebhooks;
  // Tolerate hand-edited/legacy jsonb drift: a malformed blob degrades to "no
  // webhooks" rather than throwing on every event emission.
  return Array.isArray(raw) ? (raw as EventWebhookConfig[]) : [];
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'crm', 'plan_limit_crm');

    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    sendSuccess(res, {
      webhooks: readConfigs(tenant).map(toPublic),
      subscribableEvents: SUBSCRIBABLE_EVENTS,
      maxEndpoints: MAX_ENDPOINTS,
    });
  }),
);

/**
 * PUT replaces the whole list (same semantics as the feature-toggles route).
 *
 * Body: `{ webhooks: [{ url, events, enabled?, secret? }] }`
 *
 * `secret` is optional per endpoint: omit it on an existing URL to KEEP the stored
 * secret (the GET never returns it, so a round-trip would otherwise blank it), or
 * pass one to rotate. A brand-new endpoint with no secret gets a generated one so an
 * unsigned endpoint cannot be created by omission.
 */
router.put(
  '/',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'crm', 'plan_limit_crm');

    const body = req.body as { webhooks?: unknown };
    if (!body || !Array.isArray(body.webhooks)) {
      throw new ValidationError('Body must be { webhooks: [...] }');
    }
    if (body.webhooks.length > MAX_ENDPOINTS) {
      throw new ValidationError(`At most ${MAX_ENDPOINTS} webhook endpoints`);
    }

    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');
    const existing = readConfigs(tenant);

    const next: EventWebhookConfig[] = [];
    const seen = new Set<string>();
    for (const raw of body.webhooks) {
      const entry = raw as Partial<EventWebhookConfig>;
      if (typeof entry.url !== 'string' || !entry.url) throw new ValidationError('Each webhook needs a url');

      // Validate at WRITE time so a bad target is rejected here, not silently
      // failing on every delivery attempt later.
      try {
        assertSafeOutboundUrl(entry.url);
      } catch (err) {
        throw new ValidationError(
          err instanceof SsrfError ? err.message : 'Webhook URL is not allowed',
        );
      }
      if (seen.has(entry.url)) throw new ValidationError('Duplicate webhook URL');
      seen.add(entry.url);

      if (!Array.isArray(entry.events) || entry.events.length === 0) {
        throw new ValidationError('Each webhook needs at least one event');
      }
      for (const ev of entry.events) {
        if (!SUBSCRIBABLE_EVENTS.includes(ev as WebhookEventType)) {
          throw new ValidationError(`Unknown event "${String(ev)}"`);
        }
      }

      const prior = existing.find((e) => e.url === entry.url);
      const secret =
        typeof entry.secret === 'string' && entry.secret.length > 0
          ? entry.secret
          : prior?.secret || randomBytes(32).toString('hex');

      next.push({
        url: entry.url,
        events: entry.events as WebhookEventType[],
        enabled: entry.enabled !== false,
        secret,
      });
    }

    // Targeted jsonb write: merge only our own key so a concurrent settings writer
    // elsewhere cannot be clobbered by a whole-blob read-modify-write.
    await AppDataSource.query(
      `UPDATE tenants
          SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('eventWebhooks', $2::jsonb),
              updated_at = now()
        WHERE id = $1`,
      [tenantId, JSON.stringify(next)],
    );

    // Audit the CONFIG, never the secrets.
    await logAudit(req.userId!, 'tenant.event_webhooks_updated', 'tenant', tenantId, tenantId, {
      endpoints: next.map((w) => ({ url: w.url, events: w.events, enabled: w.enabled })),
    });

    sendSuccess(res, { webhooks: next.map(toPublic) });
  }),
);

export default router;
