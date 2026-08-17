/**
 * Conversation serializer (B-PR3a) — the ONE shape shared by the REST inbox
 * list (`GET /chat/sessions`) and the normalized realtime events
 * (`conversation:upsert`, `message:created`).
 *
 * The REST row mapper that used to live inline in chat.routes.ts is extracted
 * here and the route calls it, so the socket payload and the REST list row can
 * never diverge. The serializer output is a strict SUPERSET of the legacy row:
 * every legacy key is kept byte-for-byte, and the B-PR3a additions (tenantId,
 * botId, ownership, ownershipVersion, assignedAgentId, channel) are appended.
 *
 * This module is PURE (no DB, no sockets) so both the route and the emit
 * helpers can use it without import cycles. DB reads and socket fan-out live in
 * ./conversation-events.
 */

import type { ChatSession } from '../database/entities/ChatSession';
import type { Agent } from '../database/entities/Agent';
import { decrypt } from '../utils/encryption';

/** Same truncation the REST list has always applied to the preview column. */
export const CONVERSATION_PREVIEW_CHARS = 80;

export interface LastMessagePreview {
  /** Plaintext, truncated to CONVERSATION_PREVIEW_CHARS by the serializer. */
  content: string;
  senderType: string;
}

/**
 * Build a LastMessagePreview from a raw last-message row (content possibly
 * encrypted). Extracted from the chat.routes batch loop so the single-session
 * fetch in conversation-events decrypts and falls back identically.
 */
export function previewFromRaw(row: {
  id: string;
  content: string | null;
  encrypted: boolean | null;
  senderType?: string | null;
}): LastMessagePreview {
  let content = row.content || '';
  if (row.encrypted && content) {
    try {
      content = decrypt(content, row.id);
    } catch {
      content = '[encrypted]';
    }
  }
  return {
    content: content.substring(0, CONVERSATION_PREVIEW_CHARS),
    senderType: row.senderType || 'user',
  };
}

/**
 * The binding facts needed to compute an external customerThreadId. A subset
 * of ConversationBinding, so callers can pass either the entity or a raw row.
 */
export interface CustomerThreadBinding {
  channelConnectionId: string;
  externalUserId: string;
  externalThreadId: string;
}

/**
 * The COMPUTED durable customer-thread key (B-PR4a §5). Never materialized -
 * the user decision is that external identity stays in conversation_bindings
 * and widget identity stays in (tenant_id, bot_id, visitor_id); this
 * projection just names the group so B-PR4b can render one thread.
 *
 *   widget    w:{tenantId}:{botId}:{visitorId}
 *   external  e:{channelConnectionId}:{externalUserId}:{externalThreadId}
 *             (Telegram DM vs group chat differ on externalThreadId, so they
 *              stay separate threads - same uniqueness the binding table has)
 *   fallback  s:{sessionId} when an external session has no binding AND no
 *             stamped identity triple on the row
 *
 * External reopen note: the inbound pipeline REASSIGNS the single binding
 * row to the new session, so prior sessions lose their binding. Those rows
 * still carry the identity facts the pipeline stamped at create time
 * (channelConnectionId + visitorId + metadata.customData.externalThreadId).
 * When all three are present and non-empty the key is the SAME e: shape the
 * bound sibling emits, so list grouping and /thread agree. An incomplete or
 * empty component must NEVER become e: — that would match on ''/NULL and
 * silently join unrelated sessions (same rule as resolveThreadIdentity).
 *
 * Discriminates on source === 'widget' - the same predicate the partial
 * unique index uses - so the projection and the invariant agree on which
 * sessions are widget sessions.
 */
export function computeCustomerThreadId(
  session: Pick<
    ChatSession,
    'id' | 'tenantId' | 'botId' | 'visitorId' | 'source' | 'channelConnectionId' | 'metadata'
  >,
  binding?: CustomerThreadBinding | null,
): string {
  if (session.source === 'widget') {
    return `w:${session.tenantId}:${session.botId}:${session.visitorId}`;
  }
  const candidate = binding ?? stampedExternalBinding(session);
  if (
    candidate &&
    candidate.channelConnectionId &&
    candidate.externalUserId &&
    candidate.externalThreadId
  ) {
    return `e:${candidate.channelConnectionId}:${candidate.externalUserId}:${candidate.externalThreadId}`;
  }
  return `s:${session.id}`;
}

/** Stamped-facts fallback used when an external session has no binding row.
 *  Mirrors resolveThreadIdentity in chat.routes.ts — same triple, same empty
 *  check, so list keys and /thread keys stay identical. */
function stampedExternalBinding(
  session: Pick<ChatSession, 'channelConnectionId' | 'visitorId' | 'metadata'>,
): CustomerThreadBinding | null {
  const metaThreadId = session.metadata?.customData?.externalThreadId;
  if (!session.channelConnectionId || !session.visitorId || typeof metaThreadId !== 'string') {
    return null;
  }
  return {
    channelConnectionId: session.channelConnectionId,
    externalUserId: session.visitorId,
    externalThreadId: metaThreadId,
  };
}

export function resolveAssignedAgentName(agent: Agent | null | undefined): string | null {
  if (!agent) return null;
  if (agent.user === undefined) return agent.userId;
  return agent.user.name || agent.user.email || agent.userId;
}

