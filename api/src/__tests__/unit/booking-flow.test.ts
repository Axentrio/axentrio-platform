/**
 * Booking Flow Integration Test
 *
 * Simulates a full multi-turn booking conversation through the AgentService.
 * Mocks the LLM to return realistic tool-calling sequences.
 * Mocks the booking service to return realistic Cal.com responses.
 * Verifies: tool chaining, precondition enforcement, off-topic handling, trace logging.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import { ToolRegistry } from '../../agent/tool-registry';
import { PromptBuilder } from '../../agent/prompt-builder';
import { MeteringService } from '../../agent/metering.service';
import { TraceLogger } from '../../agent/trace-logger';
import type { LLMResponse } from '../../llm/llm.types';
import type { Tenant } from '../../database/entities/Tenant';
import type { ChatSession } from '../../database/entities/ChatSession';

/** The slice of a TypeORM repository the agent loop touches in this test. */
interface MockRepo {
  save: Mock;
  create: Mock;
  find: Mock;
  findOne: Mock;
}

// ── Mock LLM provider ──────────────────────────────────────────────
const mockChat = vi.fn();
vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({ chat: mockChat }),
}));
vi.mock('../../billing/token-budget.service', () => ({
  isTokenBudgetExhausted: vi.fn().mockResolvedValue(false),
  recordTokenUsage: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock booking service ────────────────────────────────────────────
const mockCheckAvailability = vi.fn();
const mockCreateBooking = vi.fn();
const mockListBookings = vi.fn();
vi.mock('../../booking/booking.service', () => ({
  checkAvailability: (...args: any[]) => mockCheckAvailability(...args),
  createBooking: (...args: any[]) => mockCreateBooking(...args),
  listBookings: (...args: any[]) => mockListBookings(...args),
  rescheduleBooking: vi.fn(),
  cancelBooking: vi.fn(),
  updateBooking: vi.fn(),
}));

// ── Mock RAG service ────────────────────────────────────────────────
// Booking tools gate on resolved entitlements; resolve via the real pure
// resolver for the fixture tenant's tier (pro → bookings on).
vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../billing/entitlements')>();
  return {
    ...actual,
    getEntitlements: vi.fn(async () => actual.entitlementsFor('pro')),
  };
});

vi.mock('../../llm/rag.service', () => ({
  searchKnowledge: vi.fn().mockResolvedValue({ chunks: [], totalChunks: 0 }),
}));

// ── Mock AppDataSource (for trace logger + tool context) ────────────
// Booking must resolve CONFIGURED here (one active, online-bookable service AND an
// availability rule), otherwise the skill-state drop removes the booking tools
// before the model sees them and the flow under test never runs.
const SERVICE = {
  id: 'svc-1',
  name: 'Consult',
  bookingMode: 'auto',
  durationMin: 30,
  isActive: true,
  onlineBookable: true,
  priceDisplayType: 'none',
  customerAddressRequired: false,
};
const RULE = { timezone: 'Europe/Brussels', availabilityMode: 'business_hours', weeklyHours: {} };
vi.mock('../../database/data-source', () => {
  // One repo instance per entity: the trace assertions read back the very spy the
  // TraceLogger used, so getRepository must be stable per entity, not per call.
  const repos = new Map<string, MockRepo>();
  return {
    AppDataSource: {
      getRepository: vi.fn((entity?: { name?: string }) => {
        const name = entity?.name ?? 'AgentTrace';
        const cached = repos.get(name);
        if (cached) return cached;
        const repo: MockRepo = {
          save: vi.fn().mockResolvedValue({ id: 'trace-1' }),
          create: vi.fn().mockImplementation((data: unknown) => data),
          find: vi.fn().mockResolvedValue(name === 'ServiceType' ? [SERVICE] : []),
          findOne: vi.fn().mockResolvedValue(name === 'AvailabilityRule' ? RULE : null),
        };
        repos.set(name, repo);
        return repo;
      }),
    },
  };
});

// Multi-bot Phase 4 (#16d): AgentService now resolves bot config via the
// bot-config service. Stub it to surface the test's `tenant.settings.ai`
// and the same calcom integration so the booking tools register as usual.
vi.mock('../../services/bot-config.service', () => {
  const bot = { id: 'bot-anchor' };
  const settings = {
    ai: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      brandVoice: { name: 'ClinicBot', tone: 'friendly', customInstructions: '' },
      guardrails: {
        topicsToAvoid: [],
        escalationKeywords: [],
        confidenceThreshold: 0.7,
        maxResponseLength: 500,
        fallbackMessage: 'Let me connect you with our team.',
        greetingMessage: '',
        offHoursMessage: '',
      },
    },
    integrations: { calcom: { apiKey: 'encrypted_key', eventTypeId: 42 } },
    skills: [{
      name: 'booking',
      trigger: 'User wants to schedule an appointment',
      tools: ['check_availability', 'create_booking', 'list_bookings'],
      instructions: 'Always check availability before creating. Collect name and email.',
      maxSteps: 8,
      enabled: true,
    }],
  };
  return {
    getLlmRuntimeConfigForSession: async (_s: any) => ({
      bot,
      botSettings: settings,
      botAiSettings: settings.ai,
      apiKey: 'sk-test',
    }),
    getBotConfigForSession: async (_s: any) => ({ bot, settings }),
  };
});

