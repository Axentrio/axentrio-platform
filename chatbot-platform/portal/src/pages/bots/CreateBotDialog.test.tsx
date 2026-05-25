/**
 * Tests for CreateBotDialog (multi-bot Phase 2 — Portal Bots UI).
 *
 * - happy path: POSTs /bots with the typed name and closes on success.
 * - 402 plan_limit_bots: dialog stays open and shows the inline UpgradeCTA
 *   ("Start Pro trial") so the user can self-serve the upgrade.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AxiosError, AxiosHeaders } from 'axios';

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('../../services/apiClient', () => ({
  api: { get: apiGet, post: apiPost, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  extractApiErrorMessage: () => undefined,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import CreateBotDialog from './CreateBotDialog';

function entitlementsPayload() {
  // Minimal payload UpgradeCTA needs from the entitlements hook (it doesn't
  // actually use it for the "Start Pro trial" label — that comes from i18n —
  // but useEntitlements still fires inside the tree).
  return {
    current: {
      planId: 'essential',
      limits: { agents: 3, sessions: 5, dailyLlmCalls: 1000 },
      features: {},
      support: 'email',
    },
    plans: [],
    selfServePlans: ['essential', 'pro'],
  };
}

function planLimitAxiosError(): AxiosError {
  const err = new AxiosError('Plan limit reached', 'ERR_BAD_REQUEST');
  err.response = {
    status: 402,
    statusText: 'Payment Required',
    headers: {},
    config: { headers: new AxiosHeaders() } as never,
    data: {
      error: {
        code: 'plan_limit_bots',
        message: "You've reached your plan's bot limit.",
      },
    },
  };
  return err;
}

function renderUI() {
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CreateBotDialog open={true} onOpenChange={onOpenChange} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...utils, onOpenChange };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  // The UpgradeCTA renders an entitlements-aware button. Provide a benign
  // entitlements payload so the query resolves without errors.
  apiGet.mockResolvedValue(entitlementsPayload());
});

describe('CreateBotDialog — happy path', () => {
  it('submits the typed name and closes the dialog on success', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValueOnce({
      id: 'bot-new',
      name: 'Sales bot',
      status: 'active',
      isDefault: false,
      publicKey: 'bk_new',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const { onOpenChange } = renderUI();

    const input = screen.getByLabelText(/bot name/i);
    await user.type(input, 'Sales bot');
    await user.click(screen.getByRole('button', { name: /create bot/i }));

    // Sent the right payload …
    expect(apiPost).toHaveBeenCalledWith('/bots', { name: 'Sales bot' });
    // … and asked its parent to close.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('CreateBotDialog — 402 plan_limit_bots', () => {
  it('keeps the dialog open and renders the inline UpgradeCTA', async () => {
    const user = userEvent.setup();
    apiPost.mockRejectedValueOnce(planLimitAxiosError());

    const { onOpenChange } = renderUI();

    await user.type(screen.getByLabelText(/bot name/i), 'Sales bot');
    await user.click(screen.getByRole('button', { name: /create bot/i }));

    // The inline plan-limit copy appears.
    expect(
      await screen.findByText(/reached your plan's bot limit/i),
    ).toBeInTheDocument();
    // UpgradeCTA for the Pro tier surfaces a "Start Pro trial" button — same
    // hook used in LockedPreview tests, so we know this label is stable.
    expect(screen.getByRole('button', { name: /start pro trial/i })).toBeInTheDocument();
    // Dialog must NOT have been auto-closed.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
