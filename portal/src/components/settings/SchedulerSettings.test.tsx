/**
 * The hydrate → save round-trip.
 *
 * This editor loads the whole booking configuration into local state and sends the WHOLE
 * object back on every Save, which makes hydration load-bearing in a way that produces no
 * error when it goes wrong: a field the editor fails to read arrives at `handleSave` as its
 * initial `null`, and the owner's next Save silently writes that null over a real stored
 * value. Both sides of the wire hand-write the same seven-field literal, so the gap can open
 * on either one.
 *
 * These tests therefore load a config with every field populated and press Save without
 * touching anything. The payload must equal what was loaded. Nothing else about the 862-line
 * component is asserted here — this is the one property that cannot be checked by reading it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiGet, apiPut, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('../../services/apiClient', () => ({
  api: { get: apiGet, put: apiPut, post: apiPost, patch: vi.fn(), delete: vi.fn() },
  extractApiErrorMessage: () => undefined,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { SchedulerSettings } from './SchedulerSettings';

const RULES = {
  maxBookingsPerDay: 4,
  maxBookedMinutesPerDay: 420,
  minGapMin: 15,
  defaultBufferBeforeMin: 5,
  defaultBufferAfterMin: 10,
  defaultMinNoticeMin: 120,
  defaultMaxHorizonDays: 30,
};

const AREA = [
  { kind: 'municipality' as const, id: '41002', label: 'Aalst' },
  { kind: 'province' as const, id: 'VOV', label: 'Oost-Vlaanderen' },
];

const AVAILABILITY = {
  timezone: 'Europe/Brussels',
  availabilityMode: 'business_hours' as const,
  slotGranularityMin: 30,
  weeklyHours: {
    // A split shift, because the editor used to render only the first window and write
    // back a one-element array — destroying the afternoon on every save.
    wed: [
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '17:00' },
    ],
    thu: [{ start: '09:00', end: '17:00' }],
  },
  dateOverrides: [
    { date: '2026-08-07', closed: true },
    { date: '2026-08-14', windows: [{ start: '10:00', end: '14:00' }] },
  ],
};

const VENUE = { street: 'Grote Markt 1', postalCode: '9300', city: 'Aalst', country: 'BE' };

const TRAVEL = {
  enabled: true,
  slackMin: 10,
  startFromBase: true,
  blockedReason: null as null | 'platform' | 'not_entitled' | 'shared_itinerary',
};

const CONFIG = {
  provider: 'internal',
  eventType: null,
  services: [],
  availability: AVAILABILITY,
  serviceArea: AREA,
  bookingRules: RULES,
  venueAddress: VENUE,
  bookingsPaused: false,
  agent: { id: 'bot-1', name: 'Valyro' },
  travel: TRAVEL,
};

function renderUI() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SchedulerSettings />
    </QueryClientProvider>,
  );
}

/** Load `config`, wait for hydration, press Save, return the PUT payload. */
async function saveUntouched(config: unknown) {
  apiGet.mockImplementation((url: string) => {
    if (url.includes('/scheduler/config')) return Promise.resolve(config);
    if (url.includes('/services')) return Promise.resolve({ services: [] });
    if (url.includes('/availability')) return Promise.resolve({ slots: [], timezone: 'Europe/Brussels' });
    return Promise.resolve({});
  });
  apiPut.mockResolvedValue(config);
  renderUI();

  const save = await screen.findByRole('button', { name: /^save$/i });
  // Hydration runs in an effect after the query settles; pressing Save before it lands
  // would assert the INITIAL state and pass for the wrong reason. Override rows start
  // empty, so a second one existing means the fixture has landed.
  await waitFor(() => expect(document.getElementById('override-closed-1')).not.toBeNull());
  fireEvent.click(save);
  await waitFor(() => expect(apiPut).toHaveBeenCalled());
  return apiPut.mock.calls[0][1] as Record<string, unknown>;
}

