/**
 * Renaming a bot covers TWO names, and conflating them was a live bug.
 *
 * `name` is operator-facing — the label in the bots list. `assistantName`
 * (settings.ai.brandVoice.name) is what the bot calls itself to customers: it
 * feeds "You are <name>" and every template's {botName}. The editor for the
 * second was removed while the value kept feeding the prompt, so a production
 * bot introduced itself as "Mo" with nowhere in the app to change it, and
 * renaming the bot record did not touch it.
 *
 * They are NOT redundant — a bot legitimately recorded as "test account" still
 * has to greet people as "Luc" — so both live here, in the one place people
 * already go to name a bot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiPatch } = vi.hoisted(() => ({ apiPatch: vi.fn() }));

vi.mock('../../services/apiClient', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: apiPatch, delete: vi.fn() },
  extractApiErrorMessage: () => undefined,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import RenameBotDialog from './RenameBotDialog';
import type { BotListItem } from '@/queries/useBotsQueries';

const BOT: BotListItem = {
  id: 'bot-1',
  name: 'Valyro',
  assistantName: 'Mo',
  status: 'active',
  isDefault: true,
  publicKey: 'bk_test',
  aiEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const renderDialog = (bot: BotListItem = BOT) => {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RenameBotDialog bot={bot} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return { user };
};

const nameInput = () => document.getElementById('rename-bot-name') as HTMLInputElement;
const assistantInput = () => document.getElementById('rename-assistant-name') as HTMLInputElement;

describe('RenameBotDialog', () => {
  beforeEach(() => {
    apiPatch.mockReset();
    apiPatch.mockResolvedValue({ ...BOT });
  });

  it('shows both names, so the one customers hear is no longer hidden', () => {
    renderDialog();

    expect(nameInput().value).toBe('Valyro');
    expect(assistantInput().value).toBe('Mo');
  });

  it('saves a changed assistant name without renaming the bot record', async () => {
    const { user } = renderDialog();

    await user.clear(assistantInput());
    await user.click(assistantInput());
    await user.keyboard('Valyro');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    // Only the changed field travels — `name` must be absent, not resent.
    expect(apiPatch).toHaveBeenCalledWith('/bots/bot-1', { assistantName: 'Valyro' });
  });

  it('saves a changed record name without touching the assistant name', async () => {
    const { user } = renderDialog();

    await user.clear(nameInput());
    await user.click(nameInput());
    await user.keyboard('Valyro NL');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(apiPatch).toHaveBeenCalledWith('/bots/bot-1', { name: 'Valyro NL' });
  });

  it('sends both when both changed', async () => {
    const { user } = renderDialog();

    await user.clear(nameInput());
    await user.click(nameInput());
    await user.keyboard('Valyro NL');
    await user.clear(assistantInput());
    await user.click(assistantInput());
    await user.keyboard('Luc');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(apiPatch).toHaveBeenCalledWith('/bots/bot-1', { name: 'Valyro NL', assistantName: 'Luc' });
  });

  it('will not submit an unchanged form, which the API would reject as an empty patch', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('will not blank an assistant name that was set', async () => {
    const { user } = renderDialog();

    await user.clear(assistantInput());

    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(apiPatch).not.toHaveBeenCalled();
  });
});
