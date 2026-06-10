/**
 * Lead capture — the single write path for Leads across all channels
 * (.scratch/plan-leads-all-channels.md, step 3).
 *
 * Replaces the old per-tool plain INSERT (no dedup, email-required, never
 * called → 0 leads ever). `upsertLead` is deterministic and identity-
 * polymorphic: it computes a per-identity `dedupe_key`, gates on the
 * `leadCapture` entitlement, and runs ONE `INSERT … ON CONFLICT` so a
 * returning contact updates their row instead of duplicating — Postgres-
 * enforced via the partial unique index, never the silent app-side upsert.
 *
 * Callers:
 *   - Hook 1 (channel inbound, source 'channel') — also checks the per-channel
 *     auto-capture toggle before calling.
 *   - Hook 2 (booking, source 'booking').
 *   - Hook 3 (widget capture_lead tool, source 'tool').
 */
import type { DataSource } from 'typeorm';
import { ChatSession } from '../database/entities/ChatSession';
import type { LeadSource } from '../database/entities/Lead';
import { getEntitlements } from '../billing/entitlements';
import { emitWebhookEvent, buildEventBase } from '../webhooks/webhook.emitter';
import type { LeadCreatedEvent } from '../webhooks/webhook.types';
import { notificationService } from '../services/notification.service';
import { logger } from '../utils/logger';

/** Strongest-signal-wins ranking for source on an upsert conflict (D8). */
const SOURCE_RANK: Record<string, number> = {
  channel: 0,
  tool: 1,
  booking: 2,
  manual: 3,
  import: 3,
  webhook: 1,
};

export interface UpsertLeadInput {
  dataSource: DataSource;
  tenantId: string;
  sessionId?: string | null;
  botId?: string | null;
  source: LeadSource;
  /** Channel of origin; omit/undefined for the widget. */
  channel?: string | null;
  /** Channel-side durable handle (wa_id / PSID / telegram id). */
  externalUserId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface UpsertLeadResult {
  leadId: string;
  inserted: boolean;
}

/** Lowercase + trim; empty → null. */
function normalizeEmail(email?: string | null): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e || null;
}

/** Digits only (drop +, spaces, dashes) so wa_id and +32 475… collapse (D11). */
function normalizePhone(phone?: string | null): string | null {
  const p = (phone ?? '').replace(/[^0-9]/g, '');
  return p || null;
}

/**
 * Per-identity dedup key (D2 precedence): channel identity first, then email,
 * then phone. Returns null when no identifier resolves (→ no lead).
 */
function computeDedupeKey(input: {
  channel?: string | null;
  externalUserId?: string | null;
  email: string | null;
  phone: string | null;
}): string | null {
  if (input.channel && input.channel !== 'widget' && input.externalUserId) {
    return `${input.channel}:${input.externalUserId}`;
  }
  if (input.email) return `email:${input.email}`;
  if (input.phone) return `phone:${input.phone}`;
  return null;
}

/**
 * Upsert a Lead from whatever identity the conversation provided. Returns
 * `null` when capture is gated off (entitlement) or there is no identifier to
 * key on — both are no-ops, never an error.
 */
