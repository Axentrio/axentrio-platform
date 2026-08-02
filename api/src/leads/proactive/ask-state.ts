/**
 * Ask-state for the proactive contact request, persisted on the session.
 *
 * Lives in `chat_sessions.metadata` rather than a dedicated column: it is
 * conversation-scoped and dies with the conversation, the removed chip
 * implementation used the same place (`metadata.leadCallback`), and a jsonb key
 * costs no migration on a table this hot.
 *
 * `askedAt` is the ONLY state, and that is the point. A decline and a silence are
 * recorded identically, because we act on both identically: we never ask again.
 * Detecting "no thanks" in free text across en/nl/fr would be a classifier whose
 * false negatives are exactly the pushy behaviour the spec forbids, so the design
 * removes the need to detect anything.
 */
import type { ChatSession } from '../../database/entities/ChatSession';

export interface AskState {
  /** ISO timestamp of the turn the ask was put in front of the model. */
  askedAt?: string;
}

/** Exported so the SQL merge and the in-memory patch cannot drift apart. */
export const ASK_STATE_KEY = 'leadAsk';
const METADATA_KEY = ASK_STATE_KEY;

export function readAskState(session: Pick<ChatSession, 'metadata'>): AskState {
  const raw = (session.metadata as { leadAsk?: unknown } | null)?.[METADATA_KEY];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AskState) : {};
}

/**
 * Merge the ask-state into a metadata blob without disturbing anything else on it.
 * Returns a new object; the caller persists it.
 */
export function withAskState(
  metadata: Record<string, unknown> | null | undefined,
  next: AskState,
): Record<string, unknown> {
  return { ...(metadata ?? {}), [METADATA_KEY]: { ...readAskState({ metadata: metadata ?? null } as ChatSession), ...next } };
}
