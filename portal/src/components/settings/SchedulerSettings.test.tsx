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

const CONFIG = {
  provider: 'internal',
  eventType: null,
  services: [],
  availability: AVAILABILITY,
  serviceArea: AREA,
  bookingRules: RULES,
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
});
