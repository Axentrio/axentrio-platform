/**
 * B-PR4b - ChatStream "N earlier" badge: derived from the thread endpoint's
 * count for the SELECTED row only (no per-row thread fetches), shown only
 * when the customer actually has thread history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

function makeChat(id: string): Chat {
  return {
    id,
    sessionId: id,
    tenantId: 't1',
    userId: `v-${id}`,
    userName: `Visitor ${id}`,
    status: 'bot',
    messages: [],
    metadata: { source: 'widget' },
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:00:00.000Z',
    lastActivityAt: '2026-08-14T09:00:00.000Z',
    lastMessage: 'hello there',
    messageCount: 3,
    channel: 'whatsapp',
    metadata: { source: 'whatsapp' },
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

function mockThread(earlierCount: number) {
  useChatThreadMock.mockReturnValue({
    thread: null,
    earlierSessions: [],
    earlierCount,
    truncated: false,
    possibleDuplicates: [],
    isLoading: false,
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChatStream earlier-conversations badge (B-PR4b)', () => {
  it('badges ONLY the selected row when the thread has history', () => {
    mockChats([makeChat('c1'), makeChat('c2')]);
    mockThread(2);

    render(
      <ChatStream
        tenants={[]}
        onChatSelect={vi.fn()}
        onTakeover={vi.fn()}
        selectedChatId="c1"
      />,
    );

    // Exactly one badge, and the thread count comes from the SELECTED id.
    const badges = screen.getAllByText('2 earlier');
    expect(badges).toHaveLength(1);
    expect(useChatThreadMock).toHaveBeenCalledWith('c1');
    // The badge sits in the selected row (c1), not the other one.
    expect(badges[0].closest('[role="button"]')).toHaveTextContent('Visitor c1');
    expect(screen.getAllByLabelText('WhatsApp').length).toBeGreaterThan(0);
  });

  it('shows no badge when the selected customer has no history', () => {
    mockChats([makeChat('c1'), makeChat('c2')]);
    mockThread(0);

    render(
      <ChatStream
        tenants={[]}
        onChatSelect={vi.fn()}
        onTakeover={vi.fn()}
        selectedChatId="c1"
      />,
    );

    expect(screen.queryByText(/earlier/)).not.toBeInTheDocument();
  });

  it('shows no badge when nothing is selected', () => {
    mockChats([makeChat('c1')]);
    mockThread(5);

    render(
      <ChatStream tenants={[]} onChatSelect={vi.fn()} onTakeover={vi.fn()} />,
    );

    expect(screen.queryByText('5 earlier')).not.toBeInTheDocument();
  });
});
