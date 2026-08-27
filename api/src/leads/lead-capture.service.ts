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
import type {
  LeadCreatedEvent,
  LeadUpdatedEvent,
  LeadDeletedEvent,
  LeadEventPayload,
} from '../webhooks/webhook.types';
import { notificationService } from '../services/notification.service';
import { isErasedDedupeKey } from './lead-tombstone';
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
  /** Free-text summary of what the visitor needs — the request/issue plus any
   *  address or specifics. Persisted to chatbot_leads.notes so the operator
   *  sees WHY the contact wants to be reached, not just their number. */
  notes?: string | null;
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
  // `erased:` is the erasure tombstone namespace (lead-erasure.service.ts). A
  // caller must never be able to mint a key inside it — a crafted external id of
  // `erased:<someLeadId>` would otherwise target another lead's tombstone row.
  if (isErasedDedupeKey(input.externalUserId)) return null;
  if (input.channel && input.channel !== 'widget' && input.externalUserId) {
    return `${input.channel}:${input.externalUserId}`;
  }
  if (input.email) return `email:${input.email}`;
  if (input.phone) return `phone:${input.phone}`;
  return null;
}

/**
 * Link a lead to a conversation. Deliberately narrow: it INSERTs the association
 * row and does nothing else — no webhook, no notification, no lead-field write.
 *
 * Why it is separate from `upsertLead`'s fan-out rather than folded into it:
 * `upsertLead`'s side effects are guarded on "is this a brand-new CONTACT"
 * (`row.inserted`), but the association needs "is this a new CONVERSATION". Those
 * differ — a returning customer opening a second conversation is not a new contact.
 * Driving both from one guard means either the association is skipped for returning
 * customers (the original bug: `chatbot_leads.session_id` only ever points at the
 * LATEST session, so earlier conversations were unrecoverable) or the lead-created
 * webhook and operator alert re-fire on every reopened thread. Keeping the paths
 * apart makes it impossible for a later edit to widen the side-effect path by
 * accident.
 *
 * `ON CONFLICT DO NOTHING` against `UNIQUE (tenant_id, session_id)` makes it
 * idempotent and safe under concurrency. A session already linked to a DIFFERENT
 * lead is NOT silently reparented — the insert is dropped and the caller is told, so
 * the conflict can be audited rather than losing the original association.
 */
