/**
 * Accept-request mutation: the toast has to name the thing that actually happened, and
 * Upcoming has to refetch even while the owner is still on Requests. A 30s staleTime plus
 * the default `refetchType: 'active'` is how the old date survived a successful move.
 * The refetch also has to finish before toast.success — otherwise the owner can switch
 * tabs onto stale Upcoming while the toast already claims the move happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';

const { apiGet, apiPost, toastSuccess } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('../services/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../services/apiClient')>(
    '../services/apiClient',
  );
  return {
    ...actual,
    api: {
      get: apiGet,
      post: apiPost,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import {
  acceptSuccessMessage,
  useAcceptRequest,
  useAdminBookings,
  type BookingScope,
} from './useSchedulerQueries';

const THURSDAY = { bookings: [{ id: 'orig', startTime: '2026-09-10T08:00:00.000Z' }], total: 1 };
const FRIDAY = { bookings: [{ id: 'orig', startTime: '2026-09-11T08:00:00.000Z' }], total: 1 };

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  toastSuccess.mockReset();
  apiPost.mockResolvedValue({});
});

describe('acceptSuccessMessage', () => {
  it('names a move, not a confirmation', () => {
    expect(acceptSuccessMessage('reschedule')).toBe('Request accepted — appointment moved');
  });

  it('names a cancellation', () => {
    expect(acceptSuccessMessage('cancel')).toBe('Request accepted — appointment cancelled');
  });

  it('keeps the existing confirmation copy for a new request', () => {
    expect(acceptSuccessMessage('new')).toBe('Request accepted — appointment confirmed');
    expect(acceptSuccessMessage(null)).toBe('Request accepted — appointment confirmed');
    expect(acceptSuccessMessage(undefined)).toBe('Request accepted — appointment confirmed');
  });
});

describe('useAcceptRequest', () => {
  it.each([
    ['reschedule', 'Request accepted — appointment moved'],
    ['cancel', 'Request accepted — appointment cancelled'],
    ['new', 'Request accepted — appointment confirmed'],
  ] as const)('toasts %s-specific success copy', async (requestKind, message) => {
    const { result } = renderHook(() => useAcceptRequest(), { wrapper: wrapperFor(makeClient()) });
    await result.current.mutateAsync({ id: 'req-1', requestKind });
    expect(apiPost).toHaveBeenCalledWith('/scheduler/bookings/req-1/accept', {});
    expect(toastSuccess).toHaveBeenCalledWith(message);
  });

  it('invalidates booking scopes with refetchType all', async () => {
    const queryClient = makeClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAcceptRequest(), { wrapper: wrapperFor(queryClient) });
    await result.current.mutateAsync({ id: 'req-1', requestKind: 'reschedule' });
    expect(spy).toHaveBeenCalledWith({
      queryKey: ['scheduler', 'bookings'],
      refetchType: 'all',
    });
  });

  it('does not toast until invalidateQueries has settled', async () => {
    const queryClient = makeClient();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(queryClient, 'invalidateQueries').mockReturnValue(held as Promise<void>);

    const { result } = renderHook(() => useAcceptRequest(), { wrapper: wrapperFor(queryClient) });
    let settled = false;
    const pending = result.current.mutateAsync({ id: 'req-1', requestKind: 'reschedule' }).then(() => {
      settled = true;
    });

    await waitFor(() => {
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['scheduler', 'bookings'],
        refetchType: 'all',
      });
    });
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    release();
    await pending;
    expect(toastSuccess).toHaveBeenCalledWith('Request accepted — appointment moved');
  });

  it('writes the moved slot into inactive Upcoming cache before toasting', async () => {
    const queryClient = makeClient();
    apiGet.mockImplementation(async (url: string) => {
      const scope = /scope=(\w+)/.exec(url)?.[1];
      if (scope === 'upcoming') return THURSDAY;
      if (scope === 'requests') {
        return { bookings: [{ id: 'req-1', requestKind: 'reschedule' }], total: 1 };
      }
      return { bookings: [], total: 0 };
    });

    function Harness() {
      const [scope, setScope] = useState<BookingScope>('upcoming');
      useAdminBookings(scope);
      const accept = useAcceptRequest();
      return (
        <div>
          <button type="button" onClick={() => setScope('requests')}>
            requests
          </button>
          <button
            type="button"
            onClick={() => accept.mutate({ id: 'req-1', requestKind: 'reschedule' })}
          >
            accept
          </button>
        </div>
      );
    }

    const { getByRole } = render(<Harness />, { wrapper: wrapperFor(queryClient) });
    await waitFor(() =>
      expect(queryClient.getQueryData(['scheduler', 'bookings', 'upcoming'])).toEqual(THURSDAY),
    );

    await userEvent.click(getByRole('button', { name: 'requests' }));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('scope=requests')),
    );

    apiGet.mockImplementation(async (url: string) => {
      const scope = /scope=(\w+)/.exec(url)?.[1];
      if (scope === 'upcoming') return FRIDAY;
      if (scope === 'requests') return { bookings: [], total: 0 };
      return { bookings: [], total: 0 };
    });
    apiGet.mockClear();
    toastSuccess.mockClear();

    await userEvent.click(getByRole('button', { name: 'accept' }));

    await waitFor(() => {
      expect(queryClient.getQueryData(['scheduler', 'bookings', 'upcoming'])).toEqual(FRIDAY);
    });
    expect(toastSuccess).toHaveBeenCalledWith('Request accepted — appointment moved');
    const fridayAt = toastSuccess.mock.invocationCallOrder[0];
    const upcomingGets = apiGet.mock.calls
      .map((call, i) => ({ url: String(call[0]), order: apiGet.mock.invocationCallOrder[i] }))
      .filter((c) => c.url.includes('scope=upcoming'));
    expect(upcomingGets.length).toBeGreaterThan(0);
    expect(upcomingGets.every((c) => c.order < fridayAt)).toBe(true);
  });
});
