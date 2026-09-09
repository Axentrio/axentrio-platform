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
 *    capture path refuse to re-create an erased identity. `person_key` — the
 *    repeat-detection grouping key, which is a normalised copy of the phone or email
 *    — is cleared for the same reason: it is personal data, and a husk that keeps it
 *    stays linked to the subject's other rows.
 *
 * 3. **PII outlives the lead row.** The same values were copied into operator
 *    notifications (message body + `data.notes`), outbound webhook request bodies, and
 *    agent traces (which record `capture_lead`'s arguments verbatim). Scrubbing only
 *    `chatbot_leads` leaves those copies readable in the portal, the delivery log and
 *    the trace viewer.
 *
 * 4. **A downstream CRM has its own copy.** `lead.created`/`lead.updated` already
 *    shipped this person's details out. Erasure that does not emit `lead.deleted`
 *    is unenforceable past our own database.
 *
 * 5. **The transcript is the customer's own words.** The published Data Deletion
 *    page promises that "the conversation messages ... exchanged with the AI
 *    assistant" are deleted, and erasure used to stop at the transcript boundary.
 *    It no longer does: the `messages` of this lead's sessions are deleted, the
 *    visitor's participant row is scrubbed, and the session counters are reset.
 *    That is the wider blast radius this service used to defer — the whole thread
 *    goes, including the assistant's own replies, because deleting only the
 *    customer's turns would leave the assistant quoting their name, address and
 *    phone number back at anyone who opens the conversation.
 *
 * 6. **The person is in more places than the lead row and the transcript.** The
 *    channel binding holds their WhatsApp number, the judgment holds the model's
 *    verbatim reasoning, the booking holds the address they typed, the handoff
 *    holds a copy of the transcript, the sent emails hold their address, and the
 *    guardrail logs hold the message that tripped them. Erasing the lead and the
 *    messages while leaving those would make "we deleted your data" only mostly
 *    true — so all of them are scrubbed here, each keeping its row where the
 *    tenant still needs the shape (a booking's time, a judgment's aggregate).
 */
import type { DataSource } from 'typeorm';
import { emitLeadDeleted } from './lead-capture.service';
import { ERASED_PREFIX, isErasedDedupeKey } from './lead-tombstone';
import { logComplianceEvent } from '../compliance/compliance-events.service';
import { logger } from '../utils/logger';
import { returningRows } from '../utils/raw-sql';

// Tombstone vocabulary lives in its own module so the capture path can share it
// without the two services importing each other. Re-exported for convenience.
export { ERASED_PREFIX, isErasedDedupeKey } from './lead-tombstone';

export interface ErasureResult {
  leadId: string;
  /** Rows whose lead-derived PII was overwritten, per store. */
  scrubbed: {
    conversations: number;
    notifications: number;
    webhookLogs: number;
    /** Traces carry `capture_lead`'s arguments — the contact and the request. */
    agentTraces: number;
    customerMemoryRows: number;
    /** Message rows deleted from this person's sessions. */
    transcriptMessages: number;
    /** Visitor participant rows scrubbed (name, email, avatar, metadata). */
    transcriptParticipants: number;
    /** Channel bindings whose platform identifiers were tombstoned. */
    conversationBindings: number;
    /** Per-session verdicts whose visitor id and reasoning were removed. */
    judgments: number;
    /** Bookings whose contact details were removed (the row survives). */
    bookings: number;
    /** Handoffs whose embedded transcript copy was removed. */
    handoffContexts: number;
    /** Sent emails whose recipient and payload were removed. */
    emailDeliveries: number;
    /** Guardrail logs whose raw message text was removed. */
    guardrailLogs: number;
  };
  /** False: the transcript is deleted with the lead. Kept for wire compatibility. */
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
    const rows: Array<{
      id: string;
      dedupe_key: string | null;
      session_id: string | null;
      channel: string | null;
      email: string | null;
      phone: string | null;
    }> = await manager.query(
      `SELECT id, dedupe_key, session_id, channel, email, phone
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
    //
    //    `person_key` is DERIVED FROM the phone and email being nulled two lines up —
    //    an E.164 number or an address in a `varchar`, which is personal data whether
    //    or not it is called an identifier. Leaving it on the husk would keep the
    //    subject linkable, and would leave them grouped with their own other rows.
    //    The cached counts go with it so the husk cannot report a person it is no
    //    longer part of. The repeat sweep re-derives the SURVIVING rows' counts on its
    //    next run, which is what makes the erased conversation stop being counted.
    // Capture the group BEFORE the husk loses its key: the surviving rows for the same
    // human cache counts that were derived partly FROM this record, and
    // `person_first_seen_at` can be a timestamp belonging exclusively to it. Leaving
    // them until the next nightly sweep means the erased person keeps being reported,
    // on the wire and on screen, for up to a day after they asked to be forgotten.
    const [groupRow]: Array<{ person_key: string | null }> = await manager.query(
      `SELECT person_key FROM chatbot_leads WHERE id = $1 AND tenant_id = $2`,
      [leadId, tenantId],
    );

    await manager.query(
      `UPDATE chatbot_leads
          SET name = NULL,
              email = NULL,
              phone = NULL,
              notes = NULL,
              metadata = '{}'::jsonb,
              external_user_id = $3,
              dedupe_key = $3,
              person_key = NULL,
              person_lead_count = NULL,
              person_conversation_count = NULL,
              person_first_seen_at = NULL,
              person_last_seen_at = NULL,
              status = 'erased',
              deleted_at = COALESCE(deleted_at, now()),
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [leadId, tenantId, tombstone],
    );

    // Invalidate the rest of the group. Nulled rather than recomputed: recomputing here
    // would be a second implementation of the aggregate, and a wrong count is worse
    // than an absent one. The next sweep re-derives them from what is left, and the
    // read path already falls back to the row's own conversation count meanwhile —
    // a strict floor, so it can under-report a repeat but never invent one.
    if (groupRow?.person_key) {
      await manager.query(
        `UPDATE chatbot_leads
            SET person_lead_count = NULL,
                person_conversation_count = NULL,
                person_first_seen_at = NULL,
                person_last_seen_at = NULL
          WHERE tenant_id = $1 AND person_key = $2 AND deleted_at IS NULL`,
        [tenantId, groupRow.person_key],
      );
    }

    const mem = await manager.query(
      `DELETE FROM chatbot_customer_memory
        WHERE tenant_id = $1
          AND (
            ($2::varchar IS NOT NULL AND person_key = $2)
            OR ($3::varchar IS NOT NULL AND subject_key = $3)
          )
        RETURNING id`,
      [tenantId, groupRow?.person_key ?? null, priorDedupeKey],
    );
    const customerMemoryRows = returningRows<{ id: string }>(mem).length;


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

    // 5. Agent traces record every tool call INCLUDING `capture_lead`'s arguments —
    //    the customer's name, phone and request, in jsonb. Scrubbing the lead while
    //    leaving those intact would defeat the erasure for anyone who reads a trace.
    //    Scoped to this lead's conversations, so unrelated traces are untouched.
    //    NOTE: agent_traces uses QUOTED camelCase columns ("tenantId", "sessionId"),
    //    unlike every other table in this schema — it predates the snake_case
    //    convention. Unquoted snake_case here fails with `column does not exist`.
    //
    //    The session set is defined ONCE, just below, and shared with the transcript
    //    deletion: two copies of this subquery is how the two would drift apart.
    const leadSessionIdsSql = `
      SELECT session_id FROM chatbot_lead_conversations
       WHERE lead_id = $1 AND tenant_id = $2 AND session_id IS NOT NULL
      UNION
      SELECT session_id FROM chatbot_leads
       WHERE id = $1 AND tenant_id = $2 AND session_id IS NOT NULL`;

    const traces = await manager.query(
      `UPDATE agent_traces
          SET trace = jsonb_build_object('erased', true, 'leadId', $1::text)
        WHERE "tenantId" = $2
          AND "sessionId" IN (${leadSessionIdsSql})`,
      [leadId, tenantId],
    );

    // 6. The transcript itself. The published Data Deletion page promises these
    //    rows are deleted, and the customer typically typed their own name, phone
    //    and address into them. The whole thread goes — including the assistant's
    //    replies, which quote that data back.
    const transcript = await manager.query(
      `DELETE FROM messages
        WHERE tenant_id = $2
          AND session_id IN (${leadSessionIdsSql})
        RETURNING id`,
      [leadId, tenantId],
    );

    // 7. The visitor's own participant row (display name, email, avatar, metadata)
    //    is the other half of the transcript. The agent's and the bot's rows are
    //    left alone: they identify our customer's staff, not the data subject.
    const participants = await manager.query(
      `UPDATE participants
          SET name = 'Deleted', email = NULL, avatar_url = NULL,
              metadata = NULL, is_anonymous = true
        WHERE type = 'user'
          AND session_id IN (${leadSessionIdsSql})
        RETURNING id`,
      [leadId, tenantId],
    );

    // 8. The session still exists, so its cached counters must not keep advertising
    //    a conversation that is gone. `transcript_revision` is NOT touched here: the
    //    message-delete trigger above already bumps it, and bumping it twice would
    //    inflate the counter every other CAS in the system compares against.
    await manager.query(
      `UPDATE chat_sessions
          SET message_count = 0,
              unread_count = 0,
              updated_at = now()
        WHERE tenant_id = $2 AND id IN (${leadSessionIdsSql})`,
      [leadId, tenantId],
    );

    // 9. The channel binding. The WhatsApp number IS `externalUserId`, and the
    //    thread id is usually the same number again. Tombstoned rather than nulled
    //    because the column is NOT NULL and part of a unique key — and because a
    //    later inbound message must not match this binding and resurrect the
    //    conversation the customer asked to forget.
    const bindings = await manager.query(
      `UPDATE conversation_bindings
          SET "externalUserId" = 'erased:' || id::text,
              "externalThreadId" = 'erased:' || id::text,
              "externalUserName" = NULL,
              "externalAvatarUrl" = NULL,
              "platformUserData" = '{}'::jsonb
        WHERE "sessionId" IN (${leadSessionIdsSql})
        RETURNING id`,
      [leadId, tenantId],
    );

    // 10. The per-session verdict. `visitor_id` is NOT NULL, so it gets a
    //     tombstone; the model's verbatim reasoning and the evidence quotes are
    //     the personal data. The row stays so the aggregate counts survive.
    const judgments = await manager.query(
      `UPDATE chatbot_judgments
          SET visitor_id = 'erased:' || session_id::text,
              reasoning = NULL,
              topic_phrase = NULL,
              evidence_message_ids = '[]'::jsonb
        WHERE session_id IN (${leadSessionIdsSql})
        RETURNING id`,
      [leadId, tenantId],
    );

    // 11. Bookings carry the name, email, phone and address the customer typed.
    //     The row is kept — the diary still has to show the appointment — but the
    //     contact details go. `customer_place_id` has a CHECK that forbids '', so
    //     it is nulled rather than blanked.
    const bookings = await manager.query(
      `UPDATE chatbot_bookings
          SET attendee_name = NULL,
              attendee_email = NULL,
              customer_phone = NULL,
              customer_address = NULL,
              customer_place_id = NULL,
              customer_lat = NULL,
              customer_lng = NULL,
              customer_coords_at = NULL,
              customer_address_verified = NULL,
              intake_answers = NULL,
              uploaded_files = NULL,
              notes = NULL,
              ai_summary = NULL
        WHERE tenant_id = $2
          AND (lead_id = $1 OR session_id IN (${leadSessionIdsSql}))
        RETURNING id`,
      [leadId, tenantId],
    );

    // 12. A handoff embeds a COPY of the transcript plus the agent's notes. Leaving
    //     it would defeat the message delete above for anyone reading the handoff.
    const handoffs = await manager.query(
      `UPDATE handoff_requests
          SET context = COALESCE(context, '{}'::jsonb) - 'messageHistory',
              notes = NULL
        WHERE session_id IN (${leadSessionIdsSql})
        RETURNING id`,
      [leadId, tenantId],
    );

    // 13. Emails we sent them. Scoped by the address they had at erasure time (it
    //     is about to be nulled) and by any email tied to one of their sessions.
    const emails = await manager.query(
      `UPDATE email_deliveries
          SET recipient_email = 'erased:' || id::text,
              subject = 'Erased',
              payload = NULL
        WHERE tenant_id = $2
          AND (
            ($3::varchar IS NOT NULL AND recipient_email = $3)
            OR related_id IN (${leadSessionIdsSql})
          )
        RETURNING id`,
      [leadId, tenantId, lead.email],
    );

    // 14. Guardrail logs keep the raw message text that tripped them (`reasons`),
    //     plus a pointer to the message itself.
    const spamLogs = await manager.query(
      `UPDATE guardrail_spam_logs
          SET reasons = NULL,
              suspicious_message_id = NULL
        WHERE tenant_id = $2 AND conversation_id IN (${leadSessionIdsSql})
        RETURNING id`,
      [leadId, tenantId],
    );
    const outputLogs = await manager.query(
      `UPDATE guardrail_output_logs
          SET reasons = NULL,
              families = '[]'::jsonb,
              outbound_message_id = NULL
        WHERE tenant_id = $2 AND conversation_id IN (${leadSessionIdsSql})
        RETURNING id`,
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
        agentTraces: rowCount(traces),
        customerMemoryRows,
        transcriptMessages: rowCount(transcript),
        transcriptParticipants: rowCount(participants),
        conversationBindings: rowCount(bindings),
        judgments: rowCount(judgments),
        bookings: rowCount(bookings),
        handoffContexts: rowCount(handoffs),
        emailDeliveries: rowCount(emails),
        guardrailLogs: rowCount(spamLogs) + rowCount(outputLogs),
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

  // Recorded HERE, not in the route, so every path that erases — the API, the
  // retention sweep, the post-restore replay — leaves the same evidence. A
  // restore undoes this row's effect, and the replay finds it by this event.
  await logComplianceEvent({
    actorId: 'system',
    eventType: 'leads.erased',
    tenantId,
    subjectType: 'lead',
    subjectId: leadId,
    details: { scrubbed: result.scrubbed, transcriptRetained: false },
  });

  return { leadId, scrubbed: result.scrubbed, transcriptRetained: false };
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
