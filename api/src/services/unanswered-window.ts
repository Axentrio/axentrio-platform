/**
 * Unanswered-window queries for the coalesced turn pipeline: everything the
 * coalescer, guardrails gate, and agent history need to know about which user
 * messages are still unanswered, bounded by the durable answer watermark.
 */
import { AppDataSource } from '../database/data-source';
import { Message } from '../database/entities/Message';
import type { ChatSession } from '../database/entities/ChatSession';
import { decrypt } from '../utils/encryption';

const messageRepository = AppDataSource.getRepository(Message);

/** Benign loser of a watermark race (rolls back the txn → no double reply). */
export class WatermarkConflictError extends Error {}

/**
 * Newest UNANSWERED user text/image message for a session — the live turn.
 * "Unanswered" is the durable tuple compare `(created_at, id) >
 * (lastCoalescedAnswerAt, lastCoalescedAnswerMessageId)`; when the watermark is
 * null the whole conversation qualifies (the clause is simply omitted, which is
 * null-safe by construction). Returns null when everything is answered.
 */
export async function getNewestUnansweredUserMessage(session: ChatSession): Promise<Message | null> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type IN ('text','image')")
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false');
  if (session.lastCoalescedAnswerMessageId) {
    // Compare the watermark DB-side: read its created_at from the row with full
    // microsecond precision. Passing session.lastCoalescedAnswerAt (a JS Date,
    // millisecond precision) truncates sub-ms µs, so the already-answered
    // watermark message re-qualifies as "unanswered" and the coalescer re-runs
    // the agent on it forever (re-arm storm → LLM/TPM saturation). Mirrors the
    // DB-side advance in finalizeReply. COALESCE falls back to the stored
    // last_coalesced_answer_at if the watermark message was hard-deleted, so the
    // bot doesn't silently stall (the subquery would otherwise return NULL).
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
    );
  }
  return qb.orderBy('m.createdAt', 'DESC').addOrderBy('m.id', 'DESC').limit(1).getOne();
}

/**
 * OLDEST unanswered user message (same watermark predicate, ascending). Used by
 * the custom-webhook recovery drain to forward a backlog oldest→newest one at a
 * time, advancing the watermark after each — so an arbitrarily large backlog is
 * forwarded exactly once with no message hidden behind the watermark.
 */
export async function getOldestUnansweredUserMessage(
  session: ChatSession,
  upToHwmId?: string,
): Promise<Message | null> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type IN ('text','image')")
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false');
  if (session.lastCoalescedAnswerMessageId) {
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
    );
  }
  // Upper bound: don't drain past the snapped hwm. Messages that arrive DURING a
  // (slow) drain are forwarded by their own ingress path — without this bound the
  // drain loop would re-forward them (double send).
  if (upToHwmId) {
    qb.andWhere(
      '(m.created_at, m.id) <= ((SELECT created_at FROM messages WHERE id = :upTo), :upTo)',
      { upTo: upToHwmId },
    );
  }
  return qb.orderBy('m.createdAt', 'ASC').addOrderBy('m.id', 'ASC').limit(1).getOne();
}

/**
 * All unanswered USER TEXT messages up to (and including) the hwm, oldest-first,
 * capped at `limit`. Used by the coalesced escalation scan to cover the WHOLE
 * burst (legacy checks each message individually), beyond the small guardrails
 * window. Returns plaintext is the caller's job (content stays encrypted here).
 */
export async function getUnansweredUserTextUpTo(
  session: ChatSession,
  hwmId: string,
  limit: number,
): Promise<Message[]> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type = 'text'")
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false')
    .andWhere(
      '(m.created_at, m.id) <= ((SELECT created_at FROM messages WHERE id = :hwmId), :hwmId)',
      { hwmId },
    );
  if (session.lastCoalescedAnswerMessageId) {
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
    );
  }
  return qb.orderBy('m.createdAt', 'ASC').addOrderBy('m.id', 'ASC').limit(limit).getMany();
}

/**
 * Count + first/last createdAt of the unanswered user messages — lets the
 * coalescer recompute `dueAt` from the DB when Redis turn:state was lost
 * (TTL/restart). Returns null when nothing is unanswered.
 */
