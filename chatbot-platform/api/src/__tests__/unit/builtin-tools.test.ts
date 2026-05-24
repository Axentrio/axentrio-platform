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

vi.mock('../../n8n/booking.service', () => ({
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

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { KbSearchTool } from '../../agent/tools/kb-search.tool';
import {
  CheckAvailabilityTool,
  CreateBookingTool,
  ListBookingsTool,
  RescheduleBookingTool,
  CancelBookingTool,
} from '../../agent/tools/booking.tool';
import { EscalationTool } from '../../agent/tools/escalation.tool';
import type { ToolAdapter, ToolContext } from '../../agent/tool-adapter';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 'tenant-123',
    sessionId: 'session-abc',
    runId: 'run-xyz',
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
    );
  });

  it('execute returns success=false with error on failure', async () => {
    const tool = new KbSearchTool();
    mockSearchKnowledge.mockRejectedValue(new Error('DB connection failed'));

    const result = await tool.execute({ query: 'test' }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toBe('DB connection failed');
  });
});

describe('CheckAvailabilityTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has correct name and hasSideEffects=false', () => {
    const tool = new CheckAvailabilityTool();
    expect(tool.name).toBe('check_availability');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('execute calls checkAvailability with sessionId, startDate, endDate', async () => {
    const tool = new CheckAvailabilityTool();
    const ctx = makeCtx({ sessionId: 'sess-1' });
    const slots = { slots: [{ start: '2026-04-01T10:00:00Z', end: '2026-04-01T10:30:00Z' }], timezone: 'UTC' };
    mockCheckAvailability.mockResolvedValue(slots);

    const result = await tool.execute({ startDate: '2026-04-01', endDate: '2026-04-07' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(slots);
    expect(mockCheckAvailability).toHaveBeenCalledWith('sess-1', '2026-04-01', '2026-04-07');
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
  beforeEach(() => vi.clearAllMocks());

  it('has hasSideEffects=true', () => {
    const tool = new CreateBookingTool();
    expect(tool.hasSideEffects).toBe(true);
  });

  it('has no hard preconditions (handled by skill instructions instead)', () => {
    const tool = new CreateBookingTool() as ToolAdapter;
    expect(tool.preconditions).toBeUndefined();
  });

  it('generates idempotency key from runId', async () => {
    const tool = new CreateBookingTool();
    const ctx = makeCtx({ runId: 'run-abc', sessionId: 'sess-1' });
    mockCreateBooking.mockResolvedValue({ success: true, booking: { id: 'bk-1' } });

    await tool.execute(
      { startTime: '2026-04-01T10:00:00Z', attendeeName: 'Alice', attendeeEmail: 'alice@test.com' },
      ctx
    );

    expect(mockCreateBooking).toHaveBeenCalledWith(
      'sess-1',
      'run-abc:create_booking:2026-04-01T10:00:00Z',
      '2026-04-01T10:00:00Z',
      { name: 'Alice', email: 'alice@test.com' },
      undefined
    );
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
      'sess-2',
      'run-xyz:create_booking:2026-04-02T09:00:00Z',
      '2026-04-02T09:00:00Z',
      { name: 'Bob', email: 'bob@test.com' },
      'Need consultation'
    );
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
    expect(mockListBookings).toHaveBeenCalledWith('sess-3', 'user@test.com');
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
    expect(mockRescheduleBooking).toHaveBeenCalledWith('sess-4', 'bk-3', '2026-04-10T14:00:00Z');
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
    expect(mockCancelBooking).toHaveBeenCalledWith('sess-5', 'bk-4', 'Not needed');
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

  it('execute returns escalated=true with reason and session context', async () => {
    const tool = new EscalationTool();
    const ctx = makeCtx({ sessionId: 'sess-6', tenantId: 'tenant-456' });

    const result = await tool.execute({ reason: 'Cannot resolve customer issue' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as any).escalated).toBe(true);
    expect((result.data as any).reason).toBe('Cannot resolve customer issue');
    expect((result.data as any).sessionId).toBe('sess-6');
    expect((result.data as any).tenantId).toBe('tenant-456');
  });
});
