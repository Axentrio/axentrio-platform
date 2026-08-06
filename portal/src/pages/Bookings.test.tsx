/**
 * Tests for the Bookings page (M2/M5 transition, subscription/feature-access
 * epic). The page branches on `useHasFeature('bookings')`:
 *
 *   - locked   → renders <LockedPreview> with the bookings copy.
 *   - unlocked → renders the M5 placeholder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { hasFeatureMock, apiGet } = vi.hoisted(() => ({
  hasFeatureMock: vi.fn<(_key: string) => boolean>(),
  apiGet: vi.fn(),
}));

vi.mock('../queries/useEntitlementsQueries', async () => {
  const actual = await vi.importActual<typeof import('../queries/useEntitlementsQueries')>(
    '../queries/useEntitlementsQueries',
  );
  return {
    ...actual,
    useHasFeature: (key: string) => hasFeatureMock(key),
    // Page splits on entitlement (upsell) vs effective (disabled notice). No
    // tenant toggles in these tests → ceiling == effective, same mock.
    useIsEntitled: (key: string) => hasFeatureMock(key),
  };
});

vi.mock('../services/apiClient', () => ({
  api: {
    get: apiGet,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import Bookings from './Bookings';

function renderUI({ services = [] }: { services?: Array<Record<string, unknown>> } = {}) {
  // The dashboard gates its tabs on the services query (first-run owners with
  // no services land on Setup), so the mock is URL-aware: /scheduler/services
  // returns the given services, everything else gets the entitlements payload
  // LockedPreview needs for its tier strip and CTA.
  apiGet.mockImplementation(async (url: string) => {
    if (url.includes('/scheduler/services')) return { services };
    return entitlementsPayload;
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Bookings />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const entitlementsPayload = {
    current: {
      planId: 'essential',
      limits: { agents: 3, sessions: 5, dailyLlmCalls: 1000 },
      features: {
        unifiedInbox: true,
        bookings: false,
        calendarSync: false,
        leadCapture: true,
        leadEnrichment: false,
        proactiveLeadCapture: false,
        platformAssistant: false,
        crm: false,
        hideWidgetAttribution: false,
        customWidgetAppearance: false,
        handoff: true,
        fileUpload: true,
      },
      support: 'email',
    },
    plans: [
      {
        id: 'essential',
        displayName: 'Essential',
        rank: 1,
        priceEurMonthly: 29.99,
        isSelfServeCheckoutable: true,
        limits: { agents: 3, sessions: 5, dailyLlmCalls: 1000 },
        features: {} as never,
        support: 'email',
      },
      {
        id: 'pro',
        displayName: 'Pro',
        rank: 2,
        priceEurMonthly: 99.99,
        isSelfServeCheckoutable: true,
        limits: { agents: 10, sessions: 25, dailyLlmCalls: 10000 },
        features: {} as never,
        support: 'priority',
      },
    ],
    selfServePlans: ['essential', 'pro'],
};

beforeEach(() => {
  hasFeatureMock.mockReset();
  apiGet.mockReset();
});

describe('Bookings — locked (Essential tenant)', () => {
  it('renders the LockedPreview with the bookings copy', () => {
    hasFeatureMock.mockReturnValue(false);
    renderUI();

    // i18n: bookings.locked.title / oneLiner from en.json.
    expect(screen.getByRole('heading', { name: /ai bookings/i })).toBeInTheDocument();
    expect(
      screen.getByText(/let customers schedule appointments directly through chat/i),
    ).toBeInTheDocument();
    // Placeholder copy must NOT be present.
    expect(screen.queryByText(/landing here in M5/i)).not.toBeInTheDocument();
  });

  it('points the locked-state CTA at the upgrade flow (Start Pro trial)', () => {
    hasFeatureMock.mockReturnValue(false);
    renderUI();

    // UpgradeCTA for the Pro tier renders the "Start Pro trial" button —
    // clicking it kicks off the Stripe checkout (covered by UpgradeCTA tests).
    expect(screen.getByRole('button', { name: /start pro trial/i })).toBeInTheDocument();
    // The "Compare plans" secondary link points at the billing settings.
    expect(screen.getByRole('link', { name: /compare plans/i })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });
});

describe('Bookings — unlocked (Pro tenant)', () => {
  it('renders the bookings dashboard, not the LockedPreview', async () => {
    hasFeatureMock.mockReturnValue(true);
    // A configured owner (has services) lands on the Appointments tab, where
    // the Upcoming/Past/Requests scope tabs live; first-run owners land on
    // Setup instead.
    renderUI({ services: [{ id: 's1', name: 'Intro call', durationMin: 30, active: true }] });

    expect(screen.getByRole('heading', { name: /^bookings$/i })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /requests/i })).toBeInTheDocument();

    // LockedPreview-only copy should NOT be present.
    expect(screen.queryByText(/let customers schedule appointments/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start pro trial/i })).not.toBeInTheDocument();
  });
});

/**
 * The service-area flag outlives the decision it was written for.
 *
 * `service_area_match` is recorded when a REQUEST is captured and never rewritten — Accept
 * updates status, calendar_key and blocked_range, and leaves this column alone. Both amber
 * sentences were phrased as advice about a choice still to be made, so once the owner accepted
 * an out-of-area job it sat under a green Confirmed pill telling them they had not committed
 * to it, next to a calendar invite and a confirmation email that say otherwise.
 */
describe('Bookings — the out-of-area note matches the decision already taken', () => {
  const outsideBooking = {
    id: 'bk-1',
    serviceName: 'Boiler repair',
    attendeeName: 'Ada',
    startTime: '2099-06-10T08:00:00.000Z',
    endTime: '2099-06-10T09:00:00.000Z',
    status: 'confirmed',
    serviceAreaMatch: 'outside',
  };

  function renderWithBookings(scopeBookings: Record<string, unknown[]>) {
    hasFeatureMock.mockReturnValue(true);
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('/scheduler/services')) {
        return { services: [{ id: 's1', name: 'Intro call', durationMin: 30, active: true }] };
      }
      const scope = /scope=(\w+)/.exec(url)?.[1];
      if (scope) return { bookings: scopeBookings[scope] ?? [], total: (scopeBookings[scope] ?? []).length };
      return entitlementsPayload;
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <Bookings />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('does not tell the owner they are uncommitted to a booking they already accepted', async () => {
    renderWithBookings({ upcoming: [outsideBooking] });
    expect(await screen.findByText(/outside your service area/i)).toBeInTheDocument();
    expect(screen.queryByText(/you have not committed to this one/i)).not.toBeInTheDocument();
    expect(screen.getByText(/accepted anyway/i)).toBeInTheDocument();
  });

  it('still says exactly that while it IS an open request', async () => {
    renderWithBookings({ requests: [{ ...outsideBooking, status: 'request_created' }] });
    await userEvent.click(await screen.findByRole('tab', { name: /requests/i }));
    expect(await screen.findByText(/you have not committed to this one/i)).toBeInTheDocument();
  });
});
