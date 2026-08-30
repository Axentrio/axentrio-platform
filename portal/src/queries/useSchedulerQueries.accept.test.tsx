/**
 * Accept-request mutation: the toast has to name the thing that actually happened, and
 * Upcoming has to refetch even while the owner is still on Requests. A 30s staleTime plus
 * the default `refetchType: 'active'` is how the old date survived a successful move.
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

  it('refetches inactive Upcoming after accepting a move', async () => {
    const queryClient = makeClient();
    apiGet.mockImplementation(async (url: string) => {
      const scope = /scope=(\w+)/.exec(url)?.[1];
      if (scope === 'upcoming') {
        return { bookings: [{ id: 'orig', startTime: '2026-09-10T08:00:00.000Z' }], total: 1 };
      }
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
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('scope=upcoming')),
    );

    await userEvent.click(getByRole('button', { name: 'requests' }));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('scope=requests')),
    );

    apiGet.mockClear();
    await userEvent.click(getByRole('button', { name: 'accept' }));

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('scope=upcoming'));
    });
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
});