// ── Test fixtures ───────────────────────────────────────────────────
const tenant: Partial<Tenant> = {
  id: 'tenant-booking-test',
  name: 'Test Clinic',
  tier: 'pro',
  settings: {
    ai: {
      enabled: true,
      provider: 'openai' as const,
      model: 'gpt-4o',
      brandVoice: { name: 'ClinicBot', tone: 'friendly', customInstructions: '' },
      guardrails: {
        topicsToAvoid: [],
        escalationKeywords: [],
        confidenceThreshold: 0.7,
        maxResponseLength: 500,
        fallbackMessage: 'Let me connect you with our team.',
        greetingMessage: '',
        offHoursMessage: '',
      },
    },
    integrations: {
      calcom: { apiKey: 'encrypted_key', eventTypeId: 42 },
    },
    skills: [{
      name: 'booking',
      trigger: 'User wants to schedule an appointment',
      tools: ['check_availability', 'create_booking', 'list_bookings'],
      instructions: 'Always check availability before creating. Collect name and email.',
      maxSteps: 8,
      enabled: true,
    }],
  } as any,
};

const session: Partial<ChatSession> = {
  id: 'session-booking-test',
  tenantId: 'tenant-booking-test',
  status: 'bot' as any,
};

// ── Mock metering (no budget limit) ─────────────────────────────────
const mockRedis = {
  hincrby: vi.fn().mockResolvedValue(1),
  hgetall: vi.fn().mockResolvedValue({ total: '0' }),
  expireat: vi.fn().mockResolvedValue(1),
};

// ── Helpers ─────────────────────────────────────────────────────────
function llmTextResponse(content: string): LLMResponse {
  return {
    content,
    usage: { promptTokens: 100, completionTokens: 50 },
    finishReason: 'stop',
  };
}

function llmToolCallResponse(toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): LLMResponse {
  return {
    content: '',
    usage: { promptTokens: 100, completionTokens: 30 },
    finishReason: 'tool_calls',
    toolCalls,
  };
}

