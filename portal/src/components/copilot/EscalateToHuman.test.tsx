/**
 * The escalation exit.
 *
 * The one thing that must never happen here is telling someone help is on the way when
 * nothing was sent — that is worse than not offering the button at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EscalateToHuman } from './EscalateToHuman';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('@/services/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/apiClient')>()),
  api: { get: vi.fn(), post: apiPost, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EscalateToHuman />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiPost.mockReset().mockResolvedValue({ delivered: true, inbox: 'support@axentrio.com', priority: false });
});

describe('EscalateToHuman', () => {
  it('stays out of the way until asked for', async () => {
    // A support form permanently occupying the panel implies the assistant is
    // expected to fail.
    show();
    expect(screen.getByRole('button', { name: /talk to a person/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('sends what the customer wrote', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: /talk to a person/i }));
    await userEvent.type(screen.getByRole('textbox'), 'WhatsApp stopped working');
    await userEvent.click(screen.getByRole('button', { name: /send to support/i }));

    expect(apiPost).toHaveBeenCalledWith('/copilot/escalate', {
      message: 'WhatsApp stopped working',
    });
  });

  it('never sends an empty request', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: /talk to a person/i }));
    expect(screen.getByRole('button', { name: /send to support/i })).toBeDisabled();
  });

  it('confirms where it went', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: /talk to a person/i }));
    await userEvent.type(screen.getByRole('textbox'), 'help');
    await userEvent.click(screen.getByRole('button', { name: /send to support/i }));

    expect(await screen.findByText(/support@axentrio\.com/)).toBeInTheDocument();
  });

  it('says so when it did not send, instead of claiming success', async () => {
    apiPost.mockRejectedValue({
      isAxiosError: true,
      response: { status: 502, data: { error: { message: 'We could not send that just now.' } } },
    });
    show();
    await userEvent.click(screen.getByRole('button', { name: /talk to a person/i }));
    await userEvent.type(screen.getByRole('textbox'), 'help');
    await userEvent.click(screen.getByRole('button', { name: /send to support/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not send/i);
    expect(screen.queryByText(/we'll reply/i)).not.toBeInTheDocument();
  });
});
