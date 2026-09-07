import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Chat, Message } from '@app-types/index';
import { queryKeys } from '../queries/queryKeys';
import {
  ConversationDetailsPanel,
  buildTranscriptText,
} from './ConversationDetailsPanel';

const { updateTags, apiGet } = vi.hoisted(() => ({
  updateTags: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock('../queries/useChatQueries', async () => {
  const actual = await vi.importActual<typeof import('../queries/useChatQueries')>(
    '../queries/useChatQueries',
  );
  return {
    ...actual,
    useUpdateConversationTags: () => updateTags,
  };
});

vi.mock('../services/apiClient', () => ({
  api: {
    get: apiGet,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  handleApiError: (e: unknown) => e,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'c1',
    sessionId: 'c1',
    tenantId: 't1',
    userId: 'v1',
    userName: 'Achraf Lamrani',
    userEmail: 'achraf@axentrio.com',
    userPhone: '+31 6 12345678',
    location: 'Netherlands',
    leadId: 'lead-1',
    tags: ['Urgent'],
    status: 'human',
    ownership: 'human_owned',
    channel: 'whatsapp',
    tenantName: 'Axentrio Support',
    messages: [],
    metadata: { source: 'whatsapp' },
    createdAt: '2026-09-07T08:42:00.000Z',
    updatedAt: '2026-09-07T08:47:00.000Z',
    lastActivityAt: '2026-09-07T08:47:00.000Z',
    ...overrides,
  };
}

function renderPanel(chat: Chat, onAssign?: () => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.chats.detail(chat.id), chat);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConversationDetailsPanel
          chat={chat}
          workspaceName="Fallback Workspace"
          onAssign={onAssign}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ConversationDetailsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateTags.mockResolvedValue(undefined);
    apiGet.mockResolvedValue(makeChat());
  });

  it('shows contact, conversation facts, labels, and relevant actions', () => {
    renderPanel(makeChat(), vi.fn());

    const panel = screen.getByTestId('conversation-details-panel');
    expect(within(panel).getByText('+31 6 12345678')).toBeInTheDocument();
    expect(within(panel).getByText('achraf@axentrio.com')).toBeInTheDocument();
    expect(within(panel).getByText('Netherlands')).toBeInTheDocument();
    expect(within(panel).getByText('Axentrio Support')).toBeInTheDocument();
    expect(within(panel).getByText('WhatsApp')).toBeInTheDocument();
    expect(within(panel).getByText('Urgent')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'View customer' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Assign conversation' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Export conversation' })).toBeInTheDocument();
  });

  it('omits missing contact and lead actions', () => {
    renderPanel(
      makeChat({
        userEmail: undefined,
        userPhone: undefined,
        location: undefined,
        leadId: null,
        tags: [],
        ownership: 'bot_owned',
        status: 'bot',
      }),
    );

    const panel = screen.getByTestId('conversation-details-panel');
    expect(within(panel).queryByText('achraf@axentrio.com')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'View customer' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Assign conversation' })).not.toBeInTheDocument();
    expect(within(panel).getByText('No labels')).toBeInTheDocument();
  });

  it('adds a label through the plus control', async () => {
    const user = userEvent.setup();
    renderPanel(makeChat({ tags: [] }));

    const addButtons = screen.getAllByRole('button', { name: 'Add label' });
    await user.click(addButtons[0]);
    await user.type(screen.getByPlaceholderText('New label'), 'Toegang');
    await user.keyboard('{Enter}');

    expect(updateTags).toHaveBeenCalledWith('c1', ['Toegang']);
  });

  it('buildTranscriptText serialises sender and body', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        chatId: 'c1',
        type: 'text',
        content: 'Hello',
        sender: 'user',
        senderName: 'Achraf',
        isRead: true,
        createdAt: '2026-09-07T08:42:00.000Z',
      },
    ];
    expect(buildTranscriptText(makeChat(), messages)).toContain('[2026-09-07T08:42:00.000Z] Achraf: Hello');
  });
});
