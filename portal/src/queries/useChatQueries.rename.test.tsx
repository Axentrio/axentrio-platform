import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { Chat } from '@app-types/index';
import { queryKeys } from './queryKeys';
import type { ChatDetailCacheEntry, ChatListCacheEntry } from './conversationLive';

const { apiPatch } = vi.hoisted(() => ({ apiPatch: vi.fn() }));

vi.mock('../services/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../services/apiClient')>(
    '../services/apiClient',
  );
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: apiPatch,
      delete: vi.fn(),
    },
  };
});

vi.mock('@websocket/SocketContext', () => ({
  useSocket: () => ({
    isConnected: true,
    isConnecting: false,
    connectionError: null,
    registerHandlers: vi.fn(() => 'handler-1'),
    unregisterHandlers: vi.fn(),
    joinChat: vi.fn(),
    leaveChat: vi.fn(),
    sendTyping: vi.fn(),
    updateStatus: vi.fn(),
    reconnect: vi.fn(),
  }),
}));

import { useRenameConversation } from './useChatQueries';

const CHAT_ID = 'sess-1';
const LIST_KEY = queryKeys.chats.list({} as Record<string, unknown>);
const DETAIL_KEY = queryKeys.chats.detail(CHAT_ID);

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: CHAT_ID,
    sessionId: CHAT_ID,
    tenantId: 't1',
    userId: '',
    userName: 'Visitor',
    status: 'bot',
    messages: [],
    metadata: { source: 'widget' },
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:00:00.000Z',
    lastActivityAt: '2026-08-14T09:00:00.000Z',
    messageCount: 1,
    lastMessage: 'hi',
    ...overrides,
  };
}

describe('useRenameConversation', () => {
  let queryClient: QueryClient;

  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<ChatListCacheEntry>(LIST_KEY, { data: [makeChat()] });
    queryClient.setQueryData<ChatDetailCacheEntry>(DETAIL_KEY, makeChat());
  });

  it('rolls list and detail caches back when PATCH fails', async () => {
    apiPatch.mockRejectedValue(new Error('rename failed'));
    const { result } = renderHook(() => useRenameConversation(), { wrapper });

    await act(async () => {
      await expect(result.current(CHAT_ID, 'Ada Lovelace')).rejects.toThrow('rename failed');
    });

    expect(queryClient.getQueryData<ChatListCacheEntry>(LIST_KEY)?.data[0].userName).toBe(
      'Visitor',
    );
    expect(queryClient.getQueryData<ChatDetailCacheEntry>(DETAIL_KEY)?.userName).toBe('Visitor');
  });
});
