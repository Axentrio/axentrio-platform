/**
 * Normalized realtime conversation events (B-PR3a, pilot-operations capability
 * B4). Two events, ONE payload shape each, emitted from every convergence
 * point to BOTH rooms — the tenant agents room `agents:${tenantId}` (inbox
 * list) and the per-session room `${tenantId}:${sessionId}` (open detail):
 *
 *   conversation:upsert  { conversation: ConversationSummaryDto, revision }
 *   message:created      { sessionId, message: MessageDto, conversationRevision }
 *
 * Rules:
 *  - ADDITIVE: every legacy emit (message:new / message:receive / handoff:* /
 *    session:closed / ...) stays exactly as it was; these fire alongside.
 *  - Emitted only AFTER the DB transaction commits — call sites own that.
 *  - Fail-safe: an emit can never throw into (or roll back) the write path.
 *  - No full-entity save(session) anywhere near this: helpers only READ.
 *
 * The payload shape itself lives in ./conversation-serializer, which is also
 * what the REST `GET /chat/sessions` row mapper calls — the two surfaces
 * cannot diverge.
 */

import type { ChatSession } from '../database/entities/ChatSession';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
import { logger } from '../utils/logger';
import {
  serializeConversationSummary,
  serializeMessage,
  conversationRevision,
  previewFromRaw,
  type CustomerThreadBinding,
  type LastMessagePreview,
  type MessageDtoInput,
} from './conversation-serializer';

export const CONVERSATION_UPSERT_EVENT = 'conversation:upsert';
export const MESSAGE_CREATED_EVENT = 'message:created';

/**
 * Latest-message preview for one session — the single-session twin of the
 * chat.routes batch DISTINCT ON query, decrypting through the same
 * previewFromRaw. Lazy data-source import keeps this module's static import
 * graph tiny (vi.mock hoisting / load-order safety; see the
 * notification-socket-import gotcha).
 */
async function fetchLastMessagePreview(sessionId: string): Promise<LastMessagePreview | null> {
  const { AppDataSource } = await import('../database/data-source');
  const rows = (await AppDataSource.query(
    `SELECT m.id, m.content, m.content_encrypted AS encrypted, p.type AS sender_type
       FROM messages m
       LEFT JOIN participants p ON p.id = m.participant_id
      WHERE m.session_id = $1
      ORDER BY m.created_at DESC
      LIMIT 1`,
    [sessionId],
  )) as Array<{ id: string; content: string | null; encrypted: boolean | null; sender_type: string | null }>;
  if (!rows.length) return null;
  return previewFromRaw({
    id: rows[0].id,
    content: rows[0].content,
    encrypted: rows[0].encrypted,
    senderType: rows[0].sender_type,
  });
}

/**
 * Binding facts for the customerThreadId projection (B-PR4a). Widget sessions
 * compute their key from the session row alone - no query. External sessions
 * need their conversation_bindings row; newest wins on the (theoretical)
 * multi-binding case. Same lazy-import discipline as fetchLastMessagePreview.
 *
 * Perf note: this is one indexed lookup per upsert emit for EXTERNAL sessions
 * only. If an external hot path that already holds its binding ever needs to
 * shed it, extend emitConversationUpsert's opts with a `binding` pass-through
 * (mirroring `lastMessage`) instead of widening call sites ad hoc.
 */
async function fetchThreadBinding(session: ChatSession): Promise<CustomerThreadBinding | null> {
  if (session.source === 'widget') return null;
  const { AppDataSource } = await import('../database/data-source');
  const { ConversationBinding } = await import('../database/entities/ConversationBinding');
  const binding = await AppDataSource.getRepository(ConversationBinding).findOne({
    where: { sessionId: session.id },
    order: { createdAt: 'DESC' },
  });
  return binding
    ? {
        channelConnectionId: binding.channelConnectionId,
        externalUserId: binding.externalUserId,
        externalThreadId: binding.externalThreadId,
      }
    : null;
}

