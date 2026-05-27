/**
 * DB helpers for the Copilot agent loop:
 *
 *   - `ensureActiveConversation` — partial-unique-index race-safe
 *     conversation row creation (round 3 #1).
 *   - `insertAtomicPair` — single tx that locks the conversation row,
 *     reserves two consecutive turn numbers, inserts user + assistant-
 *     placeholder rows, and bumps `next_turn` by 2 (round 5 #6).
 *     Detects the send-vs-clear race (round 6 #1) and retries up to
 *     once via `ensureActiveConversation`.
 *
 * Both helpers run as raw SQL through TypeORM's QueryRunner because
 * they need precise lock + ON CONFLICT control that the repository
 * API doesn't surface cleanly. The DB trigger
 * `trg_chatbot_copilot_messages_tenant_consistency` keeps these
 * inserts honest at the DB level.
 */
import type { DataSource } from 'typeorm';

export interface ActiveConversation {
  id: string;
  /** True when this call inserted a fresh row; false on race-loss path. */
  freshlyCreated: boolean;
}

export interface AtomicPair {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  userTurn: number;
  assistantTurn: number;
}

/**
 * Get the active conversation for `(tenantId, userId)`, inserting it
 * if missing. Two browser tabs firing simultaneously hit a partial-
 * unique-index race; `ON CONFLICT (cols) WHERE archived_at IS NULL
 * DO NOTHING` resolves that. On race-loss, we re-SELECT.
 */
export async function ensureActiveConversation(
  dataSource: DataSource,
  tenantId: string,
  userId: string,
): Promise<ActiveConversation> {
  const inserted = (await dataSource.query(
    `INSERT INTO chatbot_copilot_conversations (tenant_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, user_id) WHERE archived_at IS NULL DO NOTHING
     RETURNING id`,
    [tenantId, userId],
  )) as Array<{ id: string }>;
  if (inserted.length > 0) return { id: inserted[0].id, freshlyCreated: true };

  // Race-loss: someone else inserted the active row between our INSERT
  // and the conflict check. Read the survivor.
  const existing = (await dataSource.query(
    `SELECT id FROM chatbot_copilot_conversations
      WHERE tenant_id = $1 AND user_id = $2 AND archived_at IS NULL
      LIMIT 1`,
    [tenantId, userId],
  )) as Array<{ id: string }>;
  if (existing.length === 0) {
    throw new Error(
      `ensureActiveConversation: race resolved to neither inserted nor existing for (${tenantId}, ${userId})`,
    );
  }
  return { id: existing[0].id, freshlyCreated: false };
}

/**
 * Atomic insert of (user, assistant-placeholder) under a single
 * `SELECT ... FOR UPDATE` lock on the conversation row.
 *
 * Returns the inserted message ids + their turn numbers. The
 * assistant row starts at `outcome='pending'` with empty `content`
 * and `stream_started_at = now()`.
 *
 * If the conversation gets archived between resolution and the
 * insert tx (round 6 #1 send-vs-clear race), the tx ROLLBACKs and
 * we retry once against a freshly-resolved active conversation.
 * Second attempt against an archived target throws so the route
 * can return 409.
 */
export async function insertAtomicPair(
  dataSource: DataSource,
  tenantId: string,
  userId: string,
  userText: string,
): Promise<AtomicPair> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const conv = await ensureActiveConversation(dataSource, tenantId, userId);
    const inserted = await tryInsertAtomicPairUnderLock(dataSource, tenantId, conv.id, userText);
    if (inserted) return { conversationId: conv.id, ...inserted };
    // Conversation became archived between resolution + lock; ensure
    // a fresh active conv and retry once.
  }
  throw new ConversationClearedMidSendError(tenantId, userId);
}

/**
 * Take the conversation lock, verify it's still active, insert the
 * pair, return ids + turns. Returns `null` when the row was
 * archived under us — the caller retries with a freshly-resolved
 * conversation.
 */
async function tryInsertAtomicPairUnderLock(
  dataSource: DataSource,
  tenantId: string,
  conversationId: string,
  userText: string,
): Promise<Omit<AtomicPair, 'conversationId'> | null> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    const locked = (await qr.query(
      `SELECT next_turn, archived_at
         FROM chatbot_copilot_conversations
        WHERE id = $1
          FOR UPDATE`,
      [conversationId],
    )) as Array<{ next_turn: number; archived_at: string | null }>;
    if (locked.length === 0) {
      // Conversation row was hard-deleted (shouldn't happen — ON DELETE
      // CASCADE on tenant/user is the only path). Treat as race-loss.
      await qr.rollbackTransaction();
      return null;
    }
    if (locked[0].archived_at !== null) {
      // Send-vs-clear race: the clear handler archived this conv
      // between our resolution and lock. Roll back and let the
      // caller retry against the new active conversation.
      await qr.rollbackTransaction();
      return null;
    }

    const userTurn = locked[0].next_turn;
    const assistantTurn = userTurn + 1;

    const [user] = (await qr.query(
      `INSERT INTO chatbot_copilot_messages
        (conversation_id, tenant_id, turn, role, content)
       VALUES ($1, $2, $3, 'user', $4)
       RETURNING id`,
      [conversationId, tenantId, userTurn, userText],
    )) as Array<{ id: string }>;
    const [assistant] = (await qr.query(
      `INSERT INTO chatbot_copilot_messages
        (conversation_id, tenant_id, turn, role, content, outcome, stream_started_at)
       VALUES ($1, $2, $3, 'assistant', '', 'pending', now())
       RETURNING id`,
      [conversationId, tenantId, assistantTurn],
    )) as Array<{ id: string }>;
    await qr.query(
      `UPDATE chatbot_copilot_conversations
          SET next_turn = $1, updated_at = now()
        WHERE id = $2`,
      [assistantTurn + 1, conversationId],
    );

    await qr.commitTransaction();
    return {
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      userTurn,
      assistantTurn,
    };
  } catch (err) {
    await qr.rollbackTransaction();
    throw err;
  } finally {
    await qr.release();
  }
}

export class ConversationClearedMidSendError extends Error {
  readonly code = 'conversation_cleared_mid_send';
  constructor(
    readonly tenantId: string,
    readonly userId: string,
  ) {
    super(
      `Copilot send race: the active conversation for tenant ${tenantId}, user ${userId} ` +
        `was archived mid-send across two retries. Treat as user-driven cancellation; return 409.`,
    );
    this.name = 'ConversationClearedMidSendError';
  }
}
