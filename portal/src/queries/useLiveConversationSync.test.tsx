/**
 * Tests for useLiveConversationSync (B-PR3b §1/§4): the single Inbox mount
 * point for the live feed.
 *
 * Covers: an inbound message appears in an already-open list without a
 * refresh (selected AND unselected threads update + re-sort); the selected
 * chat callback receives a normalized patch; disconnect→reconnect catches up
 * via invalidation without duplicating messages; window focus invalidates;
 * the message sound plays once per NEW message in the open thread (duplicate
 * room delivery stays silent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const { registerHandlersMock, unregisterHandlersMock, playMessageMock, socketState } = vi.hoisted(() => ({
  registerHandlersMock: vi.fn((_handlers: unknown) => 'handler-1'),
  unregisterHandlersMock: vi.fn(),
  playMessageMock: vi.fn(),
  socketState: { isConnected: true },
}));

vi.mock('@websocket/SocketContext', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    isConnecting: false,
    connectionError: null,
    registerHandlers: registerHandlersMock,
    unregisterHandlers: unregisterHandlersMock,
    joinChat: vi.fn(),
    leaveChat: vi.fn(),
    sendTyping: vi.fn(),
    updateStatus: vi.fn(),
    reconnect: vi.fn(),
  }),
}));

vi.mock('@websocket/notificationSound', () => ({
  useNotificationSound: () => ({
    playMessage: playMessageMock,
    playHandoff: vi.fn(),
    playNotification: vi.fn(),
    playError: vi.fn(),
    isMuted: false,
    toggleMute: vi.fn(),
    setVolume: vi.fn(),
  }),
}));

import { useLiveConversationSync, __resetConversationLiveState, type ChatListCacheEntry } from './conversationLive';
import { queryKeys } from './queryKeys';
import type { Chat, MessageCreatedEvent } from '@app-types/index';

type Handlers = {
  onConversationUpsert?: (e: unknown) => void;
  onMessageCreated?: (e: MessageCreatedEvent) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
};

const LIST_KEY = queryKeys.chats.list({} as Record<string, unknown>);

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
    lastMessage: 'old preview',
    ...overrides,
  };
}

function inboundMessage(id = 'm-1', sessionId = 'c1', rev = 500): MessageCreatedEvent {
  return {
    sessionId,
    conversationRevision: rev,
    message: {
      id,
      sessionId,
      type: 'text',
      content: 'fresh inbound',
      senderType: 'user',
      sender: 'user',
      status: 'sent',
      createdAt: '2026-08-14T12:00:00.000Z',
      timestamp: '2026-08-14T12:00:00.000Z',
    },
  };
}

let queryClient: QueryClient;

function setup(options: Parameters<typeof useLiveConversationSync>[0] = {}) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook((props: Parameters<typeof useLiveConversationSync>[0]) => useLiveConversationSync(props), {
    wrapper,
    initialProps: options,
  });
  const handlers = registerHandlersMock.mock.calls.at(-1)?.[0] as unknown as Handlers;
  return { ...view, handlers };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetConversationLiveState();
  socketState.isConnected = true;
});

describe('useLiveConversationSync', () => {
  it('an inbound message updates an already-open Inbox list without a refresh (and re-sorts)', () => {
    const { handlers } = setup();
    const other = makeChat({ id: 'other', lastActivityAt: '2026-08-14T11:00:00.000Z' });
    const target = makeChat({ id: 'c1', lastActivityAt: '2026-08-14T08:00:00.000Z' });
    queryClient.setQueryData(LIST_KEY, { data: [other, target] });
    queryClient.setQueryData(queryKeys.chats.detail('c1'), { ...makeChat(), messages: [] });

    act(() => handlers.onMessageCreated!(inboundMessage()));

    // Unselected list row: preview + re-sort to the top, no refetch.
    const rows = queryClient.getQueryData<ChatListCacheEntry>(LIST_KEY)!.data;
    expect(rows.map((r) => r.id)).toEqual(['c1', 'other']);
    expect(rows[0].lastMessage).toBe('fresh inbound');
    // Open thread got the message appended.
    const detail = queryClient.getQueryData<{ messages: unknown[] }>(queryKeys.chats.detail('c1'))!;
    expect(detail.messages).toHaveLength(1);
    // No refetch was needed for any of this.
    expect(queryClient.isFetching()).toBe(0);
  });

  it('a conversation:upsert reaches the selected-chat callback with a NORMALIZED patch', () => {
    const onSelectedUpsert = vi.fn();
    const { handlers } = setup({ selectedChatId: 'c1', onSelectedUpsert });

    act(() =>
      handlers.onConversationUpsert!({
        revision: 100,
        conversation: { id: 'c1', sessionId: 'c1', status: 'active', tenantId: 't1', assignedAgentId: 'ag-1' },
      }),
    );

    expect(onSelectedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', status: 'human', assignedAgentId: 'ag-1' }),
    );

    // A STALE upsert (lower revision) never reaches the callback.
    onSelectedUpsert.mockClear();
    act(() =>
      handlers.onConversationUpsert!({
        revision: 99,
        conversation: { id: 'c1', sessionId: 'c1', status: 'handoff' },
      }),
    );
    expect(onSelectedUpsert).not.toHaveBeenCalled();
  });

  it('disconnect→reconnect invalidates the chat + handoff queries; a plain connect does not', () => {
    const { handlers } = setup();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => handlers.onConnect!()); // initial connect, no gap
    expect(invalidateSpy).not.toHaveBeenCalled();

    act(() => {
      handlers.onDisconnect!('transport close');
      handlers.onConnect!();
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.chats.all() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.handoffs.all() });
  });

  it('a hook that MOUNTS disconnected treats the first connect as a catch-up', () => {
    socketState.isConnected = false;
    const { handlers } = setup();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => handlers.onConnect!()); // first connect after a disconnected mount
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.chats.all() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.handoffs.all() });
  });

  it('reconnect replay does not duplicate messages (seen-id + id dedupe)', () => {
    const { handlers } = setup();
    queryClient.setQueryData(queryKeys.chats.detail('c1'), { ...makeChat(), messages: [] });

    act(() => handlers.onMessageCreated!(inboundMessage('m-1')));
    // The same event replays after the reconnect catch-up.
    act(() => handlers.onMessageCreated!(inboundMessage('m-1')));

    const detail = queryClient.getQueryData<{ messages: unknown[] }>(queryKeys.chats.detail('c1'))!;
    expect(detail.messages).toHaveLength(1);
  });

  it('window focus invalidates list queries, not every cached thread', () => {
    setup();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [...queryKeys.chats.all(), 'list'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.chats.all() });
  });

  it('visibilitychange to visible does not refetch detail while the socket is live', () => {
    setup({ selectedChatId: 'c1' });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('visibilitychange to visible refetches the open detail when the socket is down', () => {
    socketState.isConnected = false;
    setup({ selectedChatId: 'c1' });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.chats.detail('c1') });
  });

  it('plays the message sound ONCE for a new user message in the open thread; duplicates stay silent', () => {
    const { handlers } = setup({ selectedChatId: 'c1' });
    queryClient.setQueryData(queryKeys.chats.detail('c1'), { ...makeChat(), messages: [] });

    act(() => handlers.onMessageCreated!(inboundMessage('m-9')));
    act(() => handlers.onMessageCreated!(inboundMessage('m-9'))); // second room delivery
    expect(playMessageMock).toHaveBeenCalledTimes(1);

    // A message for a DIFFERENT (unselected) conversation is silent.
    act(() => handlers.onMessageCreated!(inboundMessage('m-10', 'c2')));
    expect(playMessageMock).toHaveBeenCalledTimes(1);
  });

  it('unregisters the socket handlers on unmount', () => {
    const { unmount } = setup();
    unmount();
    expect(unregisterHandlersMock).toHaveBeenCalledWith('handler-1');
  });
});
