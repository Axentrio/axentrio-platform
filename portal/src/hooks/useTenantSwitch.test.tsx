/**
 * Tenant switch must drop the previous tenant's Bookings cache.
 *
 * Live leak (2026-08-30): impersonating Smoke while Bookings was open briefly
 * showed WaterFix. Queries use `['scheduler','bookings',scope]`; the flush list
 * omitted `scheduler`, so removeQueries never touched those entries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { reconnectMock } = vi.hoisted(() => ({ reconnectMock: vi.fn() }));

vi.mock('@clerk/clerk-react', () => ({
  useOrganizationList: () => ({
    userMemberships: { data: [] },
    setActive: vi.fn(),
  }),
}));

vi.mock('../websocket/SocketContext', () => ({
  useSocket: () => ({ reconnect: reconnectMock }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { TENANT_SCOPED_KEYS, useTenantSwitch } from './useTenantSwitch';
import { useTenantContextStore } from '../stores/tenantContextStore';

const WATERFIX_BOOKINGS = {
  bookings: [{ id: '2a81bf93-191c-4daa-896c-4b4fbd741df2', serviceName: 'booking waterFix' }],
  total: 1,
};

function seedTenantCaches(client: QueryClient) {
  client.setQueryData(['scheduler', 'bookings', 'upcoming'], WATERFIX_BOOKINGS);
  client.setQueryData(['scheduler', 'bookings', 'requests'], {
    bookings: [{ id: 'req-wf', serviceName: 'booking waterFix', requestKind: 'cancel' }],
    total: 1,
  });
  client.setQueryData(['scheduler', 'config', null], { timezone: 'Europe/Brussels' });
  client.setQueryData(['chats', 'list', {}], { chats: [{ id: 'c-wf' }] });
  client.setQueryData(['admin', 'tenants', 'all'], { tenants: [{ name: 'must-survive' }] });
}

describe('useTenantSwitch cache flush', () => {
  let client: QueryClient;

  beforeEach(() => {
    reconnectMock.mockClear();
    useTenantContextStore.getState().clearTenant();
    sessionStorage.clear();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    seedTenantCaches(client);
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  it('lists scheduler so Bookings queries are flushed on switch', () => {
    expect(TENANT_SCOPED_KEYS).toContain('scheduler');
  });

  it('drops scheduler bookings (the live WaterFix leak) and keeps admin caches', async () => {
    const { result } = renderHook(() => useTenantSwitch(), { wrapper });

    await act(async () => {
      await result.current.switchTenant({
        tenantId: '505b0f6a-2324-4a08-a8ea-be0062f07f5c',
        tenantName: 'Smoke trial barber 0820',
      });
    });

    expect(client.getQueryData(['scheduler', 'bookings', 'upcoming'])).toBeUndefined();
    expect(client.getQueryData(['scheduler', 'bookings', 'requests'])).toBeUndefined();
    expect(client.getQueryData(['scheduler', 'config', null])).toBeUndefined();
    expect(client.getQueryData(['chats', 'list', {}])).toBeUndefined();
    expect(client.getQueryData(['admin', 'tenants', 'all'])).toEqual({
      tenants: [{ name: 'must-survive' }],
    });
    expect(reconnectMock).toHaveBeenCalledTimes(1);
  });

  it('also drops scheduler bookings when exiting impersonation', () => {
    const { result } = renderHook(() => useTenantSwitch(), { wrapper });

    act(() => {
      result.current.exitTenant();
    });

    expect(client.getQueryData(['scheduler', 'bookings', 'upcoming'])).toBeUndefined();
    expect(client.getQueryData(['admin', 'tenants', 'all'])).toEqual({
      tenants: [{ name: 'must-survive' }],
    });
  });
});
