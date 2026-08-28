/**
 * Customer-memory extraction sweep.
 *
 * Discover quiet sessions, claim a run row with SKIP LOCKED, extract, commit
 * with compare-and-swap on transcript_revision. Sequential on purpose: this
 * shares the platform OpenAI budget with live replies.
 */
import { AppDataSource } from '../database/data-source';
import { Sentry } from '../config/sentry';
import { returningRows } from '../utils/raw-sql';
import { logger } from '../utils/logger';
import {
  extractMemoryFacts,
} from './fact-extractor.service';
import { isMemoryEnabledForSession } from './memory-config';
import {
  linkMemoryToContact,
  upsertMemorySubject,
  writeMemoryFact,
} from './memory-store';
import { loadSessionTranscript } from './transcript';
import { computeSubjectKey, hashSubjectKey } from './subject-key';

const QUIET_MINUTES = 20;
const LEASE_MINUTES = 5;
const BATCH = 5;
const MAX_ATTEMPTS = 3;
const MAX_CALLS_PER_RUN = 25;

let running = false;

export interface ClaimedRun {
  id: string;
  tenant_id: string;
  session_id: string;
  attempts: number;
}

class TranscriptMovedError extends Error {
  constructor() {
    super('transcript revision changed during extraction');
    this.name = 'TranscriptMovedError';
  }
}

async function discover(): Promise<number> {
  const rows = returningRows<{ id: string }>(
    await AppDataSource.query(
      `INSERT INTO chatbot_customer_memory_runs (tenant_id, session_id)
       SELECT s.tenant_id, s.id FROM chat_sessions s
        WHERE s.transcript_revision > 0
          AND NOT EXISTS (SELECT 1 FROM chatbot_customer_memory_runs r WHERE r.session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id
                            AND m.created_at > now() - interval '${QUIET_MINUTES} minutes')
          AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
        ORDER BY s.last_activity_at DESC NULLS LAST
        LIMIT 200
       ON CONFLICT (session_id) DO NOTHING
       RETURNING id`,
    ),
  );
  return rows.length;
}

async function claimBatch(): Promise<ClaimedRun[]> {
  return returningRows<ClaimedRun>(
    await AppDataSource.query(
      `UPDATE chatbot_customer_memory_runs
          SET state = 'claimed', claimed_until = now() + interval '${LEASE_MINUTES} minutes', updated_at = now()
        WHERE id IN (
          SELECT r.id FROM chatbot_customer_memory_runs r
           WHERE r.state IN ('pending', 'failed')
             AND (r.claimed_until IS NULL OR r.claimed_until < now())
             AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now())
             AND r.attempts < ${MAX_ATTEMPTS}
           ORDER BY r.next_attempt_at NULLS FIRST, r.created_at ASC
           LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, session_id, attempts`,
    ),
  );
}

