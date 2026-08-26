import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CopilotDrawerProvider, useCopilotDrawer } from './CopilotDrawerProvider';
import { CopilotDrawer } from './CopilotDrawer';

const { sendHandler, clearConversation } = vi.hoisted(() => ({
  sendHandler: vi.fn(),
  clearConversation: vi.fn(),
}));

vi.mock('@/queries/useReadinessQueries', () => ({
  useBotReadiness: () => ({ data: { capabilities: [] } }),
}));

vi.mock('@/queries/useCopilotQueries', () => ({
  useCopilotConversation: () => ({
    isLoading: false,
    data: {
      conversationId: 'c1',
      messages: [
        {
          id: 'm1',
          turn: 0,
          role: 'user',
          content: 'older question',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'm2',
          turn: 1,
          role: 'assistant',
          content: 'older answer',
          toolsCalled: [],
          outcome: 'success',
          tokensIn: 1,
          tokensOut: 1,
          latencyMs: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    },
  }),
  useSendCopilotMessageHandler: () => sendHandler,
  useClearCopilotConversation: () => ({
    mutateAsync: clearConversation,
    isPending: false,
  }),
  useEscalateToSupport: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/queries/useEntitlementsQueries', () => ({
  useHasFeature: () => true,
}));

function OpenControl() {
  const { open } = useCopilotDrawer();
  return (
    <button type="button" onClick={open}>
      Open assistant
    </button>
  );
}

function SettingsControl() {
  return (
    <button type="button" onClick={() => undefined}>
      Change settings
    </button>
  );
}

function TestApp() {
  return (
    <MemoryRouter initialEntries={['/ai']}>
      <CopilotDrawerProvider>
        <SettingsControl />
        <OpenControl />
        <CopilotDrawer />
      </CopilotDrawerProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  sendHandler.mockReset();
  clearConversation.mockReset().mockResolvedValue(undefined);
  document.body.style.overflow = '';
});

describe('CopilotDrawer', () => {
  it('keeps the portal usable while the assistant is open', async () => {
    const user = userEvent.setup();
    render(<TestApp />);
    await user.click(screen.getByRole('button', { name: 'Open assistant' }));

    expect(screen.getByText('older question')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(document.querySelector('.backdrop-blur-sm')).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe('hidden');
    expect(screen.getByRole('button', { name: 'Change settings' })).toBeEnabled();
    expect(screen.getByRole('complementary', { name: 'AI Platform Assistant' })).toBeInTheDocument();
  });
});
