/**
 * Tests for the `useTestWebhook` onSuccess branching introduced alongside the
 * Phase 3B `webhook-admin.routes.ts` contract change (plan §3.2 webhook-admin
 * row's "test-failed contract change" callout).
 *
 * After the API change, the server emits `{ success:true, data:{ ...,
 * testFailed:true } }` when the call to the customer's webhook URL returned a
 * non-2xx but the API itself succeeded. After interceptor unwrap, the hook's
 * mutation result is `{ ..., testFailed:true }`. The hook must show
 * `toast.error(...)` in that case, and `toast.success(...)` otherwise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const { apiPost, toastSuccess, toastError } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../services/apiClient', () => ({
  api: {
    get: vi.fn(),
    post: apiPost,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { useTestWebhook } from './useWebhookQueries';

function wrapper({ children }: { children: React.ReactNode }) {
  // Fresh client per test so React Query state is isolated.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  apiPost.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('useTestWebhook — onSuccess testFailed branching', () => {
  it('shows toast.error with the upstream message when result.testFailed === true', async () => {
    apiPost.mockResolvedValueOnce({
      status: 500,
      durationMs: 42,
      error: 'Connection refused',
      testFailed: true,
    });

    const { result } = renderHook(() => useTestWebhook(), { wrapper });

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Test failed: Connection refused');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('shows toast.error WITHOUT a colon when testFailed is true but error is absent', async () => {
    apiPost.mockResolvedValueOnce({ status: 0, durationMs: 9, testFailed: true });

    const { result } = renderHook(() => useTestWebhook(), { wrapper });

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Test failed');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('shows toast.success when result.testFailed is absent (target webhook succeeded)', async () => {
    apiPost.mockResolvedValueOnce({ status: 200, durationMs: 42 });

    const { result } = renderHook(() => useTestWebhook(), { wrapper });

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith('Test webhook sent');
    expect(toastError).not.toHaveBeenCalled();
  });
});