async function readRevision(sessionId: string): Promise<number | null> {
  const rows: Array<{ r: number }> = await AppDataSource.query(
    `SELECT transcript_revision AS r FROM chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0] ? Number(rows[0].r) : null;
}

async function requeue(row: ClaimedRun, reason: string): Promise<void> {
  const delayMin = Math.min(60, 5 * 2 ** row.attempts);
  await AppDataSource.query(
    `UPDATE chatbot_customer_memory_runs
        SET state = 'failed',
            attempts = attempts + 1,
            claimed_until = NULL,
            next_attempt_at = now() + ($2 || ' minutes')::interval,
            last_error = $3,
            updated_at = now()
      WHERE id = $1`,
    [row.id, String(delayMin), reason.slice(0, 500)],
  );
}

async function markSkipped(runId: string, state: 'skipped_disabled' | 'skipped_no_subject'): Promise<void> {
  await AppDataSource.query(
    `UPDATE chatbot_customer_memory_runs
        SET state = $2, claimed_until = NULL, updated_at = now()
      WHERE id = $1`,
    [runId, state],
  );
  logger.info('[customer-memory] skipped', {
    runId,
    reason: state === 'skipped_disabled' ? 'disabled' : 'no_subject',
  });
}

interface SessionRow {
  id: string;
  tenantId: string;
  botId: string;
  channel: string | null;
  visitorId: string;
}

async function loadSessionRow(sessionId: string): Promise<SessionRow | undefined> {
  const sessions: SessionRow[] = await AppDataSource.query(
    `SELECT id, tenant_id AS "tenantId", bot_id AS "botId", channel, visitor_id AS "visitorId"
       FROM chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return sessions[0];
}

async function persistExtraction(input: {
  row: ClaimedRun;
  session: SessionRow;
  subjectKey: string;
  revisionBefore: number;
  memoryId: string;
  result: Awaited<ReturnType<typeof extractMemoryFacts>>;
}): Promise<'committed' | 'moved'> {
  const { row, session, subjectKey, revisionBefore, memoryId, result } = input;
  const nextState = result.facts.length === 0 ? 'abstained' : 'extracted';
  try {
    await AppDataSource.transaction(async (manager) => {
      const updated = returningRows<{ id: string }>(
        await manager.query(
          `UPDATE chatbot_customer_memory_runs r
              SET state = $3, extracted_revision = $2, memory_id = $4, facts_written = $5,
                  model = $6, prompt_version = $7, extraction_version = $8,
                  claimed_until = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = now()
            WHERE r.id = $1
              AND (SELECT s.transcript_revision FROM chat_sessions s WHERE s.id = r.session_id) = $2
            RETURNING r.id`,
          [
            row.id,
            revisionBefore,
            nextState,
            memoryId,
            result.facts.length,
            result.model,
            result.promptVersion,
            result.extractionVersion,
          ],
        ),
      );
      if (updated.length === 0) throw new TranscriptMovedError();

      for (const fact of result.facts) {
        await writeMemoryFact(manager, {
          tenantId: session.tenantId,
          memoryId,
          factKey: fact.factKey,
          value: fact.value,
          confidence: fact.confidence,
          evidenceMessageId: fact.evidenceMessageId,
          evidenceSpan: fact.span,
          sourceSessionId: session.id,
          model: result.model,
          promptVersion: result.promptVersion,
          extractionVersion: result.extractionVersion,
        });
      }

      await manager.query(
        `UPDATE chatbot_customer_memory
            SET live_fact_count = (
                  SELECT count(*) FROM chatbot_customer_facts
                   WHERE memory_id = $1 AND superseded_at IS NULL
                ),
                updated_at = now()
          WHERE id = $1`,
        [memoryId],
      );
    });
  } catch (error) {
    if (error instanceof TranscriptMovedError) {
      logger.info('[customer-memory] transcript moved during extraction — requeued', {
        runId: row.id,
        revisionBefore,
      });
      await requeue(row, 'transcript revision changed during extraction');
      return 'moved';
    }
    throw error;
  }
  logger.debug('[customer-memory] extracted', {
    runId: row.id,
    tenantId: session.tenantId,
    sessionId: session.id,
    subjectKeyHash: hashSubjectKey(subjectKey),
    factKeys: result.facts.map((f) => f.factKey),
    abstained: result.abstained,
  });
  return 'committed';
}

export async function extractOne(row: ClaimedRun): Promise<{ calledModel: boolean }> {
  return Sentry.startSpan({ name: 'customer-memory.extract', op: 'memory.extract' }, async (span) => {
    const finish = (calledModel: boolean, facts: number, abstained: boolean) => {
      span?.setAttribute('facts', facts);
      span?.setAttribute('abstained', abstained);
      return { calledModel };
    };

    const session = await loadSessionRow(row.session_id);
    if (!session) {
      await markSkipped(row.id, 'skipped_no_subject');
      return finish(false, 0, true);
    }

    const enabled = await isMemoryEnabledForSession({
      id: session.id,
      tenantId: session.tenantId,
      botId: session.botId,
    } as import('../database/entities/ChatSession').ChatSession);
    if (!enabled) {
      await markSkipped(row.id, 'skipped_disabled');
      return finish(false, 0, true);
    }

    const subjectKey = computeSubjectKey(session);
    if (!subjectKey) {
      await markSkipped(row.id, 'skipped_no_subject');
      return finish(false, 0, true);
    }

    const revisionBefore = await readRevision(session.id);
    if (revisionBefore === null) {
      await markSkipped(row.id, 'skipped_no_subject');
      return finish(false, 0, true);
    }

    const messages = await loadSessionTranscript(session.id);
    if (messages.length === 0) {
      await AppDataSource.query(
        `UPDATE chatbot_customer_memory_runs
            SET state = 'abstained', claimed_until = NULL, updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      return finish(false, 0, true);
    }

    const result = await extractMemoryFacts(session.tenantId, messages);
    const calledModel = messages.some((m) => m.sender === 'user');
    const { id: memoryId } = await upsertMemorySubject({
      tenantId: session.tenantId,
      subjectKey,
      channel: session.channel,
    });
    await AppDataSource.query(
      `UPDATE chatbot_customer_memory_runs SET memory_id = $1, updated_at = now() WHERE id = $2`,
      [memoryId, row.id],
    );
    await linkMemoryToContact(session.tenantId, memoryId, subjectKey);

    const outcome = await persistExtraction({
      row,
      session,
      subjectKey,
      revisionBefore,
      memoryId,
      result,
    });
    if (outcome === 'moved') return finish(true, 0, true);
    return finish(calledModel, result.facts.length, result.abstained);
  });
}

export async function runCustomerMemorySweep(): Promise<{ discovered: number; processed: number; calls: number }> {
  if (running) return { discovered: 0, processed: 0, calls: 0 };
  running = true;
  const started = Date.now();
  let discovered = 0;
  let processed = 0;
  let calls = 0;
  try {
    discovered = await discover();
    const claimed = await claimBatch();
    for (const row of claimed) {
      if (calls >= MAX_CALLS_PER_RUN) {
        await AppDataSource.query(
          `UPDATE chatbot_customer_memory_runs
              SET state = 'pending', claimed_until = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        continue;
      }
      try {
        const { calledModel } = await extractOne(row);
        if (calledModel) calls += 1;
        processed += 1;
      } catch (error) {
        await requeue(row, error instanceof Error ? error.message : String(error)).catch(() => {});
      }
    }
    logger.info('[customer-memory] sweep tick', {
      discovered,
      processed,
      calls,
      durationMs: Date.now() - started,
    });
    return { discovered, processed, calls };
  } finally {
    running = false;
  }
}

