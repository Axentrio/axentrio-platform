/**
 * Superadmin testing reset: wipe conversation-scoped stores that can leak
 * into the next inbound from the same visitor (memory, draft booking/tool
 * scratch, address, lead extraction). Confirmed calendar bookings stay.
 *
 * Message transcripts are deleted for this Reset session and its STRICTLY
 * OLDER closed siblings on the same tenant + channel + visitor - the same
 * boundary GET /chats/:id/thread renders as the Inbox "earlier" list. A
 * NEWER (possibly still active) session keeps its transcript, so Reset on an
 * old row can never eat a live inbound the bot has not answered yet. Other
 * channels and person_key siblings keep their logs.
 *
 * Close alone starts a new ChatSession. Identity-keyed stores do not.
 */
import { type EntityManager } from 'typeorm';
import { getRedisClient } from '../config/redis';
import { ChatSession } from '../database/entities/ChatSession';
import { resetWipeSessionIds } from './customer-thread';
import {
  clearConversationMemory,
  type MemorySessionIdentity,
} from '../memory/memory-store';
import { ApiError } from '../middleware/error-handler';
import { logger } from '../utils/logger';

export const SCRATCH_CLEAR_ATTEMPTS = 3;
export const SCRATCH_CLEAR_DELAY_MS = 25;

/** DB wipe committed, but Redis still holds booking/tool session keys. Retry Reset. */
export class ResetScratchClearError extends ApiError {
  constructor(sessionIds: string[], cause?: unknown, conversation?: unknown) {
    super(
      'Conversation was closed but booking and tool session state could not be cleared. Press Reset again.',
      503,
      'reset_scratch_incomplete',
      {
        sessionIds,
        cause: cause instanceof Error ? cause.message : cause ? String(cause) : undefined,
        ...(conversation ? { conversation } : {}),
      },
    );
  }
}

export type ResetSessionIdentity = MemorySessionIdentity;

export interface ConversationResetClearance {
  sessionIds: string[];
  transcriptSessionIds: string[];
  factsSuperseded: number;
  runsSkipped: number;
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/** Redis keys the booking tools, loop gate, and coalescer key off session id. */
export function sessionScratchKeys(sessionId: string): string[] {
  return [
    `booking:confirm:${sessionId}`,
    `booking:confirm-reschedule:${sessionId}`,
    `booking:confirm-cancel:${sessionId}`,
    `booking:offered:${sessionId}`,
    `gr:loop:${sessionId}`,
    `turn:state:${sessionId}`,
    `agent:lock:${sessionId}`,
  ];
}

/**
 * Drop session-keyed Redis tool state. Retries, then throws
 * `ResetScratchClearError` (HTTP 503) if Redis is missing or DEL still fails.
 * Reset must not report success while pending confirm / offered slots / loop
 * counters remain — including the null-client path.
 */
export async function clearIdentityScratch(sessionIds: string[]): Promise<boolean> {
  if (sessionIds.length === 0) return true;
  const keys = sessionIds.flatMap(sessionScratchKeys);
  if (keys.length === 0) return true;

  let lastError: unknown;
  for (let attempt = 1; attempt <= SCRATCH_CLEAR_ATTEMPTS; attempt++) {
    const redis = getRedisClient();
    if (!redis) {
      lastError = new Error('Redis unavailable');
      logger.warn('[reset] scratch clear attempt failed', {
        attempt,
        err: 'Redis unavailable',
      });
    } else {
      try {
        await redis.del(...keys);
        return true;
      } catch (error) {
        lastError = error;
        logger.warn('[reset] scratch clear attempt failed', {
          attempt,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (attempt < SCRATCH_CLEAR_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, SCRATCH_CLEAR_DELAY_MS * attempt));
    }
  }

  throw new ResetScratchClearError(sessionIds, lastError);
}

/**
 * Transactional wipe for this visitor's conversation-scoped Postgres state.
 *
 * Does NOT SELECT or UPDATE chatbot_bookings. Confirmed (and other saved)
 * appointments stay in Postgres and on the calendar. Draft booking intent
 * lives in Redis (`booking:confirm`, `booking:offered`) and customer memory,
 * which Reset clears separately.
 *
 * Message rows are deleted for the Reset session and its strictly-older
 * closed siblings on this tenant + channel + visitor. Newer sessions, other
 * channels, and person_key siblings keep their transcripts.
 */
export async function clearConversationResetState(
  manager: EntityManager,
  session: ChatSession,
): Promise<ConversationResetClearance> {
  const memory = await clearConversationMemory(manager, session);
  const sessionIds = memory.sessionIds.length > 0 ? memory.sessionIds : [session.id];
  const transcriptSessionIds = await resetWipeSessionIds(manager, session);

  await clearAddressBindings(manager, sessionIds);
  await clearLeadConversationState(manager, sessionIds);
  await clearSessionTempMetadata(manager, sessionIds);
  await clearChannelIdentityTranscripts(manager, transcriptSessionIds);

  logger.info('[reset] conversation state cleared', {
    sessionId: session.id,
    sessions: sessionIds.length,
    transcripts: transcriptSessionIds.length,
    factsSuperseded: memory.factsSuperseded,
    runsSkipped: memory.runsSkipped,
  });

  return {
    sessionIds,
    transcriptSessionIds,
    factsSuperseded: memory.factsSuperseded,
    runsSkipped: memory.runsSkipped,
  };
}

async function clearAddressBindings(manager: Queryable, sessionIds: string[]): Promise<void> {
  await manager.query(
    `UPDATE chatbot_address_bindings
        SET address = NULL,
            place_id = NULL,
            source = NULL,
            pending = NULL,
            version = version + 1,
            updated_at = now()
      WHERE session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
}

async function clearLeadConversationState(manager: Queryable, sessionIds: string[]): Promise<void> {
  await manager.query(
    `UPDATE chatbot_lead_conversations
        SET request = NULL,
            service_requested = NULL,
            address = NULL,
            preferred_at = NULL,
            preferred_at_text = NULL,
            urgency = NULL,
            intent = NULL,
            tags = NULL,
            enrichment = '{}'::jsonb,
            evidence = '[]'::jsonb,
            enrich_state = CASE
              WHEN enrich_state IN ('pending', 'failed', 'claimed') THEN 'skipped_reset'
              ELSE enrich_state
            END,
            enrich_claimed_until = NULL,
            enrich_next_attempt_at = NULL,
            enrich_last_error = NULL,
            updated_at = now()
      WHERE session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
}

async function clearSessionTempMetadata(manager: Queryable, sessionIds: string[]): Promise<void> {
  await manager.query(
    `UPDATE chat_sessions
        SET subject = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb)
              - 'leadAsk' - 'lead' - 'leadCallback',
            updated_at = now()
      WHERE id = ANY($1::uuid[])`,
    [sessionIds],
  );
}

/**
 * Hard-delete Inbox/LLM transcripts for the Reset session and its older
 * closed siblings. `message_deliveries` cascade. Coalescer watermarks are
 * cleared so a retry cannot answer a deleted high-water mark. Newer sessions
 * and other channels are untouched.
 */
async function clearChannelIdentityTranscripts(
  manager: Queryable,
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  await manager.query(
    `UPDATE chat_sessions
        SET last_coalesced_answer_at = NULL,
            last_coalesced_answer_message_id = NULL,
            message_count = 0,
            unread_count = 0,
            updated_at = now()
      WHERE id = ANY($1::uuid[])`,
    [sessionIds],
  );
  await manager.query(
    `DELETE FROM messages
      WHERE session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
}
