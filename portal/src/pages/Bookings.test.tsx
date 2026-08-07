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

import Bookings, { travelVerdictLookup } from './Bookings';

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

  /**
   * Why a travel-captured Request is sitting there.
   *
   * It used to look identical to a Request captured for any other reason, with the cause only
   * in a server log. ADR-0015 names the consequence: an owner drowning in indistinguishable
   * Requests rubber-stamps them, which buys back the wrongness the gate was meant to buy off.
   */
  const travelBooking = { ...outsideBooking, serviceAreaMatch: null };

  it('tells the owner to check the journey while the decision is still open', async () => {
    renderWithBookings({ requests: [{ ...travelBooking, status: 'request_created', travelCheck: 'captured' }] });
    await userEvent.click(await screen.findByRole('tab', { name: /requests/i }));
    expect(await screen.findByText(/check the journey before accepting/i)).toBeInTheDocument();
  });

  it('keeps saying so after Accept, without pretending the decision is still open', async () => {
    // The service-area note above had to learn this: advice about a choice already made reads
    // as nonsense under a green Confirmed pill. A booking whose journey was never verified is
    // worth remembering on the morning of the job, so the fact stays and only the tense moves.
    renderWithBookings({ upcoming: [{ ...travelBooking, travelCheck: 'overridden' }] });
    expect(await screen.findByText(/accepted anyway/i)).toBeInTheDocument();
    expect(screen.queryByText(/before accepting/i)).not.toBeInTheDocument();
  });

  it.each(['ok', 'degraded'] as const)('says nothing at all when the check SUCCEEDED (%s)', async (check) => {
    // `degraded` is provenance, not a fault — the ordinary state of a business whose jobs sit
    // close together, where the flat gap settled the drive for free. Warning on it would flag
    // most of a good day and teach the owner to ignore the warning that matters.
    renderWithBookings({ upcoming: [{ ...travelBooking, travelCheck: check }] });
    expect(await screen.findByText(/Boiler repair/)).toBeInTheDocument();
    expect(screen.queryByTestId('travel-captured')).not.toBeInTheDocument();
  });
});

/**
 * Travel time on the OWNER's reschedule picker.
 *
 * The API stopped filtering this list, because feasibility is a hard constraint against the bot
 * and never against the person who owns the diary. That is only safe if the screen WARNS: an
 * unfiltered list with no marking silently regains the impossible times and shows them looking
 * exactly like the safe ones, which is worse than the filtering it replaced.
 */
describe('Bookings — which reschedule slots carry a drive nobody vouched for', () => {
  const slot = (h: number) => ({ start: `2026-06-10T${String(h).padStart(2, '0')}:00:00.000Z` });

  it('marks a proven-impossible time', () => {
    const verdict = travelVerdictLookup({ unreachableSlots: [slot(7)], requestableSlots: [] });
    expect(verdict(slot(7).start)).toBe('unreachable');
  });

  it('marks a time whose drive nobody measured', () => {
    const verdict = travelVerdictLookup({ unreachableSlots: [], requestableSlots: [slot(9)] });
    expect(verdict(slot(9).start)).toBe('requestable');
  });

  it('leaves a cleared time unmarked', () => {
    const verdict = travelVerdictLookup({ unreachableSlots: [slot(7)], requestableSlots: [slot(9)] });
    expect(verdict(slot(11).start)).toBeNull();
  });

  it('marks nothing at all for a business not using travel time', () => {
    // Every Agent on the platform today. The picker must look exactly as it did.
    const verdict = travelVerdictLookup(undefined);
    expect(verdict(slot(7).start)).toBeNull();
  });

  it('lets impossible win over merely tight if a slot somehow appears in both', () => {
    const verdict = travelVerdictLookup({ unreachableSlots: [slot(7)], requestableSlots: [slot(7)] });
    expect(verdict(slot(7).start)).toBe('unreachable');
  });
});
