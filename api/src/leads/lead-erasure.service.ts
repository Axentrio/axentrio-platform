/**
 * Lead erasure (GDPR Art 17) — the single path that removes a captured lead's
 * personal data from this platform and tells downstream consumers to do the same.
 *
 * Four things make this harder than `DELETE FROM chatbot_leads`, and all four are
 * why it is its own service rather than a route handler:
 *
 * 1. **The identity CHECK forbids a fully-blank row.** `chk_chatbot_leads_identity`
 *    requires email OR phone OR external_user_id to be non-null, so nulling all
 *    three throws. We write a reserved, non-reversible tombstone into
 *    `external_user_id` instead: `erased:<leadId>`. The row survives as an auditable
 *    husk (counts, timestamps, source) carrying no personal data.
 *
 * 2. **The tombstone must not be resurrectable.** `dedupe_key` is the upsert anchor,
 *    so leaving the old key in place means the customer's next WhatsApp message
 *    UPDATEs the erased row back into a live lead with their name and number. The
 *    key is rewritten to the tombstone too, and `isErasedDedupeKey` lets the
 *    capture path refuse to re-create an erased identity.
 *
 * 3. **PII outlives the lead row.** The same values were copied into operator
 *    notifications (message body + `data.notes`) and into outbound webhook request
 *    bodies. Scrubbing only `chatbot_leads` leaves those copies readable in the
 *    portal and in the delivery log.
 *
 * 4. **A downstream CRM has its own copy.** `lead.created`/`lead.updated` already
 *    shipped this person's details out. Erasure that does not emit `lead.deleted`
 *    is unenforceable past our own database.
 *
 * SCOPE BOUNDARY — deliberately NOT scrubbed here: the conversation transcript
 * (`messages`). That text is the customer's own words in a chat session that is also
 * the evidence base for bookings, insights and dispute handling, and deleting it is a
 * different operation with a much wider blast radius. Erasing a LEAD erases the lead
 * record and everything derived from it. Transcript deletion belongs to the
 * session/tenant deletion flow, and the two must not be conflated — see the caveat
 * returned in `ErasureResult.transcriptRetained`.
 */
import type { DataSource } from 'typeorm';
import { emitLeadDeleted } from './lead-capture.service';
import { ERASED_PREFIX, isErasedDedupeKey } from './lead-tombstone';
import { logger } from '../utils/logger';

// Tombstone vocabulary lives in its own module so the capture path can share it
// without the two services importing each other. Re-exported for convenience.
export { ERASED_PREFIX, isErasedDedupeKey } from './lead-tombstone';

export interface ErasureResult {
  leadId: string;
  /** Rows whose lead-derived PII was overwritten, per store. */
  scrubbed: { conversations: number; notifications: number; webhookLogs: number };
  /** Always true today — see the SCOPE BOUNDARY note above. */
  transcriptRetained: boolean;
}

/**
 * Erase one lead, in a single transaction, then notify downstream.
 *
 * Returns `null` when the lead does not exist for this tenant or is already erased
 * (idempotent: erasing twice is not an error, and must not emit a second event).
 */
