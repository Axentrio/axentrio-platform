import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CopilotDrawerProvider, useCopilotDrawer } from './CopilotDrawerProvider';
import { CopilotDrawer } from './CopilotDrawer';
import type { CopilotConversationMessage } from '../../queries/useCopilotQueries';

const QUESTION = 'welke dieren zijn in afrika?';
const REPLY = 'In Afrika leven onder andere leeuwen.';

const { conversationState, sendHandler, clearConversation } = vi.hoisted(() => ({
  conversationState: {
    conversationId: 'conv-1' as string | null,
    messages: [] as CopilotConversationMessage[],
    nextCursor: null as number | null,
  },
  sendHandler: vi.fn(),
  clearConversation: vi.fn(),
}));

vi.mock('@/queries/useReadinessQueries', () => ({
  useBotReadiness: () => ({ data: { capabilities: [] } }),
}));

vi.mock('@/queries/useCopilotQueries', () => ({
  useCopilotConversation: () => ({
    data: conversationState,
    isLoading: false,
  }),
  useSendCopilotMessageHandler: () => sendHandler,
  useClearCopilotConversation: () => ({
    mutateAsync: clearConversation,
    isPending: false,
  }),
  useEscalateToSupport: () => ({
    isSuccess: false,
    isError: false,
    isPending: false,
    mutate: vi.fn(),
    data: undefined,
    error: null,
  }),
}));

vi.mock('@/queries/useEntitlementsQueries', () => ({
  useHasFeature: () => true,
}));

function OpenControl() {
  const { open, isOpen } = useCopilotDrawer();
  return isOpen ? null : (
    <button type="button" onClick={open}>
      Open test drawer
    </button>
  );
}

function TestApp() {
  return (
    <MemoryRouter initialEntries={['/dashboard']}>
      <CopilotDrawerProvider>
        <OpenControl />
        <CopilotDrawer />
      </CopilotDrawerProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  conversationState.conversationId = 'conv-1';
  conversationState.messages = [];
  sendHandler.mockReset();
  clearConversation.mockReset().mockResolvedValue(undefined);
});

describe('CopilotDrawer transcript', () => {
  async function sendCurrentQuestion() {
    const user = userEvent.setup();
    render(<TestApp />);
    await user.click(screen.getByRole('button', { name: 'Open test drawer' }));
    await user.type(
      screen.getByPlaceholderText(
        'Ask about your bot, plan, leads, or how to do anything in Axentrio…',
      ),
      QUESTION,
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    return user;
  }

  it('does not show the same turn twice after the persisted copy arrives', async () => {
    sendHandler.mockImplementation(async ({ message }: { message: string }, cb: {
      onToken: (delta: string) => void;
      onComplete: (data: {
        turnId: string;
        conversationId: string;
        tokensIn: number;
        tokensOut: number;
        latencyMs: number;
      }) => void;
    }) => {
      conversationState.messages = [
        {
          id: 'user-1',
          turn: 1,
          role: 'user',
          content: message,
          createdAt: '2026-08-29T00:00:00.000Z',
        },
        {
          id: 'asst-1',
          turn: 2,
          role: 'assistant',
          content: REPLY,
          toolsCalled: [],
          outcome: 'success',
          tokensIn: 10,
          tokensOut: 20,
          latencyMs: 5,
          createdAt: '2026-08-29T00:00:01.000Z',
        },
      ];
      cb.onToken(REPLY);
      cb.onComplete({
        turnId: 'asst-1',
        conversationId: 'conv-1',
        tokensIn: 10,
        tokensOut: 20,
        latencyMs: 5,
      });
    });

    await sendCurrentQuestion();

    await waitFor(() => {
      expect(screen.getAllByText(QUESTION)).toHaveLength(1);
    });
    expect(screen.getByRole('dialog', { name: 'AI Platform Assistant' })).toBeVisible();
    expect(sendHandler).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(REPLY)).toHaveLength(1);
  });

  it('keeps the live reply when the transcript refetch does not land', async () => {
    sendHandler.mockImplementation(async (_args: { message: string }, cb: {
      onToken: (delta: string) => void;
      onComplete: (data: {
        turnId: string;
        conversationId: string;
        tokensIn: number;
        tokensOut: number;
        latencyMs: number;
      }) => void;
    }) => {
      cb.onToken(REPLY);
      cb.onComplete({
        turnId: 'asst-1',
        conversationId: 'conv-1',
        tokensIn: 10,
        tokensOut: 20,
        latencyMs: 5,
      });
    });

    await sendCurrentQuestion();

    await waitFor(() => {
      expect(screen.getByText(REPLY)).toBeInTheDocument();
    });
    expect(screen.getByRole('dialog', { name: 'AI Platform Assistant' })).toBeVisible();
    expect(conversationState.messages).toHaveLength(0);
    expect(screen.getAllByText(QUESTION)).toHaveLength(1);
    expect(screen.getAllByText(REPLY)).toHaveLength(1);
  });
});

function TripleSendControl() {
  const { send } = useCopilotDrawer();
  return (
    <button
      type="button"
      onClick={() => {
        void send('What plan am I on?');
        void send('What plan am I on?');
        void send('What plan am I on?');
      }}
    >
      triple send
    </button>
  );
}

describe('CopilotDrawer send re-entry', () => {
  it('starts only one turn when send is called three times in the same tick', async () => {
    let release!: () => void;
    sendHandler.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <CopilotDrawerProvider>
          <TripleSendControl />
        </CopilotDrawerProvider>
      </MemoryRouter>,
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'triple send' }));
    expect(sendHandler).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => {
      expect(sendHandler).toHaveBeenCalledTimes(1);
    });
  });
});