export async function associateLeadSession(input: {
  dataSource: DataSource;
  tenantId: string;
  leadId: string;
  sessionId: string;
  botId?: string | null;
  channel?: string | null;
}): Promise<{ created: boolean; conflictingLeadId: string | null }> {
  try {
    const rows: Array<{ id: string }> = await input.dataSource.query(
      `INSERT INTO chatbot_lead_conversations
         (tenant_id, lead_id, session_id, bot_id, channel, source, enrich_state)
       VALUES ($1, $2, $3, $4, $5, 'link', 'pending')
       ON CONFLICT (tenant_id, session_id) WHERE session_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [input.tenantId, input.leadId, input.sessionId, input.botId ?? null, input.channel ?? null],
    );
    if (rows.length > 0) return { created: true, conflictingLeadId: null };

    // Nothing inserted: either we already linked this session to THIS lead (normal,
    // idempotent) or it belongs to another lead (a real conflict worth surfacing).
    const existing: Array<{ lead_id: string }> = await input.dataSource.query(
      `SELECT lead_id FROM chatbot_lead_conversations WHERE tenant_id = $1 AND session_id = $2`,
      [input.tenantId, input.sessionId],
    );
    const owner = existing[0]?.lead_id ?? null;
    if (owner && owner !== input.leadId) {
      logger.warn('[leads] session already linked to a different lead — not reparenting', {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        existingLeadId: owner,
        attemptedLeadId: input.leadId,
      });
      return { created: false, conflictingLeadId: owner };
    }
    return { created: false, conflictingLeadId: null };
  } catch (error) {
    // Never block message processing or booking on the association. A missing link
    // degrades the detail view; a thrown error would drop a customer's message.
    logger.error('[leads] associate failed', {
      tenantId: input.tenantId,
      leadId: input.leadId,
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { created: false, conflictingLeadId: null };
  }
}

/**
 * The identity fields exactly as they are written. Kept together so the normalisation
 * the dedupe key sees and the normalisation the row stores cannot drift apart.
 */
function normalizeIdentity(input: UpsertLeadInput): {
  email: string | null;
  phone: string | null;
  name: string | null;
  notes: string | null;
} {
  const email = normalizeEmail(input.email);
  // WhatsApp's externalUserId IS the phone — surface it as a real phone too.
  const rawPhone = input.phone ?? (input.channel === 'whatsapp' ? input.externalUserId : null);
  return {
    email,
    phone: normalizePhone(rawPhone),
    name: input.name?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

/**
 * Post-write fan-out for one upserted row. A brand-new lead, a request landing on a
 * contact-only lead, and a plain re-touch are three different events to a consumer, so
 * the branch that fires here decides what the tenant actually receives.
 */
function notifyUpsert(
  input: UpsertLeadInput,
  row: { id: string; inserted: boolean; old_notes: string | null },
  lead: LeadEmitFields,
  channel: string | null,
): void {
  if (row.inserted) {
    logger.info('[leads] captured', { tenantId: input.tenantId, leadId: row.id, channel, source: input.source });
    // Full fan-out (webhook + email + notification) on a genuinely NEW lead.
    void emitLeadCreated(input, lead).catch(() => {});
    return;
  }

  if (lead.notes && !row.old_notes) {
    // Channel case: the request summary just landed on a lead the inbound hook
    // created earlier WITHOUT it (lead.created webhook/email already fired then,
    // contact-only). Re-notify the OPERATOR — once — with the request so the
    // channel alert is actionable, with a distinct dedupe key so the first
    // notification doesn't suppress it.
    //
    // We still do NOT re-fire `lead.created` (that would duplicate the
    // first-contact event), but we now DO emit `lead.updated`. Without it the
    // outbound payload was a lossy one-shot: it fired at first contact, before
    // the conversation had said what the customer actually wanted, so a CRM
    // received a bare phone number and never learned the request.
    logger.debug('[leads] request landed on existing lead', { tenantId: input.tenantId, leadId: row.id, source: input.source });
    void createLeadNotification(
      input,
      { leadId: row.id, name: lead.name, email: lead.email, phone: lead.phone },
      { dedupeSuffix: 'request' },
    ).catch(() => {});
    void emitLeadUpdated(input, lead, ['notes']).catch(() => {});
    return;
  }

  logger.debug('[leads] updated', { tenantId: input.tenantId, leadId: row.id, source: input.source });
}

/**
 * Upsert a Lead from whatever identity the conversation provided. Returns
 * `null` when capture is gated off (entitlement) or there is no identifier to
 * key on — both are no-ops, never an error.
 */
export async function upsertLead(input: UpsertLeadInput): Promise<UpsertLeadResult | null> {
  const { email, phone, name, notes } = normalizeIdentity(input);

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
    const rows: Array<{ id: string; inserted: boolean; old_notes: string | null }> = await input.dataSource.query(
      `
      WITH prior AS (
        SELECT notes AS old_notes FROM chatbot_leads
        WHERE tenant_id = $1 AND dedupe_key = $9 AND deleted_at IS NULL
      )
      INSERT INTO chatbot_leads
        (tenant_id, session_id, bot_id, name, email, phone, channel, external_user_id, dedupe_key, source, status, metadata, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', '{}'::jsonb, $12)
      ON CONFLICT (tenant_id, dedupe_key) WHERE deleted_at IS NULL
      DO UPDATE SET
        name  = COALESCE(chatbot_leads.name, EXCLUDED.name),
        email = COALESCE(chatbot_leads.email, EXCLUDED.email),
        phone = COALESCE(chatbot_leads.phone, EXCLUDED.phone),
        bot_id = COALESCE(chatbot_leads.bot_id, EXCLUDED.bot_id),
        session_id = COALESCE(EXCLUDED.session_id, chatbot_leads.session_id),
        -- notes prefers the NEW value (latest, usually fuller request) but a
        -- contact-only re-touch (null) never blanks an existing summary.
        notes = COALESCE(EXCLUDED.notes, chatbot_leads.notes),
        source = CASE
          WHEN $11 > (CASE chatbot_leads.source
                        WHEN 'channel' THEN 0 WHEN 'tool' THEN 1 WHEN 'booking' THEN 2
                        WHEN 'manual' THEN 3 WHEN 'import' THEN 3 WHEN 'webhook' THEN 1 ELSE 1 END)
          THEN EXCLUDED.source ELSE chatbot_leads.source END,
        updated_at = now()
      RETURNING id, (xmax = 0) AS inserted, (SELECT old_notes FROM prior) AS old_notes
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
        notes,
      ],
    );

    const row = rows[0];
    if (!row) return null;

    notifyUpsert(input, row, { leadId: row.id, dedupeKey, name, email, phone, notes }, channel);

    // Link this conversation to the lead — on EVERY capture, insert or update, and
    // independently of the fan-out above. This is what gives a returning customer a
    // per-conversation history instead of one row that silently describes only their
    // most recent chat. Idempotent, so calling it on a re-touch costs one no-op
    // insert. Awaited (not fire-and-forget) so a caller that immediately reads the
    // conversation list sees the link.
    if (input.sessionId) {
      await associateLeadSession({
        dataSource: input.dataSource,
        tenantId: input.tenantId,
        leadId: row.id,
        sessionId: input.sessionId,
        botId: input.botId ?? null,
        channel,
      });
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

interface LeadEmitFields {
  leadId: string;
  dedupeKey: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
}

/** Session context for the event envelope. Best-effort — never blocks the emit. */
async function loadEventSession(input: UpsertLeadInput): Promise<ChatSession | null> {
  if (!input.sessionId) return null;
  return input.dataSource
    .getRepository(ChatSession)
    .findOne({ where: { id: input.sessionId } })
    .catch(() => null);
}

function buildLeadEventBase(
  type: 'lead.created' | 'lead.updated',
  input: UpsertLeadInput,
  leadId: string,
  session: ChatSession | null,
) {
  return buildEventBase(type, input.tenantId, {
    id: input.sessionId ?? leadId,
    channel: session?.channel ?? input.channel ?? 'widget',
    visitorId: session?.visitorId ?? input.externalUserId ?? 'unknown',
    startedAt: session?.startedAt?.toISOString() ?? new Date().toISOString(),
    messageCount: session?.messageCount ?? 0,
    tags: session?.tags,
  });
}

/**
 * The shared `lead.*` payload. `leadId` + `dedupeKey` are what make it syncable:
 * without a stable key a downstream consumer can only ever insert, never patch
 * or delete, which is why the original one-shot payload could not honour erasure.
 */
function buildLeadPayload(input: UpsertLeadInput, lead: LeadEmitFields): LeadEventPayload {
  // Map onto the existing webhook contract (booking | chat | tool) — a
  // channel/manual/etc. auto-capture during a conversation is 'chat'. Keeps
  // the public payload stable rather than leaking new source values.
  const webhookSource: LeadEventPayload['source'] =
    input.source === 'booking' ? 'booking' : input.source === 'tool' ? 'tool' : 'chat';

  return {
    leadId: lead.leadId,
    ...(lead.dedupeKey ? { dedupeKey: lead.dedupeKey } : {}),
    ...(input.botId ? { botId: input.botId } : {}),
    name: lead.name ?? '',
    email: lead.email ?? '',
    ...(lead.phone ? { phone: lead.phone } : {}),
    ...(lead.notes ? { notes: lead.notes } : {}),
    source: webhookSource,
  };
}

/** Outbound webhook + operator notification for a newly created lead. */
async function emitLeadCreated(input: UpsertLeadInput, lead: LeadEmitFields): Promise<void> {
  const session = await loadEventSession(input);
  const event: LeadCreatedEvent = {
    ...buildLeadEventBase('lead.created', input, lead.leadId, session),
    type: 'lead.created',
    lead: buildLeadPayload(input, lead),
  };
  emitWebhookEvent(event);

  // Operator notification (in-app + push) — the at-a-glance surface.
  await createLeadNotification(input, lead, {});
}

/**
 * A lead the tenant already received has CHANGED. Emitted when the request summary
 * lands after first contact (the channel case) or when structured detail is attached.
 * `changed` lets a consumer patch the fields that moved instead of overwriting a
 * record it may have since edited itself.
 */
async function emitLeadUpdated(
  input: UpsertLeadInput,
  lead: LeadEmitFields,
  changed: string[],
): Promise<void> {
  const session = await loadEventSession(input);
  const event: LeadUpdatedEvent = {
    ...buildLeadEventBase('lead.updated', input, lead.leadId, session),
    type: 'lead.updated',
    lead: buildLeadPayload(input, lead),
    changed,
  };
  emitWebhookEvent(event);
}

/**
 * Erasure notification (GDPR Art 17). Carries ONLY the identifiers a consumer needs
 * to locate its own copy — deliberately no name/email/phone/notes, because a
 * "please delete this person" message that restates their personal data defeats its
 * own purpose and creates a fresh copy in the consumer's logs.
 *
 * Exported because erasure is driven from the route, not the capture path.
 */
export function emitLeadDeleted(args: {
  tenantId: string;
  leadId: string;
  dedupeKey?: string | null;
  sessionId?: string | null;
  channel?: string | null;
}): void {
  const event: LeadDeletedEvent = {
    ...buildEventBase('lead.deleted', args.tenantId, {
      id: args.sessionId ?? args.leadId,
      channel: args.channel ?? 'widget',
      visitorId: 'erased',
      startedAt: new Date().toISOString(),
      messageCount: 0,
    }),
    type: 'lead.deleted',
    lead: { leadId: args.leadId, ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}) },
  };
  emitWebhookEvent(event);
}

/**
 * In-app + push notification for a captured lead. Carries the contact and the ids
 * to deep-link with — deliberately NOT the customer's request text.
 *
 * `message` and `data` are handed VERBATIM to Expo Push (notification.worker.ts
 * sends `body: notif.message, data: { ...notif.data }`), so anything put here
 * leaves our infrastructure for a third-party push service. The request is free
 * text the customer typed: health details, addresses, whatever they chose to say.
 * The alert says who got in touch; the operator taps through to the portal — where
 * the data already lives, behind auth — to read what they asked for. This is also
 * why the erasure sweep can only ever find identifiers here, not personal data.
 * `notes` is not a parameter of this function on purpose.
 *
 * `dedupeSuffix` lets a later "request landed on an existing channel lead" alert
 * through past the first-contact notification, which deduped on `lead:<id>`.
 */
async function createLeadNotification(
  input: UpsertLeadInput,
  lead: { leadId: string; name: string | null; email: string | null; phone: string | null },
  opts: { dedupeSuffix?: string },
): Promise<void> {
  const contact = lead.name || lead.email || lead.phone || 'New contact';
  await notificationService
    .createForTenant({
      tenantId: input.tenantId,
      type: 'lead_created',
      title: 'New lead captured',
      // Without the suffix the re-notify would be byte-identical to the first-contact
      // alert and read as a duplicate. Say that a request arrived, not what it said.
      message: opts.dedupeSuffix === 'request' ? `${contact} — request details added` : contact,
      data: { leadId: lead.leadId, sessionId: input.sessionId ?? null },
      dedupeBase: opts.dedupeSuffix ? `lead:${lead.leadId}:${opts.dedupeSuffix}` : `lead:${lead.leadId}`,
    })
    .catch(() => {});
}
