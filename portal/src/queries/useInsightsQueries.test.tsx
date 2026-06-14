import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { apiGet, apiPost, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn() }));
vi.mock('../services/apiClient', () => ({
  api: { get: apiGet, post: apiPost, put: apiPut, patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useInsights, useGapEvidence, useResolveGap, useDigest, useSetDigestEmail } from './useInsightsQueries';

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
});

describe('useInsightsQueries', () => {
  it('useInsights fetches GET /insights', async () => {
    apiGet.mockResolvedValue({ gaps: [], meta: { retentionDays: 90 } });
    const { result } = renderHook(() => useInsights(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith('/insights');
    expect(result.current.data?.meta.retentionDays).toBe(90);
  });

  it('useGapEvidence stays idle until enabled with a gap id (the locked-tier guard)', async () => {
    renderHook(() => useGapEvidence('g1', false), { wrapper });
    renderHook(() => useGapEvidence(null, true), { wrapper });
    expect(apiGet).not.toHaveBeenCalled();

    apiGet.mockResolvedValue({ evidence: [] });
    const { result } = renderHook(() => useGapEvidence('g1', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith('/insights/g1/evidence');
  });

  it('useResolveGap posts the action and invalidates the insights cache', async () => {
    apiPost.mockResolvedValue({});
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useResolveGap('done'), { wrapper });
    result.current.mutate('g1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiPost).toHaveBeenCalledWith('/insights/g1/resolve');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['insights'] });
  });

  it('useDigest fetches GET /insights/digest when enabled', async () => {
    apiGet.mockResolvedValue({ digest: null, emailEnabled: true });
    const { result } = renderHook(() => useDigest(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith('/insights/digest');
    expect(result.current.data?.emailEnabled).toBe(true);
  });

  it('useSetDigestEmail PUTs the preference and invalidates the digest cache', async () => {
    apiPut.mockResolvedValue({});
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetDigestEmail('saved'), { wrapper });
    result.current.mutate(false);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiPut).toHaveBeenCalledWith('/insights/digest/email', { enabled: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['insights', 'digest'] });
  });
});
