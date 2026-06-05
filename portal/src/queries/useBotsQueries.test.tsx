/**
 * Tests for useBotsQueries (multi-bot Phase 2 — Portal Bots UI).
 *
 * Covers each public hook (`useBots`, `useCreateBot`, `useUpdateBot`,
 * `useDeleteBot`, `useBotEmbed`) and the 402 surfacing helper
 * `extractApiErrorCode` that the create/activate dialogs rely on for the
 * inline UpgradeCTA.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { AxiosError, AxiosHeaders } from 'axios';

const { apiGet, apiPost, apiPatch, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('../services/apiClient', () => ({
  api: {
    get: apiGet,
    post: apiPost,
    put: vi.fn(),
    patch: apiPatch,
    delete: apiDelete,
  },
}));

import {
  useBots,
  useCreateBot,
  useUpdateBot,
  useDeleteBot,
  useBotEmbed,
  extractApiErrorCode,
  type BotsListResponse,
  type BotListItem,
} from './useBotsQueries';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makeBot(overrides: Partial<BotListItem> = {}): BotListItem {
  return {
    id: 'bot-1',
    name: 'My bot',
    status: 'active',
    isDefault: true,
    publicKey: 'bk_abc',
    aiEnabled: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function planLimitAxiosError(): AxiosError {
  // Build a real AxiosError so `axios.isAxiosError(err)` returns true inside
  // extractApiErrorCode — the helper uses that as its first guard.
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

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDelete.mockReset();
});

describe('useBots', () => {
  it('fetches GET /bots and returns { bots, used, limit }', async () => {
    const payload: BotsListResponse = {
      bots: [makeBot(), makeBot({ id: 'bot-2', isDefault: false, name: 'Sales bot' })],
      used: 2,
      limit: 2,
    };
    apiGet.mockResolvedValueOnce(payload);

    const { result } = renderHook(() => useBots(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiGet).toHaveBeenCalledWith('/bots');
    expect(result.current.data).toEqual(payload);
  });
});

describe('useCreateBot', () => {
  it('POSTs /bots with the name and resolves with the created bot', async () => {
    const created = makeBot({ id: 'bot-new', name: 'Sales bot', isDefault: false });
    apiPost.mockResolvedValueOnce(created);

    const { result } = renderHook(() => useCreateBot(), { wrapper: makeWrapper() });
    const out = await result.current.mutateAsync({ name: 'Sales bot' });

    expect(apiPost).toHaveBeenCalledWith('/bots', { name: 'Sales bot' });
    expect(out).toEqual(created);
  });

  it('surfaces the plan_limit_bots code on 402 via extractApiErrorCode', async () => {
    apiPost.mockRejectedValueOnce(planLimitAxiosError());

    const { result } = renderHook(() => useCreateBot(), { wrapper: makeWrapper() });

    let caught: unknown;
    try {
      await result.current.mutateAsync({ name: 'Sales bot' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(extractApiErrorCode(caught)).toBe('plan_limit_bots');
  });
});

describe('useUpdateBot', () => {
  it('PATCHes /bots/:id with the partial body', async () => {
    apiPatch.mockResolvedValueOnce(makeBot({ status: 'paused' }));

    const { result } = renderHook(() => useUpdateBot(), { wrapper: makeWrapper() });
    await result.current.mutateAsync({ id: 'bot-1', status: 'paused' });

    expect(apiPatch).toHaveBeenCalledWith('/bots/bot-1', { status: 'paused' });
  });

  it('surfaces plan_limit_bots on activate-over-quota (402)', async () => {
    apiPatch.mockRejectedValueOnce(planLimitAxiosError());

    const { result } = renderHook(() => useUpdateBot(), { wrapper: makeWrapper() });

    let caught: unknown;
    try {
      await result.current.mutateAsync({ id: 'bot-2', status: 'active' });
    } catch (err) {
      caught = err;
    }
    expect(extractApiErrorCode(caught)).toBe('plan_limit_bots');
  });
});

describe('useDeleteBot', () => {
  it('DELETEs /bots/:id', async () => {
    apiDelete.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useDeleteBot(), { wrapper: makeWrapper() });
    await result.current.mutateAsync('bot-2');

    expect(apiDelete).toHaveBeenCalledWith('/bots/bot-2');
  });
});

describe('useBotEmbed', () => {
  it('is disabled when botId is missing (no fetch fires)', () => {
    renderHook(() => useBotEmbed(null), { wrapper: makeWrapper() });
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetches GET /bots/:id/embed when a botId is provided', async () => {
    apiGet.mockResolvedValueOnce({ snippet: '<script src="..."></script>' });

    const { result } = renderHook(() => useBotEmbed('bot-1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiGet).toHaveBeenCalledWith('/bots/bot-1/embed');
    expect(result.current.data?.snippet).toContain('<script');
  });
});

describe('extractApiErrorCode', () => {
  it('returns undefined for non-Axios errors', () => {
    expect(extractApiErrorCode(new Error('boom'))).toBeUndefined();
  });

  it('returns the structured error.code from an Axios error body', () => {
    expect(extractApiErrorCode(planLimitAxiosError())).toBe('plan_limit_bots');
  });
});
