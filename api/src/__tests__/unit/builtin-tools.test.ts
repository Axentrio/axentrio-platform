import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DateTime } from 'luxon';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockCheckAvailability = vi.fn();
const mockCreateBooking = vi.fn();
const mockRequestBooking = vi.fn();
const mockListBookings = vi.fn();
const mockRescheduleBooking = vi.fn();
const mockCancelBooking = vi.fn();
const mockUpdateBooking = vi.fn();
const mockPeekCustomerEmailRequired = vi.fn(async (_sessionId?: string, _serviceId?: string) => false);
const mockPeekCustomerChange = vi.fn(async () => 'auto' as const);


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
  requestBooking: (...args: unknown[]) => mockRequestBooking(...args),
  listBookings: (...args: unknown[]) => mockListBookings(...args),
  rescheduleBooking: (...args: unknown[]) => mockRescheduleBooking(...args),
  cancelBooking: (...args: unknown[]) => mockCancelBooking(...args),
  updateBooking: (...args: unknown[]) => mockUpdateBooking(...args),
  peekCustomerEmailRequired: (sessionId: string, serviceId?: string) =>
    mockPeekCustomerEmailRequired(sessionId, serviceId),
  peekCustomerChange: (...args: unknown[]) => mockPeekCustomerChange(...args),
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
  UpdateBookingTool,
} from '../../agent/tools/booking.tool';
import { EscalationTool } from '../../agent/tools/escalation.tool';
import { BookingError } from '../../booking/booking.service';
import { emitWebhookEvent } from '../../webhooks/webhook.emitter';
import type { ToolAdapter, ToolContext } from '../../agent/tool-adapter';
import { pendingYesNeedsCreate } from '../../agent/pending-booking-confirmation';
import { wallClockKey } from '../../agent/offered-slots-store';

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

  it('refuses a reserved example.com address the model invented', async () => {
    const tool = new CreateBookingTool();
    const result = await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@example.com' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/placeholder/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it('refuses a reserved .test TLD the same way', async () => {
    const tool = new CreateBookingTool();
    const result = await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Jan Test', attendeeEmail: 'jan@company.test' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/placeholder/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it('still succeeds when attendeeEmail is omitted', async () => {
    mockCreateBooking.mockResolvedValue({ success: true, bookingId: 'b1' });
    const tool = new CreateBookingTool();
    const result = await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'No Email' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(mockCreateBooking).toHaveBeenCalled();
  });

  it('returns EMAIL_REQUIRED before CONFIRMATION_REQUIRED when the service needs email', async () => {
    mockPeekCustomerEmailRequired.mockResolvedValue(true);
    const tool = new CreateBookingTool();
    const result = await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Ada' },
      makeCtx({
        conversationHistory: [{ role: 'user', content: 'boek het morgen om 10:00' }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/EMAIL_REQUIRED/);
    expect(result.error).not.toMatch(/CONFIRMATION_REQUIRED/);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it('returns SERVICE_NOT_FOUND, not a booking summary, for an unknown UUID', async () => {
    mockPeekCustomerEmailRequired.mockRejectedValue(
      new BookingError('That serviceId is not currently a bookable service', 'SERVICE_NOT_FOUND', 404),
    );
    const tool = new CreateBookingTool();
    const result = await tool.execute(
      {
        startTime: '2026-04-01T10:00:00Z',
        attendeeName: 'Ada',
        serviceId: '550e8400-e29b-41d4-a716-446655440000',
      },
      makeCtx({
        conversationHistory: [{ role: 'user', content: 'boek het morgen om 10:00' }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SERVICE_NOT_FOUND/);
    expect(result.error).not.toMatch(/CONFIRMATION_REQUIRED/);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it('returns SERVICE_NOT_FOUND, not a booking summary, for a non-UUID serviceId', async () => {
    mockPeekCustomerEmailRequired.mockRejectedValue(
      new BookingError('That serviceId is not currently a bookable service', 'SERVICE_NOT_FOUND', 404),
    );
    const tool = new CreateBookingTool();
    const result = await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Ada', serviceId: 'klantenafspraak' },
      makeCtx({
        conversationHistory: [{ role: 'user', content: 'boek het morgen om 10:00' }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SERVICE_NOT_FOUND/);
    expect(result.error).not.toMatch(/CONFIRMATION_REQUIRED/);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it('does not invent EMAIL_REQUIRED when the peek throws an unexpected error', async () => {
    mockPeekCustomerEmailRequired.mockRejectedValue(new Error('connection reset'));
    const tool = new CreateBookingTool();
    const result = await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Ada' },
      makeCtx({
        conversationHistory: [{ role: 'user', content: 'boek het morgen om 10:00' }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('connection reset');
    expect(result.errorSafeForModel).toBe(false);
    expect(result.error).not.toMatch(/EMAIL_REQUIRED/);
    expect(result.error).not.toMatch(/CONFIRMATION_REQUIRED/);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it('still captures a request when email is missing, so there is no dead end', async () => {
    mockPeekCustomerEmailRequired.mockResolvedValue(true);
    mockRequestBooking.mockResolvedValue({ success: true, requested: true, bookingId: 'r1' });
    const tool = new RequestAppointmentTool();
    const result = await tool.execute(
      { preferredTime: 'next Tuesday', attendeeName: 'Ada', aiSummary: 'x' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(mockRequestBooking).toHaveBeenCalled();
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
    // Trailing undefineds: customerAddress, then #149 locationChoice, then phone, then clock window.
    expect(mockCheckAvailability).toHaveBeenCalledWith('agent', 'sess-1', '2026-04-01', '2026-04-07', undefined, undefined, undefined, undefined, undefined, undefined);
  });

  it("passes the customer's part of day to the diary", async () => {
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [{ start: '2026-09-03T10:00:00.000Z', end: '2026-09-03T10:30:00.000Z' }],
      timezone: 'Europe/Brussels',
    });
    await tool.execute({ startDate: '2026-09-03', endDate: '2026-09-03', earliestTime: '12:00' }, makeCtx());
    expect(mockCheckAvailability.mock.calls[0].at(-1)).toEqual({ from: '12:00', to: '24:00' });
  });

  it('accepts a day-part word as a clock window', async () => {
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [{ start: '2026-09-03T14:00:00.000Z', end: '2026-09-03T14:30:00.000Z' }],
      timezone: 'Europe/Brussels',
    });
    const result = await tool.execute(
      { startDate: '2026-09-03', endDate: '2026-09-03', earliestTime: 'afternoon' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(mockCheckAvailability.mock.calls[0].at(-1)).toEqual({ from: '12:00', to: '18:00' });
  });

  it('refuses a malformed window', async () => {
    const tool = new CheckAvailabilityTool();
    const result = await tool.execute(
      { startDate: '2026-09-03', endDate: '2026-09-03', earliestTime: 'soon' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^INVALID_TIME_WINDOW/);
    expect(mockCheckAvailability).not.toHaveBeenCalled();
  });

  it('says the window was full and offers the other times', async () => {
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [{ start: '2026-09-03T07:00:00.000Z', end: '2026-09-03T07:30:00.000Z' }],
      timezone: 'Europe/Brussels',
      clockWindow: { from: '12:00', to: '24:00', matched: false },
    });
    const result = await tool.execute({ startDate: '2026-09-03', endDate: '2026-09-03' }, makeCtx());
    expect(result.success).toBe(true);
    expect((result.data as { guidance?: string }).guidance).toMatch(/between 12:00 and 24:00/);
    expect((result.data as { guidance?: string }).guidance).toMatch(/Do NOT capture a request/);
    expect(result.availability?.slots).toHaveLength(1);
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
    expect((result.data as { guidance?: string }).guidance).toMatch(/CONFIRMATION_REQUIRED/);
    expect((result.data as { guidance?: string }).guidance).not.toContain('€80');
  });

  it('stands down the named-hour match when the named date was refused this run', async () => {
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
        namedTimeRefused: true,
      }),
    );

    expect(result.success).toBe(true);
    expect((result.data as { requestedTimeAvailable?: boolean }).requestedTimeAvailable).toBeUndefined();
    expect((result.data as { guidance?: string }).guidance ?? '').not.toMatch(/already named this time/i);
  });

  it('tells the model to call create_booking now after an explicit yes', async () => {
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [
        { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T08:30:00.000Z' },
      ],
      timezone: 'Europe/Brussels',
    });
    const result = await tool.execute(
      { startDate: '2026-10-05', endDate: '2026-10-05' },
      makeCtx({
        conversationHistory: [
          { role: 'user', content: 'Kan ik maandag 5 oktober 2026 om 10:00 langskomen?' },
          { role: 'assistant', content: 'Zal ik 10:00 boeken?' },
          { role: 'user', content: 'Ja, dat klopt' },
        ],
      }),
    );
    const guidance =
      result.data && typeof result.data === 'object' && 'guidance' in result.data
        ? String((result.data as { guidance?: string }).guidance)
        : '';
    expect(guidance).toMatch(/Call create_booking now/i);
    expect(guidance).toMatch(/Do not send another summary/i);
    expect(guidance).not.toMatch(/CONFIRMATION_REQUIRED/);
  });

  it('still sees a named time after the customer answers a required intake question', async () => {
    // Production: Lekonderzoek auto-book, required intake "Waar bevindt het probleem zich?".
    // Customer named Monday 12 October 2026 at 10:00, then answered the intake. lastCustomerText
    // read only that answer, so requestedTimeAvailable never fired and the model re-offered
    // 00:00 / 00:30 / 01:00 instead of confirming 10:00.
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [
        { start: '2026-10-12T07:00:00.000Z', end: '2026-10-12T08:00:00.000Z' },
        { start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T09:00:00.000Z' },
      ],
      timezone: 'Europe/Brussels',
    });

    const result = await tool.execute(
      { startDate: '2026-10-12', endDate: '2026-10-12' },
      makeCtx({
        conversationHistory: [
          { role: 'user', content: 'Ik wil een lekonderzoek op maandag 12 oktober 2026 om 10:00' },
          { role: 'assistant', content: 'Waar bevindt het probleem zich?' },
          { role: 'user', content: 'Het probleem bevindt zich onder de lavabo in de badkamer.' },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect((result.data as { requestedTimeAvailable?: boolean }).requestedTimeAvailable).toBe(true);
    expect((result.data as { guidance?: string }).guidance).toMatch(/already named this time/i);
  });


  it('still flags a named time as unavailable after an intake answer', async () => {
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [{ start: '2026-10-12T07:00:00.000Z', end: '2026-10-12T08:00:00.000Z' }],
      timezone: 'Europe/Brussels',
    });

    const result = await tool.execute(
      { startDate: '2026-10-12', endDate: '2026-10-12' },
      makeCtx({
        conversationHistory: [
          { role: 'user', content: 'Ik wil een lekonderzoek op maandag 12 oktober 2026 om 10:00' },
          { role: 'assistant', content: 'Waar bevindt het probleem zich?' },
          { role: 'user', content: 'Het probleem bevindt zich onder de lavabo in de badkamer.' },
        ],
      }),
    );

    const data = result.data as {
      requestedTimeAvailable?: boolean;
      requestedTimeUnavailable?: string;
    };
    expect(data.requestedTimeAvailable).toBeUndefined();
    expect(data.requestedTimeUnavailable).toBe('10:00');
  });

  it('uses a later named hour when they change their mind after intake', async () => {
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [
        { start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T09:00:00.000Z' },
        { start: '2026-10-12T12:00:00.000Z', end: '2026-10-12T13:00:00.000Z' },
      ],
      timezone: 'Europe/Brussels',
    });

    const result = await tool.execute(
      { startDate: '2026-10-12', endDate: '2026-10-12' },
      makeCtx({
        conversationHistory: [
          { role: 'user', content: 'Ik wil een lekonderzoek op maandag 12 oktober 2026 om 10:00' },
          { role: 'user', content: 'Liever om 14:00.' },
        ],
      }),
    );

    expect((result.data as { requestedTimeAvailable?: boolean }).requestedTimeAvailable).toBe(true);
  });

  it('does not treat a rejected 10:00 as still requested after other times were offered', async () => {
    const tool = new CheckAvailabilityTool();
    mockCheckAvailability.mockResolvedValue({
      slots: [
        { start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T09:00:00.000Z' },
        { start: '2026-10-12T09:00:00.000Z', end: '2026-10-12T10:00:00.000Z' },
      ],
      timezone: 'Europe/Brussels',
    });

    const result = await tool.execute(
      { startDate: '2026-10-12', endDate: '2026-10-12' },
      makeCtx({
        conversationHistory: [
          { role: 'user', content: 'Kan ik om 10:00 langskomen?' },
          { role: 'assistant', content: '10:00 is niet vrij. Ik heb 11:00 en 11:30.' },
          { role: 'user', content: 'ja' },
        ],
      }),
    );

    const data = result.data as { requestedTimeAvailable?: boolean };
    expect(data.requestedTimeAvailable).toBeUndefined();
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

  const DUMP =
    'Ik wil maandag 26 oktober 2026 om 10:00 de Korting booking test boeken. Tom Test, 0470 00 00 12, achraftamranim@gmail.com.';
  const BOOK_ARGS = {
    startTime: '2026-10-26T10:00:00',
    attendeeName: 'Tom Test',
    attendeeEmail: 'achraftamranim@gmail.com',
    serviceId: 'svc-korting',
  };

  async function executeAfterConfirm(
    tool: CreateBookingTool,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) {
    await tool.execute(args, { ...ctx, runId: `${ctx.runId}:ask` });
    const pendingRaw = redisStore.get(`booking:confirm:${ctx.sessionId}`);
    const pendingTime = pendingRaw ? (JSON.parse(pendingRaw) as { startTime?: string }).startTime : '';
    const keyed = pendingTime || (await wallClockKey(ctx.sessionId, String(args.startTime ?? '')));
    const clock = keyed.match(/T(\d{2}):(\d{2})/);
    const hhmm = clock ? `${clock[1]}:${clock[2]}` : '10:00';
    const keyedDt = DateTime.fromISO(keyed);
    const months = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
    const dateAsk = keyedDt.isValid
      ? `Zal ik boeken op ${keyedDt.day} ${months[keyedDt.month - 1]} ${keyedDt.year} om ${hhmm}?`
      : `Zal ik boeken om ${hhmm}?`;
    return tool.execute(args, {
      ...ctx,
      runId: `${ctx.runId}:yes`,
      conversationHistory: [
        ...ctx.conversationHistory,
        { role: 'assistant', content: dateAsk },
        { role: 'user', content: 'ja' },
      ],
    });
  }

  it('does not write on the first turn when the customer dumped the details', async () => {
    const tool = new CreateBookingTool();
    const result = await tool.execute(
      BOOK_ARGS,
      makeCtx({
        sessionId: 'sess-confirm',
        runId: 'run-1',
        conversationHistory: [{ role: 'user', content: DUMP }],
      }),
    );
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CONFIRMATION_REQUIRED/);
    expect(result.error).not.toContain('€80');
  });

  it('sees a later ja as the yes the agent loop must turn into create_booking', async () => {
    const tool = new CreateBookingTool();
    await tool.execute(
      BOOK_ARGS,
      makeCtx({
        sessionId: 'sess-confirm-nudge',
        runId: 'run-1',
        conversationHistory: [{ role: 'user', content: DUMP }],
      }),
    );
    await expect(
      pendingYesNeedsCreate('sess-confirm-nudge', [
        { role: 'user', content: DUMP },
        { role: 'assistant', content: 'Zal ik boeken op maandag 26 oktober 2026 om 10:00?' },
        { role: 'user', content: 'Ja, dat klopt' },
      ]),
    ).resolves.toBe(true);
    await expect(
      pendingYesNeedsCreate('sess-confirm-nudge', [
        { role: 'user', content: DUMP },
        { role: 'assistant', content: 'Zal ik de beschikbaarheid checken?' },
        { role: 'user', content: 'Ja, dat klopt' },
      ]),
    ).resolves.toBe(false);
    await expect(
      pendingYesNeedsCreate('sess-confirm-nudge', [
        { role: 'user', content: DUMP },
        { role: 'assistant', content: 'Zal ik boeken op maandag 26 oktober 2026 om 10:00?' },
        { role: 'user', content: 'What is the address?' },
      ]),
    ).resolves.toBe(false);
  });

  it('writes after a later explicit yes for the same pending details', async () => {
    const tool = new CreateBookingTool();
    await tool.execute(
      BOOK_ARGS,
      makeCtx({
        sessionId: 'sess-confirm-yes',
        runId: 'run-1',
        conversationHistory: [{ role: 'user', content: DUMP }],
      }),
    );
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-1' } });
    const result = await tool.execute(
      BOOK_ARGS,
      makeCtx({
        sessionId: 'sess-confirm-yes',
        runId: 'run-2',
        conversationHistory: [
          { role: 'user', content: DUMP },
          { role: 'assistant', content: 'Zal ik Korting booking test boeken op maandag 26 oktober 2026 om 10:00 op naam van Tom Test?' },
          { role: 'user', content: 'Ja, dat klopt' },
        ],
      }),
    );
    expect(mockCreateBooking).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('writes on a second create_booking in the same yes turn', async () => {
    const tool = new CreateBookingTool();
    const yesCtx = {
      sessionId: 'sess-confirm-samerun',
      runId: 'run-yes',
      conversationHistory: [
        { role: 'user' as const, content: DUMP },
        { role: 'assistant' as const, content: 'Zal ik boeken op maandag 26 oktober 2026 om 10:00?' },
        { role: 'user' as const, content: 'Ja, dat klopt' },
      ],
    };
    await tool.execute(BOOK_ARGS, makeCtx(yesCtx));
    expect(mockCreateBooking).not.toHaveBeenCalled();
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-same' } });
    const result = await tool.execute(BOOK_ARGS, makeCtx(yesCtx));
    expect(mockCreateBooking).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('does not write a same-run ja that only answered an availability question', async () => {
    const tool = new CreateBookingTool();
    const yesCtx = {
      sessionId: 'sess-confirm-avail-ja',
      runId: 'run-avail',
      conversationHistory: [
        { role: 'user' as const, content: DUMP },
        { role: 'assistant' as const, content: 'Zal ik de beschikbaarheid checken?' },
        { role: 'user' as const, content: 'Ja, dat klopt' },
      ],
    };
    await tool.execute(BOOK_ARGS, makeCtx(yesCtx));
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-no' } });
    const result = await tool.execute(BOOK_ARGS, makeCtx(yesCtx));
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CONFIRMATION_REQUIRED/);
  });

  it('does not write when the model asks to book only after the yes', async () => {
    const tool = new CreateBookingTool();
    const yesCtx = {
      sessionId: 'sess-confirm-sameturn',
      runId: 'run-sameturn',
      conversationHistory: [
        { role: 'user' as const, content: DUMP },
        { role: 'assistant' as const, content: 'Zal ik de beschikbaarheid checken?' },
        { role: 'user' as const, content: 'Ja, dat klopt' },
        { role: 'assistant' as const, content: 'Zal ik boeken op maandag 26 oktober 2026 om 10:00?' },
      ],
    };
    await tool.execute(BOOK_ARGS, makeCtx(yesCtx));
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-no' } });
    const result = await tool.execute(BOOK_ARGS, makeCtx(yesCtx));
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CONFIRMATION_REQUIRED/);
  });

  it('treats an offered Z instant and a later zoneless time as the same booking', async () => {
    const tool = new CreateBookingTool();
    const dumpCtx = {
      sessionId: 'sess-confirm-z',
      conversationHistory: [{ role: 'user' as const, content: DUMP }],
    };
    redisStore.set('booking:offered:sess-confirm-z', JSON.stringify({
      starts: ['2026-10-26T09:00:00.000Z'],
      timezone: 'Europe/Brussels',
    }));
    await tool.execute(
      { ...BOOK_ARGS, startTime: '2026-10-26T09:00:00.000Z' },
      makeCtx({ ...dumpCtx, runId: 'run-1' }),
    );
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-z' } });
    const { serviceId: _omit, ...withoutService } = BOOK_ARGS;
    const result = await tool.execute(
      { ...withoutService, startTime: '2026-10-26T10:00:00' },
      makeCtx({
        ...dumpCtx,
        runId: 'run-2',
        conversationHistory: [
          { role: 'user', content: DUMP },
          { role: 'assistant', content: 'Zal ik boeken op maandag 26 oktober 2026 om 10:00?' },
          { role: 'user', content: 'Ja, dat klopt' },
        ],
      }),
    );
    expect(mockCreateBooking).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('does not write when a later message changes the time', async () => {
    const tool = new CreateBookingTool();
    await tool.execute(
      BOOK_ARGS,
      makeCtx({
        sessionId: 'sess-confirm-change',
        runId: 'run-1',
        conversationHistory: [{ role: 'user', content: DUMP }],
      }),
    );
    const result = await tool.execute(
      { ...BOOK_ARGS, startTime: '2026-10-26T11:00:00' },
      makeCtx({
        sessionId: 'sess-confirm-change',
        runId: 'run-2',
        conversationHistory: [
          { role: 'user', content: DUMP },
          { role: 'assistant', content: 'Zal ik 10:00 boeken?' },
          { role: 'user', content: 'Change it to 11:00' },
        ],
      }),
    );
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CONFIRMATION_REQUIRED/);
  });

  it('does not treat a later question as confirmation of the old summary', async () => {
    const tool = new CreateBookingTool();
    await tool.execute(
      BOOK_ARGS,
      makeCtx({
        sessionId: 'sess-confirm-q',
        runId: 'run-1',
        conversationHistory: [{ role: 'user', content: DUMP }],
      }),
    );
    const result = await tool.execute(
      BOOK_ARGS,
      makeCtx({
        sessionId: 'sess-confirm-q',
        runId: 'run-2',
        conversationHistory: [
          { role: 'user', content: DUMP },
          { role: 'assistant', content: 'Zal ik 10:00 boeken?' },
          { role: 'user', content: 'What is the address?' },
        ],
      }),
    );
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('does not treat a later time question as confirmation of the pending summary', async () => {
    const tool = new CreateBookingTool();
    await tool.execute(
      BOOK_ARGS,
      makeCtx({
        sessionId: 'sess-confirm-timeq',
        runId: 'run-1',
        conversationHistory: [{ role: 'user', content: DUMP }],
      }),
    );
    const result = await tool.execute(
      BOOK_ARGS,
      makeCtx({
        sessionId: 'sess-confirm-timeq',
        runId: 'run-2',
        conversationHistory: [
          { role: 'user', content: DUMP },
          { role: 'assistant', content: 'Zal ik 10:00 boeken?' },
          { role: 'user', content: 'Kan ik om 10:00 langskomen?' },
        ],
      }),
    );
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('does not expose fileSessionIds to the model', () => {
    const create = new CreateBookingTool();
    const request = new RequestAppointmentTool();
    expect(create.parameters.properties).not.toHaveProperty('fileSessionIds');
    expect(request.parameters.properties).not.toHaveProperty('fileSessionIds');
  });

  it('drops a hallucinated fileSessionIds argument instead of forwarding it', async () => {
    const tool = new CreateBookingTool();
    const ctx = makeCtx({ runId: 'run-abc', sessionId: 'sess-1' });
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-1' } });

    await tool.execute(
      {
        startTime: '2026-04-01T10:00:00Z',
        attendeeName: 'Alice',
        attendeeEmail: 'alice@test.com',
        fileSessionIds: ['invented-id'],
      },
      ctx
    );

    const extras = mockCreateBooking.mock.calls[0]?.[8] as Record<string, unknown> | undefined;
    expect(extras).toBeDefined();
    expect(extras).not.toHaveProperty('fileSessionIds');
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
      { startTime: '2026-10-05T10:00:00.000Z', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@valyro.be' },
      makeCtx({ sessionId: 'sess-z' }),
    );

    expect(mockCreateBooking.mock.calls[0][3]).toBe('2026-10-05T10:00:00.000');

    mockCreateBooking.mockClear();
    await tool.execute(
      { startTime: '2026-10-05T10:00:00+02:00', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@valyro.be' },
      makeCtx({ sessionId: 'sess-z2' }),
    );
    expect(mockCreateBooking.mock.calls[0][3]).toBe('2026-10-05T10:00:00');

    mockCreateBooking.mockClear();
    await tool.execute(
      { startTime: '2026-10-05T10:00:00', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@valyro.be' },
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
    await executeAfterConfirm(
      tool,
      { startTime: '2026-10-05T09:00:00.000Z', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@valyro.be' },
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
    await executeAfterConfirm(
      tool,
      { startTime: '2026-10-05T13:00:00.000Z', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@valyro.be' },
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
    await executeAfterConfirm(
      tool,
      { startTime: '2026-10-05T10:00:00.000Z', attendeeName: 'Jan Test', attendeeEmail: 'jan.test@valyro.be' },
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

  it('execute calls listBookings with undefined when attendeeEmail is omitted', async () => {
    const tool = new ListBookingsTool();
    const ctx = makeCtx({ sessionId: 'sess-3' });
    mockListBookings.mockResolvedValue({ bookings: [] });

    const result = await tool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(mockListBookings).toHaveBeenCalledWith('agent', 'sess-3', undefined);
  });

  it('tells the model when a listed booking cannot be cancelled', async () => {
    const tool = new ListBookingsTool();
    mockListBookings.mockResolvedValue({
      bookings: [
        { id: 'bk-1', status: 'confirmed', cancel: 'not_allowed', reschedule: 'request' },
      ],
    });

    const result = await tool.execute({}, makeCtx({ sessionId: 'sess-3' }));

    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        guidance: expect.stringMatching(/cannot be cancelled[\s\S]*CHANGE_NOT_ALLOWED/),
      }),
    );
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
    expect(mockRescheduleBooking).toHaveBeenCalledWith('agent', 'sess-4', 'bk-3', '2026-04-10T14:00:00Z', undefined);
  });

  it('writes the address the customer confirmed, even when the model drops it', async () => {
    // The gate holds the door the customer agreed to in a summary. Reading `args` here instead
    // would open the fence and then move the job to the address the row already had (WaterFix,
    // 2026-09-01: the move never landed at all, and this is the write it owed them).
    const tool = new RescheduleBookingTool();
    const ctx = makeCtx({
      sessionId: 'sess-5',
      conversationHistory: [
        {
          role: 'assistant',
          content: 'Ter bevestiging: donderdag om 13:00 op Turnhoutsebaan 100, 2140 Antwerpen. Zal ik dit boeken?',
        },
        { role: 'user', content: 'ja doe maar' },
      ],
    });
    mockRescheduleBooking.mockResolvedValue({ success: true, booking: { id: 'bk-9' } });

    // First call records the pending move with the address; the confirming call omits it.
    await tool.execute(
      { bookingId: 'bk-9', newStartTime: '2026-09-03T13:00:00', customerAddress: 'Turnhoutsebaan 100, 2140 Antwerpen' },
      makeCtx({ sessionId: 'sess-5', conversationHistory: [{ role: 'user', content: 'verzet naar 13:00' }] }),
    );
    const result = await tool.execute({ bookingId: 'bk-9', newStartTime: '2026-09-03T13:00:00' }, ctx);

    expect(result.success).toBe(true);
    expect(mockRescheduleBooking).toHaveBeenLastCalledWith('agent', 'sess-5', 'bk-9', '2026-09-03T13:00:00', {
      customerAddress: 'Turnhoutsebaan 100, 2140 Antwerpen',
    });
  });

  it('a request-policy move still waits for an explicit yes', async () => {
    const tool = new RescheduleBookingTool();
    mockPeekCustomerChange.mockResolvedValueOnce('request');
    const ctx = makeCtx({
      sessionId: 'sess-sv-reschedule',
      conversationHistory: [{ role: 'user', content: 'passtraat 248B, 9100 Sint-Niklaas' }],
    });

    const result = await tool.execute(
      {
        bookingId: 'bk-orig',
        newStartTime: '2026-09-07T15:00:00',
        customerAddress: 'Passtraat 248B, 9100 Sint-Niklaas',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CONFIRMATION_REQUIRED/);
    expect(mockRescheduleBooking).not.toHaveBeenCalled();
  });

  it('refuses a not_allowed move on the first call, without confirmation', async () => {
    const tool = new RescheduleBookingTool();
    mockPeekCustomerChange.mockResolvedValueOnce('not_allowed');
    const ctx = makeCtx({
      sessionId: 'sess-sv-na',
      conversationHistory: [{ role: 'user', content: 'verzet naar 15:00' }],
    });

    const result = await tool.execute(
      { bookingId: 'bk-orig', newStartTime: '2026-09-07T15:00:00' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CHANGE_NOT_ALLOWED/);
    expect(result.error).not.toMatch(/CONFIRMATION_REQUIRED/);
    expect(mockRescheduleBooking).not.toHaveBeenCalled();
  });

  it('still waits for a yes when the Service auto-moves', async () => {
    const tool = new RescheduleBookingTool();
    const ctx = makeCtx({
      sessionId: 'sess-sv-auto',
      conversationHistory: [{ role: 'user', content: 'passtraat 248B, 9100 Sint-Niklaas' }],
    });

    const result = await tool.execute(
      {
        bookingId: 'bk-orig',
        newStartTime: '2026-09-07T15:00:00',
        customerAddress: 'Passtraat 248B, 9100 Sint-Niklaas',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CONFIRMATION_REQUIRED/);
    expect(mockRescheduleBooking).not.toHaveBeenCalled();
  });

  it('refuses not_allowed before asking the customer to confirm a move', async () => {
    // Screenshot: reschedule Not allowed, the bot asked for a new time, then
    // said the change was confirmed while the calendar stayed on 4 Sep.
    const tool = new RescheduleBookingTool();
    mockPeekCustomerChange.mockResolvedValueOnce('not_allowed');
    const ctx = makeCtx({
      sessionId: 'sess-sv-forbidden',
      conversationHistory: [{ role: 'user', content: 'ik wil graag mijn afspraak wijzigen' }],
    });

    const result = await tool.execute(
      { bookingId: 'bk-orig', newStartTime: '2026-09-07T14:00:00' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CHANGE_NOT_ALLOWED/);
    expect(result.error).not.toMatch(/CONFIRMATION_REQUIRED/);
    expect(result.error).not.toMatch(/MOVE_PENDING/);
    expect(mockRescheduleBooking).not.toHaveBeenCalled();
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

  it('a request-policy cancel still waits for an explicit yes', async () => {
    mockPeekCustomerChange.mockResolvedValueOnce('request');
    const tool = new CancelBookingTool();
    const ctx = makeCtx({
      sessionId: 'sess-sv-cancel',
      conversationHistory: [{ role: 'user', content: 'ik wil mijn afspraak annuleren' }],
    });

    const result = await tool.execute({ bookingId: 'bk-orig' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CONFIRMATION_REQUIRED/);
    expect(mockCancelBooking).not.toHaveBeenCalled();
  });

  it('refuses a not_allowed cancel on the first call, without confirmation', async () => {
    mockPeekCustomerChange.mockResolvedValueOnce('not_allowed');
    const tool = new CancelBookingTool();
    const ctx = makeCtx({
      sessionId: 'sess-sv-cancel',
      conversationHistory: [{ role: 'user', content: 'of nee annuleer het maar gewoon' }],
    });

    const result = await tool.execute({ bookingId: 'bk-orig' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CHANGE_NOT_ALLOWED/);
    expect(result.error).not.toMatch(/CONFIRMATION_REQUIRED/);
    expect(mockCancelBooking).not.toHaveBeenCalled();
  });
});

describe('UpdateBookingTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has hasSideEffects=true', () => {
    const tool = new UpdateBookingTool();
    expect(tool.name).toBe('update_booking');
    expect(tool.hasSideEffects).toBe(true);
  });

  it('execute calls updateBooking with session contact fields', async () => {
    const tool = new UpdateBookingTool();
    const ctx = makeCtx({ sessionId: 'sess-6' });
    mockUpdateBooking.mockResolvedValue({ success: true, emailSent: true, booking: { id: 'bk-5' } });

    const result = await tool.execute(
      { attendeeEmail: 'ada@valyro.be', notes: 'Gate code 12' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(mockUpdateBooking).toHaveBeenCalledWith('agent', 'sess-6', {
      bookingId: undefined,
      attendeeName: undefined,
      attendeeEmail: 'ada@valyro.be',
      customerPhone: undefined,
      notes: 'Gate code 12',
    });
  });

  it('refuses a bad email before calling the service', async () => {
    const tool = new UpdateBookingTool();
    const result = await tool.execute({ attendeeEmail: 'not-an-email' }, makeCtx());
    expect(result.success).toBe(false);
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it('refuses a reserved example.org address before calling the service', async () => {
    const tool = new UpdateBookingTool();
    const result = await tool.execute({ attendeeEmail: 'x@example.org' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/placeholder/i);
    expect(mockUpdateBooking).not.toHaveBeenCalled();
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