export interface ConversationSummaryDto {
  // ── Legacy GET /chat/sessions row (unchanged keys and semantics) ──────────
  id: string;
  sessionId: string;
  status: ChatSession['status'];
  aiAutoReplyEnabled: boolean;
  guardrailStatus: string;
  userName: string;
  assignedAgent: { id: string } | null;
  /**
   * Relation-only field: present ONLY when the assignedAgent relation was
   * loaded on the serialized entity (the REST list and the ownership emits
   * load it; message hot paths do not). OMITTED — not null — when unknown, so
   * a partial summary can never clobber a known name on the client. B-PR3b's
   * list patch merges defined fields only and refetches on reconnect/focus.
   */
  assignedAgentName?: string | null;
  messageCount: number;
  lastMessage: string | null;
  lastMessageSender: string | null;
  lastMessageAt: Date | null;
  lastActivityAt: Date;
  source: string;
  createdAt: Date;
  // ── B-PR3a additions (additive; the shipped portal ignores unknown keys) ──
  tenantId: string;
  botId: string;
  ownership: ChatSession['ownership'];
  ownershipVersion: number;
  assignedAgentId: string | null;
  channel: string;
  // ── B-PR4a addition (additive; shipped clients ignore unknown keys) ───────
  /** Durable customer-thread key - see computeCustomerThreadId. */
  customerThreadId: string;
  // ── B-PR5a additions (additive; shipped clients ignore unknown keys) ──────
  // The timed human-control facts, so the portal countdown (B-PR5b) can render
  // and update from the same conversation:upsert every ownership change emits.
  humanControlMode: 'timed' | 'indefinite' | null;
  humanControlDurationHours: number | null;
  humanControlUntil: Date | null;
}

/**
 * The one conversation-list row. `opts.lastMessage` is the preview when the
 * caller has it in hand (the REST batch query, or the message that was just
 * written); `null` means "known to have none" (a brand-new session). The async
 * fetch for callers that hold neither lives in conversation-events.
 */
export function serializeConversationSummary(
  session: ChatSession,
  opts: {
    lastMessage?: LastMessagePreview | null;
    /**
     * Binding facts for EXTERNAL sessions (B-PR4a). Widget sessions never
     * need it. When omitted/null, computeCustomerThreadId falls back to the
     * stamped identity triple on the session row (channel reopen priors);
     * only an incomplete triple degrades to s:{sessionId}.
     */
    binding?: CustomerThreadBinding | null;
  } = {},
): ConversationSummaryDto {
  const last = opts.lastMessage ?? null;
  // The REST list loads the assignedAgent relation; most emit sites only hold
  // the FK column. Same value either way (the relation is loaded by that FK).
  const assignedAgentId = session.assignedAgent?.id ?? session.assignedAgentId ?? null;
  // Relation-only field: `undefined` means NOT LOADED (message hot paths) and
  // the key is omitted; a loaded-but-empty relation is `null` and serializes
  // as an honest null. Never emit null for "unknown".
  const agentRelationLoaded = session.assignedAgent !== undefined;
  return {
    id: session.id,
    sessionId: session.id,
    status: session.status,
    aiAutoReplyEnabled: session.aiAutoReplyEnabled,
    guardrailStatus: session.guardrailStatus,
    userName: `Visitor ${session.visitorId?.substring(0, 8) || 'Anonymous'}`,
    assignedAgent: assignedAgentId ? { id: assignedAgentId } : null,
    ...(agentRelationLoaded ? { assignedAgentName: resolveAssignedAgentName(session.assignedAgent) } : {}),
    messageCount: session.messageCount,
    lastMessage: last ? last.content.substring(0, CONVERSATION_PREVIEW_CHARS) : null,
    lastMessageSender: last ? last.senderType || 'user' : null,
    // Legacy semantics kept exactly: the list has always reported the
    // session's own activity clock here, whether or not a preview exists.
    lastMessageAt: session.lastActivityAt ?? null,
    lastActivityAt: session.lastActivityAt,
    source: session.source,
    createdAt: session.createdAt,
    tenantId: session.tenantId,
    botId: session.botId,
    ownership: session.ownership,
    ownershipVersion: session.ownershipVersion ?? 0,
    assignedAgentId,
    channel: session.channel,
    customerThreadId: computeCustomerThreadId(session, opts.binding ?? null),
    humanControlMode: session.humanControlMode ?? null,
    humanControlDurationHours: session.humanControlDurationHours ?? null,
    humanControlUntil: session.humanControlUntil ?? null,
  };
}

export interface MessageDtoInput {
  id: string;
  sessionId: string;
  /** Message.type ('text' | 'image' | 'file' | 'system'). */
  type: string;
  /** PLAINTEXT — matches the existing message:receive wire convention. */
  content: string;
  senderType: 'user' | 'agent' | 'bot' | 'system' | string;
  status?: string;
  createdAt?: Date | string;
  metadata?: Record<string, unknown>;
}

export interface MessageDto {
  id: string;
  sessionId: string;
  type: string;
  content: string;
  senderType: string;
  /** Alias of senderType — the legacy message:new payloads used both names. */
  sender: string;
  status: string;
  createdAt: Date | string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** The ONE MessageDto every `message:created` emit carries (the three legacy
 *  message:new sites disagreed on fields; this contract does not). */
export function serializeMessage(input: MessageDtoInput): MessageDto {
  const createdAt = input.createdAt ?? new Date();
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: input.type || 'text',
    content: input.content,
    senderType: input.senderType,
    sender: input.senderType,
    status: input.status ?? 'sent',
    createdAt,
    timestamp: new Date(createdAt).toISOString(),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

/**
 * Client-side dedup/ordering revision: epoch-ms of ONE consistent clock — the
 * emit time (`at` defaults to `new Date()` when the event is built). Every
 * event type uses this same clock, so revisions are non-decreasing per
 * conversation within a process; a stale in-memory column (e.g.
 * lastActivityAt loaded before a concurrent write) can never outrank a later
 * emit. The client dedups with strict `<` — equal revisions in the same ms
 * are applied, not dropped. A DB-generated per-write revision counter is a
 * later hardening; this PR adds no migration.
 */
export function conversationRevision(at?: Date): number {
  return (at ?? new Date()).getTime();
}
