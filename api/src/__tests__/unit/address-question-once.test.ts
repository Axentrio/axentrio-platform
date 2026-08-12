/**
 * The question the platform is allowed to ask once, and which tool gets to ask it.
 *
 * A **Pending Correction** exists because the model's `customerAddress` argument can name a
 * different place from the one the **Booking Customer** picked, and only they can settle that. The
 * design allows exactly one question per proposal - ask on every turn and a customer whose address
 * Google cannot suggest could never book, which is worse than the thing being guarded.
 *
 * "Once" is counted by `proposeCorrection` returning `isNew`, and that is the defect these tests
 * pin. `isNew` reports whether a PROPOSAL is new; the cap is meant to count QUESTIONS. Those are
 * the same number only while every proposer also asks - and all three booking tools call
 * `addressForTurn`, so all three propose, while only `create_booking` ever asks.
 *
 * The normal sequence therefore spends the question on silence:
 *
 *   check_availability proposes P   -> isNew true, read by nobody
 *   create_booking     proposes P   -> isNew FALSE, because P is already outstanding
 *   create_booking     asks nothing, books against the bound address
 *
 * These tests are written at the two seams that see it: the tool sequence, and one model response
 * containing both calls. The second matters separately - a batch of tool calls is executed without
 * returning to the model in between, so a `create_booking` sitting behind a `check_availability`
 * in the SAME response must not be able to book past a question that has just been raised.
 *
 * `never blocks them from booking` (CONTEXT.md, Pending Correction) is the other half and is
 * asserted here too: asking is one refusal, not a wall. The next attempt goes through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The binding is the real state machine over a fake store - these tests are about WHICH TOOL
// spends the question, so the transitions underneath must behave, not be stubbed into agreement.
const store = new Map<string, string>();
vi.mock('../../config/redis', () => ({
  getRedisClient: () => ({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    },
    del: async (k: string) => {
      store.delete(k);
      return 1;
    },
    expire: async () => 1,
  }),
  isRedisAvailable: () => true,
}));

const mockCheckAvailability = vi.fn();
const mockCreateBooking = vi.fn();
vi.mock('../../booking/booking.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/booking.service')>();
  return {
    ...actual,
    checkAvailability: (...a: unknown[]) => mockCheckAvailability(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: vi.fn(() => ({})),
}));

import { CheckAvailabilityTool, CreateBookingTool } from '../../agent/tools/booking.tool';
import { bindAddress, getBoundAddress, getPendingCorrection } from '../../booking/travel/address-binding';
import type { ToolContext } from '../../agent/tool-adapter';

/** What the Booking Customer picked. Authoritative; only they may move it. */
const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Turnhoutsebaan 100, 2140 Antwerpen' };
/** What the model names instead - a different door, so a real question rather than a reformat. */
const PROPOSED = 'Kerkstraat 12, 2060 Antwerpen';

const SESSION = 'sess-question-once';

/** One booking attempt, reused so the tests differ only in WHO calls it and in which run. */
const BOOK = {
  startTime: '2026-09-01T09:00:00Z',
  attendeeName: 'A Customer',
  attendeeEmail: 'customer@example.com',
  customerAddress: PROPOSED,
};

/**
 * One agent run = one customer message.
 *
 * The run id is load-bearing here, not decoration. Tool calls inside a run execute back to back
 * with no customer in between, so two calls sharing a run id have NOT been separated by anything
 * the customer saw. Passing the same id for what a test calls "the second attempt" would quietly
 * assert that a batch is a conversation.
 */
const ctx = (runId: string): ToolContext => ({
  tenantId: 'tenant-1',
  sessionId: SESSION,
  runId,
  toolsCalledThisTurn: [],
  dataSource: {} as never,
  conversationHistory: [],
});

/** True when a tool result is the "address is not settled" refusal that raises the question. */
const raisesTheQuestion = (r: { success: boolean; error?: string }) =>
  r.success === false && /address for this appointment is not settled/i.test(r.error ?? '');

beforeEach(async () => {
  vi.clearAllMocks();
  store.clear();
  mockCheckAvailability.mockResolvedValue({ slots: [], timezone: 'Europe/Brussels' });
  mockCreateBooking.mockResolvedValue({ id: 'bk-1', status: 'confirmed' });
  await bindAddress(SESSION, CHOSEN);
});