export async function getUnansweredBounds(
  session: ChatSession,
): Promise<{ count: number; firstAt: Date; lastAt: Date } | null> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .select('COUNT(*)', 'cnt')
    .addSelect('MIN(m.created_at)', 'firstat')
    .addSelect('MAX(m.created_at)', 'lastat')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type IN ('text','image')")
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false');
  if (session.lastCoalescedAnswerMessageId) {
    // DB-side watermark comparison (full µs precision) — see the note in
    // getNewestUnansweredUserMessage.
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
    );
  }
  const raw = await qb.getRawOne<{ cnt: string; firstat: string; lastat: string }>();
  if (!raw || Number(raw.cnt) === 0) return null;
  return { count: Number(raw.cnt), firstAt: new Date(raw.firstat), lastAt: new Date(raw.lastat) };
}

/**
 * Conversation history bounded to `<= hwm` (and excluding the hwm message
 * itself, which is the live turn). The created_at is read DB-side from the hwm id
 * for microsecond fidelity. Messages that arrived AFTER the hwm are intentionally
 * left for their own future turn.
 */
export async function getCoalescedHistory(
  sessionId: string,
  hwmId: string,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const messages = await messageRepository
    .createQueryBuilder('message')
    .leftJoinAndSelect('message.participant', 'participant')
    .where('message.sessionId = :sid', { sid: sessionId })
    .andWhere('message.isDeleted = false')
    .andWhere("message.type IN ('text','image')")
    .andWhere('message.guardrailFlagged = false')
    .andWhere('message.id != :hwmId', { hwmId })
    .andWhere(
      '(message.created_at, message.id) <= ((SELECT created_at FROM messages WHERE id = :hwmId), :hwmId)',
      { hwmId },
    )
    .orderBy('message.createdAt', 'DESC')
    .addOrderBy('message.id', 'DESC')
    // One extra row beyond the 10-message window so we can tell whether older
    // history exists (and therefore whether the leading turn is the greeting).
    .take(11)
    .getMany();

  // `messages` is DESC; >10 means older history exists beyond the window.
  const hasOlder = messages.length > 10;
  const turns = messages
    .slice(0, 10)
    .reverse()
    .map((msg) => {
      const text = msg.contentEncrypted ? decrypt(msg.content) : msg.content;
      const content = msg.type === 'image' ? (text ? `[Image] ${text}` : '[Image]') : text;
      return {
        role: msg.participant?.type === 'bot' ? ('assistant' as const) : ('user' as const),
        content,
      };
    });

  // Drop the leading assistant turn ONLY when the window reaches the start of the
  // conversation — that leading assistant turn is the session greeting, a static
  // configured message (often the business default language) that would otherwise
  // anchor the model's reply language on turn 1. When older history exists, the
  // leading turn is a genuine assistant reply, so keep it.
  if (hasOlder) return turns;
  let start = 0;
  while (start < turns.length && turns[start].role === 'assistant') start++;
  return turns.slice(start);
}

/**
 * Unanswered USER messages in the coalesced window — `(watermark, hwm]`,
 * chronological — for the guardrails gate to vet every message that will be
 * answered or enter history (not just the hwm). Excludes already-flagged
 * messages; already-checked-clean ones are included but the gate no-ops them
 * (idempotent claim).
 *
 * Limit is 11 = the hwm + the 10 non-hwm rows getCoalescedHistory can include
 * (which uses `take(10)` AFTER excluding the hwm). That guarantees every user
 * message the agent could see — answered turn OR history — is gated, with no
 * off-by-one (codex review).
 */
export async function getUnansweredUserWindow(session: ChatSession, hwmId: string): Promise<Message[]> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .leftJoinAndSelect('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type IN ('text','image')")
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false')
    .andWhere(
      '(m.created_at, m.id) <= ((SELECT created_at FROM messages WHERE id = :hwmId), :hwmId)',
      { hwmId },
    );
  if (session.lastCoalescedAnswerMessageId) {
    // COALESCE to the stored date if the watermark message was hard-deleted — see
    // getNewestUnansweredUserMessage.
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
    );
  }
  const rows = await qb.orderBy('m.createdAt', 'DESC').addOrderBy('m.id', 'DESC').take(11).getMany();
  return rows.reverse();
}