/**
 * Emit `conversation:upsert` for a session entity the caller already holds
 * (post-commit). `opts.lastMessage`: pass the preview when in hand (the
 * message just written), pass `null` for a brand-new session (skips the
 * fetch), omit to have the latest message looked up. The revision is the
 * emit-time clock for EVERY event type (see conversationRevision), so a
 * create-upsert can never outrank the message emit that follows it.
 */
export async function emitConversationUpsert(
  session: ChatSession,
  opts: { lastMessage?: LastMessagePreview | null } = {},
): Promise<void> {
  try {
    const lastMessage =
      opts.lastMessage !== undefined ? opts.lastMessage : await fetchLastMessagePreview(session.id);
    const binding = await fetchThreadBinding(session);
    const payload = {
      conversation: serializeConversationSummary(session, { lastMessage, binding }),
      revision: conversationRevision(),
    };
    // SAME payload to both rooms — the plan forbids per-room wrapping.
    emitToTenantAgents(session.tenantId, CONVERSATION_UPSERT_EVENT, payload);
    emitToSession(session.tenantId, session.id, CONVERSATION_UPSERT_EVENT, payload);
  } catch (err) {
    logger.error('[realtime] conversation:upsert emit failed', {
      sessionId: session.id,
      tenantId: session.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fresh read of a session for serialization — WITH the assignedAgent relation,
 * so the summary matches the REST list. READ ONLY; never introduces a save.
 * `tenantId` scopes the lookup when known; system sweeps omit it.
 */
export async function loadConversationForEmit(
  sessionId: string,
  tenantId?: string,
): Promise<ChatSession | null> {
  const { AppDataSource } = await import('../database/data-source');
  const { ChatSession: ChatSessionEntity } = await import('../database/entities/ChatSession');
  return AppDataSource.getRepository(ChatSessionEntity).findOne({
    where: tenantId ? { id: sessionId, tenantId } : { id: sessionId },
    relations: ['assignedAgent', 'assignedAgent.user'],
  });
}

/**
 * Emit `conversation:upsert` when the caller only holds a session id
 * (post-commit blocks of the REST command routes).
 */
export async function emitConversationUpsertForSession(
  sessionId: string,
  tenantId?: string,
): Promise<void> {
  try {
    const fresh = await loadConversationForEmit(sessionId, tenantId);
    if (!fresh) return;
    await emitConversationUpsert(fresh);
  } catch (err) {
    logger.error('[realtime] conversation:upsert (by id) emit failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit `message:created` + `conversation:upsert` when the caller only holds a
 * session id and the committed message facts (the operator REST reply). The
 * WHOLE block — the fresh re-select and both emits — is fail-safe: a DB
 * hiccup here is logged and never becomes a 500 on a request whose message
 * already committed.
 */
export async function emitMessageCreatedForSession(
  sessionId: string,
  tenantId: string | undefined,
  message: MessageDtoInput,
): Promise<void> {
  try {
    const fresh = await loadConversationForEmit(sessionId, tenantId);
    if (!fresh) return;
    emitMessageCreated(fresh, message);
    await emitConversationUpsert(fresh, {
      lastMessage: { content: message.content, senderType: message.senderType },
    });
  } catch (err) {
    logger.error('[realtime] message:created (by id) emit failed', {
      sessionId,
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit `message:created` (post-commit). `message.content` is PLAINTEXT — the
 * same wire convention as the existing message:receive. The revision is the
 * emit-time clock, same as every conversation:upsert.
 */
export function emitMessageCreated(
  session: ChatSession,
  message: MessageDtoInput,
): void {
  try {
    const payload = {
      sessionId: session.id,
      message: serializeMessage({ ...message, sessionId: message.sessionId || session.id }),
      conversationRevision: conversationRevision(),
    };
    emitToTenantAgents(session.tenantId, MESSAGE_CREATED_EVENT, payload);
    emitToSession(session.tenantId, session.id, MESSAGE_CREATED_EVENT, payload);
  } catch (err) {
    logger.error('[realtime] message:created emit failed', {
      sessionId: session.id,
      tenantId: session.tenantId,
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
