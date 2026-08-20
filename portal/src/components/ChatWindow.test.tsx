/**
 * Tests for the ChatWindow composer behavior (B-PR3b fix round):
 *  - FIX 5: completing a send clears ONLY the sent draft — text the operator
 *    typed while the POST was in flight is never erased.
 *  - FIX 4: a retry that returns 409 surfaces the non-destructive
 *    "another agent took this" notice (the hook keeps the bubble).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Chat, Message } from '@app-types/index';
import type { SendMessageResult } from '../queries/useChatQueries';

const { useChatDetailMock, sendMessageMock, retryMessageMock } = vi.hoisted(() => ({
  useChatDetailMock: vi.fn(),
  sendMessageMock: vi.fn(),
  retryMessageMock: vi.fn(),
}));

vi.mock('../queries/useChatQueries', () => ({
  useChatDetail: useChatDetailMock,
  // B-PR4b: ChatWindow also mounts the thread hook - an empty thread here
  // keeps these composer tests focused on the live-session behavior.
  useChatThread: () => ({
    thread: null,
    earlierSessions: [],
    earlierCount: 0,
    truncated: false,
    possibleDuplicates: [],
    isLoading: false,
    error: null,
  }),
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
    id: 'c1',
    sessionId: 'c1',
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

function mockDetail(messages: Message[] = []) {
  useChatDetailMock.mockReturnValue({
    chat: makeChat(),
    messages,
    isTyping: false,
    typingUsers: [],
    isLoading: false,
    isFetching: false,
    error: null,
    sendMessage: sendMessageMock,
    retryMessage: retryMessageMock,
    sendTyping: vi.fn(),
    refetch: vi.fn(),
    markAsRead: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChatWindow composer', () => {
  it('clears only the SENT draft — text typed during the POST is preserved', async () => {
    mockDetail();
    let resolveSend!: (r: SendMessageResult) => void;
    sendMessageMock.mockImplementation(
      () => new Promise<SendMessageResult>((resolve) => { resolveSend = resolve; }),
    );

    const user = userEvent.setup();
    render(<ChatWindow chat={makeChat()} />);

    const textarea = screen.getByPlaceholderText('Type a message…');
    await user.type(textarea, 'first reply');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(sendMessageMock).toHaveBeenCalledWith('first reply');

    // The operator keeps typing while the POST is in flight.
    await user.type(textarea, ' and a second thought');

    await act(async () => {
      resolveSend({ status: 'sent' });
    });

    // The newly-typed text is NOT erased.
    await waitFor(() =>
      expect(textarea).toHaveValue('first reply and a second thought'),
    );
  });

  it('clears the composer when the input still equals the sent draft', async () => {
    mockDetail();
    sendMessageMock.mockResolvedValue({ status: 'sent' } satisfies SendMessageResult);

    const user = userEvent.setup();
    render(<ChatWindow chat={makeChat()} />);

    const textarea = screen.getByPlaceholderText('Type a message…');
    await user.type(textarea, 'just this');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('a first-send 409 keeps the draft and shows the non-destructive notice', async () => {
    mockDetail();
    sendMessageMock.mockResolvedValue({
      status: 'conflict',
      code: 'conversation_already_claimed',
    } satisfies SendMessageResult);

    const user = userEvent.setup();
    render(<ChatWindow chat={makeChat()} />);

    const textarea = screen.getByPlaceholderText('Type a message…');
    await user.type(textarea, 'my precious draft');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'A different agent has this conversation',
      ),
    );
    expect(textarea).toHaveValue('my precious draft');
  });

  it('a first-send 403 operator_not_in_tenant keeps the draft and says to ask an admin', async () => {
    mockDetail();
    sendMessageMock.mockResolvedValue({
      status: 'conflict',
      code: 'operator_not_in_tenant',
    } satisfies SendMessageResult);

    const user = userEvent.setup();
    render(<ChatWindow chat={makeChat()} />);

    const textarea = screen.getByPlaceholderText('Type a message…');
    await user.type(textarea, 'still mine');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/ask an admin to add you as a support agent/i),
    );
    expect(textarea).toHaveValue('still mine');
  });

  it('a retry that 409s surfaces the taken-notice (FIX 4 — the window acts on the result)', async () => {
    const failed: Message = {
      id: 'cid-1',
      clientMessageId: 'cid-1',
      chatId: 'c1',
      type: 'text',
      content: 'undelivered text',
      sender: 'agent',
      isRead: true,
      createdAt: '2026-08-14T12:00:00.000Z',
      deliveryState: 'failed',
    };
    mockDetail([failed]);
    retryMessageMock.mockResolvedValue({
      status: 'conflict',
      code: 'conversation_already_claimed',
    } satisfies SendMessageResult);

    const user = userEvent.setup();
    render(<ChatWindow chat={makeChat()} />);

    await user.click(screen.getByRole('button', { name: /Retry/ }));

    expect(retryMessageMock).toHaveBeenCalledWith('cid-1');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'A different agent has this conversation',
      ),
    );
    // The failed bubble is still rendered (the hook keeps it).
    expect(screen.getByText('undelivered text')).toBeInTheDocument();
  });

  it('hints that sending will take over a bot-owned conversation', async () => {
    mockDetail();
    const user = userEvent.setup();
    render(
      <ChatWindow chat={{ ...makeChat(), status: 'bot', ownership: 'bot_owned' }} />,
    );

    expect(screen.queryByTestId('send-takes-over-hint')).not.toBeInTheDocument();
    await user.click(screen.getByPlaceholderText('Type a message…'));
    expect(screen.getByTestId('send-takes-over-hint')).toHaveTextContent(
      'Sending will take over this conversation from the AI',
    );
  });
});

describe('ChatWindow system events', () => {
  it('renders a handoff system message as caption text, not a File card', () => {
    const sys: Message = {
      id: 'sys-1',
      chatId: 'c1',
      type: 'system',
      content: 'Handoff requested: escalation trigger',
      sender: 'system',
      senderName: 'System',
      isRead: true,
      createdAt: '2026-08-20T16:41:00.000Z',
    };
    mockDetail([sys]);
    render(<ChatWindow chat={makeChat()} />);
    expect(screen.getByTestId('system-event')).toHaveTextContent(
      'Handoff requested: escalation trigger',
    );
    expect(screen.queryByText(/^File$/)).not.toBeInTheDocument();
  });
});
