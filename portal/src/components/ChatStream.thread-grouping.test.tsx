/**
 * Inbox list grouping is DISPLAY-ONLY: session rows stay distinct in cache
 * and on the wire. ChatStream collapses same-customer rows at render time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Chat } from '@app-types/index';

const { useChatsQueryMock, useChatThreadMock } = vi.hoisted(() => ({
  useChatsQueryMock: vi.fn(),
  useChatThreadMock: vi.fn(),
}));

vi.mock('../queries/useChatQueries', () => ({
  useChatsQuery: useChatsQueryMock,
  useChatThread: useChatThreadMock,
}));

import { ChatStream } from './ChatStream';

function makeChat(overrides: Partial<Chat> & { id: string }): Chat {
  return {
    sessionId: overrides.id,
    tenantId: 't1',
    userId: `v-${overrides.id}`,
    userName: `Visitor ${overrides.id}`,
    status: 'bot',
    messages: [],
    metadata: { source: 'telegram' },
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:00:00.000Z',
    lastActivityAt: '2026-08-14T09:00:00.000Z',
    lastMessage: 'hello there',
    messageCount: 3,
    ...overrides,
  };
}

function mockChats(chats: Chat[]) {
  useChatsQueryMock.mockReturnValue({
    chats,
    totalCount: chats.length,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
    pagination: { page: 1, totalPages: 1, hasMore: false },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatThreadMock.mockReturnValue({
    thread: null,
    earlierSessions: [],
    earlierCount: 0,
    truncated: false,
    possibleDuplicates: [],
    isLoading: false,
    error: null,
  });
});

describe('ChatStream customer-thread grouping (display only)', () => {
  it('collapses two rows that share a customerThreadId into the latest session', async () => {
    const onChatSelect = vi.fn();
    mockChats([
      makeChat({
        id: 'sess-new',
        customerThreadId: 'e:conn-1:tg-user-9:tg-chat-9',
        lastActivityAt: '2026-08-14T11:00:00.000Z',
        lastMessage: 'reopened just now',
        status: 'handsoff',
        userName: 'Visitor newest',
      }),
      makeChat({
        id: 'sess-prior',
        customerThreadId: 'e:conn-1:tg-user-9:tg-chat-9',
        lastActivityAt: '2026-08-14T08:00:00.000Z',
        lastMessage: 'older preview',
        status: 'bot',
        userName: 'Visitor older',
      }),
    ]);

    render(
      <ChatStream tenants={[]} onChatSelect={onChatSelect} onTakeover={vi.fn()} />,
    );

    expect(screen.getByText('Visitor newest')).toBeInTheDocument();
    expect(screen.getByText('reopened just now')).toBeInTheDocument();
    expect(screen.getByText('Handoff pending')).toBeInTheDocument();
    expect(screen.getByTitle(/2 conversations on this page/i)).toBeInTheDocument();
    expect(screen.queryByText('Visitor older')).not.toBeInTheDocument();
    expect(screen.queryByText('older preview')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Visitor newest'));
    expect(onChatSelect).toHaveBeenCalledTimes(1);
    expect(onChatSelect.mock.calls[0][0].id).toBe('sess-new');
    expect(onChatSelect.mock.calls[0][0].sessionId).toBe('sess-new');
  });

  it('never groups two s:-keyed rows — each unresolvable identity stands alone', () => {
    mockChats([
      makeChat({
        id: 'sess-a',
        customerThreadId: 's:sess-a',
        lastMessage: 'alpha',
        userName: 'Visitor A',
      }),
      makeChat({
        id: 'sess-b',
        customerThreadId: 's:sess-b',
        lastMessage: 'bravo',
        userName: 'Visitor B',
      }),
    ]);

    render(
      <ChatStream tenants={[]} onChatSelect={vi.fn()} onTakeover={vi.fn()} />,
    );

    expect(screen.getByText('Visitor A')).toBeInTheDocument();
    expect(screen.getByText('Visitor B')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('bravo')).toBeInTheDocument();
    expect(screen.queryByTitle(/conversations on this page/i)).not.toBeInTheDocument();
  });
});
