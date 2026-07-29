import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TestChatPanel from './TestChatPanel';

// The panel drives the preview through useBotTestChat. Mock it so `mutate`
// records the payload AND echoes a canned assistant reply via onSuccess — the
// transcript then grows exactly as it does in the app.
const { mockMutate } = vi.hoisted(() => ({ mockMutate: vi.fn() }));

vi.mock('@/queries/useBotsQueries', () => ({
  useBotTestChat: () => ({ mutate: mockMutate, isPending: false }),
}));

beforeEach(() => {
  mockMutate.mockReset();
  mockMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: (d: unknown) => void }) => {
    opts?.onSuccess?.({ response: 'Bot reply' });
  });
});

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  botId: 'bot-1',
  botName: 'TestBot',
  provider: 'openai',
  model: 'gpt-4o-mini',
  hasIndexedDocs: false,
};

const send = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  const input = screen.getByPlaceholderText('Type a message…');
  await user.type(input, `${text}{Enter}`);
};

const lastHistory = () => {
  const calls = mockMutate.mock.calls;
  return (calls[calls.length - 1]?.[0] as { history: unknown[] }).history;
};

describe('TestChatPanel — New chat reset', () => {
  it('clears the transcript so the current bot config takes effect on the next message', async () => {
    const user = userEvent.setup();
    render(<TestChatPanel {...defaultProps} />);

    await send(user, 'hello');
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText('Bot reply')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /new chat/i }));

    // Transcript gone, empty state back.
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    expect(screen.queryByText('Bot reply')).not.toBeInTheDocument();
    expect(screen.getByText('Send a message to test your bot')).toBeInTheDocument();
  });

  it('drops the stale conversation history from the payload after reset', async () => {
    const user = userEvent.setup();
    render(<TestChatPanel {...defaultProps} />);

    await send(user, 'one');
    await send(user, 'two');
    // The 2nd send replays the prior user+assistant turns.
    expect(lastHistory()).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /new chat/i }));

    await send(user, 'three');
    // After reset, the next send carries no prior turns — so the model sees only
    // the fresh system prompt (current specialty), not the old persona.
    expect(lastHistory()).toEqual([]);
  });

  it('disables New chat while the transcript is empty', () => {
    render(<TestChatPanel {...defaultProps} />);
    expect(screen.getByRole('button', { name: /new chat/i })).toBeDisabled();
  });
});
