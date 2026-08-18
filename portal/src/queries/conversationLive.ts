/**
 * conversationLive — the ONE place the B-PR3a realtime events and the REST
 * command responses are folded into the React Query cache (B-PR3b).
 *
 * Responsibilities:
 *  - Status vocabulary: the backend speaks 'active'|'closed'|'waiting'|
 *    'handoff'|'bot'; the portal UI speaks 'human'|'closed'|'pending'|
 *    'handsoff'|'bot'. Everything ENTERING the cache is normalized to the
 *    portal vocabulary (normalizeChatStatus); everything LEAVING toward the
 *    server is remapped by buildChatListParams. Admission of a live upsert
 *    into a cached list variant compares BACKEND vocab against the variant's
 *    (already remapped) query-key params — one vocabulary end to end.
 *  - applyConversationUpsert: upsert the summary into EVERY cached chat-list
 *    variant (insert / merge-defined / remove-on-mismatch, re-sort by
 *    lastActivityAt desc) + the detail cache. Strict `<` revision dedupe.
 *  - applyMessageCreated: append to the detail cache deduped by message id
 *    (and reconcile the operator's optimistic bubble), patch the list rows'
 *    preview. Message appends are NEVER revision-gated — only summary patches.
 *  - applyCommandConversation: fold a POST command response's reduced summary
 *    into the caches (drops the follow-up GET /chats/:id).
 *  - useLiveConversationSync: the single mount point that registers the
 *    socket handlers + reconnect/focus catch-up invalidation.
 */

import { useEffect, useRef } from 'react';
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import { useSocket } from '@websocket/SocketContext';
import { useNotificationSound } from '@websocket/notificationSound';
import type {
  Chat,
  ChatStatus,
  Message,
  MessageSender,
  MessageType,
  ConversationSummaryPayload,
  ConversationUpsertEvent,
  MessageCreatedEvent,
  MessageCreatedPayload,
  CommandConversationSummary,
} from '@app-types/index';

// ---------------------------------------------------------------------------
// Cache entry shapes (mirrors useChatQueries)
// ---------------------------------------------------------------------------

export interface ChatListCacheEntry {
  data: Chat[];
  meta?: { total: number; totalPages: number };
  pagination?: { total: number; totalPages: number };
}

