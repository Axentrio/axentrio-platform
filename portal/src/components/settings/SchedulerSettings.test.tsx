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

/**
 * A budget for tests that are genuinely slow, not a mask over tests that are wrong.
 *
 * Each of these renders a ~1000-line form, waits for four queries to settle, and hydrates the
 * whole booking configuration into local state. MEASURED on one machine, same file:
 *
 *   commit e571ab7 (23 tests)   slowest test 3334ms
 *   commit d98a1b0 (27 tests)   slowest test 2618ms
 *
 * So the file was already within ~1.7s of the 5s default BEFORE the per-Agent work, and that
 * work made it faster rather than slower. The margin is real and pre-existing, and it produces
 * an occasional timeout on a loaded machine — a test passing alone and failing in a full run.
 *
 * NOT ATTRIBUTED. It is not a render loop: no dependency array holds an unstable identity, and
 * removing the effect added by #86 changed nothing. A control file in the same run is
 * unaffected. Whoever finds the real cause should bring this back DOWN rather than leave it —
 * a raised budget is a place for a slow test to hide.
 */
const SLOW_FORM_TIMEOUT_MS = 15_000;


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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

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

const VENUE = { placeId: null, street: 'Grote Markt 1', postalCode: '9300', city: 'Aalst', country: 'BE' };

