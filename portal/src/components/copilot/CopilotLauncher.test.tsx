import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CopilotDrawerProvider, useCopilotDrawer } from './CopilotDrawerProvider';
import { CopilotLauncher } from './CopilotLauncher';

const { readinessState, sendHandler, clearConversation } = vi.hoisted(() => ({
  readinessState: {
    capabilities: [] as Array<{
      capability: 'booking' | 'answering' | 'lead_capture' | 'channel';
      state: 'not_ready' | 'live';
      missingSteps: Array<{
        id: string;
        label: string;
        cta?: { route: string; label: string };
      }>;
    }>,
  },
  sendHandler: vi.fn(),
  clearConversation: vi.fn(),
}));

vi.mock('@/queries/useReadinessQueries', () => ({
  useBotReadiness: () => ({ data: readinessState }),
}));

vi.mock('@/queries/useCopilotQueries', () => ({
  useSendCopilotMessageHandler: () => sendHandler,
  useClearCopilotConversation: () => ({
    mutateAsync: clearConversation,
    isPending: false,
  }),
}));

vi.mock('@/queries/useEntitlementsQueries', () => ({
  useHasFeature: () => true,
}));

function CloseControl() {
  const { isOpen, close } = useCopilotDrawer();
  return isOpen ? <button onClick={close}>Close test drawer</button> : null;
}

function TestApp() {
  return (
    <MemoryRouter initialEntries={['/dashboard']}>
      <CopilotDrawerProvider>
        <CopilotLauncher />
        <CloseControl />
      </CopilotDrawerProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  readinessState.capabilities = [];
  sendHandler.mockReset();
  clearConversation.mockReset().mockResolvedValue(undefined);
});

describe('CopilotLauncher', () => {
  it('shows a badge for real readiness suggestions', () => {
    readinessState.capabilities = [
      {
        capability: 'answering',
        state: 'not_ready',
        missingSteps: [
          { id: 'knowledge', label: 'Add knowledge' },
          { id: 'instructions', label: 'Add instructions' },
        ],
      },
    ];

    render(<TestApp />);

    expect(
      screen.getByRole('button', { name: /2 suggestions available/i }),
    ).toHaveTextContent('2');
  });

  it('hides the badge when the drawer only has fallback questions', () => {
    readinessState.capabilities = [
      {
        capability: 'answering',
        state: 'live',
        missingSteps: [],
      },
    ];

    render(<TestApp />);

    const launcher = screen.getByRole('button', { name: 'Ask the AI Platform Assistant' });
    expect(launcher).not.toHaveTextContent(/\d/);
  });

  it('clears the badge after the drawer has been opened', async () => {
    readinessState.capabilities = [
      {
        capability: 'booking',
        state: 'not_ready',
        missingSteps: [{ id: 'calendar', label: 'Connect a calendar' }],
      },
    ];
    const user = userEvent.setup();

    const { rerender } = render(<TestApp />);
    await user.click(screen.getByRole('button', { name: /1 suggestion available/i }));
    await user.click(screen.getByRole('button', { name: 'Close test drawer' }));

    const launcher = screen.getByRole('button', { name: 'Ask the AI Platform Assistant' });
    expect(launcher).not.toHaveTextContent(/\d/);

    readinessState.capabilities = [
      {
        capability: 'answering',
        state: 'not_ready',
        missingSteps: [{ id: 'knowledge', label: 'Add knowledge' }],
      },
    ];
    rerender(<TestApp />);

    expect(screen.getByRole('button', { name: /1 suggestion available/i })).toHaveTextContent('1');
  });
});
