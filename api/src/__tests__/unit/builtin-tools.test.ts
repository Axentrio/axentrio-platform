import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockCheckAvailability = vi.fn();
const mockCreateBooking = vi.fn();
const mockListBookings = vi.fn();
const mockRescheduleBooking = vi.fn();
const mockCancelBooking = vi.fn();

vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: vi.fn().mockReturnValue({
    id: 'evt-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    timestamp: new Date().toISOString(),
    session: { channel: 'widget', visitorId: 'v1', startedAt: new Date().toISOString(), messageCount: 0 },
  }),
}));

vi.mock('../../booking/booking.service', () => ({
  checkAvailability: (...args: unknown[]) => mockCheckAvailability(...args),
  createBooking: (...args: unknown[]) => mockCreateBooking(...args),
  listBookings: (...args: unknown[]) => mockListBookings(...args),
  rescheduleBooking: (...args: unknown[]) => mockRescheduleBooking(...args),
  cancelBooking: (...args: unknown[]) => mockCancelBooking(...args),
  BookingError: class BookingError extends Error {
    code: string;
    statusCode: number;
    constructor(message: string, code: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));

const mockSearchKnowledge = vi.fn();

vi.mock('../../llm/rag.service', () => ({
  searchKnowledge: (...args: unknown[]) => mockSearchKnowledge(...args),
}));


// A tiny in-memory Redis: the offered-slot store must run its REAL path, because a module
// mock of the store would not rebind the internal call from resolveBookingTime.
const redisStore = new Map<string, string>();
vi.mock('../../config/redis', () => ({
  getRedisClient: () => ({
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string) => { redisStore.set(k, v); },
    del: async (k: string) => { redisStore.delete(k); },
  }),
}));


// ── Imports (after mocks) ───────────────────────────────────────────────────

import { KbSearchTool } from '../../agent/tools/kb-search.tool';
import {
  CheckAvailabilityTool,
  CreateBookingTool,
  RequestAppointmentTool,
  ListBookingsTool,
  RescheduleBookingTool,
  CancelBookingTool,
} from '../../agent/tools/booking.tool';
import { EscalationTool } from '../../agent/tools/escalation.tool';
import { emitWebhookEvent } from '../../webhooks/webhook.emitter';
import type { ToolAdapter, ToolContext } from '../../agent/tool-adapter';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 'tenant-123',
    sessionId: 'session-abc',
    runId: 'run-xyz',
    channel: 'widget',
    toolsCalledThisTurn: [],
    // The KbSearchTool now queries the session row to resolve `bot_id` for
    // RAG scoping (multi-bot Phase 3). Stub `dataSource.query` so the tool
    // sees "no session row" and falls back to tenant-wide search.
    dataSource: { query: vi.fn().mockResolvedValue([]) } as any,
    conversationHistory: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('KbSearchTool', () => {
  it('has correct name and hasSideEffects=false', () => {
    const tool = new KbSearchTool();
    expect(tool.name).toBe('kb_search');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('has description and parameters defined', () => {
    const tool = new KbSearchTool();
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.parameters).toBeDefined();
  });

  it('execute returns success with chunks on valid query', async () => {
    const tool = new KbSearchTool();
    const ctx = makeCtx();
    const fakeResult = { chunks: [{ id: '1', content: 'hello', title: 'doc', similarity: 0.9, metadata: {} }], totalChunks: 1 };
    mockSearchKnowledge.mockResolvedValue(fakeResult);

    const result = await tool.execute({ query: 'how to reset password' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(fakeResult);
    // Multi-bot Phase 3 added two trailing args: maxChunks (undefined → default)
    // and knowledgeBaseIds (undefined → tenant-wide RAG, the legacy behaviour).
    expect(mockSearchKnowledge).toHaveBeenCalledWith(
      ctx.dataSource,
      ctx.tenantId,
      'how to reset password',
      [],
      undefined,
      undefined,
      undefined, // S5 specialtyTerms (none on this ctx)
    );
  });

  describe('travel time — times that need a request rather than a confirmation', () => {
    const slot = (h: number) => ({ start: `2026-04-01T${String(h).padStart(2, '0')}:00:00Z`, end: `2026-04-01T${String(h).padStart(2, '0')}:30:00Z` });

    it('tells the model that requestable times are NOT confirmable', async () => {
      mockCheckAvailability.mockResolvedValue({
        slots: [slot(10)], timezone: 'UTC',
        travel: { requestableSlots: [slot(14)], unreachableCount: 1 },
      });
      const result = await new CheckAvailabilityTool().execute(
        { startDate: '2026-04-01', endDate: '2026-04-02', customerAddress: 'Kerkstraat 12, 9000 Gent' },
        makeCtx({ sessionId: 'sess-1' })
      );
      expect((result.data as any).suggestedAction).toBe('request_appointment');
      expect((result.data as any).guidance).toMatch(/request_appointment/);
      expect((result.data as any).guidance).toMatch(/cannot be auto-confirmed/i);
    });

    it('asks for a postcode when the address was only located to the town', async () => {
      // The one thing that can turn these into confirmable times, and the reason a coarse
      // address is filtered coarsely rather than refused outright.
      mockCheckAvailability.mockResolvedValue({
        slots: [], timezone: 'UTC',
        travel: { requestableSlots: [slot(10), slot(14)], unreachableCount: 0, addressTooVague: true },
      });
      const result = await new CheckAvailabilityTool().execute(
        { startDate: '2026-04-01', endDate: '2026-04-02', customerAddress: 'Gent' },
        makeCtx({ sessionId: 'sess-1' })
      );
      expect((result.data as any).guidance).toMatch(/postcode/i);
      expect((result.data as any).guidance).toMatch(/check_availability again/i);
    });

    it('does NOT read an all-requestable result out as an empty range', async () => {
      // Handled after the empty-slots branch this would say "no times available", turning a
      // list of perfectly askable times into a dead end.
      mockCheckAvailability.mockResolvedValue({
        slots: [], timezone: 'UTC',
        travel: { requestableSlots: [slot(10)], unreachableCount: 0 },
      });
      const result = await new CheckAvailabilityTool().execute(
        { startDate: '2026-04-01', endDate: '2026-04-02' },
        makeCtx({ sessionId: 'sess-1' })
      );
      expect((result.data as any).noSlotsInRange).toBeUndefined();
      expect((result.data as any).guidance).not.toMatch(/No auto-confirmable times in this range/);
    });

    it('says nothing extra when travel filtered nothing out', async () => {
      mockCheckAvailability.mockResolvedValue({
        slots: [slot(10)], timezone: 'UTC',
        travel: { requestableSlots: [], unreachableCount: 0 },
      });
      const result = await new CheckAvailabilityTool().execute(
        { startDate: '2026-04-01', endDate: '2026-04-02' },
        makeCtx({ sessionId: 'sess-1' })
      );
      expect((result.data as any).suggestedAction).toBeUndefined();
    });
  });

  it('execute returns success=false with error on failure', async () => {
    const tool = new KbSearchTool();
    mockSearchKnowledge.mockRejectedValue(new Error('DB connection failed'));

    const result = await tool.execute({ query: 'test' }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toBe('DB connection failed');
  });
});

describe('an email the confirmation cannot reach', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to book with a malformed address', async () => {
    // Found by testing production, not by review: `not-an-email` was accepted and the booking
    // confirmed. The customer was told they were booked, the confirmation had nowhere to go, and
    // their manage link was unreachable — and nothing failed loudly, because `EmailService.send`
    // returns `{ success: false }` rather than throwing.
    const tool = new CreateBookingTool();

    const result = await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Edge Nine', attendeeEmail: 'not-an-email' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(mockCreateBooking).not.toHaveBeenCalled();
    // Safe for the model AND actionable: it can ask the customer to repeat the address.
    expect(result.errorSafeForModel).toBe(true);
    expect(result.error).toMatch(/not valid/i);
  });

  it('refuses on the REQUEST path too, where the owner is the one who cannot reply', async () => {
    const tool = new RequestAppointmentTool();

    const result = await tool.execute(
      { preferredTime: 'next Tuesday', attendeeName: 'Edge Nine', attendeeEmail: 'bob@@example', aiSummary: 'x' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.errorSafeForModel).toBe(true);
  });

  it('still allows a booking with NO email, which is a different thing from a wrong one', async () => {
    // Email is optional on this path. Absent must not be treated as invalid, or a phone-only
    // customer stops being bookable.
    //
    // BOTH shapes of absent, because they arrive by different routes: the model omits the
    // argument, and the tool schema's own default fills an empty string. An empty string reaching
    // the validator as "invalid" would refuse every phone-only booking with a nonsense message
    // about checking the address.
    mockCreateBooking.mockResolvedValue({ success: true, bookingId: 'b1' });
    const tool = new CreateBookingTool();

    for (const attendeeEmail of [undefined, '', '   ']) {
      mockCreateBooking.mockClear();
      const result = await tool.execute(
        { startTime: '2026-04-01T10:00:00Z', attendeeName: 'No Email', ...(attendeeEmail === undefined ? {} : { attendeeEmail }) },
        makeCtx(),
      );
      expect(result.success).toBe(true);
      expect(mockCreateBooking).toHaveBeenCalled();
    }
  });
});

describe('CheckAvailabilityTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has correct name and hasSideEffects=false', () => {
    const tool = new CheckAvailabilityTool();
    expect(tool.name).toBe('check_availability');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('says the slots in the business wall clock and keeps the instants off `data`', async () => {
    // THE MODEL READS THE DIGITS, NOT THE ZONE. Handed `2026-10-09T08:30:00.000Z` and told the
    // business is in Brussels, a live bot answered "the next valid time is 08:30" - the 10:30
    // slot, said half an hour before the business opens, above chips that said 10:30. The same
    // call had already called 10:00 free off a `T10:00:00Z` slot that starts at 12:00 local.
    const tool = new CheckAvailabilityTool();
    const ctx = makeCtx({ sessionId: 'sess-1' });
    mockCheckAvailability.mockResolvedValue({
      slots: [{ start: '2026-04-01T10:00:00Z', end: '2026-04-01T10:30:00Z' }],
      timezone: 'Europe/Brussels',
    });

    const result = await tool.execute({ startDate: '2026-04-01', endDate: '2026-04-07' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      slots: [{ start: '2026-04-01T12:00:00', end: '2026-04-01T12:30:00' }],
      timezone: 'Europe/Brussels',
    });
    // No offset anywhere in the payload, so there is nothing left to misread.
    expect(JSON.stringify(result.data)).not.toMatch(/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
    // Moved, not dropped: chips, the offer record and the invented-time guard need real instants.
    expect(result.availability).toMatchObject({
      slots: [{ start: '2026-04-01T10:00:00Z', end: '2026-04-01T10:30:00Z' }],
      timezone: 'Europe/Brussels',
    });
    // Trailing undefineds: customerAddress, then #149 locationChoice.
    expect(mockCheckAvailability).toHaveBeenCalledWith('agent', 'sess-1', '2026-04-01', '2026-04-07', undefined, undefined, undefined, undefined);
  });

  it('tells the model not to re-offer hours when the customer already named a free time', async () => {
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [
        { start: '2026-10-05T07:00:00.000Z', end: '2026-10-05T07:30:00.000Z' },
        { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T08:30:00.000Z' },
      ],
      timezone: 'Europe/Brussels',
    });

    const result = await tool.execute(
      { startDate: '2026-10-05', endDate: '2026-10-05' },
      makeCtx({
        conversationHistory: [
          { role: 'user', content: 'Kan ik maandag 5 oktober 2026 om 10:00 langskomen?' },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect((result.data as { requestedTimeAvailable?: boolean }).requestedTimeAvailable).toBe(true);
    expect((result.data as { guidance?: string }).guidance).toMatch(/already named this time/i);
    expect((result.data as { guidance?: string }).guidance).toMatch(/do not list or offer other times/i);
  });

  it('tells the model outright that a named time it did not offer is unavailable', async () => {
    // The positive twin above has existed for months; its absence said nothing, and nothing is
    // what shipped "10:00 is beschikbaar" for a 10:00 the buffers had already ruled out. Only
    // the create call refused it, one turn and one confirmation too late.
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [{ start: '2026-10-05T07:00:00.000Z', end: '2026-10-05T07:30:00.000Z' }],
      timezone: 'Europe/Brussels',
    });

    const result = await tool.execute(
      { startDate: '2026-10-05', endDate: '2026-10-05' },
      makeCtx({
        conversationHistory: [
          { role: 'user', content: 'Kan ik om 10:00 langskomen?' },
        ],
      }),
    );

    // One named assertion at the boundary: `data` is `unknown` on ToolResult by design.
    const data = result.data as {
      requestedTimeAvailable?: boolean;
      requestedTimeUnavailable?: string;
      guidance?: string;
    };
    expect(data.requestedTimeAvailable).toBeUndefined();
    expect(data.requestedTimeUnavailable).toBe('10:00');
    expect(data.guidance).toMatch(/never tell the customer it is available/i);
  });

  it('#81: moves shadow scoring off `data`, which is what the model reads', async () => {
    // `data` is serialised into the tool message verbatim and truncated at 4000 characters. Left
    // there, the scoring both teaches a model that is meant to be unaware of any ranking AND
    // competes with the slot list for the budget - a shadow feature able to break the real one.
    const tool = new CheckAvailabilityTool();
    const grouping = { scorerVersion: 'lp4-1', scores: {}, counterfactualOrder: [], cheaperAlternativeExisted: false, elementsSpent: 1, ms: 5 };
    mockCheckAvailability.mockResolvedValue({ slots: [], timezone: 'UTC', grouping });

    const result = await tool.execute({ startDate: '2026-04-01', endDate: '2026-04-07' }, makeCtx());

    expect(JSON.stringify(result.data)).not.toContain('lp4-1');
    // ...and moved, not dropped: the offer record is written from it at the dispatch boundary.
    expect(result.measurement).toEqual({ grouping });
  });

  it('#81: adds no measurement key at all when the scorer did not run', async () => {
    // A present-but-empty measurement would read as "scored, found nothing", which is a different
    // fact from "never ran" and would land in the denominator of every LP4 question.
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({ slots: [], timezone: 'UTC' });

    const result = await tool.execute({ startDate: '2026-04-01', endDate: '2026-04-07' }, makeCtx());

    expect(result.measurement).toBeUndefined();
  });

  it('execute returns success=false with error on failure', async () => {
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockRejectedValue(new Error('Cal.com unavailable'));

    const result = await tool.execute({ startDate: '2026-04-01', endDate: '2026-04-07' }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cal.com unavailable');
  });
});

describe('CreateBookingTool', () => {
  beforeEach(() => { vi.clearAllMocks(); redisStore.clear(); });

  it('has hasSideEffects=true', () => {
    const tool = new CreateBookingTool();
    expect(tool.hasSideEffects).toBe(true);
  });

  it('has no hard preconditions (handled by skill instructions instead)', () => {
    const tool = new CreateBookingTool() as ToolAdapter;
    expect(tool.preconditions).toBeUndefined();
  });

  it('generates a stable session+service idempotency key (not per-runId, so re-confirms dedupe)', async () => {
    const tool = new CreateBookingTool();
    const ctx = makeCtx({ runId: 'run-abc', sessionId: 'sess-1' });
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-1' } });

    await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Alice', attendeeEmail: 'alice@test.com' },
      ctx
    );

    expect(mockCreateBooking).toHaveBeenCalledWith(
      'agent',
      'sess-1',
      // `noaddr` rather than a hash: this booking named no address, and a service that needs
      // none must key exactly as it always did.
      'create_booking:sess-1:default:2026-04-01T10:00:00:noaddr',
      '2026-04-01T10:00:00',
      { name: 'Alice', email: 'alice@test.com' },
      undefined,
      undefined,
      undefined,
      { customerAddress: undefined, customerPhone: undefined, durationMin: undefined }    );
  });

  it('keys a CHANGED address as a different booking, and an unchanged one as the same', async () => {
    // The property, not the format. Two calls that differ only in where the van goes are not the
    // same booking - live on production a customer who corrected their address was handed the
    // original row back as a success and told it was confirmed at the new one.
    const tool = new CreateBookingTool();
    const ctx = makeCtx({ runId: 'run-1', sessionId: 'sess-9' });
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-9' } });
    const args = { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Alice', attendeeEmail: 'a@t.com' };
    const keyOf = (call: unknown[]) => call[2] as string;

    await tool.execute({ ...args, customerAddress: 'Place Saint-Lambert 1, 4000 Liege' }, ctx);
    await tool.execute({ ...args, customerAddress: 'Turnhoutsebaan 100, 2140 Antwerpen' }, ctx);
    // Same doorway, spelled the way a model rewrites it — must NOT become a second booking.
    await tool.execute({ ...args, customerAddress: '  place saint-lambert 1,  4000 liege ' }, ctx);

    const [liege, antwerp, liegeAgain] = mockCreateBooking.mock.calls.map(keyOf);
    expect(liege).not.toBe(antwerp);
    expect(liegeAgain).toBe(liege);
  });

  it('passes notes when provided', async () => {
    const tool = new CreateBookingTool();
    const ctx = makeCtx({ runId: 'run-xyz', sessionId: 'sess-2' });
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-2' } });

    await tool.execute(
      { startTime: '2026-04-02T09:00:00Z', attendeeName: 'Bob', attendeeEmail: 'bob@test.com', notes: 'Need consultation' },
      ctx
    );

    expect(mockCreateBooking).toHaveBeenCalledWith(
      'agent',
      'sess-2',
      'create_booking:sess-2:default:2026-04-02T09:00:00:noaddr',
      '2026-04-02T09:00:00',
      { name: 'Bob', email: 'bob@test.com' },
      'Need consultation',
      undefined,
      undefined,
      { customerAddress: undefined, customerPhone: undefined, durationMin: undefined }    );
  });

  it('re-reads a UTC or offset startTime as the wall clock the customer named', async () => {
    // Live 2026-08-26: customer said "om 10:00", the model passed 10:00Z, the provider booked
    // 12:00 Brussels. The digits are the local hour; the suffix is the lie.
    const tool = new CreateBookingTool();
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-z' } });

    await tool.execute(
      { startTime: '2026-10-05T10:00:00.000Z', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@example.com' },
      makeCtx({ sessionId: 'sess-z' }),
    );

    expect(mockCreateBooking.mock.calls[0][3]).toBe('2026-10-05T10:00:00.000');

    mockCreateBooking.mockClear();
    await tool.execute(
      { startTime: '2026-10-05T10:00:00+02:00', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@example.com' },
      makeCtx({ sessionId: 'sess-z2' }),
    );
    expect(mockCreateBooking.mock.calls[0][3]).toBe('2026-10-05T10:00:00');

    mockCreateBooking.mockClear();
    await tool.execute(
      { startTime: '2026-10-05T10:00:00', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@example.com' },
      makeCtx({ sessionId: 'sess-z3' }),
    );
    expect(mockCreateBooking.mock.calls[0][3]).toBe('2026-10-05T10:00:00');
  });

  it('keeps a verbatim offered slot when it does not contradict the customer', async () => {
    // Live: the model copied the offered 09:00Z slot (11:00 Brussels) for "om 11:00". A blanket
    // strip booked 09:00. The slot stands: its local clock is the hour the customer named.
    const tool = new CreateBookingTool();
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-slot' } });

    redisStore.set('booking:offered:sess-verbatim', JSON.stringify({
      starts: ['2026-10-05T09:00:00.000Z', '2026-10-05T09:30:00.000Z'],
      timezone: 'Europe/Brussels',
    }));
    await tool.execute(
      { startTime: '2026-10-05T09:00:00.000Z', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@example.com' },
      makeCtx({
        sessionId: 'sess-verbatim',
        conversationHistory: [{ role: 'user', content: 'Kan ik maandag 5 oktober om 11:00 langskomen?' }],
      }),
    );
    expect(mockCreateBooking.mock.calls[0][3]).toBe('2026-10-05T09:00:00.000Z');
  });

  it('strips an offset that contradicts the hour the customer named', async () => {
    // Live: customer said "om 13:00"; the model echoed 13:00Z (= 15:00 Brussels), and 15:00
    // HAPPENED to be an offered slot, so the offered-slot check kept it and booked 15:00.
    // The customer's own clock time is the tiebreaker.
    const tool = new CreateBookingTool();
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-contradict' } });

    redisStore.set('booking:offered:sess-contradict', JSON.stringify({
      starts: ['2026-10-05T13:00:00.000Z'],
      timezone: 'Europe/Brussels',
    }));
    await tool.execute(
      { startTime: '2026-10-05T13:00:00.000Z', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@example.com' },
      makeCtx({
        sessionId: 'sess-contradict',
        conversationHistory: [{ role: 'user', content: 'Kan ik maandag 5 oktober om 13:00 langskomen?' }],
      }),
    );
    expect(mockCreateBooking.mock.calls[0][3]).toBe('2026-10-05T13:00:00.000');
  });

  it('strips a constructed offset time that was never offered', async () => {
    // Live: customer said "om 10:00", the model passed 10:00Z, the provider booked 12:00.
    const tool = new CreateBookingTool();
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-constructed' } });

    redisStore.set('booking:offered:sess-constructed', JSON.stringify({
      starts: ['2026-10-05T09:00:00.000Z', '2026-10-05T09:30:00.000Z'],
      timezone: 'Europe/Brussels',
    }));
    await tool.execute(
      { startTime: '2026-10-05T10:00:00.000Z', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@example.com' },
      makeCtx({
        sessionId: 'sess-constructed',
        conversationHistory: [{ role: 'user', content: 'Kan ik om 10:00 langskomen?' }],
      }),
    );
    expect(mockCreateBooking.mock.calls[0][3]).toBe('2026-10-05T10:00:00.000');
  });

  it('#5: emits appointment.booked with the real booking id + canonical UTC startTime (not the idempotency key / arg time)', async () => {
    const tool = new CreateBookingTool();
    const ctx = makeCtx({ sessionId: 'sess-5' });
    mockCreateBooking.mockResolvedValue({
      success: true,
      booking: {
        id: 'bk-real-uuid',
        startTime: '2026-04-03T12:00:00.000Z',
        endTime: '2026-04-03T12:30:00.000Z',
        attendee: { name: 'Cara' },
      },
    });
    // arg time is the raw/zoneless model string; the webhook must carry the
    // provider's canonical UTC time + the real booking id.
    await tool.execute(
      { startTime: '2026-04-03T12:00', attendeeName: 'Cara', attendeeEmail: 'c@test.com' },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 0)); // flush the fire-and-forget emit
    expect(vi.mocked(emitWebhookEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'appointment.booked',
        appointment: expect.objectContaining({
          bookingId: 'bk-real-uuid',
          startTime: '2026-04-03T12:00:00.000Z',
        }),
      }),
    );
  });

  it('#5: does NOT re-emit appointment.booked on an idempotent retry', async () => {
    const tool = new CreateBookingTool();
    mockCreateBooking.mockResolvedValue({
      success: true,
      idempotent: true,
      booking: { id: 'bk-x', startTime: '2026-04-04T10:00:00.000Z', endTime: '2026-04-04T10:30:00.000Z', attendee: {} },
    });
    await tool.execute(
      { startTime: '2026-04-04T10:00:00Z', attendeeName: 'Dee', attendeeEmail: 'd@test.com' },
      makeCtx(),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(emitWebhookEvent)).not.toHaveBeenCalled();
  });

  it('#5: skips the webhook when a confirmed result is missing the booking id (contract violation)', async () => {
    const tool = new CreateBookingTool();
    mockCreateBooking.mockResolvedValue({
      success: true,
      booking: { id: undefined, startTime: undefined, endTime: undefined, attendee: {} },
    });
    await tool.execute(
      { startTime: '2026-04-05T10:00:00Z', attendeeName: 'Eve', attendeeEmail: 'e@test.com' },
      makeCtx(),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(emitWebhookEvent)).not.toHaveBeenCalled();
  });

  it('execute returns success=false with error on failure', async () => {
    const tool = new CreateBookingTool();
    mockCreateBooking.mockRejectedValue(new Error('Slot unavailable'));

    const result = await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Alice', attendeeEmail: 'alice@test.com' },
      makeCtx()
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Slot unavailable');
  });
});

describe('ListBookingsTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has correct name and hasSideEffects=false', () => {
    const tool = new ListBookingsTool();
    expect(tool.name).toBe('list_bookings');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('execute calls listBookings with sessionId and attendeeEmail', async () => {
    const tool = new ListBookingsTool();
    const ctx = makeCtx({ sessionId: 'sess-3' });
    const fakeBookings = { bookings: [] };
    mockListBookings.mockResolvedValue(fakeBookings);

    const result = await tool.execute({ attendeeEmail: 'user@test.com' }, ctx);

    expect(result.success).toBe(true);
    expect(mockListBookings).toHaveBeenCalledWith('agent', 'sess-3', 'user@test.com');
  });
});

describe('RescheduleBookingTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has hasSideEffects=true', () => {
    const tool = new RescheduleBookingTool();
    expect(tool.hasSideEffects).toBe(true);
  });

  it('execute calls rescheduleBooking with correct args', async () => {
    const tool = new RescheduleBookingTool();
    const ctx = makeCtx({ sessionId: 'sess-4' });
    mockRescheduleBooking.mockResolvedValue({ success: true, booking: { id: 'bk-3' } });

    const result = await tool.execute({ bookingId: 'bk-3', newStartTime: '2026-04-10T14:00:00Z' }, ctx);

    expect(result.success).toBe(true);
    expect(mockRescheduleBooking).toHaveBeenCalledWith('agent', 'sess-4', 'bk-3', '2026-04-10T14:00:00Z');
  });
});

describe('CancelBookingTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has hasSideEffects=true', () => {
    const tool = new CancelBookingTool();
    expect(tool.hasSideEffects).toBe(true);
  });

  it('execute calls cancelBooking with sessionId and bookingId', async () => {
    const tool = new CancelBookingTool();
    const ctx = makeCtx({ sessionId: 'sess-5' });
    mockCancelBooking.mockResolvedValue({ success: true, cancelled: true });

    const result = await tool.execute({ bookingId: 'bk-4', reason: 'Not needed' }, ctx);

    expect(result.success).toBe(true);
    expect(mockCancelBooking).toHaveBeenCalledWith('agent', 'sess-5', 'bk-4', 'Not needed');
  });
});

describe('EscalationTool', () => {
  it('has hasSideEffects=true', () => {
    const tool = new EscalationTool();
    expect(tool.hasSideEffects).toBe(true);
  });

  it('has correct name', () => {
    const tool = new EscalationTool();
    expect(tool.name).toBe('escalate_to_human');
  });

  it('execute returns escalated=true with reason, but NOT internal ids (R31)', async () => {
    const tool = new EscalationTool();
    const ctx = makeCtx({ sessionId: 'sess-6', tenantId: 'tenant-456' });

    const result = await tool.execute({ reason: 'Cannot resolve customer issue' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as any).escalated).toBe(true);
    expect((result.data as any).reason).toBe('Cannot resolve customer issue');
    // R31: internal ids must NOT be exposed to the model (it could echo them).
    expect((result.data as any).sessionId).toBeUndefined();
    expect((result.data as any).tenantId).toBeUndefined();
  });

  it('refuses to escalate when the session is not bot-owned', async () => {
    const tool = new EscalationTool();
    const result = await tool.execute({ reason: 'asked for a person' }, makeCtx({ botOwned: false }));

    expect(result.success).toBe(true);
    expect((result.data as any).alreadyActive).toBe(true);
    expect((result.data as any).escalated).toBeUndefined();
    expect((result.data as any).guidance).toMatch(/human is already involved/i);
    expect((result.data as any).sessionId).toBeUndefined();
  });
});
