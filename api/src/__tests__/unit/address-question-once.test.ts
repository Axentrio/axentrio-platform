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
