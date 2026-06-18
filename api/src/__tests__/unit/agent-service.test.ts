import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { LLMProvider } from '../../llm/llm.types';

// Create mock dependencies
const mockProvider: LLMProvider = {
  chat: vi.fn(),
};

const mockGetProvider = vi.fn().mockReturnValue(mockProvider);
vi.mock('../../llm/provider-factory', () => ({
  getProvider: (...args: any[]) => mockGetProvider(...args),
}));

// run() loads the active services catalog for the prompt; stub the repo.
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ find: async () => [] }) },
}));

// Multi-bot Phase 4 (#16d): AgentService.run resolves bot config via the
// bot-config service (hits the DB). Stub the resolvers so each test's
// in-memory tenant.settings.ai is what reaches the LLM call.
vi.mock('../../services/bot-config.service', () => ({
  // AgentService.run resolves bot row + settings + AI slice + apiKey from a
  // single getLlmRuntimeConfigForSession call. The behavioural slice + apiKey
  // both come from the seeded `tenant.settings.ai`.
  getLlmRuntimeConfigForSession: async (_session: any) => ({
    bot: { id: 'bot-anchor' } as any,
    botSettings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } as any,
    botAiSettings: { enabled: true, provider: 'openai', model: 'gpt-4o' } as any,
    apiKey: 'sk-test',
  }),
  getBotConfigForSession: async (_session: any) => ({
    bot: { id: 'bot-anchor' } as any,
    settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } as any,
  }),
}));

const mockMeteringRecord = vi.fn();
const mockMeteringIsOverBudget = vi.fn().mockResolvedValue(false);
const mockMetering = { record: mockMeteringRecord, isOverBudget: mockMeteringIsOverBudget };

const mockTraceSave = vi.fn();
const mockTraceLogger = { save: mockTraceSave };

const mockKbSearch: ToolAdapter = {
  name: 'kb_search',
  description: 'Search KB',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  hasSideEffects: false,
  execute: vi.fn().mockResolvedValue({ success: true, data: { chunks: [] } }),
};

const mockGetToolsForTenant = vi.fn().mockResolvedValue([mockKbSearch]);
const mockToolRegistry = { getToolsForTenant: mockGetToolsForTenant, getBuiltinToolNames: vi.fn() };

const mockPromptBuilder = { build: vi.fn().mockReturnValue('You are TestBot.') };