export async function eraseLead(
  dataSource: DataSource,
  tenantId: string,
  leadId: string,
): Promise<ErasureResult | null> {
  const tombstone = `${ERASED_PREFIX}${leadId}`;

  const result = await dataSource.transaction(async (manager) => {
    // Lock the row so a concurrent capture-path upsert cannot interleave between
    // our read and the scrub and re-populate the fields we just cleared.
    const rows: Array<{ id: string; dedupe_key: string | null; session_id: string | null; channel: string | null }> =
      await manager.query(
        `SELECT id, dedupe_key, session_id, channel
           FROM chatbot_leads
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE`,
        [leadId, tenantId],
      );
    const lead = rows[0];
    if (!lead) return null; // wrong tenant or nonexistent — caller maps to 404
    if (isErasedDedupeKey(lead.dedupe_key)) return null; // already erased, idempotent

    const priorDedupeKey = lead.dedupe_key;

    // 1. The lead row itself. `deleted_at` is set so it drops out of every list,
    //    export and aggregate; the husk is kept for audit (who erased what, when).
    //    `status='erased'` is TERMINAL — the worklist PATCH must never move it back.
    await manager.query(
      `UPDATE chatbot_leads
          SET name = NULL,
              email = NULL,
              phone = NULL,
              notes = NULL,
              metadata = '{}'::jsonb,
              external_user_id = $3,
              dedupe_key = $3,
              status = 'erased',
              deleted_at = COALESCE(deleted_at, now()),
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [leadId, tenantId, tombstone],
    );

    // 2. Per-conversation rows: every extracted field is personal data (address,
    //    verbatim request, evidence quotes). `enrich_state='erased'` is terminal so
    //    the enrichment sweep can never pick these up and re-derive them.
    const conv = await manager.query(
      `UPDATE chatbot_lead_conversations
          SET request = NULL, service_requested = NULL, address = NULL,
              preferred_at = NULL, preferred_at_text = NULL,
              urgency = NULL, intent = NULL, tags = NULL,
              enrichment = '{}'::jsonb, evidence = '[]'::jsonb,
              enrich_state = 'erased', enrich_claimed_until = NULL,
              enrich_next_attempt_at = NULL, enrich_last_error = NULL,
              updated_at = now()
        WHERE lead_id = $1 AND tenant_id = $2`,
      [leadId, tenantId],
    );

    // 3. Operator notifications copied the contact and the request summary into the
    //    body and into `data.notes` — both readable in the portal and pushed to
    //    devices. Keep the row (the operator's read state is theirs) but strip it.
    const notif = await manager.query(
      `UPDATE notifications
          SET message = 'This lead was erased at the customer''s request.',
              data = jsonb_build_object('leadId', $1::text, 'erased', true)
        WHERE tenant_id = $2
          AND type = 'lead_created'
          AND data->>'leadId' = $1::text`,
      [leadId, tenantId],
    );

    // 4. Outbound webhook bodies contain the full lead payload. Null the body rather
    //    than delete the row so the delivery history (what fired, when, status)
    //    survives for debugging without retaining the personal data.
    const hooks = await manager.query(
      `UPDATE webhook_delivery_logs
          SET request_body = jsonb_build_object('leadId', $1::text, 'redacted', true)
        WHERE tenant_id = $2
          AND request_body -> 'lead' ->> 'leadId' = $1::text`,
      [leadId, tenantId],
    );

    return {
      priorDedupeKey,
      sessionId: lead.session_id,
      channel: lead.channel,
      scrubbed: {
        conversations: rowCount(conv),
        notifications: rowCount(notif),
        webhookLogs: rowCount(hooks),
      },
    };
  });

  if (!result) return null;

  // Downstream notification happens AFTER the transaction commits: a consumer that
  // acts on `lead.deleted` must not be able to observe it before our own erasure is
  // durable. Carries the PRIOR dedupe key — that is how a CRM finds its copy — and
  // deliberately no name/email/phone.
  emitLeadDeleted({
    tenantId,
    leadId,
    dedupeKey: result.priorDedupeKey,
    sessionId: result.sessionId,
    channel: result.channel,
  });

  logger.info('[leads] erased', { tenantId, leadId, scrubbed: result.scrubbed });

  return { leadId, scrubbed: result.scrubbed, transcriptRetained: true };
}

/**
 * `.query()` returns `[rows, affectedCount]` for UPDATE in node-pg via TypeORM.
 * Reading `[1]` directly is the shape bug that has bitten this repo before, so
 * normalize defensively rather than trusting one shape.
 */
function rowCount(res: unknown): number {
  if (Array.isArray(res) && typeof res[1] === 'number') return res[1];
  if (Array.isArray(res)) return res.length;
  return 0;
}