describe('the address question survives a preceding availability check', () => {
  it('is still asked when check_availability named the same address first', async () => {
    // THE DEFECT, at the seam it lives at. `check_availability` proposes and cannot ask; the cap
    // is spent; `create_booking` then finds nothing new and books against an address the customer
    // never agreed to. This is the ordinary flow - a model asked to book almost always checks
    // times first.
    await new CheckAvailabilityTool().execute(
      { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress: PROPOSED },
      ctx('run-1')
    );

    const booked = await new CreateBookingTool().execute(BOOK, ctx('run-1'));

    expect(raisesTheQuestion(booked)).toBe(true);
    // And it did NOT quietly book while the question stood.
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it('keeps refusing inside the SAME run, because the customer has not seen the question yet', async () => {
    // A model may emit several tool calls in one response, and they run back to back with nobody
    // in between. The question raised by the first is sitting in a tool result the customer will
    // never read on its own - so treating it as asked lets the very next call book past it. That
    // is the original defect wearing the fix's clothes, which is why the refusal is scoped to the
    // run rather than to the proposal.
    await new CreateBookingTool().execute(BOOK, ctx('run-1'));

    const alsoInRunOne = await new CreateBookingTool().execute(BOOK, ctx('run-1'));

    expect(raisesTheQuestion(alsoInRunOne)).toBe(true);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it('does not ask twice across turns, so the customer is never wedged', async () => {
    // The other half of the design, and the half a naive fix breaks. CONTEXT.md: a Pending
    // Correction "never blocks them from booking". A NEW run means the customer saw the question
    // and answered it, or did not - either way they have had their turn, and a customer whose
    // address Google cannot suggest must still be able to book.
    await new CheckAvailabilityTool().execute(
      { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress: PROPOSED },
      ctx('run-1')
    );
    await new CreateBookingTool().execute(BOOK, ctx('run-1'));

    const nextTurn = await new CreateBookingTool().execute(BOOK, ctx('run-2'));

    expect(raisesTheQuestion(nextTurn)).toBe(false);
    expect(mockCreateBooking).toHaveBeenCalledTimes(1);
    // Against the BOUND address, never the proposed one. Nothing the model said replaced it.
    expect(mockCreateBooking.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ customerAddress: CHOSEN.formattedAddress })])
    );
  });

  it('does not let a speculative check replace a question already on screen', async () => {
    // `check_availability` is read-only and the model may call it with an address it reconstructed.
    // Once the customer has been ASKED, superseding the proposal underneath them turns their next
    // tap into "that question no longer exists" - for a question they were asked seconds ago and
    // never got to answer.
    await new CreateBookingTool().execute(BOOK, ctx('run-1'));

    await new CheckAvailabilityTool().execute(
      { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress: 'Meir 78, 2000 Antwerpen' },
      ctx('run-2')
    );

    const pending = await getPendingCorrection(SESSION);
    expect(pending?.formattedAddress).toBe(PROPOSED);
  });

  it('names BOTH addresses, because most channels render no buttons', async () => {
    // A REGRESSION I INTRODUCED AND THEN CAUGHT IN REVIEW.
    //
    // The refusal used to say "they have been shown the two options - do not name either one
    // yourself", which is true on the widget and false everywhere else. `affordance` reaches
    // `Message.metadata` and the widget socket; it appears in NO channel adapter. So on Messenger,
    // Instagram, WhatsApp and Telegram the customer saw nothing while the model was forbidden from
    // saying anything - "which address is right?" with no addresses in it. Before that change those
    // customers at least heard one address named.
    //
    // The prose has to work where there are no buttons, so it names both. Where buttons DO exist
    // they are still server-labelled and still authoritative; the prose merely agrees with them.
    // Letting the model name the two options is safe now in a way it was not this morning: a tap
    // carries the server-issued proposalId and the transition requires `presented`, so a model that
    // words the choice badly still cannot manufacture a valid answer.
    const refused = await new CreateBookingTool().execute(BOOK, ctx('run-1'));

    expect(refused.success).toBe(false);
    expect(refused.error).toContain(CHOSEN.formattedAddress);
    expect(refused.error).toContain(PROPOSED);
    expect(refused.error).not.toMatch(/have been shown/i);
  });

  it('tells the model WHICH address it actually used', async () => {
    // Observed live on production, twice, on two different tools. The customer was told
    // "your appointment at Kerkstraat 12 is confirmed" while the row said Grote Markt 1 - the
    // BOUND address, which is the correct one to book. The data was right and the customer was
    // misinformed, so they would wait at one door while the business drove to another. Identical
    // outcome to #95, reached from the opposite direction.
    //
    // The model was not being careless; it was uninformed. `CreateBookingResult` carried no
    // address at all, so the tool silently replaced the model's argument and never said so, and
    // the model reported the only address it knew - the one it had asked for.
    //
    // This is the rule #92 produced and nobody implemented: a tool result should echo the RESOLVED
    // inputs it acted on, not only the outcome.
    await new CreateBookingTool().execute(BOOK, ctx('run-1'));      // asks
    const booked = await new CreateBookingTool().execute(BOOK, ctx('run-2')); // books

    expect(booked.success).toBe(true);
    expect((booked.data as { customerAddress?: string }).customerAddress).toBe(CHOSEN.formattedAddress);
  });

  it('leaves the binding alone whatever the tools proposed', async () => {
    // A proposal is a question, not a change. Stated separately because it is the invariant the
    // whole file exists to protect, and a fix that moved the binding would still pass the tests
    // above.
    await new CheckAvailabilityTool().execute(
      { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress: PROPOSED },
      ctx('run-1')
    );

    expect((await getBoundAddress(SESSION))?.formattedAddress).toBe(CHOSEN.formattedAddress);
  });
});