describe('Booking Flow — Full Agent Loop', () => {
  let agent: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    const registry = new ToolRegistry();
    const promptBuilder = new PromptBuilder();
    const metering = new MeteringService(mockRedis as any);
    const traceLogger = new TraceLogger();
    agent = new AgentService(registry, promptBuilder, metering, traceLogger);
  });

  it('completes a full booking: greet → check availability → collect info → create booking', async () => {
    // Turn 1: User asks to book. LLM asks when.
    mockChat.mockResolvedValueOnce(llmTextResponse(
      "I'd be happy to help you book an appointment! When would you like to come in?"
    ));

    const turn1 = await agent.run(
      'I want to book an appointment',
      session as ChatSession,
      tenant as Tenant,
      [],
    );

    expect(turn1.type).toBe('response');
    expect((turn1 as any).content).toContain('appointment');

    // Turn 2: User says "next Tuesday". LLM calls check_availability.
    mockCheckAvailability.mockResolvedValueOnce({
      // EXPLICIT UTC, as the provider always emits. Written without an offset these parsed in
      // the running machine's zone, so the same fixture produced 9:00 AM chips in Amsterdam and
      // 3:00 AM chips in Kuala Lumpur while the prose below claimed 9:00 either way.
      // 07:00Z is 09:00 in Amsterdam on 7 April 2026 (CEST).
      slots: [
        { start: '2026-04-07T07:00:00.000Z', end: '2026-04-07T07:30:00.000Z' },
        { start: '2026-04-07T08:00:00.000Z', end: '2026-04-07T08:30:00.000Z' },
        { start: '2026-04-07T12:00:00.000Z', end: '2026-04-07T12:30:00.000Z' },
      ],
      timezone: 'Europe/Amsterdam',
    });

    mockChat
      // First LLM call: decides to check availability
      .mockResolvedValueOnce(llmToolCallResponse([{
        id: 'call_avail_1',
        name: 'check_availability',
        arguments: { startDate: '2026-04-07', endDate: '2026-04-08' },
      }]))
      // Second LLM call: presents slots to user
      .mockResolvedValueOnce(llmTextResponse(
        "I found some available slots for Tuesday April 7:\n- 09:00\n- 10:00\n- 14:00\n\nWhich time works best for you?"
      ));

    const turn2 = await agent.run(
      'Next Tuesday please',
      session as ChatSession,
      tenant as Tenant,
      [
        { role: 'user', content: 'I want to book an appointment' },
        { role: 'assistant', content: "I'd be happy to help you book an appointment! When would you like to come in?" },
      ],
    );

    expect(turn2.type).toBe('response');
    expect((turn2 as any).content).toContain('09:00');
    // The chips and the prose must name the SAME times. They disagreed here for as long as this
    // test existed - the fixture's slots carried no UTC offset, so they rendered in whatever zone
    // the machine ran in while the prose claimed 9:00 regardless - and nothing compared them.
    // A customer reads the words; they can only tap the chips.
    expect((turn2 as any).quickReplies?.map((q: { title: string }) => q.title)).toEqual([
      'Tue 09:00',
      'Tue 10:00',
      'Tue 14:00',
    ]);
    // Trailing undefineds: customerAddress, then #149 locationChoice, then phone.
    expect(mockCheckAvailability).toHaveBeenCalledWith('agent', 'session-booking-test', '2026-04-07', '2026-04-08', undefined, undefined, undefined, undefined, undefined);

    // Turn 3: User picks 10am and gives info. LLM re-verifies availability then books.
    // The precondition requires check_availability in the SAME turn before create_booking.
    // This is the safe pattern: always re-check before booking (slot could have been taken).
    mockCheckAvailability.mockResolvedValueOnce({
      slots: [{ start: '2026-04-07T10:00:00', end: '2026-04-07T10:30:00' }],
      timezone: 'Europe/Amsterdam',
    });
    mockCreateBooking.mockResolvedValueOnce({
      success: true,
      booking: {
        id: 'bk_abc123',
        startTime: '2026-04-07T10:00:00',
        endTime: '2026-04-07T10:30:00',
        attendee: { name: 'Sarah Connor', email: 'sarah@example.com' },
      },
    });

    mockChat
      // First LLM call: re-checks availability for the specific slot, then books
      .mockResolvedValueOnce(llmToolCallResponse([
        {
          id: 'call_avail_2',
          name: 'check_availability',
          arguments: { startDate: '2026-04-07', endDate: '2026-04-08' },
        },
      ]))
      // Second LLM call: now creates the booking (precondition satisfied)
      .mockResolvedValueOnce(llmToolCallResponse([
        {
          id: 'call_book_1',
          name: 'create_booking',
          arguments: {
            startTime: '2026-04-07T10:00:00',
            attendeeName: 'Sarah Connor',
            attendeeEmail: 'sarah@example.com',
          },
        },
      ]))
      // Third LLM call: confirms booking to user
      .mockResolvedValueOnce(llmTextResponse(
        "Your appointment has been booked for Tuesday, April 7 at 10:00. See you then, Sarah!"
      ));

    const turn3 = await agent.run(
      "10am works. I'm Sarah Connor, sarah@example.com",
      session as ChatSession,
      tenant as Tenant,
      [
        { role: 'user', content: 'I want to book an appointment' },
        { role: 'assistant', content: "I'd be happy to help you book an appointment! When would you like to come in?" },
        { role: 'user', content: 'Next Tuesday please' },
        { role: 'assistant', content: "I found some available slots for Tuesday April 7:\n- 09:00\n- 10:00\n- 14:00\n\nWhich time works best for you?" },
      ],
    );

    expect(turn3.type).toBe('response');
    expect((turn3 as any).content).toContain('booked');
    expect((turn3 as any).content).toContain('Sarah');
    expect(mockCreateBooking).toHaveBeenCalledWith(
      'agent',
      'session-booking-test',
      expect.stringContaining('create_booking'), // idempotency key
      '2026-04-07T10:00:00',
      { name: 'Sarah Connor', email: 'sarah@example.com' },
      undefined,
      undefined,
      undefined,
      { customerAddress: undefined, customerPhone: undefined, durationMin: undefined },
    );
  });

  it('replaces a reply that names times the customer cannot actually book', async () => {
    // Seen in production: the chips carried 9:00, 9:30, 12:30, 13:00, 13:30, 14:00, 14:30, 15:00
    // while the sentence above them read "09:30, 11:30, 12:00, 12:30, 13:00, 13:30, and 14:00".
    // Two times nobody could book, three real ones missing. A tap was safe; reading the words and
    // replying "11:30 then" asked for a slot that never existed. The prompt already forbids
    // listing slots in prose — the model does it anyway, which is why this is enforced on the way
    // out rather than asked for on the way in.
    mockCheckAvailability.mockResolvedValueOnce({
      slots: [
        { start: '2026-04-07T07:00:00.000Z', end: '2026-04-07T07:30:00.000Z' },
        { start: '2026-04-07T08:00:00.000Z', end: '2026-04-07T08:30:00.000Z' },
      ],
      timezone: 'Europe/Amsterdam',
    });

    mockChat
      .mockResolvedValueOnce(
        llmToolCallResponse([
          { id: 'call_avail_x', name: 'check_availability', arguments: { startDate: '2026-04-07', endDate: '2026-04-08' } },
        ]),
      )
      // 11:30 was never offered; 9:00 and 10:00 were.
      .mockResolvedValueOnce(llmTextResponse('I have 9:00 AM, 10:00 AM and 11:30 AM free. Which suits?'));

    const turn = await agent.run(
      'Next Tuesday please',
      session as ChatSession,
      tenant as Tenant,
      [],
    );

    expect(turn.type).toBe('response');
    // Replaced wholesale rather than edited: removing the time leaves grammar nobody wrote, and
    // correcting it means guessing which offered slot was meant.
    expect((turn as any).content).not.toContain('11:30');
    expect((turn as any).content).toBe('Here are the times I have available — let me know which one suits you.');
    // ...and the real times still reach the customer, because the chips were never the problem.
    expect((turn as any).quickReplies?.map((q: { title: string }) => q.title)).toEqual([
      'Tue 09:00',
      'Tue 10:00',
    ]);
  });

  it('allows create_booking directly (precondition removed, handled by skill instructions)', async () => {
    // LLM calls create_booking directly — no hard precondition blocks it
    mockCreateBooking.mockResolvedValueOnce({
      success: true,
      booking: { id: 'bk_direct', startTime: '2026-04-07T10:00:00', attendee: { name: 'John', email: 'john@test.com' } },
    });

    mockChat
      .mockResolvedValueOnce(llmToolCallResponse([{
        id: 'call_book_direct',
        name: 'create_booking',
        arguments: {
          startTime: '2026-04-07T10:00:00',
          attendeeName: 'John',
          attendeeEmail: 'john@test.com',
        },
      }]))
      .mockResolvedValueOnce(llmTextResponse(
        "Your appointment is booked for tomorrow at 10am!"
      ));

    const result = await agent.run(
      'Book me for tomorrow at 10am, John, john@test.com',
      session as ChatSession,
      tenant as Tenant,
      [],
    );

    expect(result.type).toBe('response');
    // create_booking SHOULD have been called (no precondition blocking it)
    expect(mockCreateBooking).toHaveBeenCalled();
  });

  it('handles user going off-topic mid-booking flow', async () => {
    // User was in booking flow but asks an unrelated question
    mockChat.mockResolvedValueOnce(llmTextResponse(
      "Our office is open Monday to Friday, 9 AM to 5 PM. Would you still like to book that appointment?"
    ));

    const result = await agent.run(
      "Actually, what are your opening hours?",
      session as ChatSession,
      tenant as Tenant,
      [
        { role: 'user', content: 'I want to book an appointment' },
        { role: 'assistant', content: "When would you like to come in?" },
      ],
    );

    expect(result.type).toBe('response');
    expect((result as any).content).toContain('open');
    // No tools should be called for a simple FAQ
    expect(mockCheckAvailability).not.toHaveBeenCalled();
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  /**
   * A named date declared shut when nothing looked.
   *
   * Production, in Dutch: asked for Wednesday 16 September, the bot answered that the date
   * "valt op een sluitingsdag" and offered to submit a manual request. The trace for that turn
   * holds ZERO tool calls, and the day had sixteen free slots. Every other availability guard
   * reads a `check_availability` result, so a turn that never called it is the one turn none of
   * them can judge - which is why the sentence shipped.
   */
  it('will not ship a dated "we are closed" the model never checked', async () => {
    mockChat
      .mockResolvedValueOnce(llmTextResponse(
        'Woensdag 16 september valt op een sluitingsdag; wil je toch een aanvraag indienen voor 10:00?',
      ))
      // The nudge lands: the model looks, and answers from what it found.
      .mockResolvedValueOnce(llmToolCallResponse([{
        id: 'call_avail_16',
        name: 'check_availability',
        arguments: { startDate: '2026-09-16', endDate: '2026-09-16' },
      }]))
      .mockResolvedValueOnce(llmTextResponse('Woensdag 16 september kan om 10:00. Zal ik die vastleggen?'));

    const result = await agent.run(
      'Ik wil een afspraak op woensdag 16 september 2026 om 10:00.',
      session as ChatSession,
      tenant as Tenant,
      [],
    );

    // The hallucination is gone, and the reply is the one made after looking.
    expect((result as any).content).not.toMatch(/sluitingsdag/);
    expect((result as any).content).toContain('10:00');
    expect(mockCheckAvailability).toHaveBeenCalled();
    // The model was told WHY, not merely asked again.
    const nudged = mockChat.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(nudged.some((m) => /did not call check_availability this turn/.test(String(m.content)))).toBe(true);
  });

  it('says nothing about a generic opening-hours answer, which needs no tool', async () => {
    // The false positive that would make the guard unusable: hours live in the prompt, so
    // answering from them is the bot doing its job. One LLM call, no nudge.
    mockChat.mockResolvedValueOnce(llmTextResponse('Op zondag zijn we gesloten. Kan ik je op een andere dag helpen?'));

    const result = await agent.run(
      'Zijn jullie open op zondag?',
      session as ChatSession,
      tenant as Tenant,
      [],
    );

    expect((result as any).content).toContain('gesloten');
    expect(mockChat).toHaveBeenCalledOnce();
  });

  it('records the correction on the trace, so the guard is observable in production', async () => {
    // The trigger is a model misbehaviour nobody can summon on demand, so a live reproduction
    // is not available to prove this guard works in the wild. A counter that goes up is.
    const { AppDataSource } = await import('../../database/data-source');
    const mockRepo = (AppDataSource as any).getRepository();

    mockChat
      .mockResolvedValueOnce(llmTextResponse('Op 16 september zijn we gesloten.'))
      .mockResolvedValueOnce(llmTextResponse('Even kijken wanneer het wel kan.'));

    await agent.run(
      'Kan ik op 16 september 2026 terecht?',
      session as ChatSession,
      tenant as Tenant,
      [],
    );

    const savedTrace = mockRepo.create.mock.calls[0][0];
    expect(savedTrace.trace.corrections).toEqual(['availability_unchecked_claim']);
  });

  it('handles Cal.com API failure gracefully', async () => {
    // check_availability fails (Cal.com is down)
    mockCheckAvailability.mockRejectedValueOnce(new Error('Cal.com is currently unavailable'));

    mockChat
      .mockResolvedValueOnce(llmToolCallResponse([{
        id: 'call_avail_fail',
        name: 'check_availability',
        arguments: { startDate: '2026-04-07', endDate: '2026-04-08' },
      }]))
      // LLM gets the error result, tells user gracefully
      .mockResolvedValueOnce(llmTextResponse(
        "I'm having trouble checking our schedule right now. Could you try again in a few minutes, or would you like me to connect you with our team?"
      ));

    const result = await agent.run(
      'Can I book for next Tuesday?',
      session as ChatSession,
      tenant as Tenant,
      [],
    );

    expect(result.type).toBe('response');
    expect((result as any).content).toContain('trouble');
  });

  it('records complete trace for multi-tool booking flow', async () => {
    const { AppDataSource } = await import('../../database/data-source');
    const mockRepo = (AppDataSource as any).getRepository();

    mockCheckAvailability.mockResolvedValueOnce({
      slots: [{ start: '2026-04-07T10:00:00', end: '2026-04-07T10:30:00' }],
      timezone: 'UTC',
    });

    mockChat
      .mockResolvedValueOnce(llmToolCallResponse([{
        id: 'call_a1',
        name: 'check_availability',
        arguments: { startDate: '2026-04-07', endDate: '2026-04-08' },
      }]))
      .mockResolvedValueOnce(llmTextResponse('Here are the slots...'));

    await agent.run(
      'Check availability for next Tuesday',
      session as ChatSession,
      tenant as Tenant,
      [],
    );

    // Trace should have been saved
    expect(mockRepo.create).toHaveBeenCalled();
    const savedTrace = mockRepo.create.mock.calls[0][0];
    expect(savedTrace.tenantId).toBe('tenant-booking-test');
    expect(savedTrace.sessionId).toBe('session-booking-test');
    expect(savedTrace.finishReason).toBe('completed');
    expect(savedTrace.totalTokens).toBeGreaterThan(0);

    // Trace should contain the tool call
    const iterations = savedTrace.trace.iterations;
    expect(iterations).toHaveLength(2); // two LLM calls
    expect(iterations[0].toolCalls).toHaveLength(1);
    expect(iterations[0].toolCalls[0].name).toBe('check_availability');
    expect(iterations[0].toolCalls[0].result.success).toBe(true);
  });

  it('metering records tokens for each LLM call in the loop', async () => {
    mockCheckAvailability.mockResolvedValueOnce({ slots: [], timezone: 'UTC' });

    mockChat
      .mockResolvedValueOnce(llmToolCallResponse([{
        id: 'call_m1',
        name: 'check_availability',
        arguments: { startDate: '2026-04-07', endDate: '2026-04-08' },
      }]))
      .mockResolvedValueOnce(llmTextResponse('No slots available.'));

    await agent.run('Check next Tuesday', session as ChatSession, tenant as Tenant, []);

    // Should have recorded usage for both LLM calls
    expect(mockRedis.hincrby).toHaveBeenCalled();
    // 4 hincrby calls per LLM call (prompt, completion, total, calls) × 2 calls = 8
    const totalHincrby = mockRedis.hincrby.mock.calls.length;
    expect(totalHincrby).toBe(8);
  });
});
