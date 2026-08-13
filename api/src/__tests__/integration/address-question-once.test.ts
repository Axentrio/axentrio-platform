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
 * On the widget, asking is one refusal rather than a wall: the next attempt goes through. A
 * channel that cannot render the control may capture a Request, but may not silently confirm at
 * either address while the question is contested.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckAvailability = vi.fn();
const mockCreateBooking = vi.fn();
const mockRequestBooking = vi.fn();
vi.mock('../../booking/booking.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/booking.service')>();
  return {
    ...actual,
    checkAvailability: (...a: unknown[]) => mockCheckAvailability(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
    requestBooking: (...a: unknown[]) => mockRequestBooking(...a),
  };
});


vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: vi.fn(() => ({})),
}));

import { CheckAvailabilityTool, CreateBookingTool, RequestAppointmentTool } from '../../agent/tools/booking.tool';
import { bindAddress, getBoundAddress, getPendingCorrection, markQuestionAsked } from '../../booking/travel/address-binding';
import type { ToolContext } from '../../agent/tool-adapter';
import { AppDataSource } from '../../database/data-source';
import { Participant } from '../../database/entities/Participant';
import { Message } from '../../database/entities/Message';
import { createTestTenant, createTestAnchorBot, createTestSession } from '../helpers/factories';

/** What the Booking Customer picked. Authoritative; only they may move it. */
const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Turnhoutsebaan 100, 2140 Antwerpen' };
/** What the model names instead - a different door, so a real question rather than a reformat. */
const PROPOSED = 'Kerkstraat 12, 2060 Antwerpen';
const CHANNELS_WITHOUT_ADDRESS_CONTROLS = ['messenger', 'instagram', 'whatsapp', 'telegram'] as const;

let sessionId: string;
let tenantId: string;
let botParticipantId: string;

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
const ctx = (runId: string, channel: ToolContext['channel'] = 'widget'): ToolContext => ({
  tenantId,
  sessionId,
  runId,
  channel,
  toolsCalledThisTurn: [],
  dataSource: AppDataSource,
  conversationHistory: [],
});

/** True when a tool result is the "address is not settled" refusal that raises the question. */
/** What `finalizeReply` does when it persists a reply carrying the control. */
const deliverTheQuestion = async () => {
  const pending = await getPendingCorrection(sessionId);
  if (!pending) return;
  const message = await AppDataSource.getRepository(Message).save(
    AppDataSource.getRepository(Message).create({
      sessionId,
      tenantId,
      participantId: botParticipantId,
      type: 'text',
      content: 'which address?',
      status: 'sent',
      sentAt: new Date(),
      metadata: {
        affordance: { kind: 'address_confirm', proposalId: pending.proposalId },
      } as never,
    })
  );
  await markQuestionAsked(
    sessionId,
    pending.proposalId,
    { messageId: message.id, channel: 'widget' }
  );
};

const raisesTheQuestion = (r: { success: boolean; error?: string }) =>
  r.success === false && /address for this appointment is not settled/i.test(r.error ?? '');

beforeEach(async () => {
  vi.clearAllMocks();
  const tenant = await createTestTenant({ tier: 'pro' });
  tenantId = tenant.id;
  const bot = await createTestAnchorBot(tenant);
  const session = await createTestSession(tenant.id, { botId: bot.id, channel: 'widget' });
  sessionId = session.id;
  const participant = await AppDataSource.getRepository(Participant).save(
    AppDataSource.getRepository(Participant).create({
      sessionId,
      type: 'bot',
      name: 'bot',
      joinedAt: new Date(),
    })
  );
  botParticipantId = participant.id;
  mockCheckAvailability.mockResolvedValue({ slots: [], timezone: 'Europe/Brussels' });
  mockCreateBooking.mockResolvedValue({ id: 'bk-1', status: 'confirmed' });
  mockRequestBooking.mockResolvedValue({ id: 'req-1', status: 'request_created', requested: true });
  await bindAddress(sessionId, CHOSEN);
});