describe('AgentService', () => {
  let agent: AgentService;

  beforeEach(() => {
    agent = new AgentService(
      mockToolRegistry as any,
      mockPromptBuilder as any,
      mockMetering as any,
      mockTraceLogger as any,
    );
    vi.clearAllMocks();
    mockMeteringIsOverBudget.mockResolvedValue(false);
  });

  it('returns a text response when LLM finishes with stop', async () => {
    (mockProvider.chat as any).mockResolvedValue({
      content: 'Hello! How can I help?',
      usage: { promptTokens: 50, completionTokens: 20 },
      finishReason: 'stop',
    });

    const result = await agent.run(
      'hi',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') expect(result.content).toBe('Hello! How can I help?');
    expect(mockMeteringRecord).toHaveBeenCalled();
    expect(mockTraceSave).toHaveBeenCalled();
  });

  it('attaches an image to the live user turn as a multimodal message', async () => {
    (mockProvider.chat as any).mockResolvedValue({
      content: 'That looks like a cat.',
      usage: { promptTokens: 50, completionTokens: 20 },
      finishReason: 'stop',
    });

    await agent.run(
      'What is in this picture?',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
      [{ mimeType: 'image/jpeg', data: 'BASE64DATA' }],
    );

    const sentMessages = (mockProvider.chat as any).mock.calls[0][0];
    const userMsg = sentMessages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toEqual([
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', mimeType: 'image/jpeg', data: 'BASE64DATA' },
    ]);
  });

  it('sends an image-only turn (no caption) as a single image part', async () => {
    (mockProvider.chat as any).mockResolvedValue({
      content: 'Nice photo!',
      usage: { promptTokens: 50, completionTokens: 20 },
      finishReason: 'stop',
    });

    await agent.run(
      '',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
      [{ mimeType: 'image/png', data: 'PNGDATA' }],
    );

    const sentMessages = (mockProvider.chat as any).mock.calls[0][0];
    const userMsg = sentMessages.find((m: any) => Array.isArray(m.content));
    expect(userMsg.content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'PNGDATA' }]);
  });

  it('keeps the live turn a plain string when no images are attached', async () => {
    (mockProvider.chat as any).mockResolvedValue({
      content: 'Hi!',
      usage: { promptTokens: 10, completionTokens: 5 },
      finishReason: 'stop',
    });

    await agent.run(
      'hello',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    const sentMessages = (mockProvider.chat as any).mock.calls[0][0];
    const userMsg = sentMessages[sentMessages.length - 1];
    expect(userMsg).toEqual({ role: 'user', content: 'hello' });
  });

  it('executes tool calls and loops back to LLM', async () => {
    // First call: LLM wants to use kb_search
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'kb_search', arguments: { query: 'pricing' } }],
      })
      // Second call: LLM gives final answer
      .mockResolvedValueOnce({
        content: 'Our pricing starts at $29/mo.',
        usage: { promptTokens: 100, completionTokens: 30 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'what is your pricing?',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') expect(result.content).toBe('Our pricing starts at $29/mo.');
    expect(mockKbSearch.execute).toHaveBeenCalledWith(
      { query: 'pricing' },
      expect.objectContaining({ tenantId: 't1', sessionId: 's1' }),
    );
    expect(mockMeteringRecord).toHaveBeenCalledTimes(2); // two LLM calls
  });

  it('#7: dedupes a side-effecting tool called twice with identical args in one run', async () => {
    const sideEffectExec = vi.fn().mockResolvedValue({ success: true, data: { ok: true } });
    const sideTool: ToolAdapter = {
      name: 'create_booking',
      description: 'book',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: true,
      execute: sideEffectExec,
    };
    mockGetToolsForTenant.mockResolvedValue([sideTool]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'tc_1', name: 'create_booking', arguments: { startTime: '2026-04-01T10:00:00Z' } },
          { id: 'tc_2', name: 'create_booking', arguments: { startTime: '2026-04-01T10:00:00Z' } }, // identical → must dedupe
        ],
      })
      .mockResolvedValueOnce({ content: 'Booked!', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });

    await agent.run(
      'book it',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(sideEffectExec).toHaveBeenCalledTimes(1); // second identical side-effect call skipped
  });

  it('R31: sanitizes an unexpected tool exception before it reaches the model', async () => {
    const RAW = 'connection to 10.0.0.5:5432 failed: password authentication failed for user "secret"';
    const throwingTool: ToolAdapter = {
      name: 'kb_search',
      description: 'Search KB',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      hasSideEffects: false,
      execute: vi.fn().mockRejectedValue(new Error(RAW)),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([throwingTool]);

    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'kb_search', arguments: { query: 'pricing' } }],
      })
      .mockResolvedValueOnce({
        content: "Sorry, I'm having trouble — let me connect you with someone.",
        usage: { promptTokens: 100, completionTokens: 20 },
        finishReason: 'stop',
      });

    await agent.run(
      'pricing?',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    // The tool result fed back to the model on the 2nd call must be sanitized:
    // no raw exception text (host/credentials), just a generic unavailable note.
    const secondCallMessages = (mockProvider.chat as any).mock.calls[1][0];
    const toolMsg = secondCallMessages.find((m: any) => m.role === 'tool' && m.toolCallId === 'tc_1');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.content).not.toContain('password');
    expect(toolMsg.content).not.toContain('10.0.0.5');
    expect(toolMsg.content).toContain('temporarily unavailable');
  });

  it('R31: sanitizes an UNMARKED returned tool error before it reaches the model', async () => {
    const RAW = 'duplicate key value violates unique constraint "leads_pkey" at 10.0.0.5';
    const leakyTool: ToolAdapter = {
      name: 'kb_search', description: 'Search KB',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({ success: false, error: RAW }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([leakyTool]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({ content: '', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'tool_calls', toolCalls: [{ id: 'tc_1', name: 'kb_search', arguments: {} }] })
      .mockResolvedValueOnce({ content: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });

    await agent.run('x', { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any, []);

    const toolMsg = (mockProvider.chat as any).mock.calls[1][0].find((m: any) => m.role === 'tool');
    expect(toolMsg.content).not.toContain('duplicate key');
    expect(toolMsg.content).not.toContain('10.0.0.5');
    expect(toolMsg.content).toContain("couldn't complete");
  });

  it('R31: preserves a tool-authored domain error marked errorSafeForModel', async () => {
    const domainTool: ToolAdapter = {
      name: 'check_availability', description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({ success: false, error: 'NO_AVAILABILITY: no slots that day', errorSafeForModel: true }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([domainTool]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({ content: '', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'tool_calls', toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: {} }] })
      .mockResolvedValueOnce({ content: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });

    await agent.run('x', { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any, []);

    const toolMsg = (mockProvider.chat as any).mock.calls[1][0].find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('NO_AVAILABILITY');
  });

  it('attaches slot chips (quickReplies) when check_availability offers slots', async () => {
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: {
          slots: [
            { start: '2026-06-10T08:00:00.000Z', end: '2026-06-10T08:30:00.000Z' },
            { start: '2026-06-10T09:00:00.000Z', end: '2026-06-10T09:30:00.000Z' },
          ],
          timezone: 'UTC',
        },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);

    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: 'x', endDate: 'y' } }],
      })
      .mockResolvedValueOnce({
        content: 'Here are some available times:',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'when can I book?',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.quickReplies).toBeDefined();
      expect(result.quickReplies).toHaveLength(2);
      expect(result.quickReplies![0]).toHaveProperty('title');
      expect(result.quickReplies![0]).toHaveProperty('value');
      // value carries the absolute date+time+tz so the next turn can re-book it
      expect(result.quickReplies![0].value).toContain('10 June');
      expect(result.quickReplies![0].value).toContain('UTC');
    }
  });

  it('embeds the service name in slot chips when check_availability returns one', async () => {
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: {
          slots: [{ start: '2026-06-10T08:00:00.000Z', end: '2026-06-10T08:30:00.000Z' }],
          timezone: 'UTC',
          serviceName: 'Mens Haircut',
        },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: 'x', endDate: 'y', serviceId: 'svc-1' } }],
      })
      .mockResolvedValueOnce({
        content: 'Here are some times:',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'book a haircut',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.quickReplies![0].value).toContain('Mens Haircut');
    }
  });

  it('drops slot chips once a booking is created in the same run', async () => {
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots: [{ start: '2026-06-10T08:00:00.000Z', end: '2026-06-10T08:30:00.000Z' }], timezone: 'UTC' },
      }),
    };
    const createBooking: ToolAdapter = {
      name: 'create_booking',
      description: 'Book',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: true,
      execute: vi.fn().mockResolvedValue({ success: true, data: { booking: { id: 'b1' } } }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability, createBooking]);

    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 60, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_2', name: 'create_booking', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: 'You are booked!',
        usage: { promptTokens: 70, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'book the 8am',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') expect(result.quickReplies).toBeUndefined();
  });

  it('drops slot chips once a request is captured in the same run', async () => {
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots: [{ start: '2026-06-10T08:00:00.000Z', end: '2026-06-10T08:30:00.000Z' }], timezone: 'UTC' },
      }),
    };
    const requestAppointment: ToolAdapter = {
      name: 'request_appointment',
      description: 'Request',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: true,
      execute: vi.fn().mockResolvedValue({ success: true, data: { requested: true, booking: { id: 'r1' } } }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability, requestAppointment]);

    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 60, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_2', name: 'request_appointment', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: "I've sent your request to the owner.",
        usage: { promptTokens: 70, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'request the 8am',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') expect(result.quickReplies).toBeUndefined();
  });

  it('enforces preconditions — blocks tool if prerequisite not called', async () => {
    const createBooking: ToolAdapter = {
      name: 'create_booking',
      description: 'Create booking',
      parameters: {},
      hasSideEffects: true,
      preconditions: { toolsCalled: ['check_availability'] },
      execute: vi.fn(),
    };
    mockGetToolsForTenant.mockResolvedValue([createBooking]);

    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'create_booking', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: 'I need to check availability first.',
        usage: { promptTokens: 80, completionTokens: 15 },
        finishReason: 'stop',
      });

    await agent.run(
      'book me in',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    // create_booking should NOT have been called
    expect(createBooking.execute).not.toHaveBeenCalled();
  });

  it('returns budget_exceeded when over budget', async () => {
    mockMeteringIsOverBudget.mockResolvedValue(true);

    const result = await agent.run(
      'hi',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      {
        id: 't1',
        settings: {
          ai: {
            enabled: true, provider: 'openai', model: 'gpt-4o', dailyTokenBudget: 1000,
            guardrails: { fallbackMessage: 'Budget reached.' },
          },
        },
      } as any,
      [],
    );

    expect(result.type).toBe('budget_exceeded');
  });
});