describe('SchedulerSettings — hydrate/save round-trip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns every business rule unchanged when the owner saves without editing', async () => {
    const payload = await saveUntouched(CONFIG);
    // Field-by-field, not a subset match: a rule the editor never hydrated arrives as null
    // and toMatchObject would still pass against a partially-correct object.
    expect(payload.bookingRules).toEqual(RULES);
  });

  it('returns the service area unchanged, entries and order intact', async () => {
    const payload = await saveUntouched(CONFIG);
    expect(payload.serviceArea).toEqual(AREA);
  });

  it('preserves split shifts and both kinds of date override', async () => {
    const payload = await saveUntouched(CONFIG);
    const availability = payload.availability as typeof AVAILABILITY;
    expect(availability.weeklyHours).toEqual(AVAILABILITY.weeklyHours);
    expect(availability.dateOverrides).toEqual(AVAILABILITY.dateOverrides);
    expect(availability.timezone).toBe('Europe/Brussels');
    expect(availability.slotGranularityMin).toBe(30);
  });

  it('sends an empty area as [] rather than dropping the key', async () => {
    // `[]` IS the clear gesture. Omitting the key means "leave it alone", so an owner who
    // removes their last place would find it still there after a reload.
    const payload = await saveUntouched({ ...CONFIG, serviceArea: [] });
    expect(payload).toHaveProperty('serviceArea');
    expect(payload.serviceArea).toEqual([]);
  });

  it('sends every rule key even when the business has set none', async () => {
    // The whole object every time: an omitted key leaves the stored value untouched, so a
    // partial payload could never clear a rule the owner had just removed.
    const empty = {
      maxBookingsPerDay: null,
      maxBookedMinutesPerDay: null,
      minGapMin: null,
      defaultBufferBeforeMin: null,
      defaultBufferAfterMin: null,
      defaultMinNoticeMin: null,
      defaultMaxHorizonDays: null,
    };
    const payload = await saveUntouched({ ...CONFIG, bookingRules: empty });
    expect(payload.bookingRules).toEqual(empty);
    expect(Object.keys(payload.bookingRules as object).sort()).toEqual(Object.keys(RULES).sort());
  });

  it('keeps an explicit 0 rather than reading it as unset', async () => {
    // `?? null` is correct here; `|| null` would turn a deliberate zero-minute buffer into
    // "inherit", which is a different and wrong answer.
    const zeros = { ...RULES, defaultBufferBeforeMin: 0, defaultMinNoticeMin: 0 };
    const payload = await saveUntouched({ ...CONFIG, bookingRules: zeros });
    expect(payload.bookingRules).toEqual(zeros);
  });

  it('survives a config that predates the settings row', async () => {
    // A bot with no BookingSettings row reads back nulls and an empty area. It must still
    // save — and must not invent values.
    const payload = await saveUntouched({ ...CONFIG, serviceArea: [], bookingRules: undefined });
    expect(payload.serviceArea).toEqual([]);
    expect(payload.bookingRules).toEqual({
      maxBookingsPerDay: null,
      maxBookedMinutesPerDay: null,
      minGapMin: null,
      defaultBufferBeforeMin: null,
      defaultBufferAfterMin: null,
      defaultMinNoticeMin: null,
      defaultMaxHorizonDays: null,
    });
  });

  it('returns the venue address unchanged when the owner saves without editing', async () => {
    // Same hazard as the rules: a component the editor fails to hydrate arrives as null and
    // Save writes the blank over a real address the owner set weeks ago.
    const payload = await saveUntouched(CONFIG);
    expect(payload.venueAddress).toEqual(VENUE);
  });

  it('sends every venue key even when the business has entered none', async () => {
    // The grandfathered state for every existing tenant. It must save without inventing an
    // address, and without dropping the key (which would mean "leave it alone" forever).
    const empty = { street: null, postalCode: null, city: null, country: null };
    const payload = await saveUntouched({ ...CONFIG, venueAddress: empty });
    expect(payload).toHaveProperty('venueAddress');
    expect(payload.venueAddress).toEqual(empty);
  });

  it('never prefills the venue from the registered company address', async () => {
    // GDPR Art. 25(2): the VAT address is frequently the owner's home, and a prefill they
    // click past is not the individual's intervention. It must stay empty.
    const payload = await saveUntouched({
      ...CONFIG,
      venueAddress: { street: null, postalCode: null, city: null, country: null },
      company: { street: 'Woonstraat 9', postalCode: '1000', city: 'Brussel' },
    });
    expect(payload.venueAddress).toEqual({ street: null, postalCode: null, city: null, country: null });
    expect(JSON.stringify(payload)).not.toContain('Woonstraat');
  });

  it('returns the pause switch unchanged when the owner saves without editing', async () => {
    // Same hazard as every other field on this card: hydrate it wrong and the next Save
    // silently un-pauses a business that deliberately stopped taking bookings.
    const payload = await saveUntouched({ ...CONFIG, bookingsPaused: true });
    expect(payload.bookingsPaused).toBe(true);
  });

  it('always sends the switch, so it can be turned back off', async () => {
    const payload = await saveUntouched(CONFIG);
    expect(payload).toHaveProperty('bookingsPaused');
    expect(payload.bookingsPaused).toBe(false);
  });

  it('treats a config that predates the column as not paused', async () => {
    const payload = await saveUntouched({ ...CONFIG, bookingsPaused: undefined });
    expect(payload.bookingsPaused).toBe(false);
  });
});