describe('the address question survives a preceding availability check', () => {
  it('fails closed when runtime context omits the channel', async () => {
    const noChannel = ctx('run-1');
    delete (noChannel as { channel?: string }).channel;

    const result = await new CreateBookingTool().execute(BOOK, noChannel);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/request_appointment/);
    expect(result.affordance).toBeUndefined();
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect((await getPendingCorrection(sessionId))?.status).toBe('recorded');
  });

  it.each(CHANNELS_WITHOUT_ADDRESS_CONTROLS)(
    'refuses a confirmed booking on %s, where the contested address cannot be settled safely',
    async (channel) => {
      const result = await new CreateBookingTool().execute(BOOK, ctx('run-1', channel));

      expect(raisesTheQuestion(result)).toBe(false);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/request_appointment/);
      expect(result.affordance).toBeUndefined();
      expect(mockCreateBooking).not.toHaveBeenCalled();
      expect((await getPendingCorrection(sessionId))?.status).toBe('recorded');

      const request = await new RequestAppointmentTool().execute(
        {
          preferredTime: BOOK.startTime,
          attendeeName: BOOK.attendeeName,
          attendeeEmail: BOOK.attendeeEmail,
          customerAddress: BOOK.customerAddress,
        },
        ctx('run-1', channel)
      );
      expect(request.success).toBe(true);
      expect(mockRequestBooking).toHaveBeenCalledWith(
        'agent',
        sessionId,
        expect.any(String),
        BOOK.startTime,
        expect.objectContaining({ name: BOOK.attendeeName }),
        undefined,
        undefined,
        undefined,
        undefined,
        expect.objectContaining({ customerAddress: CHOSEN.formattedAddress })
      );
    }
  );

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

  it('asks AGAIN when the run that asked died before its reply was written', async () => {
    // The coalescer re-runs the same customer message after a processor error, with a fresh run id.
    // Keyed on the run, the refusal lifted and the booking went through - for a question whose
    // reply was never persisted, so the customer had seen nothing at all. Keyed on whether the
    // reply EXISTS, the replay correctly asks again.
    await new CreateBookingTool().execute(BOOK, ctx('run-1'));   // asks; reply never persisted
    // ...and nothing marked it delivered, so the customer saw nothing.

    const replay = await new CreateBookingTool().execute(BOOK, ctx('run-2-replay'));

    expect(raisesTheQuestion(replay)).toBe(true);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it('does not ask twice across turns, so the customer is never wedged', async () => {
    // The other half of the widget design, and the half a naive fix breaks. A NEW run means the
    // customer saw the question and answered it, or did not - either way they have had their turn,
    // and a customer whose address Google cannot suggest must still be able to book.
    await new CheckAvailabilityTool().execute(
      { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress: PROPOSED },
      ctx('run-1')
    );
    await new CreateBookingTool().execute(BOOK, ctx('run-1'));
    // The reply landed, which is what marks the question delivered in production.
    await deliverTheQuestion();

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
    // ON SCREEN means DELIVERED. A question still sitting in an unread tool result may be
    // superseded - nothing is showing, so nothing is pulled out from under anyone. The rule only
    // binds once the reply carrying the control has been persisted.
    await deliverTheQuestion();

    await new CheckAvailabilityTool().execute(
      { startDate: '2026-09-01', endDate: '2026-09-02', customerAddress: 'Meir 78, 2000 Antwerpen' },
      ctx('run-2')
    );

    const pending = await getPendingCorrection(sessionId);
    expect(pending?.formattedAddress).toBe(PROPOSED);
  });

  it('names BOTH addresses in the widget reply that carries the controls', async () => {
    // The prose and the server-labelled buttons must express the same A-or-B question. A tap still
    // carries the server-issued proposalId and answering still requires persisted ASKED evidence;
    // the model's wording cannot manufacture authority.
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
    await deliverTheQuestion();                                      // the reply landed
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

    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe(CHOSEN.formattedAddress);
  });
});
