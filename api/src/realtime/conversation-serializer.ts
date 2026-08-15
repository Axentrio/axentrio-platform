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
}

/**
 * The one conversation-list row. `opts.lastMessage` is the preview when the
 * caller has it in hand (the REST batch query, or the message that was just
 * written); `null` means "known to have none" (a brand-new session). The async
 * fetch for callers that hold neither lives in conversation-events.
 */
export function serializeConversationSummary(
  session: ChatSession,
  opts: { lastMessage?: LastMessagePreview | null } = {},
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
    ...(agentRelationLoaded ? { assignedAgentName: session.assignedAgent?.userId ?? null } : {}),
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