/**
 * Save-blocking validation.
 *
 * The API parses the entire payload before any write, so anything this editor lets through
 * rejects all ~20 controls at once behind one unattributable "Validation failed" toast. Two
 * inputs could reach that state, and one of them was worse than a rejection: a backwards
 * closure range was quietly rewritten to a single day and saved under a SUCCESS toast, so the
 * rest of the intended closure stayed bookable and the pickers kept showing the range the
 * owner thought they had stored.
 */
/**
 * Travel time joins the round-trip, and it is the field most likely to break it.
 *
 * The editor sends the WHOLE travel object on every Save, so a switch the editor failed to
 * hydrate arrives as its initial `false` and the owner's next Save silently turns travel time
 * OFF for a business that had it on — and travel going quiet is exactly the failure mode that
 * cannot be seen from the outside.
 */
describe('SchedulerSettings — travel time', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns every travel field unchanged when the owner saves without editing', async () => {
    const payload = await saveUntouched(CONFIG);
    expect(payload.travel).toEqual({ enabled: true, slackMin: 10, startFromBase: true });
  });

  it('does not send blockedReason back — that is the server answer, not an owner setting', async () => {
    const payload = await saveUntouched(CONFIG);
    expect(payload.travel).not.toHaveProperty('blockedReason');
  });

  it('explains a shared calendar instead of just disabling the switch', async () => {
    // AC: the refusal is explained in the UI, not only enforced by the API. This is the
    // feature's one genuinely harmful state and the fix lives in the calendar connection,
    // so an owner who is merely refused has nowhere to go.
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/scheduler/config')) {
        return Promise.resolve({ ...CONFIG, travel: { ...TRAVEL, enabled: false, blockedReason: 'shared_itinerary' } });
      }
      if (url.includes('/services')) return Promise.resolve({ services: [] });
      return Promise.resolve({});
    });
    renderUI();

    expect(await screen.findByText(/books into the same calendar/i)).toBeInTheDocument();
    expect(await screen.findByText(/give each agent its own calendar/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/only offer times i can reach/i)).toBeDisabled());
  });

  it('states the single-driver assumption', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/scheduler/config')) return Promise.resolve(CONFIG);
      if (url.includes('/services')) return Promise.resolve({ services: [] });
      return Promise.resolve({});
    });
    renderUI();
    expect(await screen.findByText(/one person on the road/i)).toBeInTheDocument();
  });
});

describe('SchedulerSettings — refuses to save what the API will reject', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Load `config`, wait for hydration, and hand back the Save button unpressed. */
  async function hydrate(config: unknown) {
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/scheduler/config')) return Promise.resolve(config);
      if (url.includes('/services')) return Promise.resolve({ services: [] });
      if (url.includes('/availability')) return Promise.resolve({ slots: [], timezone: 'Europe/Brussels' });
      return Promise.resolve({});
    });
    apiPut.mockResolvedValue(config);
    renderUI();
    const save = (await screen.findByRole('button', { name: /^save$/i })) as HTMLButtonElement;
    await waitFor(() => expect(document.getElementById('override-closed-1')).not.toBeNull());
    return save;
  }

  it('blocks the save on a one-letter country code instead of sending it', async () => {
    const save = await hydrate(CONFIG);
    expect(save.disabled).toBe(false);

    fireEvent.change(document.getElementById('venue-country')!, { target: { value: 'B' } });

    await waitFor(() => expect(save.disabled).toBe(true));
    expect(screen.getByText(/2-letter code/i)).toBeTruthy();
    fireEvent.click(save);
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('accepts a valid two-letter code', async () => {
    const save = await hydrate(CONFIG);
    fireEvent.change(document.getElementById('venue-country')!, { target: { value: 'NL' } });
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it('blocks a backwards closure range rather than silently saving one day of it', async () => {
    const save = await hydrate({
      ...CONFIG,
      availability: {
        ...AVAILABILITY,
        dateOverrides: [
          { date: '2026-08-07', closed: true },
          { date: '2026-08-20', endDate: '2026-08-10', closed: true },
        ],
      },
    });

    await waitFor(() => expect(save.disabled).toBe(true));
    expect(screen.getByText(/end date must be on or after the start date/i)).toBeTruthy();
    fireEvent.click(save);
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('leaves a forwards range saveable', async () => {
    const save = await hydrate({
      ...CONFIG,
      availability: {
        ...AVAILABILITY,
        dateOverrides: [
          { date: '2026-08-07', closed: true },
          { date: '2026-08-10', endDate: '2026-08-20', closed: true },
        ],
      },
    });
    expect(save.disabled).toBe(false);
  });
});