const TRAVEL = {
  enabled: true,
  slackMin: 10,
  startFromBase: true,
  // NON-ZERO deliberately (#91). Zero is the field's default, so a fixture carrying zero would
  // pass the round-trip below even if the editor never hydrated the value at all.
  baseDepartOffsetMin: 30,
  // #82's switch, non-default here for the same reason as the offset above: `false` is what an
  // unhydrated checkbox reads as, so a false fixture cannot tell "round-tripped" from "never read".
  preferClusters: true,
  blockedReason: null as null | 'no_maps_key' | 'not_entitled' | 'shared_itinerary',
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
    // The editor now asks who the tenant's Agents are, to decide whether an Agent picker is
    // worth showing. Answered deterministically: an unhandled URL left that query resolving
    // by luck and added seconds to every test in this file.
    if (url.includes('/bots')) return Promise.resolve({ bots: [{ id: 'bot-1', name: 'Valyro', isDefault: true }] });
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

describe('SchedulerSettings — hydrate/save round-trip', { timeout: SLOW_FORM_TIMEOUT_MS }, () => {
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

  /**
   * #79 (LP1): the location controls are shown only where they apply.
   *
   * Two halves, and the first is the safety rule. The editor sends `venueAddress` and
   * `serviceArea` on EVERY save - `[]` is how an owner clears their area, a null line is how they
   * clear an address - so hiding a control that holds something is one refactor away from
   * deleting it. The component's rule is therefore "hide only when there is nothing stored to
   * hide", which makes a populated-but-hidden control impossible rather than merely handled.
   */
  it('never hides a control that holds something, even where it does not apply (#79)', async () => {
    const remoteOnly = {
      ...CONFIG,
      services: [{ id: 's1', isActive: true, locationType: 'google_meet', customerAddressRequired: false }],
      workLocation: 'no_location',
    };
    const body = await saveUntouched(remoteOnly);

    // Still on screen, because it holds an address. This is the assertion that makes the
    // round-trip below mean something: a test that only checked the payload would pass just as
    // happily against a hidden control whose state happened to survive.
    expect(document.getElementById('venue-street')).not.toBeNull();
    expect(body.venueAddress).toEqual(VENUE);
    expect(body.serviceArea).toEqual(AREA);
  });

  /**
   * #71: an `unset` service puts the owner's address on its invites, and until now the only
   * prompt lived inside that service's own editor - which an owner typing their address has no
   * reason to open. The warning exists for the moment those two facts meet.
   */
  it('warns, by name, when a stored address will go on a never-asked service (#71)', async () => {
    const withUnset = {
      ...CONFIG,
      services: [{ id: 's1', isActive: true, locationType: 'unset', customerAddressRequired: false, name: 'Online intro call' }],
      workLocation: 'at_one_location',
    };
    await saveUntouched(withUnset);

    // Named, not counted: "1 service" would send the owner hunting for which.
    expect(document.body.textContent).toMatch(/Online intro call/);
    expect(document.body.textContent).toMatch(/nobody has chosen/i);
  });

  it('stays silent when there is no address to leak (#71)', async () => {
    // No venue means nothing goes on any invite, so the warning would be pure noise - and noise
    // is what stops the real one being read.
    const noVenue = {
      ...CONFIG,
      services: [{ id: 's1', isActive: true, locationType: 'unset', customerAddressRequired: false, name: 'Online intro call' }],
      workLocation: 'at_one_location',
      venueAddress: { placeId: null, street: null, postalCode: null, city: null, country: null },
    };
    await saveUntouched(noVenue);
    expect(document.body.textContent).not.toMatch(/nobody has chosen/i);
  });

  it('stays silent when every service has been settled (#71)', async () => {
    const settled = {
      ...CONFIG,
      services: [{ id: 's1', isActive: true, locationType: 'google_meet', customerAddressRequired: false, name: 'Online intro call' }],
      workLocation: 'at_one_location',
    };
    await saveUntouched(settled);
    expect(document.body.textContent).not.toMatch(/nobody has chosen/i);
  });

  it('hides both controls when they neither apply nor hold anything (#79)', async () => {
    const nothingToShow = {
      ...CONFIG,
      services: [{ id: 's1', isActive: true, locationType: 'google_meet', customerAddressRequired: false }],
      workLocation: 'no_location',
      venueAddress: { placeId: null, street: null, postalCode: null, city: null, country: null },
      serviceArea: [],
    };
    const body = await saveUntouched(nothingToShow);

    // Gone, because there is nothing to answer: no customer comes here and nobody travels.
    expect(document.getElementById('venue-street')).toBeNull();
    // And an absent control still sends its empty value, so nothing about the save changes.
    expect(body.venueAddress).toEqual({ placeId: null, street: null, postalCode: null, city: null, country: null });
    expect(body.serviceArea).toEqual([]);
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
    const empty = { placeId: null, street: null, postalCode: null, city: null, country: null };
    const payload = await saveUntouched({ ...CONFIG, venueAddress: empty });
    expect(payload).toHaveProperty('venueAddress');
    expect(payload.venueAddress).toEqual(empty);
  });

  it('never prefills the venue from the registered company address', async () => {
    // GDPR Art. 25(2): the VAT address is frequently the owner's home, and a prefill they
    // click past is not the individual's intervention. It must stay empty.
    const payload = await saveUntouched({
      ...CONFIG,
      venueAddress: { placeId: null, street: null, postalCode: null, city: null, country: null },
      company: { street: 'Woonstraat 9', postalCode: '1000', city: 'Brussel' },
    });
    expect(payload.venueAddress).toEqual({ placeId: null, street: null, postalCode: null, city: null, country: null });
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
describe('SchedulerSettings — travel time', { timeout: SLOW_FORM_TIMEOUT_MS }, () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns every travel field unchanged when the owner saves without editing', async () => {
    const payload = await saveUntouched(CONFIG);
    expect(payload.travel).toEqual({
      enabled: true,
      slackMin: 10,
      startFromBase: true,
      baseDepartOffsetMin: 30,
      preferClusters: true,
    });
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
      if (url.includes('/bots')) return Promise.resolve({ bots: [{ id: 'bot-1', name: 'Valyro', isDefault: true }] });
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

  it('lets the owner switch travel OFF when a shared calendar blocked it', async () => {
    // THE LOCKOUT. Travel is on, somebody connects a second Agent to the calendar months
    // later, and the stored preference is deliberately left alone. Disabling the box outright
    // meant the owner could not clear the one field making their whole settings page
    // unsaveable — venue, opening hours and pause along with it.
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/bots')) return Promise.resolve({ bots: [{ id: 'bot-1', name: 'Valyro', isDefault: true }] });
      if (url.includes('/scheduler/config')) {
        return Promise.resolve({ ...CONFIG, travel: { ...TRAVEL, enabled: true, blockedReason: 'shared_itinerary' } });
      }
      if (url.includes('/services')) return Promise.resolve({ services: [] });
      return Promise.resolve({});
    });
    renderUI();

    const box = await screen.findByLabelText(/only offer times i can reach/i);
    await waitFor(() => expect(box).toBeChecked());
    expect(box).not.toBeDisabled();
  });

  it('refuses a slack value the API would reject, before the Save', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/bots')) return Promise.resolve({ bots: [{ id: 'bot-1', name: 'Valyro', isDefault: true }] });
      if (url.includes('/scheduler/config')) {
        return Promise.resolve({ ...CONFIG, travel: { ...TRAVEL, slackMin: 500 } });
      }
      if (url.includes('/services')) return Promise.resolve({ services: [] });
      return Promise.resolve({});
    });
    renderUI();
    expect(await screen.findByText(/whole number between 0 and 120/i)).toBeInTheDocument();
  });

  it('states the single-driver assumption', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/bots')) return Promise.resolve({ bots: [{ id: 'bot-1', name: 'Valyro', isDefault: true }] });
      if (url.includes('/scheduler/config')) return Promise.resolve(CONFIG);
      if (url.includes('/services')) return Promise.resolve({ services: [] });
      return Promise.resolve({});
    });
    renderUI();
    expect(await screen.findByText(/one person on the road/i)).toBeInTheDocument();
  });
});