export async function upsertLead(input: UpsertLeadInput): Promise<UpsertLeadResult | null> {
  const email = normalizeEmail(input.email);
  // WhatsApp's externalUserId IS the phone — surface it as a real phone too.
  const rawPhone = input.phone ?? (input.channel === 'whatsapp' ? input.externalUserId : null);
  const phone = normalizePhone(rawPhone);
  const name = input.name?.trim() || null;

  const dedupeKey = computeDedupeKey({
    channel: input.channel,
    externalUserId: input.externalUserId,
    email,
    phone,
  });
  if (!dedupeKey) {
    // No durable identifier — nothing to capture (e.g. anonymous widget chat
    // that never shared contact info). Not an error.
    return null;
  }

  // D6: auto-capture sits under the leadCapture entitlement. Fail closed.
  try {
    if (!(await getEntitlements(input.tenantId)).features.leadCapture) return null;
  } catch (error) {
    logger.warn('[leads] entitlement resolution failed — skipping capture', {
      tenantId: input.tenantId,
      error,
    });
    return null;
  }

  const channel = input.channel ?? null;
  const externalUserId = input.externalUserId ?? null;
  const newRank = SOURCE_RANK[input.source] ?? 1;

  try {
    // Single statement: insert, or update-in-place on the existing identity.
    // Fill-not-overwrite (COALESCE) so a later null never blanks a known
    // name/email/phone; source upgrades toward the stronger signal (D8).
    // A soft-deleted same-key row is invisible to the partial index → a fresh
    // lead is created (re-engaging an archived contact). xmax=0 ⇒ inserted.
    const rows: Array<{ id: string; inserted: boolean }> = await input.dataSource.query(
      `
      INSERT INTO chatbot_leads
        (tenant_id, session_id, bot_id, name, email, phone, channel, external_user_id, dedupe_key, source, status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', '{}'::jsonb)
      ON CONFLICT (tenant_id, dedupe_key) WHERE deleted_at IS NULL
      DO UPDATE SET
        name  = COALESCE(chatbot_leads.name, EXCLUDED.name),
        email = COALESCE(chatbot_leads.email, EXCLUDED.email),
        phone = COALESCE(chatbot_leads.phone, EXCLUDED.phone),
        bot_id = COALESCE(chatbot_leads.bot_id, EXCLUDED.bot_id),
        session_id = COALESCE(EXCLUDED.session_id, chatbot_leads.session_id),
        source = CASE
          WHEN $11 > (CASE chatbot_leads.source
                        WHEN 'channel' THEN 0 WHEN 'tool' THEN 1 WHEN 'booking' THEN 2
                        WHEN 'manual' THEN 3 WHEN 'import' THEN 3 WHEN 'webhook' THEN 1 ELSE 1 END)
          THEN EXCLUDED.source ELSE chatbot_leads.source END,
        updated_at = now()
      RETURNING id, (xmax = 0) AS inserted
      `,
      [
        input.tenantId,
        input.sessionId ?? null,
        input.botId ?? null,
        name,
        email,
        phone,
        channel,
        externalUserId,
        dedupeKey,
        input.source,
        newRank,
      ],
    );

    const row = rows[0];
    if (!row) return null;

    if (row.inserted) {
      logger.info('[leads] captured', { tenantId: input.tenantId, leadId: row.id, channel, source: input.source });
      // Real-time fan-out only on a genuinely NEW lead — never on a re-touch.
      void emitLeadCreated(input, { leadId: row.id, name, email, phone }).catch(() => {});
    } else {
      logger.debug('[leads] updated', { tenantId: input.tenantId, leadId: row.id, source: input.source });
    }

    return { leadId: row.id, inserted: row.inserted };
  } catch (error) {
    // D10: never a silent zero again — a broken capture path is loud.
    logger.error('[leads] upsert failed', {
      tenantId: input.tenantId,
      channel,
      source: input.source,
      dedupeKeyKind: dedupeKey.split(':')[0],
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Outbound webhook + operator notification for a newly created lead. */
async function emitLeadCreated(
  input: UpsertLeadInput,
  lead: { leadId: string; name: string | null; email: string | null; phone: string | null },
): Promise<void> {
  let session: ChatSession | null = null;
  if (input.sessionId) {
    session = await input.dataSource
      .getRepository(ChatSession)
      .findOne({ where: { id: input.sessionId } })
      .catch(() => null);
  }

  const base = buildEventBase('lead.created', input.tenantId, {
    id: input.sessionId ?? lead.leadId,
    channel: session?.channel ?? input.channel ?? 'widget',
    visitorId: session?.visitorId ?? input.externalUserId ?? 'unknown',
    startedAt: session?.startedAt?.toISOString() ?? new Date().toISOString(),
    messageCount: session?.messageCount ?? 0,
    tags: session?.tags,
  });

  // Map onto the existing webhook contract (booking | chat | tool) — a
  // channel/manual/etc. auto-capture during a conversation is 'chat'. Keeps
  // the public n8n payload stable rather than leaking new source values.
  const webhookSource: LeadCreatedEvent['lead']['source'] =
    input.source === 'booking' ? 'booking' : input.source === 'tool' ? 'tool' : 'chat';

  const event: LeadCreatedEvent = {
    ...base,
    type: 'lead.created',
    lead: {
      name: lead.name ?? '',
      email: lead.email ?? '',
      ...(lead.phone ? { phone: lead.phone } : {}),
      source: webhookSource,
    },
  };
  emitWebhookEvent(event);

  await notificationService
    .createForTenant({
      tenantId: input.tenantId,
      type: 'lead_created',
      title: 'New lead captured',
      message: lead.name || lead.email || lead.phone || 'New contact',
      data: { leadId: lead.leadId, sessionId: input.sessionId ?? null },
      dedupeBase: `lead:${lead.leadId}`,
    })
    .catch(() => {});
}
