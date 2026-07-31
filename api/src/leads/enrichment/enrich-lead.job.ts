/**
 * Lead-enrichment sweep — Release B's runner.
 *
 * Triggers on transcript QUIESCENCE, not session close. There is no close hook in this
 * codebase: the dominant close path is raw SQL in `server.ts` that emits nothing, the
 * widget close endpoint rejects AI-bot sessions, and an agent-handled session can sit
 * `active` indefinitely — while Story 3 explicitly names human agents as a lead source.
 * So eligibility is "this conversation has gone quiet", which covers every status.
 *
 * The correctness property that matters is the COMMIT. Between reading a transcript and
 * writing the extraction, the conversation can change — a message arrives, is edited, or
 * is deleted. We read `chat_sessions.transcript_revision` first (a DB trigger owns it,
 * see migration 1787600000000) and commit with a compare-and-swap on it. If it moved,
 * the write is refused and the row is requeued. A `(created_at, id)` high-water mark
 * cannot do this: it is blind to edits and deletes, and recompare-then-write outside the
 * UPDATE is a TOCTOU window.
 *
 * Safety, all explicit rather than defaulted, because a background LLM pass on this
 * platform previously saturated the shared OpenAI TPM budget and produced customer-facing
 * 429s on live replies:
 *   - default OFF behind `LEAD_ENRICHMENT_ENABLED`
 *   - concurrency ONE (sequential), never a queue default of 10
 *   - an enforcing per-run call ceiling that aborts the sweep, not just telemetry
 *   - bounded exponential backoff, and a give-up after MAX_ATTEMPTS
 *   - a DB claim-lease, so multiple replicas cannot double-spend
 */
import { AppDataSource } from '../../database/data-source';
import { returningRows } from '../../utils/raw-sql';
import { decrypt } from '../../utils/encryption';
import { getEntitlements } from '../../billing/entitlements';
import { logger } from '../../utils/logger';
import { extractLead, ENRICHMENT_VERSION } from './extractor.service';
import type { TranscriptMessage } from './validate';

/** A conversation must be quiet this long before we read it as finished. */
const QUIET_MINUTES = 20;
const LEASE_MINUTES = 5;
/** Rows per tick. Small: this is sequential LLM work, not a bulk update. */
const BATCH = 5;
const MAX_ATTEMPTS = 3;
/** Hard ceiling per sweep. Reaching it aborts the run — see the TPM note above. */
const MAX_CALLS_PER_RUN = 25;

let running = false;

interface ClaimedRow {
  id: string;
  tenant_id: string;
  lead_id: string;
  session_id: string;
  enrich_attempts: number;
}

/**
 * Load a session transcript as plaintext.
 *
 * The decrypt branch is NOT optional and is copied deliberately from
 * `insights/refresh-insights.job.ts`: the first prod run of the insights judge read
 * ciphertext and confidently reported "no questions" for every session. Skipping it
 * here would ship plausible-looking extractions computed over encrypted bytes.
 */
async function loadTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  const rows: Array<{ id: string; content: string; contentEncrypted: boolean; sender: string; createdAt: Date }> =
    await AppDataSource.query(
      `SELECT m.id, m.content, m.content_encrypted AS "contentEncrypted",
              p.type AS sender, m.created_at AS "createdAt"
         FROM messages m
         JOIN participants p ON p.id = m.participant_id
        WHERE m.session_id = $1 AND m.type = 'text'
        ORDER BY m.created_at ASC`,
      [sessionId],
    );
  return rows.map((r) => ({
    id: r.id,
    content: r.contentEncrypted ? decrypt(r.content) : r.content,
    sender: (['user', 'agent', 'bot', 'system'].includes(r.sender) ? r.sender : 'system') as TranscriptMessage['sender'],
    createdAt: r.createdAt,
  })) as TranscriptMessage[];
}