/**
 * #86 — which Agent is being edited.
 *
 * The dangerous half of this ticket is not the settings: it is that the calendar CONNECT and
 * DISCONNECT controls live on this same screen. An Agent picker over endpoints that resolve the
 * tenant's default Agent means an owner selects Agent B, is shown Agent A's connection, presses
 * Disconnect, and A's calendar is disconnected while the screen says B — A's bookings stop
 * syncing and nothing says why. So the assertions below are about the WIRE, not the wording.
 */
describe('SchedulerSettings — per-Agent scoping', { timeout: SLOW_FORM_TIMEOUT_MS }, () => {
  beforeEach(() => vi.clearAllMocks());

  const multiAgentGet = (config: unknown = CONFIG) => (url: string) => {
    if (url.includes('/bots')) return Promise.resolve({ bots: [{ id: 'bot-1', name: 'Valyro', isDefault: true }, { id: 'bot-2', name: 'Second driver', isDefault: false }] });
    if (url.includes('/scheduler/config')) return Promise.resolve(config);
    if (url.includes('/services')) return Promise.resolve({ services: [] });
    return Promise.resolve({});
  };

  const soloTenantGet = () => (url: string) => {
    if (url.includes('/bots')) return Promise.resolve({ bots: [{ id: 'bot-1', name: 'Valyro', isDefault: true }] });
    if (url.includes('/scheduler/config')) return Promise.resolve(CONFIG);
    if (url.includes('/services')) return Promise.resolve({ services: [] });
    return Promise.resolve({});
  };

  it('offers no Agent choice to a tenant with one Agent', async () => {
    apiGet.mockImplementation(soloTenantGet());
    renderUI();
    await screen.findByRole('button', { name: /^save$/i });
    expect(screen.queryByLabelText(/^agent$/i)).not.toBeInTheDocument();
  });

  it('sends NO botId for the default Agent, so a solo tenant is on the wire it always was', async () => {
    apiGet.mockImplementation(multiAgentGet());
    renderUI();
    await screen.findByLabelText(/^agent$/i);
    const configCalls = apiGet.mock.calls.map((c: unknown[]) => String(c[0])).filter((u) => u.includes('/scheduler/config'));
    expect(configCalls.every((u) => !u.includes('botId'))).toBe(true);
  });

  it('addresses the CALENDAR endpoints at the selected Agent, not the default one', async () => {
    // The destructive path. Disconnect is on this screen; if its request omits the Agent, it
    // disconnects whichever calendar the server resolves — the default one.
    apiGet.mockImplementation(multiAgentGet());
    renderUI();
    const picker = await screen.findByLabelText(/^agent$/i);
    fireEvent.change(picker, { target: { value: 'bot-2' } });

    await waitFor(() => {
      const statusCalls = apiGet.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((u) => u.includes('/integrations/google/status'));
      expect(statusCalls.some((u) => u.includes('botId=bot-2'))).toBe(true);
    });
  });

  it('returns from a calendar connect on the Agent it was connected FOR', async () => {
    // The OAuth callback appends the Agent from its signed state. Reading it back is the whole
    // point: without it an owner who connects Agent B's calendar lands on the DEFAULT Agent's
    // editor and is toasted "connected" over the anchor's disconnected status.
    const original = window.location.search;
    window.history.replaceState({}, '', '/bookings?google=connected&botId=bot-2');
    try {
      apiGet.mockImplementation(multiAgentGet());
      renderUI();
      await waitFor(() => {
        const calls = apiGet.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(calls.some((u) => u.includes('/scheduler/config') && u.includes('botId=bot-2'))).toBe(true);
      });
      // And the parameter is cleared, or a later navigation silently reselects that Agent.
      await waitFor(() => expect(window.location.search).not.toContain('botId'));
    } finally {
      window.history.replaceState({}, '', `/bookings${original}`);
    }
  });

  it('re-reads the selected Agent’s configuration', async () => {
    apiGet.mockImplementation(multiAgentGet());
    renderUI();
    const picker = await screen.findByLabelText(/^agent$/i);
    fireEvent.change(picker, { target: { value: 'bot-2' } });

    await waitFor(() => {
      const calls = apiGet.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((u) => u.includes('/scheduler/config') && u.includes('botId=bot-2'))).toBe(true);
    });
  });
});

describe('SchedulerSettings — refuses to save what the API will reject', { timeout: SLOW_FORM_TIMEOUT_MS }, () => {
  beforeEach(() => vi.clearAllMocks());

  /** Load `config`, wait for hydration, and hand back the Save button unpressed. */
  async function hydrate(config: unknown) {
    apiGet.mockImplementation((url: string) => {
      // The editor now asks who the tenant's Agents are, to decide whether an Agent picker is
    // worth showing. Answered deterministically: an unhandled URL left that query resolving
    // by luck and added seconds to every test in this file.
    if (url.includes('/bots')) return Promise.resolve({ bots: [{ id: 'bot-1', name: 'Valyro', isDefault: true }] });
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
