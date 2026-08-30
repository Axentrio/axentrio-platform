/**
 * When the platform should offer to VERIFY an address, rather than keep guessing at one.
 *
 * An **Address Binding** can only be created by picking an **Address Suggestion**, and nothing in
 * any client offers that list - so `bindAddress` has never been reachable by a customer on any
 * surface. Every piece of machinery downstream of it (the **Pending Correction**, the confirmation
 * endpoint, the wrong-door guard, the address-aware dedup identity) is built, tested, and
 * unreachable, because the one thing that starts the chain has no front door.
 *
 * This is the signal that opens it. The server, not the client, decides when to offer the picker,
 * for two reasons:
 *
 *   - Suggestions are billed per request and fire on a debounce, so a client that guesses "this
 *     looks like an address" pays for every guess and still misses the times it matters.
 *   - `ADDRESS_REQUIRED` is the obvious trigger and is the WRONG one: `booking.module.ts:379`
 *     tells the model to ask for the address BEFORE calling check_availability, so that error only
 *     fires when the model misbehaved. Gating on it would show the picker exactly when things had
 *     already gone wrong and never during a conversation that went well.
 *
 * The signal used instead is `result.travel`. Travel only applies to a service whose
 * `customerAddressRequired` is set (`booking-place.ts:80`), so its presence IS the server saying
 * this job happens at the customer's address. Paired with "no verified place is bound yet", that
 * is precisely the moment a picker helps and the only moment it is worth paying for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckAvailability = vi.fn();
const mockCreateBooking = vi.fn();
const mockAutocompleteAddress = vi.fn();
vi.mock('../../booking/booking.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/booking.service')>();
  return {
    ...actual,
    checkAvailability: (...a: unknown[]) => mockCheckAvailability(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
  };
});
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: vi.fn(() => ({})),
}));
vi.mock('../../booking/travel/places.service', () => ({
  autocompleteAddress: (...a: unknown[]) => mockAutocompleteAddress(...a),
}));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CheckAvailabilityTool, CreateBookingTool } from '../../agent/tools/booking.tool';
import { bindAddress } from '../../booking/travel/address-binding';
import type { ToolContext } from '../../agent/tool-adapter';

const SESSION = '20000000-0000-4000-8000-000000000001';
const TYPED = 'Kerkstraat 12, 2060 Antwerpen';
/** What the customer actually picked, so the model's argument is a genuine second option. */
const BOUND = 'Turnhoutsebaan 100, 2140 Antwerpen';

const ctx = (): ToolContext => ({
  tenantId: 'tenant-1',
  sessionId: SESSION,
  runId: 'run-1',
  channel: 'widget',
  toolsCalledThisTurn: [],
  dataSource: {} as never,
  conversationHistory: [],
});

const check = (args: Record<string, unknown> = {}) =>
  new CheckAvailabilityTool().execute(
    { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress: TYPED, ...args },
    ctx()
  );

/** A result for a service that travels: `travel` present is what says so. */
const TRAVELS = {
  slots: [{ start: '2026-09-01T09:00:00Z' }],
  timezone: 'Europe/Brussels',
  travel: { requestableSlots: [], addressTooVague: false },
};
/** A service the customer comes to. No `travel`, so no address is needed and none is offered. */
const NO_TRAVEL = { slots: [{ start: '2026-09-01T09:00:00Z' }], timezone: 'Europe/Brussels' };

beforeEach(async () => {
  vi.clearAllMocks();
  mockAutocompleteAddress.mockResolvedValue({ status: 'ok', suggestions: [] });
});

