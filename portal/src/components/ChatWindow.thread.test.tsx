/**
 * B-PR4b - ChatWindow thread continuity:
 *  - prior closed sessions render as labelled boundary blocks ABOVE the live
 *    thread, collapsed by default, expandable read-only;
 *  - the CURRENT session stays the composable thread;
 *  - the possible-duplicates audit renders read-only and opens via callback;
 *  - the truncation notice shows only when the server signals the cap.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Chat, Message, ThreadDuplicateEntry } from '@app-types/index';
import type { EarlierThreadSession, UseChatThreadReturn } from '../queries/useChatQueries';

const { useChatDetailMock, useChatThreadMock } = vi.hoisted(() => ({
  useChatDetailMock: vi.fn(),
  useChatThreadMock: vi.fn(),
}));

vi.mock('../queries/useChatQueries', () => ({
  useChatDetail: useChatDetailMock,
  useChatThread: useChatThreadMock,
}));

vi.mock('@websocket/notificationSound', () => ({
  useNotificationSound: () => ({
    playMessage: vi.fn(),
    playHandoff: vi.fn(),
    isMuted: false,
    toggleMute: vi.fn(),
    setVolume: vi.fn(),
  }),
}));

vi.mock('./CannedResponsePicker', () => ({
  SlashCommandDropdown: () => null,
  CannedResponsePickerButton: () => null,
}));

import { ChatWindow } from './ChatWindow';

function makeChat(): Chat {
  return {
    id: 'c-current',
    sessionId: 'c-current',
    tenantId: 't1',
    userId: 'v1',
    userName: 'Visitor',
    status: 'human',
    messages: [],
    metadata: { source: 'widget' },
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:00:00.000Z',
  };
}

function liveMessage(content: string): Message {
  return {
    id: `live-${content}`,
    chatId: 'c-current',
    type: 'text',
    content,
    sender: 'user',
    isRead: true,
    createdAt: '2026-08-14T10:00:00.000Z',
  };
}

function earlierSession(id: string, contents: string[]): EarlierThreadSession {
  return {
    id,
    boundary: {
      startedAt: '2026-08-01T09:00:00.000Z',
      endedAt: '2026-08-01T09:30:00.000Z',
      status: 'closed',
    },
    status: 'closed',
    messages: contents.map((content, i) => ({
      id: `${id}-m${i}`,
      chatId: id,
      type: 'text',
      content,
      sender: 'user',
      isRead: true,
      createdAt: '2026-08-01T09:05:00.000Z',
    })),
  };
}

function mockDetail(messages: Message[] = []) {
  useChatDetailMock.mockReturnValue({
    chat: makeChat(),
    messages,
    isTyping: false,
    typingUsers: [],
    isLoading: false,
    isFetching: false,
    error: null,
    sendMessage: vi.fn(),
    retryMessage: vi.fn(),
    sendTyping: vi.fn(),
    refetch: vi.fn(),
    markAsRead: vi.fn(),
  });
}

function mockThread(overrides: Partial<UseChatThreadReturn> = {}) {
  useChatThreadMock.mockReturnValue({
    thread: null,
    earlierSessions: [],
    earlierCount: 0,
    truncated: false,
    possibleDuplicates: [],
    isLoading: false,
    error: null,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChatWindow thread continuity (B-PR4b)', () => {
  it('renders prior closed sessions as collapsed boundaries ABOVE the live thread', async () => {
    mockDetail([liveMessage('live message')]);
    mockThread({
      earlierSessions: [earlierSession('old-1', ['old hello', 'old follow-up'])],
    });

    const user = userEvent.setup();
    render(<ChatWindow chat={makeChat()} />);

    // The boundary label is present, collapsed by default: earlier message
    // content is NOT in the document yet.
    const boundary = screen.getByRole('button', { expanded: false });
    expect(boundary).toHaveTextContent(/Earlier conversation - closed/);
    expect(boundary).toHaveTextContent('2 messages');
    expect(screen.queryByText('old hello')).not.toBeInTheDocument();

    // The boundary block sits ABOVE the live message in the DOM.
    const live = screen.getByText('live message');
    expect(
      boundary.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Expanding reveals the prior session's messages, read-only.
    await user.click(boundary);
    expect(boundary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('old hello')).toBeInTheDocument();
    expect(screen.getByText('old follow-up')).toBeInTheDocument();

    // Collapsing hides them again.
    await user.click(boundary);
    expect(screen.queryByText('old hello')).not.toBeInTheDocument();
  });

  it('keeps the CURRENT session composable while history renders', () => {
    mockDetail([liveMessage('live message')]);
    mockThread({
      earlierSessions: [earlierSession('old-1', ['old hello'])],
    });

    render(<ChatWindow chat={makeChat()} />);

    // Composer stays present and usable - B-PR3b behavior unchanged.
    expect(screen.getByPlaceholderText('Type a message…')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('renders history even when the current session has no live messages yet', () => {
    mockDetail([]);
    mockThread({
      earlierSessions: [earlierSession('old-1', ['old hello'])],
    });

    render(<ChatWindow chat={makeChat()} />);

    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent(
      /Earlier conversation - closed/,
    );
    // The empty state must NOT swallow the history.
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
  });

  it('shows the truncation notice only when the server signals the cap', () => {
    mockDetail([liveMessage('live message')]);
    mockThread({
      earlierSessions: [earlierSession('old-1', ['old hello'])],
      truncated: true,
    });

    render(<ChatWindow chat={makeChat()} />);
    expect(
      screen.getByText('Only the newest earlier conversations are shown'),
    ).toBeInTheDocument();
  });

  it('renders the possible-duplicates audit read-only and opens a session via the callback', async () => {
    const duplicates: ThreadDuplicateEntry[] = [
      {
        summary: {
          id: 'dup-1',
          sessionId: 'dup-1',
          status: 'closed',
          userName: 'Visitor abc',
          channel: 'messenger',
        },
        boundary: {
          startedAt: '2026-07-01T09:00:00.000Z',
          endedAt: '2026-07-01T09:30:00.000Z',
          status: 'closed',
        },
      },
    ];
    mockDetail([liveMessage('live message')]);
    mockThread({ possibleDuplicates: duplicates });

    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<ChatWindow chat={makeChat()} onOpenSession={onOpenSession} />);

    expect(screen.getByText('Possible same customer - not merged')).toBeInTheDocument();
    expect(screen.getByText(/Visitor abc/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenSession).toHaveBeenCalledWith('dup-1');
  });

  it('renders neither boundaries nor the audit for an empty thread', () => {
    mockDetail([liveMessage('live message')]);
    mockThread();

    render(<ChatWindow chat={makeChat()} />);

    expect(screen.queryByText(/Earlier conversation/)).not.toBeInTheDocument();
    expect(screen.queryByText('Possible same customer - not merged')).not.toBeInTheDocument();
  });
});