/** Claim due, quiet, unclaimed conversations. Lease + SKIP LOCKED = replica-safe. */
async function claimBatch(): Promise<ClaimedRow[]> {
  // UPDATE…RETURNING through .query() yields [rows, count], NOT rows — consuming it
  // raw is what produced phantom rows forever in the booking reconciler.
  return returningRows<ClaimedRow>(
    await AppDataSource.query(
      `UPDATE chatbot_lead_conversations
          SET enrich_state = 'claimed',
              enrich_claimed_until = now() + interval '${LEASE_MINUTES} minutes'
        WHERE id IN (
          SELECT lc.id
            FROM chatbot_lead_conversations lc
            JOIN chat_sessions s ON s.id = lc.session_id
           WHERE lc.enrich_state IN ('pending', 'failed')
             AND lc.session_id IS NOT NULL
             AND (lc.enrich_claimed_until IS NULL OR lc.enrich_claimed_until < now())
             AND (lc.enrich_next_attempt_at IS NULL OR lc.enrich_next_attempt_at <= now())
             AND lc.enrich_attempts < ${MAX_ATTEMPTS}
             -- Quiescence: the last message in this conversation is old enough that
             -- the customer has almost certainly finished talking. Covers every
             -- session status, including one an agent left 'active'.
             AND NOT EXISTS (
               SELECT 1 FROM messages m
                WHERE m.session_id = lc.session_id
                  AND m.created_at > now() - interval '${QUIET_MINUTES} minutes'
             )
             AND EXISTS (
               SELECT 1 FROM messages m WHERE m.session_id = lc.session_id
             )
           ORDER BY lc.enrich_next_attempt_at NULLS FIRST, lc.created_at ASC
           LIMIT ${BATCH}
           FOR UPDATE SKIP LOCKED
        )
      RETURNING id, tenant_id, lead_id, session_id, enrich_attempts`,
    ),
  );
}

