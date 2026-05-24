/**
 * Tests for the M1 entitlements SDK (subscription/feature-access epic).
 *
 * Covers the three public hooks exported by `useEntitlementsQueries`:
 *   - useEntitlements()   — raw fetch.
 *   - useHasFeature(key)  — feature flag check, fail-closed on loading.
 *   - useCurrentTier()    — current planId, undefined while loading.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('../services/apiClient', () => ({
  api: {
    get: apiGet,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import {
  useEntitlements,
  useHasFeature,
  useCurrentTier,
  type EntitlementsResponse,
} from './useEntitlementsQueries';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function essentialResponse(overrides?: Partial<EntitlementsResponse>): EntitlementsResponse {
  return {
    current: {
      planId: 'essential',
      limits: { agents: 3, sessions: 5, dailyLlmCalls: 1000 },
      features: {
        unifiedInbox: true,
        bookings: false,
        calendarIntegrations: false,
        leadCapture: true,
        platformAssistant: false,
        crm: false,
        hideWidgetAttribution: false,
        customWidgetAppearance: false,
        handoff: true,
        fileUpload: true,
      },
      support: 'email',
    },
    plans: [],
    selfServePlans: ['essential', 'pro'],
    ...overrides,
  };
}

beforeEach(() => {
  apiGet.mockReset();
});

describe('useEntitlements', () => {
  it('fetches GET /entitlements and returns the response data', async () => {
    const payload = essentialResponse();
    apiGet.mockResolvedValueOnce(payload);

    const { result } = renderHook(() => useEntitlements(), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(apiGet).toHaveBeenCalledWith('/entitlements');
    expect(result.current.data).toEqual(payload);
  });
});

describe('useHasFeature', () => {
  it('returns false during loading', () => {
    // Never resolves — keeps the query pending so we can assert the loading branch.
    apiGet.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useHasFeature('bookings'), {
      wrapper: makeWrapper(),
    });
    expect(result.current).toBe(false);
  });

  it('returns true when the loaded entitlements have the feature', async () => {
    apiGet.mockResolvedValueOnce(
      essentialResponse({
        current: {
          ...essentialResponse().current,
          features: { ...essentialResponse().current.features, bookings: true },
        },
      }),
    );

    const { result } = renderHook(() => useHasFeature('bookings'), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('returns false when the loaded entitlements do not have the feature', async () => {
    apiGet.mockResolvedValueOnce(essentialResponse());

    const { result, rerender } = renderHook(() => useHasFeature('bookings'), {
      wrapper: makeWrapper(),
    });

    // Wait for the fetch to complete. Then verify the hook still returns false
    // because Essential does not include `bookings`.
    await waitFor(() => {
      // After resolution the underlying useQuery should be settled — force a
      // rerender to pick up the new state.
      rerender();
      expect(result.current).toBe(false);
    });
  });
});

describe('useCurrentTier', () => {
  it('returns undefined during loading', () => {
    apiGet.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useCurrentTier(), { wrapper: makeWrapper() });
    expect(result.current).toBeUndefined();
  });

  it('returns the current planId once loaded', async () => {
    apiGet.mockResolvedValueOnce(
      essentialResponse({
        current: { ...essentialResponse().current, planId: 'pro' },
      }),
    );

    const { result } = renderHook(() => useCurrentTier(), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(result.current).toBe('pro');
    });
  });
});
