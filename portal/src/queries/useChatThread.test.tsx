/**
 * B-PR4b - useChatThread: fetches GET /chats/:id/thread into its OWN cache
 * entry (a sibling of the live detail cache, which stays untouched), derives
 * the prior-session blocks in portal shape, and reports the TRUE pre-cap
 * earlier count for the list badge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatThreadResponse } from '@app-types/index';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../services/apiClient', () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  handleApiError: (e: unknown) => String(e),
}));

vi.mock('@websocket/SocketContext', () => ({
  useSocket: () => ({
    registerHandlers: vi.fn(() => 'h'),
    unregisterHandlers: vi.fn(),
    joinChat: vi.fn(),
    leaveChat: vi.fn(),
    sendTyping: vi.fn(),
    isConnected: true,
    isConnecting: false,
  }),
}));

import { useChatThread, threadMessageToMessage } from './useChatQueries';
import { queryKeys } from './queryKeys';

function threadPayload(): ChatThreadResponse {
  return {
    sessionId: 'c-current',
    customerThreadId: 'w:t1:b1:v1',
    identity: 'widget',
    totalSessions: 23, // pre-cap truth: 22 earlier, only 2 returned below
    truncated: true,
    sessions: [
      {
        summary: { id: 'c-old', sessionId: 'c-old', status: 'closed' },
        boundary: {
          startedAt: '2026-08-01T09:00:00.000Z',
          endedAt: '2026-08-01T09:30:00.000Z',
          status: 'closed',
        },
        isCurrent: false,
        messages: [
          {
            id: 'm-old-1',
            sessionId: 'c-old',
            type: 'text',
            content: 'old hello',
            createdAt: '2026-08-01T09:05:00.000Z',
            sender: 'user',
            senderName: 'Customer',
          },
        ],
      },
      {
        summary: { id: 'c-current', sessionId: 'c-current', status: 'active' },
        boundary: {
          startedAt: '2026-08-14T09:00:00.000Z',
          endedAt: null,
          status: 'active',
        },
        isCurrent: true,
        messages: [],
      },
    ],
    possibleDuplicates: [],
  };
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useChatThread (B-PR4b)', () => {
  it('fetches the thread, derives prior sessions, and never touches the detail cache', async () => {
    apiGetMock.mockResolvedValue(threadPayload());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A pre-existing live detail entry that must stay untouched.
    const detailEntry = { id: 'c-current', messages: [{ id: 'live-1' }] };
    client.setQueryData(queryKeys.chats.detail('c-current'), detailEntry);

    const { result } = renderHook(() => useChatThread('c-current'), {
      wrapper: makeWrapper(client),
    });

    await waitFor(() => expect(result.current.thread).not.toBeNull());
    expect(apiGetMock).toHaveBeenCalledWith('/chats/c-current/thread');

    // Derivation: only NON-current sessions, portal-shaped messages.
    expect(result.current.earlierSessions).toHaveLength(1);
    const earlier = result.current.earlierSessions[0];
    expect(earlier.id).toBe('c-old');
    expect(earlier.status).toBe('closed');
    expect(earlier.messages[0]).toMatchObject({
      id: 'm-old-1',
      chatId: 'c-old',
      content: 'old hello',
      sender: 'user',
      senderName: 'Customer',
      isRead: true,
    });

    // The badge count is the TRUE pre-cap count, not the returned page size.
    expect(result.current.earlierCount).toBe(22);
    expect(result.current.truncated).toBe(true);

    // Cache separation: the thread lives under its OWN key; the live detail
    // entry is byte-for-byte untouched.
    expect(client.getQueryData(queryKeys.chats.thread('c-current'))).toBeTruthy();
    expect(client.getQueryData(queryKeys.chats.detail('c-current'))).toBe(detailEntry);
  });

  it('hides emptied earlier chats after a Reset wipe', async () => {
    apiGetMock.mockResolvedValue({
      ...threadPayload(),
      sessions: [
        {
          summary: { id: 'c-old', sessionId: 'c-old', status: 'closed' },
          boundary: {
            startedAt: '2026-08-01T09:00:00.000Z',
            endedAt: '2026-08-01T09:30:00.000Z',
            status: 'closed',
          },
          isCurrent: false,
          messages: [],
        },
        {
          summary: { id: 'c-current', sessionId: 'c-current', status: 'closed' },
          boundary: {
            startedAt: '2026-08-14T09:00:00.000Z',
            endedAt: '2026-08-14T09:05:00.000Z',
            status: 'closed',
          },
          isCurrent: true,
          messages: [],
        },
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useChatThread('c-current'), {
      wrapper: makeWrapper(client),
    });

    await waitFor(() => expect(result.current.thread).not.toBeNull());
    expect(result.current.earlierSessions).toEqual([]);
    expect(result.current.earlierCount).toBe(0);
  });

  it('does not fetch without a selected chat id', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useChatThread(undefined), {
      wrapper: makeWrapper(client),
    });

    expect(result.current.thread).toBeNull();
    expect(result.current.earlierSessions).toEqual([]);
    expect(result.current.earlierCount).toBe(0);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('threadMessageToMessage maps the detail-GET shape to the portal Message', () => {
    expect(
      threadMessageToMessage({
        id: 'm1',
        sessionId: 's1',
        type: '',
        content: 'hi',
        createdAt: '2026-08-14T09:00:00.000Z',
        sender: '',
      }),
    ).toEqual({
      id: 'm1',
      chatId: 's1',
      type: 'text',
      content: 'hi',
      sender: 'user',
      isRead: true,
      createdAt: '2026-08-14T09:00:00.000Z',
    });
  });
});