/** Read the revision we are about to extract against. */
async function readRevision(sessionId: string): Promise<number | null> {
  const rows: Array<{ r: number }> = await AppDataSource.query(
    `SELECT transcript_revision AS r FROM chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0] ? Number(rows[0].r) : null;
}

async function requeue(row: ClaimedRow, reason: string): Promise<void> {
  // Bounded exponential backoff. Give up (state stays 'failed' with attempts at the
  // cap) rather than retrying an unfixable transcript forever.
  const delayMin = Math.min(60, 5 * 2 ** row.enrich_attempts);
  await AppDataSource.query(
    `UPDATE chatbot_lead_conversations
        SET enrich_state = 'failed',
            enrich_attempts = enrich_attempts + 1,
            enrich_claimed_until = NULL,
            enrich_next_attempt_at = now() + ($2 || ' minutes')::interval,
            enrich_last_error = $3,
            updated_at = now()
      WHERE id = $1`,
    [row.id, String(delayMin), reason.slice(0, 500)],
  );
}

/**
 * Process one conversation. Returns whether an LLM call was spent, so the caller can
 * enforce the per-run ceiling.
 */
export async function enrichOne(row: ClaimedRow): Promise<{ calledModel: boolean }> {
  // Gate per tenant. Checked here, not at claim time, so a mid-sweep downgrade or a
  // tenant switching the feature off takes effect immediately.
  let eligible = false;
  try {
    const { features } = await getEntitlements(row.tenant_id);
    // Eligibility is `leadCapture` — the EXPOSURE of structured columns is what
    // `leadEnrichment` gates. Running for every paid tier means Essential gets a
    // proper request summary; the wide column set is still Pro-only.
    eligible = features.leadCapture === true;
  } catch (error) {
    await requeue(row, `entitlement resolution failed: ${String(error)}`);
    return { calledModel: false };
  }
  if (!eligible) {
    await AppDataSource.query(
      `UPDATE chatbot_lead_conversations SET enrich_state = 'skipped_guardrail', enrich_claimed_until = NULL, updated_at = now() WHERE id = $1`,
      [row.id],
    );
    return { calledModel: false };
  }

  const revisionBefore = await readRevision(row.session_id);
  if (revisionBefore === null) {
    // Session vanished (hard-deleted). Nothing to enrich, and no point retrying.
    await AppDataSource.query(
      `UPDATE chatbot_lead_conversations SET enrich_state = 'skipped_legacy', enrich_claimed_until = NULL, updated_at = now() WHERE id = $1`,
      [row.id],
    );
    return { calledModel: false };
  }

  const messages = await loadTranscript(row.session_id);
  if (messages.length === 0) {
    await AppDataSource.query(
      `UPDATE chatbot_lead_conversations SET enrich_state = 'abstained', enrich_claimed_until = NULL, updated_at = now() WHERE id = $1`,
      [row.id],
    );
    return { calledModel: false };
  }

  const result = await extractLead(messages);

  // COMPARE-AND-SWAP. The subquery is evaluated inside the UPDATE, so there is no
  // window between checking the revision and writing — unlike a read-then-write.
  const updated = returningRows<{ id: string }>(
    await AppDataSource.query(
      `UPDATE chatbot_lead_conversations lc
          SET request = $3, service_requested = $4, address = $5,
              preferred_at = $6, preferred_at_text = $7,
              urgency = $8, intent = $9, tags = $10,
              enrichment = $11::jsonb, evidence = $12::jsonb,
              enrich_state = $13,
              enriched_revision = $2,
              enrich_claimed_until = NULL,
              enrich_next_attempt_at = NULL,
              enrich_last_error = NULL,
              enrichment_version = $14,
              model = $15, prompt_version = $16, extracted_language = $17,
              source = 'extractor',
              updated_at = now()
        WHERE lc.id = $1
          AND (SELECT s.transcript_revision FROM chat_sessions s WHERE s.id = lc.session_id) = $2
        RETURNING lc.id`,
      [
        row.id,
        revisionBefore,
        result.request,
        result.serviceRequested,
        result.address,
        result.preferredAt,
        result.preferredAtText,
        result.urgency,
        result.intent,
        result.tags,
        JSON.stringify(result.enrichment),
        JSON.stringify(result.evidence),
        result.abstained ? 'abstained' : 'enriched',
        result.enrichmentVersion,
        result.model,
        result.promptVersion,
        result.language,
      ],
    ),
  );

  if (updated.length === 0) {
    // The transcript changed while we were extracting. Refusing the write is the
    // whole point — the reading describes a conversation that no longer exists.
    logger.info('[lead-enrich] transcript moved during extraction — requeued', {
      conversationId: row.id,
      revisionBefore,
    });
    await requeue(row, 'transcript revision changed during extraction');
    return { calledModel: true };
  }

  logger.debug('[lead-enrich] enriched', {
    conversationId: row.id,
    abstained: result.abstained,
    fields: result.evidence.map((e) => e.field),
  });
  return { calledModel: true };
}

/**
 * One sweep tick. Sequential by design (concurrency 1) — this shares the platform
 * OpenAI budget with live customer replies, and a parallel default is exactly the
 * shape of the incident that caused customer-facing 429s.
 */
export async function runLeadEnrichmentSweep(): Promise<{ processed: number; calls: number }> {
  if (running) return { processed: 0, calls: 0 };
  running = true;
  let processed = 0;
  let calls = 0;
  try {
    const claimed = await claimBatch();
    if (claimed.length === 0) return { processed: 0, calls: 0 };

    for (const row of claimed) {
      if (calls >= MAX_CALLS_PER_RUN) {
        // ENFORCING, not advisory: release the rest of the batch and stop.
        logger.warn('[lead-enrich] per-run call ceiling reached — releasing remainder', {
          ceiling: MAX_CALLS_PER_RUN,
        });
        await AppDataSource.query(
          `UPDATE chatbot_lead_conversations
              SET enrich_state = 'pending', enrich_claimed_until = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        continue;
      }
      try {
        const { calledModel } = await enrichOne(row);
        if (calledModel) calls += 1;
        processed += 1;
      } catch (error) {
        await requeue(row, error instanceof Error ? error.message : String(error)).catch(() => {});
      }
    }
    logger.info('[lead-enrich] sweep complete', { processed, calls, version: ENRICHMENT_VERSION });
    return { processed, calls };
  } finally {
    running = false;
  }
}

/** Exported for the metrics surface: per-field abstain rate is the early warning that
 *  extraction has silently degraded (e.g. after a model bump). */
export async function enrichmentAbstainStats(tenantId: string, days = 7) {
  const [row] = await AppDataSource.query(
    `SELECT count(*)::int                                            AS total,
            count(*) FILTER (WHERE enrich_state = 'abstained')::int  AS abstained,
            count(*) FILTER (WHERE request IS NULL)::int             AS no_request,
            count(*) FILTER (WHERE address IS NULL)::int             AS no_address,
            count(*) FILTER (WHERE urgency IS NULL)::int             AS no_urgency,
            count(*) FILTER (WHERE intent IS NULL)::int              AS no_intent
       FROM chatbot_lead_conversations
      WHERE tenant_id = $1
        AND enrich_state IN ('enriched', 'abstained')
        AND updated_at >= now() - ($2 || ' days')::interval`,
    [tenantId, String(days)],
  );
  return row ?? { total: 0, abstained: 0 };
}