describe('offering to verify the address', () => {
  it('returns the availability address as a server-only reply fact', async () => {
    mockCheckAvailability.mockResolvedValue(TRAVELS);

    const res = await check();

    expect(res.replyFact).toEqual({
      kind: 'booking_address',
      address: TYPED,
      use: 'availability',
      alternatives: [],
    });
    expect(JSON.stringify(res.data)).not.toContain('replyFact');
  });

  it('offers the picker when the job travels and nothing verified is bound', async () => {
    // The whole point. The customer typed an address, the model passed it along, and nobody has
    // asked Google whether that is a real doorway. Until they pick one, every downstream
    // protection is running on text.
    mockCheckAvailability.mockResolvedValue(TRAVELS);

    const res = await check();

    expect(res.affordance).toEqual({ kind: 'address_picker', reason: 'unverified', query: TYPED });
  });

  it.each(['messenger', 'instagram', 'whatsapp'] as const)(
    'offers %s numbered options backed by server suggestions',
    async (channel) => {
      mockCheckAvailability.mockResolvedValue(TRAVELS);
      mockAutocompleteAddress.mockResolvedValue({
        status: 'ok',
        suggestions: [
          { placeId: 'ChIJ_one', text: 'Turnhoutsebaan 100, 2140 Antwerpen' },
          { placeId: 'ChIJ_two', text: 'Turnhoutsebaan 101, 2140 Antwerpen' },
        ],
      });

      const res = await new CheckAvailabilityTool().execute(
        { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress: TYPED },
        { ...ctx(), channel },
      );

      expect(mockAutocompleteAddress).toHaveBeenCalledWith('tenant-1', TYPED);
      expect(res.affordance).toMatchObject({
        kind: 'address_picker',
        options: [
          { placeId: 'ChIJ_one', text: 'Turnhoutsebaan 100, 2140 Antwerpen' },
          { placeId: 'ChIJ_two', text: 'Turnhoutsebaan 101, 2140 Antwerpen' },
        ],
      });
    },
  );

  it('says nothing for a service the customer comes to', async () => {
    // No travel, no address needed. Asking a customer to verify their home address for a job that
    // happens on the business's premises is a question with no purpose, and it still costs a
    // billable request per keystroke once they start typing.
    mockCheckAvailability.mockResolvedValue(NO_TRAVEL);

    const res = await check();

    expect(res.affordance).toBeUndefined();
  });

  it('stops offering once the customer has picked one', async () => {
    // A binding means they already chose from the list and Google resolved it. Offering again
    // would ask them to redo the one thing that worked.
    await bindAddress(SESSION, { placeId: 'ChIJ_chosen', formattedAddress: TYPED });
    mockCheckAvailability.mockResolvedValue(TRAVELS);

    const res = await check({ customerAddress: TYPED });

    expect(res.affordance).toBeUndefined();
  });

  it('flags the town-only case, where verifying matters most', async () => {
    // `addressTooVague` means Google reached the town and no further, so no time can be
    // auto-confirmed. This is the case where picking a suggestion changes the customer's actual
    // outcome rather than merely tidying the record.
    mockCheckAvailability.mockResolvedValue({
      ...TRAVELS,
      travel: { requestableSlots: [{ start: '2026-09-01T09:00:00Z' }], addressTooVague: true },
    });

    const res = await check();

    expect(res.affordance).toMatchObject({ kind: 'address_picker', reason: 'too_vague' });
  });

  it.each(['Antwerp', 'Antwerp, Belgium', 'Antwerpen, Antwerp, Belgium'])(
    'does not offer map search results when the address is only %s',
    async (customerAddress) => {
      // The live failure: the model passed a city, availability treated it as the job
      // location, and Meta rendered Google's city/station hits as booking options.
      // A city is not an appointment address, so the picker must not open.
      mockCheckAvailability.mockResolvedValue({
        ...TRAVELS,
        travel: { requestableSlots: [{ start: '2026-09-01T09:00:00Z' }], addressTooVague: true },
      });

      const res = await new CheckAvailabilityTool().execute(
        { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress },
        { ...ctx(), channel: 'whatsapp' },
      );

      expect(mockAutocompleteAddress).not.toHaveBeenCalled();
      expect(res.affordance).toBeUndefined();
    },
  );

  it.each(['Grote Markt 1, Antwerpen', 'Kerkstraat 12, Antwerpen'])(
    'does not offer map search when %s has no postal code',
    async (customerAddress) => {
      mockCheckAvailability.mockResolvedValue({
        ...TRAVELS,
        travel: { requestableSlots: [{ start: '2026-09-01T09:00:00Z' }], addressTooVague: true },
      });

      const res = await new CheckAvailabilityTool().execute(
        { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress },
        { ...ctx(), channel: 'whatsapp' },
      );

      expect(mockAutocompleteAddress).not.toHaveBeenCalled();
      expect(res.affordance).toBeUndefined();
    },
  );

  it('does not offer map search when no address was given', async () => {
    mockCheckAvailability.mockResolvedValue({
      ...TRAVELS,
      travel: { requestableSlots: [{ start: '2026-09-01T09:00:00Z' }], addressTooVague: true },
    });

    const res = await new CheckAvailabilityTool().execute(
      { startDate: '2026-09-01', endDate: '2026-09-02' },
      { ...ctx(), channel: 'whatsapp' },
    );

    expect(mockAutocompleteAddress).not.toHaveBeenCalled();
    expect(res.affordance).toBeUndefined();
  });

  it('offers the CONFIRM control when it asks which address is right', async () => {
    // #95 itself. The question has been askable since the presentation split landed, but the
    // answer had nowhere to go: only a server-observed event may move an Address Binding, and
    // typing "yes" is not one. This is the control that produces one.
    //
    // It carries BOTH addresses and the proposalId. Both, because a question is a choice between
    // two and a client handed one option has to invent the other - which is the model defining the
    // options again, the thing the whole design refuses. The proposalId, because a late answer
    // must not settle a question the customer has already moved past.
    await bindAddress(SESSION, { placeId: 'ChIJ_chosen', formattedAddress: BOUND });
    mockCheckAvailability.mockResolvedValue(TRAVELS);
    mockCreateBooking.mockResolvedValue({ id: 'bk-1' });

    const res = await new CreateBookingTool().execute(
      {
        startTime: '2026-09-01T09:00:00Z',
        attendeeName: 'A Customer',
        attendeeEmail: 'customer@example.com',
        customerAddress: TYPED,
      },
      ctx()
    );

    expect(res.success).toBe(false); // it refused, which is how it asks
    expect(res.affordance).toMatchObject({
      kind: 'address_confirm',
      proposed: TYPED,
      bound: BOUND,
    });
    expect((res.affordance as { proposalId?: string }).proposalId).toBeTruthy();
  });

  it('never rides on `data`, which the model reads', async () => {
    // Same rule `measurement` follows, and for the same reason: `data` is serialised into the tool
    // message and truncated at 4000 characters, so anything parked there competes with the slot
    // list. It is also UI, and a model told about a picker will start describing one.
    mockCheckAvailability.mockResolvedValue(TRAVELS);

    const res = await check();

    expect(JSON.stringify(res.data)).not.toContain('address_picker');
  });
});
