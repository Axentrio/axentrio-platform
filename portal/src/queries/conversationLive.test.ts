/**
 * Tests for conversationLive — the B-PR3b cache-patch core.
 *
 * Covers the PR3 portal subset at the cache level:
 *  - conversation:upsert lands in EVERY cached list variant (insert / merge /
 *    remove-on-mismatch) using the remapped backend status vocabulary, and
 *    re-sorts by lastActivityAt.
 *  - Defined-fields-only merge (B-PR3a omits assignedAgentName when the
 *    relation is not loaded — a known value is never clobbered).
 *  - Strict `<` revision dedupe (equal revisions APPLY, lower ones drop).
 *  - message:created appends deduped by id (duplicate room delivery is the
 *    norm), reconciles the operator's optimistic bubble, patches the list
 *    row's preview.
 *  - applyCommandConversation moves the row between variants from a POST
 *    response (Take Over updates the list row AND the open thread).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import {
  applyConversationUpsert,
  applyMessageCreated,
  applyCommandConversation,
  findCachedChat,
  mergeDefined,
  normalizeChatStatus,
  summaryToChatPatch,
  __resetConversationLiveState,
  type ChatListCacheEntry,
  type ChatDetailCacheEntry,
} from './conversationLive';
import type {
  Chat,
  ConversationSummaryPayload,
  ConversationUpsertEvent,
  MessageCreatedEvent,
} from '@app-types/index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_PARAMS = {} as Record<string, string>;
const BOT_PARAMS = { status: 'bot' };
const ACTIVE_PARAMS = { status: 'active' };
const HANDOFF_PARAMS = { status: 'handoff' };
const SEARCH_PARAMS = { search: 'foo' };

function listKey(params: Record<string, string>) {
  return queryKeys.chats.list(params as Record<string, unknown>);
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'c1',
    sessionId: 'c1',
    tenantId: 't1',
    userId: '',
    userName: 'Visitor aaaa',
    status: 'bot',
    messages: [],
    metadata: { source: 'widget' },
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:00:00.000Z',
    lastActivityAt: '2026-08-14T09:00:00.000Z',
    messageCount: 1,
    lastMessage: 'hello',
    ...overrides,
  };
}

function makeSummary(overrides: Partial<ConversationSummaryPayload> = {}): ConversationSummaryPayload {
  return {
    id: 'c1',
    sessionId: 'c1',
    status: 'bot',
    tenantId: 't1',
    userName: 'Visitor aaaa',
    messageCount: 2,
    lastMessage: 'newest',
    lastMessageSender: 'user',
    lastMessageAt: '2026-08-14T10:00:00.000Z',
    lastActivityAt: '2026-08-14T10:00:00.000Z',
    ownership: 'bot',
    ownershipVersion: 1,
    assignedAgentId: null,
    channel: 'widget',
    ...overrides,
  };
}

function upsert(
  conversation: ConversationSummaryPayload,
  revision = Date.now(),
): ConversationUpsertEvent {
  return { conversation, revision };
}

function listData(qc: QueryClient, params: Record<string, string>): Chat[] {
  return qc.getQueryData<ChatListCacheEntry>(listKey(params))?.data ?? [];
}

let qc: QueryClient;

beforeEach(() => {
  __resetConversationLiveState();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

// ---------------------------------------------------------------------------
// conversation:upsert → list variants
// ---------------------------------------------------------------------------

describe('applyConversationUpsert — list variants', () => {
  it('inserts a NEW conversation into every matching cached variant and re-sorts by lastActivityAt', () => {
    const older = makeChat({ id: 'c0', lastActivityAt: '2026-08-14T08:00:00.000Z' });
    qc.setQueryData(listKey(ALL_PARAMS), { data: [older], meta: { total: 1, totalPages: 1 } });
    qc.setQueryData(listKey(BOT_PARAMS), { data: [older] });
    qc.setQueryData(listKey(ACTIVE_PARAMS), { data: [] });

    applyConversationUpsert(qc, upsert(makeSummary({ id: 'c9', sessionId: 'c9', status: 'bot' })));

    // Inserted at the top of the 'all' and 'bot' variants (newer activity).
    expect(listData(qc, ALL_PARAMS).map((c) => c.id)).toEqual(['c9', 'c0']);
    expect(listData(qc, BOT_PARAMS).map((c) => c.id)).toEqual(['c9', 'c0']);
    // NOT admitted into the 'active' variant.
    expect(listData(qc, ACTIVE_PARAMS)).toEqual([]);
    // meta.total keeps up.
    expect(qc.getQueryData<ChatListCacheEntry>(listKey(ALL_PARAMS))?.meta?.total).toBe(2);
    // Status entered the cache in the PORTAL vocabulary.
    expect(listData(qc, ALL_PARAMS)[0].status).toBe('bot');
  });

  it('re-sorts an existing row to the top when its activity becomes most recent', () => {
    const a = makeChat({ id: 'a', lastActivityAt: '2026-08-14T09:00:00.000Z' });
    const b = makeChat({ id: 'b', lastActivityAt: '2026-08-14T08:00:00.000Z' });
    qc.setQueryData(listKey(ALL_PARAMS), { data: [a, b] });

    applyConversationUpsert(
      qc,
      upsert(makeSummary({ id: 'b', sessionId: 'b', lastActivityAt: '2026-08-14T11:00:00.000Z' })),
    );

    expect(listData(qc, ALL_PARAMS).map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('merges only DEFINED fields — an omitted assignedAgentName never clobbers a known value, null clears it', () => {
    const row = makeChat({ assignedAgentName: 'Alice', assignedAgentId: 'ag-1' });
    qc.setQueryData(listKey(ALL_PARAMS), { data: [row] });

    // Message hot path: relation not loaded → key omitted entirely.
    const partial = makeSummary();
    delete partial.assignedAgentName;
    applyConversationUpsert(qc, upsert(partial, 100));
    expect(listData(qc, ALL_PARAMS)[0].assignedAgentName).toBe('Alice');
    expect(listData(qc, ALL_PARAMS)[0].lastMessage).toBe('newest');

    // Loaded-but-empty relation: honest null clears the name.
    applyConversationUpsert(
      qc,
      upsert(makeSummary({ assignedAgentName: null, assignedAgentId: null }), 200),
    );
    expect(listData(qc, ALL_PARAMS)[0].assignedAgentName).toBeNull();
  });

  it('drops a STALE upsert (strict <): lower revision is ignored, equal revision applies', () => {
    qc.setQueryData(listKey(ALL_PARAMS), { data: [makeChat()] });

    applyConversationUpsert(qc, upsert(makeSummary({ lastMessage: 'rev-100' }), 100));
    expect(listData(qc, ALL_PARAMS)[0].lastMessage).toBe('rev-100');

    // Stale (lower) revision — dropped.
    expect(applyConversationUpsert(qc, upsert(makeSummary({ lastMessage: 'rev-99' }), 99))).toBeNull();
    expect(listData(qc, ALL_PARAMS)[0].lastMessage).toBe('rev-100');

    // Equal revision (same-ms emit) — applied, not dropped.
    expect(applyConversationUpsert(qc, upsert(makeSummary({ lastMessage: 'rev-100b' }), 100))).not.toBeNull();
    expect(listData(qc, ALL_PARAMS)[0].lastMessage).toBe('rev-100b');
  });

  it('moves a conversation between tabs when ownership changes (handoff → active vocabulary)', () => {
    const row = makeChat({ status: 'handsoff' });
    qc.setQueryData(listKey(ALL_PARAMS), { data: [row] });
    qc.setQueryData(listKey(HANDOFF_PARAMS), { data: [row], meta: { total: 1, totalPages: 1 } });
    qc.setQueryData(listKey(ACTIVE_PARAMS), { data: [], meta: { total: 0, totalPages: 1 } });

    applyConversationUpsert(
      qc,
      upsert(makeSummary({ status: 'active', assignedAgentId: 'ag-1', ownership: 'human' })),
    );

    // Removed from the handoff tab, inserted into the agent tab, kept in all.
    expect(listData(qc, HANDOFF_PARAMS)).toEqual([]);
    expect(qc.getQueryData<ChatListCacheEntry>(listKey(HANDOFF_PARAMS))?.meta?.total).toBe(0);
    expect(listData(qc, ACTIVE_PARAMS).map((c) => c.id)).toEqual(['c1']);
    expect(listData(qc, ALL_PARAMS)[0].status).toBe('human');
  });

  it('never INSERTS into an opaque (search-filtered) variant, but still merges an existing row', () => {
    qc.setQueryData(listKey(SEARCH_PARAMS), { data: [makeChat({ id: 'known' })] });

    applyConversationUpsert(qc, upsert(makeSummary({ id: 'unknown', sessionId: 'unknown' }), 10));
    expect(listData(qc, SEARCH_PARAMS).map((c) => c.id)).toEqual(['known']);

    applyConversationUpsert(
      qc,
      upsert(makeSummary({ id: 'known', sessionId: 'known', lastMessage: 'merged' }), 20),
    );
    expect(listData(qc, SEARCH_PARAMS)[0].lastMessage).toBe('merged');
  });

  it('invalidates an opaque (search) variant for an unknown conversation so a refetch decides', () => {
    qc.setQueryData(listKey(SEARCH_PARAMS), { data: [makeChat({ id: 'known' })] });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    applyConversationUpsert(qc, upsert(makeSummary({ id: 'unknown', sessionId: 'unknown' }), 10));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: listKey(SEARCH_PARAMS), exact: true });
    // The cached rows themselves were not touched.
    expect(listData(qc, SEARCH_PARAMS).map((c) => c.id)).toEqual(['known']);
  });

  it('never INSERTS into a paginated variant beyond page 1, and never bumps its total', () => {
    const PAGE1 = { status: 'bot', page: '1', limit: '20' };
    const PAGE2 = { status: 'bot', page: '2', limit: '20' };
    qc.setQueryData(listKey(PAGE1), { data: [makeChat({ id: 'p1-row' })], meta: { total: 21, totalPages: 2 } });
    qc.setQueryData(listKey(PAGE2), { data: [makeChat({ id: 'p2-row' })], meta: { total: 21, totalPages: 2 } });

    applyConversationUpsert(qc, upsert(makeSummary({ id: 'c-new', sessionId: 'c-new', status: 'bot' })));

    // Page 1 receives the newest row; page 2 must NOT (no duplicate, no
    // inflated total).
    expect(listData(qc, PAGE1).map((c) => c.id)).toContain('c-new');
    expect(qc.getQueryData<ChatListCacheEntry>(listKey(PAGE1))?.meta?.total).toBe(22);
    expect(listData(qc, PAGE2).map((c) => c.id)).toEqual(['p2-row']);
    expect(qc.getQueryData<ChatListCacheEntry>(listKey(PAGE2))?.meta?.total).toBe(21);
  });

  it('never INSERTS into a variant filtered on a dimension the payload omits', () => {
    const TENANT_PARAMS = { tenantId: 't1' };
    const AGENT_PARAMS = { assignedAgentId: 'ag-1' };
    qc.setQueryData(listKey(TENANT_PARAMS), { data: [] });
    qc.setQueryData(listKey(AGENT_PARAMS), { data: [] });

    // Payload omits tenantId entirely and carries no assignment.
    const dto = makeSummary({ id: 'c-x', sessionId: 'c-x' });
    delete dto.tenantId;
    dto.assignedAgentId = null;
    applyConversationUpsert(qc, upsert(dto));

    expect(listData(qc, TENANT_PARAMS)).toEqual([]);
    expect(listData(qc, AGENT_PARAMS)).toEqual([]);
  });

  it('ownership gate: a delayed pre-command upsert cannot undo a confirmed takeover', () => {
    const row = makeChat({ status: 'handsoff', ownershipVersion: 2 });
    qc.setQueryData(listKey(ALL_PARAMS), { data: [row] });
    qc.setQueryData(listKey(HANDOFF_PARAMS), { data: [] });

    // The takeover commits: command response carries ownershipVersion 3.
    applyCommandConversation(qc, {
      sessionId: 'c1',
      tenantId: 't1',
      status: 'active',
      ownership: 'human',
      ownershipVersion: 3,
      assignedAgentId: 'ag-1',
    });
    expect(listData(qc, ALL_PARAMS)[0].status).toBe('human');

    // A DELAYED pre-command upsert (higher revision, older ownershipVersion)
    // arrives afterwards. Ownership fields are dropped; other facts merge.
    applyConversationUpsert(
      qc,
      upsert(
        makeSummary({ status: 'handoff', ownership: 'handoff_requested', ownershipVersion: 2, assignedAgentId: null, lastMessage: 'still merges' }),
        Date.now() + 1000,
      ),
    );

    const patched = listData(qc, ALL_PARAMS)[0];
    expect(patched.status).toBe('human'); // NOT regressed
    expect(patched.assignedAgentId).toBe('ag-1');
    expect(patched.lastMessage).toBe('still merges'); // non-ownership facts applied
    // And the stale event must not re-insert the row into the handoff tab.
    expect(listData(qc, HANDOFF_PARAMS)).toEqual([]);
  });

  it('B-PR5b: the human-control policy merges from an upsert but never from a stale-ownership one', () => {
    const until = '2026-08-15T14:00:00.000Z';
    qc.setQueryData(listKey(ALL_PARAMS), { data: [makeChat({ status: 'handsoff' })] });

    // The timed takeover commits (command response, ownershipVersion 3).
    // REAL contract: the claim keeps status 'handoff' with ownership
    // 'human_owned' (deriveStatusFromOwnership).
    applyCommandConversation(qc, {
      sessionId: 'c1',
      tenantId: 't1',
      status: 'handoff',
      ownership: 'human_owned',
      ownershipVersion: 3,
      assignedAgentId: 'ag-1',
      humanControlMode: 'timed',
      humanControlDurationHours: 2,
      humanControlUntil: until,
    });
    let row = listData(qc, ALL_PARAMS)[0];
    expect(row.ownership).toBe('human_owned');
    expect(row.humanControlMode).toBe('timed');
    expect(row.humanControlDurationHours).toBe(2);
    expect(row.humanControlUntil).toBe(until);

    // A delayed PRE-command upsert must not regress the policy either — the
    // human-control columns are written by the same ownership commands. The
    // RETURNED patch is the sanitized one the open pane must receive (FIX 2):
    // the ownership-bearing fields are stripped from it.
    const stalePatch = applyConversationUpsert(
      qc,
      upsert(
        makeSummary({
          status: 'handoff',
          ownership: 'handoff_requested',
          ownershipVersion: 2,
          humanControlMode: null,
          humanControlDurationHours: null,
          humanControlUntil: null,
          lastMessage: 'still merges',
        }),
        Date.now() + 1000,
      ),
    );
    expect(stalePatch).not.toBeNull();
    expect(stalePatch!.lastMessage).toBe('still merges');
    expect(stalePatch).not.toHaveProperty('ownership');
    expect(stalePatch).not.toHaveProperty('status');
    expect(stalePatch).not.toHaveProperty('humanControlMode');
    expect(stalePatch).not.toHaveProperty('humanControlDurationHours');
    expect(stalePatch).not.toHaveProperty('humanControlUntil');
    row = listData(qc, ALL_PARAMS)[0];
    expect(row.ownership).toBe('human_owned');
    expect(row.humanControlMode).toBe('timed');
    expect(row.humanControlUntil).toBe(until);

    // A CURRENT upsert (the expiry worker's release) clears the fields.
    applyConversationUpsert(
      qc,
      upsert(
        makeSummary({
          status: 'bot',
          ownership: 'bot_owned',
          ownershipVersion: 4,
          assignedAgentId: null,
          humanControlMode: null,
          humanControlDurationHours: null,
          humanControlUntil: null,
        }),
        Date.now() + 2000,
      ),
    );
    row = listData(qc, ALL_PARAMS)[0];
    expect(row.humanControlMode).toBeNull();
    expect(row.humanControlDurationHours).toBeNull();
    expect(row.humanControlUntil).toBeNull();
  });

  it('patches the selected chat detail summary without touching messages', () => {
    const detail: ChatDetailCacheEntry = {
      ...makeChat(),
      messages: [
        { id: 'm1', chatId: 'c1', type: 'text', content: 'hi', sender: 'user', isRead: false, createdAt: '2026-08-14T09:00:00.000Z' },
      ],
    };
    qc.setQueryData(queryKeys.chats.detail('c1'), detail);

    applyConversationUpsert(qc, upsert(makeSummary({ status: 'active', assignedAgentName: 'Bob' })));

    const next = qc.getQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail('c1'))!;
    expect(next.status).toBe('human');
    expect(next.assignedAgentName).toBe('Bob');
    expect(next.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// message:created
// ---------------------------------------------------------------------------

function messageEvent(overrides: Partial<MessageCreatedEvent['message']> = {}, rev = 500): MessageCreatedEvent {
  const message = {
    id: 'm-new',
    sessionId: 'c1',
    type: 'text',
    content: 'inbound hello',
    senderType: 'user',
    sender: 'user',
    status: 'sent',
    createdAt: '2026-08-14T12:00:00.000Z',
    timestamp: '2026-08-14T12:00:00.000Z',
    ...overrides,
  };
  return { sessionId: message.sessionId, message, conversationRevision: rev };
}

describe('applyMessageCreated', () => {
  it('appends to the open thread deduped by id — the same event arrives once per room', () => {
    qc.setQueryData(queryKeys.chats.detail('c1'), { ...makeChat(), messages: [] });

    const first = applyMessageCreated(qc, messageEvent());
    const second = applyMessageCreated(qc, messageEvent()); // duplicate room delivery

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    const detail = qc.getQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail('c1'))!;
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages![0]).toMatchObject({ id: 'm-new', sender: 'user', content: 'inbound hello' });
  });

  it('updates the list row preview + re-sorts the UNSELECTED thread on a new message', () => {
    const a = makeChat({ id: 'a', lastActivityAt: '2026-08-14T09:00:00.000Z' });
    const c1 = makeChat({ id: 'c1', lastActivityAt: '2026-08-14T08:00:00.000Z', lastMessage: 'old' });
    qc.setQueryData(listKey(ALL_PARAMS), { data: [a, c1] });

    applyMessageCreated(qc, messageEvent());

    const rows = listData(qc, ALL_PARAMS);
    expect(rows.map((r) => r.id)).toEqual(['c1', 'a']);
    expect(rows[0].lastMessage).toBe('inbound hello');
    expect(rows[0].lastActivityAt).toBe('2026-08-14T12:00:00.000Z');
  });

  it('reconciles the operator optimistic bubble by clientMessageId IDENTITY (metadata on the wire)', () => {
    qc.setQueryData(queryKeys.chats.detail('c1'), {
      ...makeChat(),
      messages: [
        {
          id: 'client-uuid',
          clientMessageId: 'client-uuid',
          chatId: 'c1',
          type: 'text',
          content: 'operator reply',
          sender: 'agent',
          isRead: true,
          createdAt: '2026-08-14T12:00:00.000Z',
          deliveryState: 'pending',
        },
      ],
    });

    applyMessageCreated(
      qc,
      messageEvent({
        id: 'srv-9',
        senderType: 'agent',
        sender: 'agent',
        content: 'operator reply (server-normalized)',
        metadata: { clientMessageId: 'client-uuid' },
      }),
    );

    const messages = qc.getQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail('c1'))!.messages!;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'srv-9',
      clientMessageId: 'client-uuid', // kept for the POST reconcile
      deliveryState: 'sent',
    });
  });

  it('two identical pending replies: identity reconcile replaces the RIGHT bubble, never by content', () => {
    const bubble = (cid: string) => ({
      id: cid,
      clientMessageId: cid,
      chatId: 'c1',
      type: 'text' as const,
      content: 'same text', // identical content on purpose
      sender: 'agent' as const,
      isRead: true,
      createdAt: '2026-08-14T12:00:00.000Z',
      deliveryState: 'pending' as const,
    });
    qc.setQueryData(queryKeys.chats.detail('c1'), {
      ...makeChat(),
      messages: [bubble('cid-A'), bubble('cid-B')],
    });

    // The server copy for the SECOND send arrives first.
    applyMessageCreated(
      qc,
      messageEvent({
        id: 'srv-B',
        senderType: 'agent',
        sender: 'agent',
        content: 'same text',
        metadata: { clientMessageId: 'cid-B' },
      }),
    );

    const messages = qc.getQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail('c1'))!.messages!;
    expect(messages).toHaveLength(2);
    // cid-A stays pending; cid-B took the server id.
    expect(messages.find((m) => m.clientMessageId === 'cid-A')).toMatchObject({
      id: 'cid-A',
      deliveryState: 'pending',
    });
    expect(messages.find((m) => m.clientMessageId === 'cid-B')).toMatchObject({
      id: 'srv-B',
      deliveryState: 'sent',
    });
  });

  it('a tenant-room copy arriving before the detail cache is loaded never hides the session-room copy', () => {
    // No detail cache yet (the open thread is still fetching).
    const first = applyMessageCreated(qc, messageEvent({ id: 'm-early' }));
    expect(first.isNew).toBe(false); // nothing was appended anywhere

    // The fetch completes WITHOUT the message (it raced past the snapshot).
    qc.setQueryData(queryKeys.chats.detail('c1'), { ...makeChat(), messages: [] });

    // The session-room copy of the SAME event arrives — it must still append.
    const second = applyMessageCreated(qc, messageEvent({ id: 'm-early' }));
    expect(second.isNew).toBe(true);
    const detail = qc.getQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail('c1'))!;
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages![0].id).toBe('m-early');
  });

  it('never revision-gates the thread append, but gates the list-row patch', () => {
    qc.setQueryData(queryKeys.chats.detail('c1'), { ...makeChat(), messages: [] });
    qc.setQueryData(listKey(ALL_PARAMS), { data: [makeChat({ lastMessage: 'authoritative' })] });

    // A fresher upsert was already applied for this conversation…
    applyConversationUpsert(qc, upsert(makeSummary({ lastMessage: 'authoritative' }), 1000));
    // …then a STALE message event arrives (lower conversationRevision).
    applyMessageCreated(qc, messageEvent({ id: 'm-stale', content: 'stale preview' }, 900));

    // The thread append happened (a real message must never be dropped)…
    expect(qc.getQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail('c1'))!.messages).toHaveLength(1);
    // …but the list preview kept the fresher value.
    expect(listData(qc, ALL_PARAMS)[0].lastMessage).toBe('authoritative');
  });
});

// ---------------------------------------------------------------------------
// applyCommandConversation (POST response folding, e.g. Take Over)
// ---------------------------------------------------------------------------

describe('applyCommandConversation', () => {
  it('Take Over: the POST response updates both the list rows and the open thread to human ownership', () => {
    const row = makeChat({ status: 'handsoff' });
    qc.setQueryData(listKey(ALL_PARAMS), { data: [row] });
    qc.setQueryData(listKey(HANDOFF_PARAMS), { data: [row] });
    qc.setQueryData(listKey(ACTIVE_PARAMS), { data: [] });
    qc.setQueryData(queryKeys.chats.detail('c1'), { ...makeChat({ status: 'handsoff' }), messages: [] });

    applyCommandConversation(qc, {
      sessionId: 'c1',
      tenantId: 't1',
      status: 'active',
      ownership: 'human',
      ownershipVersion: 3,
      assignedAgentId: 'ag-1',
    });

    expect(listData(qc, ALL_PARAMS)[0]).toMatchObject({ status: 'human', assignedAgentId: 'ag-1' });
    expect(listData(qc, HANDOFF_PARAMS)).toEqual([]);
    // Moved INTO the agent tab, seeded from the cached full row.
    expect(listData(qc, ACTIVE_PARAMS)[0]).toMatchObject({ id: 'c1', status: 'human', userName: 'Visitor aaaa' });
    expect(
      qc.getQueryData<ChatDetailCacheEntry>(queryKeys.chats.detail('c1')),
    ).toMatchObject({ status: 'human', ownership: 'human', ownershipVersion: 3 });
  });

  it('findCachedChat returns the freshest cached row for the selected-pane patch', () => {
    qc.setQueryData(listKey(ALL_PARAMS), { data: [makeChat({ id: 'c7', sessionId: 'c7' })] });
    expect(findCachedChat(qc, 'c7')?.id).toBe('c7');
    expect(findCachedChat(qc, 'missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('summaryToChatPatch preserves customerThreadId', () => {
  it('copies customerThreadId onto the Chat patch so a socket-inserted row can group', () => {
    const patch = summaryToChatPatch(
      makeSummary({ customerThreadId: 'e:conn-1:tg-user-9:tg-chat-9' }),
    );
    expect(patch.customerThreadId).toBe('e:conn-1:tg-user-9:tg-chat-9');
  });

  it('omits customerThreadId when the payload does not define it', () => {
    const patch = summaryToChatPatch(makeSummary());
    expect(patch).not.toHaveProperty('customerThreadId');
  });

  it('admits a sibling upsert by session id — grouping never merges cache rows', () => {
    const older = makeChat({
      id: 'sess-prior',
      sessionId: 'sess-prior',
      customerThreadId: 'e:conn-1:tg-user-9:tg-chat-9',
      lastActivityAt: '2026-08-14T08:00:00.000Z',
    });
    qc.setQueryData(listKey(ALL_PARAMS), { data: [older], meta: { total: 1, totalPages: 1 } });

    applyConversationUpsert(
      qc,
      upsert(
        makeSummary({
          id: 'sess-new',
          sessionId: 'sess-new',
          customerThreadId: 'e:conn-1:tg-user-9:tg-chat-9',
          lastMessage: 'reopened',
          lastActivityAt: '2026-08-14T11:00:00.000Z',
        }),
      ),
    );

    const rows = listData(qc, ALL_PARAMS);
    expect(rows.map((c) => c.id)).toEqual(['sess-new', 'sess-prior']);
    expect(rows[0].customerThreadId).toBe('e:conn-1:tg-user-9:tg-chat-9');
    expect(rows[1].customerThreadId).toBe('e:conn-1:tg-user-9:tg-chat-9');
    expect(qc.getQueryData<ChatListCacheEntry>(listKey(ALL_PARAMS))?.meta?.total).toBe(2);
  });
});

describe('vocabulary + merge helpers', () => {
  it('normalizes the backend status vocabulary to the portal one (and passes portal values through)', () => {
    expect(normalizeChatStatus('handoff')).toBe('handsoff');
    expect(normalizeChatStatus('active')).toBe('human');
    expect(normalizeChatStatus('waiting')).toBe('pending');
    expect(normalizeChatStatus('closed')).toBe('closed');
    expect(normalizeChatStatus('bot')).toBe('bot');
    expect(normalizeChatStatus('handsoff')).toBe('handsoff');
    expect(normalizeChatStatus('human')).toBe('human');
  });

  it('mergeDefined applies null but never undefined', () => {
    const base = { a: 1, b: 'keep', c: 'clear' } as { a: number; b?: string | null; c?: string | null };
    const next = mergeDefined(base, { b: undefined, c: null });
    expect(next).toEqual({ a: 1, b: 'keep', c: null });
  });
});
