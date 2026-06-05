/**
 * Tests for the BotsList table (multi-bot Phase 2 — Portal Bots UI).
 *
 * - renders one row per bot with name + status + default badge
 * - "+ New bot" is disabled when used >= limit (quota hit)
 * - the action menu hides Delete on the anchor (`isDefault`) bot
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { apiGet, apiPost, apiPatch, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('../../services/apiClient', () => ({
  api: { get: apiGet, post: apiPost, put: vi.fn(), patch: apiPatch, delete: apiDelete },
  extractApiErrorMessage: () => undefined,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Onboarding-checklist data sources (relocated into BotsList). Stubbed so they
// don't consume the shared apiGet mock used for the bots list payload.
vi.mock('@/queries/useKnowledgeQueries', () => ({
  useKnowledgeStats: () => ({ data: undefined }),
}));
vi.mock('@/queries/useChannelQueries', () => ({
  useChannelConnections: () => ({ data: [] }),
}));

import BotsList from './BotsList';
import type { BotsListResponse } from '../../queries/useBotsQueries';

function renderUI(payload: BotsListResponse) {
  apiGet.mockResolvedValueOnce(payload);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <BotsList />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDelete.mockReset();
});

describe('BotsList — rendering', () => {
  it('renders a row for each bot with name, status, and a Default badge on the anchor', async () => {
    renderUI({
      bots: [
        {
          id: 'bot-anchor',
          name: 'Main bot',
          status: 'active',
          isDefault: true,
          publicKey: 'bk_anchor',
          aiEnabled: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'bot-extra',
          name: 'Sales bot',
          status: 'paused',
          isDefault: false,
          publicKey: 'bk_extra',
          aiEnabled: false,
          createdAt: '2026-02-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
      used: 2,
      limit: 2,
    });

    expect(await screen.findByText('Main bot')).toBeInTheDocument();
    expect(screen.getByText('Sales bot')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    // "Default" badge appears on the anchor row only (plus the column header).
    const defaultBadges = screen.getAllByText('Default');
    expect(defaultBadges.length).toBeGreaterThanOrEqual(2);
  });
});

describe('BotsList — quota / new-bot button', () => {
  it('disables "+ New bot" when used >= limit', async () => {
    renderUI({
      bots: [
        {
          id: 'bot-anchor',
          name: 'Main bot',
          status: 'active',
          isDefault: true,
          publicKey: 'bk_anchor',
          aiEnabled: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      used: 1,
      limit: 1,
    });

    const button = await screen.findByRole('button', { name: /new bot/i });
    expect(button).toBeDisabled();
    // Usage chip reflects the quota.
    expect(screen.getByText(/1 of 1 used/i)).toBeInTheDocument();
  });

  it('enables "+ New bot" when below quota', async () => {
    renderUI({
      bots: [
        {
          id: 'bot-anchor',
          name: 'Main bot',
          status: 'active',
          isDefault: true,
          publicKey: 'bk_anchor',
          aiEnabled: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      used: 1,
      limit: 2,
    });

    const button = await screen.findByRole('button', { name: /new bot/i });
    expect(button).toBeEnabled();
  });
});

describe('BotsList — action menu', () => {
  it('hides the Delete item on the anchor (isDefault) bot', async () => {
    renderUI({
      bots: [
        {
          id: 'bot-anchor',
          name: 'Main bot',
          status: 'active',
          isDefault: true,
          publicKey: 'bk_anchor',
          aiEnabled: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      used: 1,
      limit: 2,
    });

    const trigger = await screen.findByRole('button', { name: /actions for main bot/i });
    await userEvent.click(trigger);

    // Rename and "Show embed snippet" are present; Delete is NOT, and Pause
    // (anchor cannot be paused) is also NOT shown.
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Rename')).toBeInTheDocument();
    expect(within(menu).getByText(/show embed snippet/i)).toBeInTheDocument();
    expect(within(menu).queryByText('Delete')).not.toBeInTheDocument();
    expect(within(menu).queryByText('Pause')).not.toBeInTheDocument();
  });

  it('shows Delete and Pause on a non-anchor active bot', async () => {
    renderUI({
      bots: [
        {
          id: 'bot-extra',
          name: 'Sales bot',
          status: 'active',
          isDefault: false,
          publicKey: 'bk_extra',
          aiEnabled: false,
          createdAt: '2026-02-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
      used: 1,
      limit: 2,
    });

    const trigger = await screen.findByRole('button', { name: /actions for sales bot/i });
    await userEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Rename')).toBeInTheDocument();
    expect(within(menu).getByText('Pause')).toBeInTheDocument();
    expect(within(menu).getByText('Delete')).toBeInTheDocument();
    expect(within(menu).queryByText('Activate')).not.toBeInTheDocument();
  });
});