export interface ChatDetailCacheEntry extends Omit<Chat, 'messages'> {
  messages?: Message[];
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/** Backend SessionStatus → portal ChatStatus. Portal values pass through. */
export function normalizeChatStatus(status: string | undefined): ChatStatus {
  switch (status) {
    case 'handoff':
    case 'handsoff':
      return 'handsoff';
    case 'active':
    case 'human':
      return 'human';
    case 'waiting':
    case 'pending':
      return 'pending';
    case 'closed':
      return 'closed';
    default:
      return 'bot';
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC4122-ish fallback for very old runtimes.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Merge only DEFINED fields of `patch` into `base`. `null` IS applied (an
 * honest "cleared" value, e.g. assignedAgentName after a release); `undefined`
 * (an omitted key, e.g. assignedAgentName when the relation was not loaded)
 * never clobbers a known value.
 */
export function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
  const next: T = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

function activityTime(chat: Chat): number {
  const at = chat.lastActivityAt || chat.lastMessageAt;
  return at ? new Date(at).getTime() : 0;
}

function sortByActivityDesc(rows: Chat[]): Chat[] {
  return [...rows].sort((a, b) => activityTime(b) - activityTime(a));
}

// ---------------------------------------------------------------------------
// Payload → portal shapes
// ---------------------------------------------------------------------------

/**
 * Partial Chat patch from an upsert summary: only fields the payload DEFINES,
 * status normalized to the portal vocabulary.
 */
export function summaryToChatPatch(dto: ConversationSummaryPayload): Partial<Chat> & { id: string } {
  const patch: Partial<Chat> & { id: string } = {
    id: dto.id ?? dto.sessionId,
    sessionId: dto.sessionId ?? dto.id,
    status: normalizeChatStatus(dto.status),
  };
  if (dto.tenantId !== undefined) patch.tenantId = dto.tenantId;
  if (dto.userName !== undefined) patch.userName = dto.userName;
  if (dto.aiAutoReplyEnabled !== undefined) patch.aiAutoReplyEnabled = dto.aiAutoReplyEnabled;
  if (dto.guardrailStatus !== undefined) patch.guardrailStatus = dto.guardrailStatus;
  if (dto.assignedAgentId !== undefined) patch.assignedAgentId = dto.assignedAgentId;
  if (dto.assignedAgentName !== undefined) patch.assignedAgentName = dto.assignedAgentName;
  if (dto.messageCount !== undefined) patch.messageCount = dto.messageCount;
  if (dto.lastMessage !== undefined) patch.lastMessage = dto.lastMessage;
  if (dto.lastMessageSender !== undefined) patch.lastMessageSender = dto.lastMessageSender;
  if (dto.lastMessageAt !== undefined) patch.lastMessageAt = dto.lastMessageAt ?? undefined;
  if (dto.lastActivityAt !== undefined) patch.lastActivityAt = dto.lastActivityAt;
  if (dto.createdAt !== undefined) patch.createdAt = dto.createdAt;
  if (dto.ownership !== undefined) patch.ownership = dto.ownership;
  if (dto.ownershipVersion !== undefined) patch.ownershipVersion = dto.ownershipVersion;
  if (dto.channel !== undefined) patch.channel = dto.channel;
  if (dto.botId !== undefined) patch.botId = dto.botId;
  if (dto.customerThreadId !== undefined) patch.customerThreadId = dto.customerThreadId;
  if (dto.humanControlMode !== undefined) patch.humanControlMode = dto.humanControlMode;
  if (dto.humanControlDurationHours !== undefined) {
    patch.humanControlDurationHours = dto.humanControlDurationHours;
  }
  if (dto.humanControlUntil !== undefined) patch.humanControlUntil = dto.humanControlUntil;
  return patch;
}

/** Minimal detail entry so a live message / optimistic send can land before GET /chats/:id. */
export function seedChatDetail(
  id: string,
  patch: Partial<ChatDetailCacheEntry> = {},
): ChatDetailCacheEntry {
  return {
    id,
    sessionId: id,
    tenantId: '',
    userId: '',
    status: 'bot',
    metadata: { source: 'widget' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

/** Full new list row from an upsert summary (insert path). */
function summaryToChatRow(dto: ConversationSummaryPayload): Chat {
  const patch = summaryToChatPatch(dto);
  const base: Chat = {
    id: patch.id,
    sessionId: patch.sessionId ?? patch.id,
    tenantId: dto.tenantId ?? '',
    userId: '',
    status: patch.status ?? 'bot',
    messages: [],
    metadata: { source: dto.source ?? 'widget' },
    createdAt: dto.createdAt ?? new Date().toISOString(),
    updatedAt: dto.lastActivityAt ?? dto.createdAt ?? new Date().toISOString(),
  };
  return mergeDefined(base, patch);
}

/** Reduced POST-response summary → partial Chat patch (portal vocabulary). */
export function commandSummaryToChatPatch(
  summary: CommandConversationSummary,
): Partial<Chat> & { id: string } {
  const patch: Partial<Chat> & { id: string } = {
    id: summary.sessionId,
    sessionId: summary.sessionId,
    status: normalizeChatStatus(summary.status),
    assignedAgentId: summary.assignedAgentId,
    ownership: summary.ownership,
    ownershipVersion: summary.ownershipVersion,
  };
  // B-PR5b: the human-control policy the command committed (defined-only, so
  // an older API that omits the fields never clobbers a known value).
  if (summary.humanControlMode !== undefined) patch.humanControlMode = summary.humanControlMode;
  if (summary.humanControlDurationHours !== undefined) {
    patch.humanControlDurationHours = summary.humanControlDurationHours;
  }
  if (summary.humanControlUntil !== undefined) patch.humanControlUntil = summary.humanControlUntil;
  return patch;
}

/** Socket message payload → portal Message. The operator reply carries its
 *  clientMessageId in `metadata` (the server-side dedupe key) — surfacing it
 *  lets the sender reconcile the optimistic bubble by IDENTITY. */
export function messagePayloadToMessage(dto: MessageCreatedPayload): Message {
  const metaClientMessageId = dto.metadata?.clientMessageId;
  return {
    id: dto.id,
    chatId: dto.sessionId,
    type: (dto.type || 'text') as MessageType,
    content: dto.content,
    sender: (dto.senderType || dto.sender || 'user') as MessageSender,
    isRead: false,
    createdAt: dto.createdAt ?? dto.timestamp ?? new Date().toISOString(),
    ...(typeof metaClientMessageId === 'string' && metaClientMessageId
      ? { clientMessageId: metaClientMessageId }
      : {}),
    ...(dto.status === 'failed' ? { deliveryState: 'failed' as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// Revision / ownership registries (scoped to ONE QueryClient lifetime)
// ---------------------------------------------------------------------------

/** Highest applied `revision` per conversation id. Strict `<` drops a stale upsert. */
const appliedRevisions = new Map<string, number>();

/**
 * Highest applied `ownershipVersion` per conversation id — a SERVER-side
 * monotonic counter (no clock). A command response advances it, so a delayed
 * pre-command `conversation:upsert` can never regress just-confirmed
 * ownership (its ownership-bearing fields are stripped; see
 * applyConversationUpsert).
 */
const appliedOwnershipVersions = new Map<string, number>();

/**
 * The registries must not outlive the QueryClient (re-login / tenant switch
 * builds a new client with an empty cache — stale revisions would wrongly
 * drop that tenant's events). Every apply* call re-binds; a client change
 * starts clean.
 */
let boundClient: QueryClient | null = null;
function ensureRegistriesFor(client: QueryClient): void {
  if (boundClient !== client) {
    boundClient = client;
    appliedRevisions.clear();
    appliedOwnershipVersions.clear();
  }
}

/** Test hook: clears the module-level registries + the client binding. */
export function __resetConversationLiveState(): void {
  boundClient = null;
  appliedRevisions.clear();
  appliedOwnershipVersions.clear();
}

// ---------------------------------------------------------------------------
// List-variant iteration
// ---------------------------------------------------------------------------

const LIST_KEY_PREFIX = [...queryKeys.chats.all(), 'list'] as const;

type ListParams = Record<string, string> | undefined;

/**
 * Filters we can evaluate client-side against an upsert payload. `search` /
 * `dateFrom` / `dateTo` are server-side-only: those variants still get
 * merges and evaluable removals, but never a live INSERT (a refetch owns it).
 */
function hasOpaqueFilter(params: ListParams): boolean {
  return !!(params && (params.search || params.dateFrom || params.dateTo));
}

/** Does the summary belong in the variant, judged on the evaluable filters?
 *  BOTH sides use the backend vocabulary: `params` were remapped by
 *  buildChatListParams before they became the query key. A dto dimension the
 *  payload OMITS counts as "cannot disprove" here — this drives merges and
 *  removals, where keeping the row on unknown is the safe direction. */
function matchesVariant(params: ListParams, dto: ConversationSummaryPayload): boolean {
  if (!params) return true;
  if (params.status && params.status !== dto.status) return false;
  if (params.tenantId && dto.tenantId !== undefined && params.tenantId !== dto.tenantId) return false;
  if (
    params.assignedAgentId &&
    dto.assignedAgentId !== undefined &&
    params.assignedAgentId !== dto.assignedAgentId
  ) {
    return false;
  }
  return true;
}

/**
 * May a NEW row be inserted into this variant? Stricter than matchesVariant:
 * every filter dimension the params carry must be POSITIVELY satisfied by the
 * payload (an omitted dto dimension disqualifies), the variant must not be
 * opaquely filtered (search/date — server-side only), and it must be page 1
 * (or unpaginated): later pages must never receive the newest row, and their
 * totals must never be bumped for a row they do not contain.
 */
function canInsertInto(params: ListParams, dto: ConversationSummaryPayload): boolean {
  if (hasOpaqueFilter(params)) return false;
  if (params?.page && params.page !== '1') return false;
  if (params?.status && params.status !== dto.status) return false;
  if (params?.tenantId && dto.tenantId !== params.tenantId) return false;
  if (params?.assignedAgentId && dto.assignedAgentId !== params.assignedAgentId) return false;
  return true;
}

function forEachListVariant(
  queryClient: QueryClient,
  fn: (key: readonly unknown[], params: ListParams, entry: ChatListCacheEntry) => void,
): void {
  const entries = queryClient.getQueriesData<ChatListCacheEntry>({
    queryKey: LIST_KEY_PREFIX as unknown as unknown[],
  });
  for (const [key, entry] of entries) {
    if (!entry) continue;
    fn(key, key[2] as ListParams, entry);
  }
}

function withTotalDelta(entry: ChatListCacheEntry, rows: Chat[], delta: number): ChatListCacheEntry {
  const next: ChatListCacheEntry = { ...entry, data: rows };
  if (delta !== 0 && next.meta) {
    next.meta = { ...next.meta, total: Math.max(0, (next.meta.total ?? 0) + delta) };
  }
  if (delta !== 0 && next.pagination) {
    next.pagination = { ...next.pagination, total: Math.max(0, (next.pagination.total ?? 0) + delta) };
  }
  return next;
}

// ---------------------------------------------------------------------------
// applyConversationUpsert
// ---------------------------------------------------------------------------

/**
 * Fold a `conversation:upsert` into every cached list variant + the detail
 * cache. Returns the SANITIZED patch that was applied (revision-gated,
 * ownership-stale fields stripped) so the caller can apply the exact same
 * patch to any component-state copy of the row (the open Inbox pane) —
 * rebuilding a patch from the raw event would bypass the ownership gate and
 * could resurrect just-cleared human-control state. Returns null when the
 * event was dropped as stale (strict `<` revision).
 */
export function applyConversationUpsert(
  queryClient: QueryClient,
  event: ConversationUpsertEvent,
): (Partial<Chat> & { id: string }) | null {
  ensureRegistriesFor(queryClient);
  const dto = event?.conversation;
  if (!dto) return null;
  const id = dto.id ?? dto.sessionId;
  if (!id) return null;

  const applied = appliedRevisions.get(id);
  if (typeof event.revision === 'number') {
    if (applied !== undefined && event.revision < applied) return null;
    appliedRevisions.set(id, event.revision);
  }

  // Ownership gate (server-monotonic ownershipVersion, no clocks): a delayed
  // pre-command upsert must never regress a just-confirmed ownership. When
  // stale, its ownership-bearing fields are stripped and it cannot move rows
  // between variants — the non-ownership facts (preview, activity) still merge.
  const ownershipGate = appliedOwnershipVersions.get(id);
  const ownershipStale =
    dto.ownershipVersion !== undefined &&
    ownershipGate !== undefined &&
    dto.ownershipVersion < ownershipGate;
  if (!ownershipStale && dto.ownershipVersion !== undefined) {
    appliedOwnershipVersions.set(id, dto.ownershipVersion);
  }

  let patch = summaryToChatPatch(dto);
  if (ownershipStale) {
    const {
      status: _status,
      ownership: _ownership,
      ownershipVersion: _ownershipVersion,
      assignedAgentId: _assignedAgentId,
      assignedAgentName: _assignedAgentName,
      // The human-control policy is written by the same ownership commands —
      // a stale upsert must not regress a just-changed duration either.
      humanControlMode: _humanControlMode,
      humanControlDurationHours: _humanControlDurationHours,
      humanControlUntil: _humanControlUntil,
      ...rest
    } = patch;
    patch = rest as typeof patch;
  }

  forEachListVariant(queryClient, (key, params, entry) => {
    const rows = entry.data ?? [];
    const index = rows.findIndex((c) => c.id === id);

    if (index >= 0) {
      // MERGE is always safe (defined fields only) — admission moves below.
      if (!ownershipStale && !matchesVariant(params, dto)) {
        queryClient.setQueryData(
          key,
          withTotalDelta(entry, rows.filter((c) => c.id !== id), -1),
        );
        return;
      }
      const next = [...rows];
      next[index] = mergeDefined(next[index], patch);
      queryClient.setQueryData(key, withTotalDelta(entry, sortByActivityDesc(next), 0));
      return;
    }

    // Row absent. A stale-ownership event must not place rows anywhere.
    if (ownershipStale || !matchesVariant(params, dto)) return;
    if (canInsertInto(params, dto)) {
      const next = sortByActivityDesc([summaryToChatRow(dto), ...rows]);
      queryClient.setQueryData(key, withTotalDelta(entry, next, 1));
    } else if (hasOpaqueFilter(params)) {
      // The conversation MIGHT belong to this server-side-filtered variant —
      // only a refetch can decide. (page>1 variants are simply left alone:
      // the newest row belongs on page 1.)
      queryClient.invalidateQueries({ queryKey: key as unknown[], exact: true });
    }
  });

  // Detail summary. `patch` carries no `messages` key, so the thread is safe.
  queryClient.setQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail(id), (old) =>
    old ? mergeDefined(old, patch as Partial<ChatDetailCacheEntry>) : old,
  );

  return patch;
}

// ---------------------------------------------------------------------------
// applyMessageCreated
// ---------------------------------------------------------------------------

export interface ApplyMessageResult {
  /** True when the message actually CHANGED the open thread (appended or
   *  reconciled an optimistic bubble). Derived from the detail cache itself —
   *  never from a pre-append registry, so a copy that arrives while the
   *  detail cache is absent/in-flight can never poison a later delivery.
   *  Callers use it to gate the new-message sound. */
  isNew: boolean;
}

/**
 * Fold a `message:created` into the caches:
 *  - detail messages: dedupe by id against the REAL cache; reconcile the
 *    operator's optimistic bubble by clientMessageId identity
 *    (message.metadata.clientMessageId, the server dedupe key). NEVER
 *    revision-gated — a new message must never be dropped from the thread.
 *  - list rows: preview/lastActivityAt patch, gated by conversationRevision
 *    (a duplicate room delivery re-applies idempotently).
 */
export function applyMessageCreated(
  queryClient: QueryClient,
  event: MessageCreatedEvent,
): ApplyMessageResult {
  ensureRegistriesFor(queryClient);
  const dto = event?.message;
  const sessionId = event?.sessionId ?? dto?.sessionId;
  if (!dto || !sessionId) return { isNew: false };

  const incoming = messagePayloadToMessage({ ...dto, sessionId });

  // 1. Detail thread append/reconcile. Seed ONLY when something is watching
  // or already fetching this thread — a setQueryData seed is a successful
  // fetch in TQ v5, so seeding unopened chats would skip GET /chats/:id.
  let changedThread = false;
  queryClient.setQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail(sessionId), (old) => {
    if (!old) {
      const q = queryClient.getQueryCache().find({ queryKey: queryKeys.chats.detail(sessionId) });
      if (!q || (q.getObserversCount() === 0 && q.state.fetchStatus !== 'fetching')) return old;
      changedThread = true;
      return seedChatDetail(sessionId, {
        messages: [incoming],
        lastMessage: incoming.content.substring(0, 80),
        lastMessageSender: incoming.sender,
        lastMessageAt: incoming.createdAt,
        lastActivityAt: incoming.createdAt,
        messageCount: 1,
        createdAt: incoming.createdAt,
        updatedAt: incoming.createdAt,
      });
    }
    const messages = old.messages ?? [];
    if (messages.some((m) => m.id === incoming.id)) return old;

    if (incoming.clientMessageId) {
      // Identity reconcile: the wire carries the clientMessageId the server
      // deduped on — replace OUR optimistic bubble, whatever its content.
      const idx = messages.findIndex((m) => m.clientMessageId === incoming.clientMessageId);
      if (idx >= 0) {
        const next = [...messages];
        next[idx] = { ...incoming, deliveryState: incoming.deliveryState ?? 'sent' };
        changedThread = true;
        return { ...old, messages: next };
      }
    }
    changedThread = true;
    return { ...old, messages: [...messages, incoming] };
  });

  // 2. List-row preview patch (revision-gated like any summary patch).
  const appliedRev = appliedRevisions.get(sessionId);
  if (typeof event.conversationRevision === 'number') {
    if (appliedRev !== undefined && event.conversationRevision < appliedRev) {
      return { isNew: changedThread };
    }
    appliedRevisions.set(sessionId, event.conversationRevision);
  }

  const rowPatch: Partial<Chat> = {
    lastMessage: incoming.content.substring(0, 80),
    lastMessageSender: incoming.sender,
    lastMessageAt: incoming.createdAt,
    lastActivityAt: incoming.createdAt,
  };
  // status/tenant omitted on purpose — canInsertInto then only admits unfiltered page-1.
  const insertDto = {
    id: sessionId,
    sessionId,
    lastMessage: rowPatch.lastMessage,
    lastMessageSender: rowPatch.lastMessageSender,
    lastMessageAt: rowPatch.lastMessageAt,
    lastActivityAt: rowPatch.lastActivityAt,
    messageCount: 1,
  } as ConversationSummaryPayload;
  forEachListVariant(queryClient, (key, params, entry) => {
    const rows = entry.data ?? [];
    const index = rows.findIndex((c) => c.id === sessionId);
    if (index >= 0) {
      const next = [...rows];
      next[index] = mergeDefined(next[index], rowPatch);
      queryClient.setQueryData(key, { ...entry, data: sortByActivityDesc(next) });
      return;
    }
    // No companion upsert yet: insert into unfiltered page-1 only (we don't
    // know status/tenant). ChatStream hides `messageCount===0 && !lastMessage`.
    if (!canInsertInto(params, insertDto)) return;
    const stub = summaryToChatRow({ ...insertDto, createdAt: incoming.createdAt });
    queryClient.setQueryData(key, withTotalDelta(entry, sortByActivityDesc([stub, ...rows]), 1));
  });

  return { isNew: changedThread };
}

// ---------------------------------------------------------------------------
// applyCommandConversation (POST response folding)
// ---------------------------------------------------------------------------

/** Newest cached copy of a conversation row (list variants first, then detail). */
export function findCachedChat(queryClient: QueryClient, id: string): Chat | null {
  let found: Chat | null = null;
  forEachListVariant(queryClient, (_key, _params, entry) => {
    if (found) return;
    const row = (entry.data ?? []).find((c) => c.id === id);
    if (row) found = row;
  });
  if (found) return found;
  const detail = queryClient.getQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail(id));
  if (detail) {
    const { messages: _messages, ...rest } = detail;
    return { ...(rest as Omit<Chat, 'messages'>), messages: [] };
  }
  return null;
}

/**
 * Fold a command response's reduced summary into the caches. The summary has
 * no display fields, so a variant the row must MOVE INTO is seeded from the
 * freshest cached copy; without one the list patch is skipped (the follow-up
 * conversation:upsert / refetch owns it).
 */
export function applyCommandConversation(
  queryClient: QueryClient,
  summary: CommandConversationSummary | undefined | null,
): void {
  if (!summary?.sessionId) return;
  ensureRegistriesFor(queryClient);

  // ADVANCE the ownership gate to the command's committed version, so a
  // delayed pre-command conversation:upsert cannot undo this ownership.
  if (typeof summary.ownershipVersion === 'number') {
    const gate = appliedOwnershipVersions.get(summary.sessionId);
    if (gate === undefined || summary.ownershipVersion > gate) {
      appliedOwnershipVersions.set(summary.sessionId, summary.ownershipVersion);
    }
  }

  const patch = commandSummaryToChatPatch(summary);
  const base = findCachedChat(queryClient, summary.sessionId);
  const fullRow = base ? mergeDefined(base, patch) : null;

  // Admission uses the backend vocabulary, same as a live upsert.
  const admissionDto: ConversationSummaryPayload = {
    id: summary.sessionId,
    sessionId: summary.sessionId,
    status: summary.status,
    tenantId: summary.tenantId,
    assignedAgentId: summary.assignedAgentId,
  };

  forEachListVariant(queryClient, (key, params, entry) => {
    const rows = entry.data ?? [];
    const index = rows.findIndex((c) => c.id === summary.sessionId);
    const admitted = matchesVariant(params, admissionDto);
    if (admitted) {
      if (index >= 0) {
        const next = [...rows];
        next[index] = mergeDefined(next[index], patch);
        queryClient.setQueryData(key, withTotalDelta(entry, sortByActivityDesc(next), 0));
      } else if (fullRow && canInsertInto(params, admissionDto)) {
        queryClient.setQueryData(
          key,
          withTotalDelta(entry, sortByActivityDesc([fullRow, ...rows]), 1),
        );
      }
    } else if (index >= 0) {
      queryClient.setQueryData(
        key,
        withTotalDelta(entry, rows.filter((c) => c.id !== summary.sessionId), -1),
      );
    }
  });

  queryClient.setQueryData<ChatDetailCacheEntry>(
    queryKeys.chats.detail(summary.sessionId),
    (old) => (old ? mergeDefined(old, patch as Partial<ChatDetailCacheEntry>) : old),
  );
}

// ---------------------------------------------------------------------------
// useLiveConversationSync — the single Inbox mount point
// ---------------------------------------------------------------------------

export interface LiveConversationSyncOptions {
  /** The open conversation — drives the selected-chat patch + message sound. */
  selectedChatId?: string;
  /** Called with a normalized partial Chat when an upsert hits the open chat. */
  onSelectedUpsert?: (patch: Partial<Chat> & { id: string }) => void;
}

/**
 * Registers the conversation:upsert / message:created socket handlers exactly
 * once, plays the message sound for the open thread, and catches up after a
 * gap: on socket reconnect AND on window focus the chat list + detail queries
 * are invalidated (revisions dedupe any overlap).
 */
export function useLiveConversationSync(options: LiveConversationSyncOptions = {}): void {
  const queryClient = useQueryClient();
  const { registerHandlers, unregisterHandlers, isConnected } = useSocket();
  const { playMessage } = useNotificationSound();

  const selectedChatIdRef = useRef(options.selectedChatId);
  const onSelectedUpsertRef = useRef(options.onSelectedUpsert);
  useEffect(() => {
    selectedChatIdRef.current = options.selectedChatId;
    onSelectedUpsertRef.current = options.onSelectedUpsert;
  });

  // The registration effect runs once per mount — capture the mount-time
  // connection state without re-registering on every connect flip.
  const isConnectedRef = useRef(isConnected);
  useEffect(() => {
    isConnectedRef.current = isConnected;
  });

  useEffect(() => {
    // Bind the registries to THIS QueryClient (tenant switch starts clean).
    ensureRegistriesFor(queryClient);
    // Mounting while disconnected means events were already missed: treat the
    // FIRST connect as a catch-up, not only a disconnect->reconnect edge.
    const wasDisconnected = { current: !isConnectedRef.current };
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.handoffs.all() });
    };

    const handlerId = registerHandlers({
      onConversationUpsert: (event) => {
        // The pane gets the SAME sanitized patch the cache got — never a
        // rebuilt raw one, which would bypass the revision/ownership gates
        // and could resurrect cleared human-control state (B-PR5b FIX 2).
        const appliedPatch = applyConversationUpsert(queryClient, event);
        if (appliedPatch && appliedPatch.id === selectedChatIdRef.current) {
          onSelectedUpsertRef.current?.(appliedPatch);
        }
      },
      onMessageCreated: (event) => {
        const { isNew } = applyMessageCreated(queryClient, event);
        const sender = event?.message?.senderType ?? event?.message?.sender;
        if (
          isNew &&
          event.sessionId === selectedChatIdRef.current &&
          (sender === 'user' || sender === 'bot')
        ) {
          playMessage();
        }
      },
      onDisconnect: () => {
        wasDisconnected.current = true;
      },
      onConnect: () => {
        if (wasDisconnected.current) {
          wasDisconnected.current = false;
          invalidate();
        }
      },
    });

    const onFocus = () => invalidate();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const id = selectedChatIdRef.current;
      if (id) queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(id) });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      unregisterHandlers(handlerId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [queryClient, registerHandlers, unregisterHandlers, playMessage]);
}
