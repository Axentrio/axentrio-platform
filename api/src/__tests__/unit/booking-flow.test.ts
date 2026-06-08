/**
 * Booking Flow Integration Test
 *
 * Simulates a full multi-turn booking conversation through the AgentService.
 * Mocks the LLM to return realistic tool-calling sequences.
 * Mocks the booking service to return realistic Cal.com responses.
 * Verifies: tool chaining, precondition enforcement, off-topic handling, trace logging.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import { ToolRegistry } from '../../agent/tool-registry';
import { PromptBuilder } from '../../agent/prompt-builder';
import { MeteringService } from '../../agent/metering.service';
import { TraceLogger } from '../../agent/trace-logger';
import type { LLMResponse } from '../../llm/llm.types';
import type { Tenant } from '../../database/entities/Tenant';
import type { ChatSession } from '../../database/entities/ChatSession';

// ── Mock LLM provider ──────────────────────────────────────────────
const mockChat = vi.fn();
vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({ chat: mockChat }),
}));

// ── Mock booking service ────────────────────────────────────────────
const mockCheckAvailability = vi.fn();
const mockCreateBooking = vi.fn();
const mockListBookings = vi.fn();
vi.mock('../../n8n/booking.service', () => ({
  checkAvailability: (...args: any[]) => mockCheckAvailability(...args),
  createBooking: (...args: any[]) => mockCreateBooking(...args),
  listBookings: (...args: any[]) => mockListBookings(...args),
  rescheduleBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));

// ── Mock RAG service ────────────────────────────────────────────────
vi.mock('../../llm/rag.service', () => ({
  searchKnowledge: vi.fn().mockResolvedValue({ chunks: [], totalChunks: 0 }),
}));

// ── Mock AppDataSource (for trace logger + tool context) ────────────
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn().mockReturnValue({
      save: vi.fn().mockResolvedValue({ id: 'trace-1' }),
      create: vi.fn().mockImplementation((data: any) => data),
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
    }),
  },
}));

// Multi-bot Phase 4 (#16d): AgentService now resolves bot config via the
// bot-config service. Stub it to surface the test's `tenant.settings.ai`
// and the same calcom integration so the booking tools register as usual.
vi.mock('../../services/bot-config.service', () => ({
  getLlmRuntimeConfigForSession: async (_s: any) => ({
    botAiSettings: {
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
    apiKey: 'sk-test',
  }),
  getBotConfigForSession: async (_s: any) => ({
    bot: { id: 'bot-anchor' },
    settings: {
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
    },
  }),
}));

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
      slots: [
        { start: '2026-04-07T09:00:00', end: '2026-04-07T09:30:00' },
        { start: '2026-04-07T10:00:00', end: '2026-04-07T10:30:00' },
        { start: '2026-04-07T14:00:00', end: '2026-04-07T14:30:00' },
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
        "I found some available slots for Tuesday April 7:\n- 9:00 AM\n- 10:00 AM\n- 2:00 PM\n\nWhich time works best for you?"
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
    expect((turn2 as any).content).toContain('9:00 AM');
    expect(mockCheckAvailability).toHaveBeenCalledWith('session-booking-test', '2026-04-07', '2026-04-08', undefined);

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
        "Your appointment has been booked for Tuesday, April 7 at 10:00 AM. See you then, Sarah!"
      ));

    const turn3 = await agent.run(
      "10am works. I'm Sarah Connor, sarah@example.com",
      session as ChatSession,
      tenant as Tenant,
      [
        { role: 'user', content: 'I want to book an appointment' },
        { role: 'assistant', content: "I'd be happy to help you book an appointment! When would you like to come in?" },
        { role: 'user', content: 'Next Tuesday please' },
        { role: 'assistant', content: "I found some available slots for Tuesday April 7:\n- 9:00 AM\n- 10:00 AM\n- 2:00 PM\n\nWhich time works best for you?" },
      ],
    );

    expect(turn3.type).toBe('response');
    expect((turn3 as any).content).toContain('booked');
    expect((turn3 as any).content).toContain('Sarah');
    expect(mockCreateBooking).toHaveBeenCalledWith(
      'session-booking-test',
      expect.stringContaining('create_booking'), // idempotency key
      '2026-04-07T10:00:00',
      { name: 'Sarah Connor', email: 'sarah@example.com' },
      undefined,
      undefined,
      undefined,
    );
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
