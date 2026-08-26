import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { LLMProvider } from '../../llm/llm.types';
import { createBlockLedger } from '../../llm/block-ledger';

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

// A guard replacement is said in the CUSTOMER's language. Identity here, and spied on, so the
// chained `mockProvider.chat` responses each test sets up are not consumed by the localizer.
const mockLocalize = vi.fn(async (message: string, _customerText: string, _session: unknown) => message);
vi.mock('../../llm/localize', () => ({
  localizeMessage: (...args: [string, string, unknown]) => mockLocalize(...args),
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

// Mock ledger mirrors the loaded tools (mockGetToolsForTenant returns kb_search)
// so the persisted trace's allowedTools reflects the real pipeline.
const mockPromptBuilder = { build: vi.fn().mockReturnValue({ prompt: 'You are TestBot.', ledger: createBlockLedger(['kb_search']) }) };

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
    mockGetToolsForTenant.mockResolvedValue([mockKbSearch]);
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

  it('persists the prompt-build ledger on the saved trace', async () => {
    (mockProvider.chat as any).mockResolvedValue({
      content: 'Hi.',
      usage: { promptTokens: 5, completionTokens: 2 },
      finishReason: 'stop',
    });

    await agent.run(
      'hi',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    const savedTrace = mockTraceSave.mock.calls.at(-1)?.[0];
    expect(savedTrace.prompt).toBeDefined();
    expect(Array.isArray(savedTrace.prompt.includedBlocks)).toBe(true);
    expect(Array.isArray(savedTrace.prompt.excludedBlocks)).toBe(true);
    expect(savedTrace.prompt.allowedTools).toContain('kb_search');
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
        availability: {
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
      // value carries the absolute date+time so the next turn can re-book it;
      // IANA timezone stays off the customer-visible bubble (slot ISO + tool JSON
      // identify the slot).
      expect(result.quickReplies![0].value).toContain('10 June');
      expect(result.quickReplies![0].value).toContain('8:00 AM');
      expect(result.quickReplies![0].value).not.toContain('UTC');
      expect(result.quickReplies![0].value).not.toMatch(/\([A-Za-z]+\/[A-Za-z_]+\)/);
    }
  });

  it('does not attach slot chips when the reply confirms the one time the customer named', async () => {
    // WhatsApp production: customer asked for Monday 10:00, the bot confirmed 10:00 is free,
    // then still attached Mon 9:00 / 9:30 / 10:00. Tapping 10:00 looped the same question.
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: {
          slots: [
            { start: '2026-10-05T07:00:00.000Z', end: '2026-10-05T07:30:00.000Z' },
            { start: '2026-10-05T07:30:00.000Z', end: '2026-10-05T08:00:00.000Z' },
            { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T08:30:00.000Z' },
          ],
          timezone: 'Europe/Brussels',
        },
        availability: {
          slots: [
            { start: '2026-10-05T07:00:00.000Z', end: '2026-10-05T07:30:00.000Z' },
            { start: '2026-10-05T07:30:00.000Z', end: '2026-10-05T08:00:00.000Z' },
            { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T08:30:00.000Z' },
          ],
          timezone: 'Europe/Brussels',
        },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-10-05', endDate: '2026-10-05' } }],
      })
      .mockResolvedValueOnce({
        content: 'Maandag 5 oktober 2026 om 10:00 is beschikbaar. Zal ik deze afspraak bevestigen?',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'Kan ik maandag 5 oktober 2026 om 10:00 langskomen?',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.quickReplies).toBeUndefined();
    }
  });

  it('replaces a reply that recommends ONE time nobody offered, and keeps the chips', async () => {
    // THE REPORTED FAILURE, end to end. Brussels, 09:00-17:00, 60 minutes with a 15-minute
    // pre-buffer and a 09:45 appointment in the way: the engine offers 10:30, 11:00 and 11:30.
    // Asked for the next valid time, the model answered "08:30" - the first slot's UTC instant,
    // read as a wall clock, half an hour before the business opens - beside chips saying 10:30.
    // The enumeration guard stands down on one time, so this sentence shipped.
    const slots = [
      { start: '2026-10-09T08:30:00.000Z', end: '2026-10-09T09:30:00.000Z' },
      { start: '2026-10-09T09:00:00.000Z', end: '2026-10-09T10:00:00.000Z' },
      { start: '2026-10-09T09:30:00.000Z', end: '2026-10-09T10:30:00.000Z' },
    ];
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots, timezone: 'Europe/Brussels' },
        availability: { slots, timezone: 'Europe/Brussels' },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    vi.mocked(mockProvider.chat)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-10-09', endDate: '2026-10-09' } }],
      })
      .mockResolvedValueOnce({
        content: 'Het eerstvolgende geldige tijdstip is vrijdag 9 oktober 2026 om 08:30, voor 60 minuten.',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'Als 10:00 niet kan, geef mij het eerstvolgende geldige tijdstip.',
      // Partial fixtures, cast once with a reason: `run` reads only the fields set here.
      { id: 's1', tenantId: 't1', status: 'bot' } as unknown as Parameters<typeof agent.run>[1],
      {
        id: 't1',
        settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
      } as unknown as Parameters<typeof agent.run>[2],
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.content).not.toContain('08:30');
      expect(result.content).toMatch(/not available/i);
      // The chips were never wrong, and they are the customer's way out of this turn.
      expect(result.quickReplies).toHaveLength(3);
      expect(result.quickReplies![0].title).toContain('10:30');
    }
  });

  it("answers the customer's own unbookable hour, in their language", async () => {
    // FOUND LIVE ON PRODUCTION, 2026-08-26, driving the real widget. A half-hour diary was asked
    // for 09:15. The reply named 09:15 plus real alternatives, the enumeration guard replaced it -
    // correctly, since a reply naming three hours could just as easily have been "09:15 is vrij,
    // net als 09:00 en 09:30", and no allowlist can tell a refusal from a confirmation - but what
    // shipped was an English sentence into a Dutch conversation, pointing at a list as if the
    // question had never been asked. Their own hour picks the sharper sentence, and the
    // replacement goes through the localizer.
    const slots = [
      { start: '2026-09-02T07:00:00.000Z', end: '2026-09-02T07:30:00.000Z' },
      { start: '2026-09-02T07:30:00.000Z', end: '2026-09-02T08:00:00.000Z' },
    ];
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots, timezone: 'Europe/Brussels' },
        availability: { slots, timezone: 'Europe/Brussels' },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    vi.mocked(mockProvider.chat)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-09-02', endDate: '2026-09-02' } }],
      })
      .mockResolvedValueOnce({
        content: '09:15 kan helaas niet, wel 09:00 of 09:30. Wat past het beste?',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'Kan het om 09:15 op woensdag 2 september 2026?',
      // Partial fixtures, cast once with a reason: `run` reads only the fields set here.
      { id: 's1', tenantId: 't1', status: 'bot' } as unknown as Parameters<typeof agent.run>[1],
      {
        id: 't1',
        settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
      } as unknown as Parameters<typeof agent.run>[2],
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      // Replaced, because the guard cannot read intent from three named hours.
      expect(result.content).not.toContain('09:15 kan helaas niet');
      // Their hour is the subject, so it is answered rather than pointed past.
      expect(result.content).toMatch(/^That time is not available/);
      expect(result.quickReplies).toHaveLength(2);
      // Said in the customer's language: the canned English text goes through the localizer with
      // the customer's own message as the sample.
      expect(mockLocalize).toHaveBeenCalledWith(
        expect.stringMatching(/^That time is not available/),
        'Kan het om 09:15 op woensdag 2 september 2026?',
        expect.objectContaining({ id: 's1' }),
      );
    }
  });

  it('points at the list when the invented hour was nobody\'s idea but the model\'s', async () => {
    // The control for the wording choice above. The customer named no time at all, so "that time
    // is not available" would answer a question they never asked; the list is the whole answer.
    // Same guard, same replacement machinery, different true sentence.
    const slots = [
      { start: '2026-09-02T07:00:00.000Z', end: '2026-09-02T07:30:00.000Z' },
      { start: '2026-09-02T07:30:00.000Z', end: '2026-09-02T08:00:00.000Z' },
    ];
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots, timezone: 'Europe/Brussels' },
        availability: { slots, timezone: 'Europe/Brussels' },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    vi.mocked(mockProvider.chat)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-09-02', endDate: '2026-09-02' } }],
      })
      .mockResolvedValueOnce({
        content: 'Ik heb 08:00 en 09:00 vrij. Wat past?',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'Welke tijden zijn vrij op woensdag 2 september 2026?',
      // Partial fixtures, cast once with a reason: `run` reads only the fields set here.
      { id: 's1', tenantId: 't1', status: 'bot' } as unknown as Parameters<typeof agent.run>[1],
      {
        id: 't1',
        settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
      } as unknown as Parameters<typeof agent.run>[2],
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.content).not.toContain('08:00');
      expect(result.content).toMatch(/^Here are the times I have available/);
    }
  });

  it('ships the reply in English rather than wait on a hanging localizer', async () => {
    // `localizeMessage` is two sequential LLM calls, it fails open on an error and NOT on a hang,
    // and it does not go through `callProviderWithRetry`. On the reply path a stalled provider
    // would mean NO answer at all on a session that still shows the bot as active, which is far
    // worse than an English sentence. The deadline is what makes the nicer wording safe to want.
    vi.useFakeTimers();
    mockLocalize.mockImplementationOnce(() => new Promise<string>(() => {}));
    const slots = [
      { start: '2026-09-02T07:00:00.000Z', end: '2026-09-02T07:30:00.000Z' },
      { start: '2026-09-02T07:30:00.000Z', end: '2026-09-02T08:00:00.000Z' },
    ];
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots, timezone: 'Europe/Brussels' },
        availability: { slots, timezone: 'Europe/Brussels' },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    vi.mocked(mockProvider.chat)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-09-02', endDate: '2026-09-02' } }],
      })
      .mockResolvedValueOnce({
        content: 'Ik heb 08:00 en 09:00 vrij. Wat past?',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const run = agent.run(
      'Welke tijden zijn vrij op woensdag 2 september 2026?',
      // Partial fixtures, cast once with a reason: `run` reads only the fields set here.
      { id: 's1', tenantId: 't1', status: 'bot' } as unknown as Parameters<typeof agent.run>[1],
      {
        id: 't1',
        settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
      } as unknown as Parameters<typeof agent.run>[2],
      [],
    );
    await vi.advanceTimersByTimeAsync(3000);
    const result = await run;
    vi.useRealTimers();

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      // The authored English, which is exactly what shipped before localization existed.
      expect(result.content).toMatch(/^Here are the times I have available/);
      expect(result.quickReplies).toHaveLength(2);
    }
  });

  it('keeps a reply that names a REQUESTABLE travel time, which no chip carries', async () => {
    // The other half of the same guard. A mixed travel result confirms 10:30 and offers 14:00 as
    // a time the business must be asked about - `check_availability` tells the model in so many
    // words to offer it and capture it with request_appointment. Judged against the chips alone,
    // doing exactly as asked would be answered with "that time is not available".
    const slots = [{ start: '2026-10-09T08:30:00.000Z', end: '2026-10-09T09:30:00.000Z' }];
    const requestableSlots = [{ start: '2026-10-09T12:00:00.000Z', end: '2026-10-09T13:00:00.000Z' }];
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots, timezone: 'Europe/Brussels' },
        availability: { slots, requestableSlots, timezone: 'Europe/Brussels' },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    vi.mocked(mockProvider.chat)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-10-09', endDate: '2026-10-09' } }],
      })
      .mockResolvedValueOnce({
        content: '14:00 kan ik niet meteen bevestigen, maar ik vraag het na bij de zaak. Is dat goed?',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'Kan 14:00 ook?',
      // Partial fixtures, cast once with a reason: `run` reads only the fields set here.
      { id: 's1', tenantId: 't1', status: 'bot' } as unknown as Parameters<typeof agent.run>[1],
      {
        id: 't1',
        settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
      } as unknown as Parameters<typeof agent.run>[2],
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      // 14:00 local is the 12:00Z requestable slot. The sentence survives untouched.
      expect(result.content).toContain('14:00');
      expect(result.content).not.toMatch(/not available/i);
      // The confirmable slot still gets its chip: 10:30 local.
      expect(result.quickReplies).toHaveLength(1);
      expect(result.quickReplies![0].title).toContain('10:30');
    }
  });

  it('still judges a reply when NOTHING is tappable, and does not point at absent chips', async () => {
    // The turn the chip gate used to skip. An all-requestable travel result offers every time in
    // prose - no slot is auto-confirmable, so no chip exists - which is exactly where an invented
    // time does the most damage: the tool has just told the model to read times out, and nothing
    // on screen contradicts it. The replacement must not promise a list either.
    const requestableSlots = [{ start: '2026-10-09T12:00:00.000Z', end: '2026-10-09T13:00:00.000Z' }];
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots: [], timezone: 'Europe/Brussels' },
        availability: { slots: [], requestableSlots, timezone: 'Europe/Brussels' },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    vi.mocked(mockProvider.chat)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-10-09', endDate: '2026-10-09' } }],
      })
      .mockResolvedValueOnce({
        content: 'Het eerstvolgende geldige tijdstip is om 08:30. Zal ik dat boeken?',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'Wat is het eerstvolgende geldige tijdstip?',
      // Partial fixtures, cast once with a reason: `run` reads only the fields set here.
      { id: 's1', tenantId: 't1', status: 'bot' } as unknown as Parameters<typeof agent.run>[1],
      {
        id: 't1',
        settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
      } as unknown as Parameters<typeof agent.run>[2],
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.content).not.toContain('08:30');
      // Nothing is on screen, so the reply must ask rather than point at a list.
      expect(result.content).toMatch(/tell me which time suits you/i);
      expect(result.content).not.toMatch(/here are the times/i);
      expect(result.quickReplies).toBeUndefined();
    }
  });

  it('keeps a confirmation that names the appointment as a SPAN, with the chips still up', async () => {
    // The universal confirmation turn: the customer says "that last one" and names no clock time,
    // so the chips stay and the enumeration guard runs. The reply says the appointment in full -
    // "16:00 tot 17:00" - and 17:00 is the slot's END, which is nobody's slot start on a day that
    // closes at 17:00. Judged as two offered times it loses the customer their confirmation. The
    // span is exactly one appointment long, so it is read as the one time it names.
    const slots = [
      { start: '2026-10-09T12:00:00.000Z', end: '2026-10-09T13:00:00.000Z' },
      { start: '2026-10-09T14:00:00.000Z', end: '2026-10-09T15:00:00.000Z' },
    ];
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots, timezone: 'Europe/Brussels' },
        availability: { slots, timezone: 'Europe/Brussels' },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    vi.mocked(mockProvider.chat)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-10-09', endDate: '2026-10-09' } }],
      })
      .mockResolvedValueOnce({
        content: 'Prima, ik zet uw afspraak op vrijdag 16:00 tot 17:00. Klopt dat?',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'Ja, doe die laatste.',
      // Partial fixtures, cast once with a reason: `run` reads only the fields set here.
      { id: 's1', tenantId: 't1', status: 'bot' } as unknown as Parameters<typeof agent.run>[1],
      {
        id: 't1',
        settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
      } as unknown as Parameters<typeof agent.run>[2],
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      // 16:00 local is the 14:00Z slot; 17:00 is its end and no slot's start.
      expect(result.content).toContain('16:00 tot 17:00');
      // They named no time, so the offer stands and the enumeration guard really did run.
      expect(result.quickReplies).toHaveLength(2);
    }
  });

  it('keeps an opening-hours range on a turn with nothing tappable', async () => {
    // The other side of the length gate, and the reason it exists. The customer already chose
    // 14:00, so the chips come off and only the always-on single-time guard is left. The reply is
    // a business fact and NOTHING else - one range, no chosen time beside it - because a reply
    // that also named 14:00 would survive an unconditional collapse too and prove nothing. This
    // range is 480 minutes and no appointment length here, so it stays two readings and the guard
    // stands down. Collapsed, it would be a lone unoffered 9:00 and a true sentence would go.
    const slots = [{ start: '2026-10-09T12:00:00.000Z', end: '2026-10-09T13:00:00.000Z' }];
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots, timezone: 'Europe/Brussels' },
        availability: { slots, timezone: 'Europe/Brussels' },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    vi.mocked(mockProvider.chat)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-10-09', endDate: '2026-10-09' } }],
      })
      .mockResolvedValueOnce({
        content: 'Wij zijn open van 9:00 tot 17:00.',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      '14:00 graag.',
      // Partial fixtures, cast once with a reason: `run` reads only the fields set here.
      { id: 's1', tenantId: 't1', status: 'bot' } as unknown as Parameters<typeof agent.run>[1],
      {
        id: 't1',
        settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
      } as unknown as Parameters<typeof agent.run>[2],
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.content).toContain('open van 9:00 tot 17:00');
      expect(result.quickReplies).toBeUndefined();
    }
  });

  it('does not re-attach slot chips when the customer taps the time they already chose', async () => {
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: {
          slots: [
            { start: '2026-10-05T07:00:00.000Z', end: '2026-10-05T07:30:00.000Z' },
            { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T08:30:00.000Z' },
          ],
          timezone: 'Europe/Brussels',
        },
        availability: {
          slots: [
            { start: '2026-10-05T07:00:00.000Z', end: '2026-10-05T07:30:00.000Z' },
            { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T08:30:00.000Z' },
          ],
          timezone: 'Europe/Brussels',
        },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: { startDate: '2026-10-05', endDate: '2026-10-05' } }],
      })
      .mockResolvedValueOnce({
        content: 'I have 9:00, 9:30 and 10:00. Which works?',
        usage: { promptTokens: 100, completionTokens: 10 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'Book Lekdetectie on Monday 5 October at 10:00 AM',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.quickReplies).toBeUndefined();
    }
  });

  it('#81: keeps shadow scoring out of the model message and on the offer instead', async () => {
    // TWO failures guarded at once, and both are silent. Scoring vocabulary in the tool message
    // teaches a model that is meant to be unaware any ranking happened - it can start telling a
    // customer a time is "preferred". And the tool message is truncated at 4000 characters, so a
    // measurement blob on `data` can cut the slot list itself: a shadow feature breaking the real
    // one. It must ride on `measurement`, which never reaches the prompt.
    const scoring = {
      scorerVersion: 'lp4-1',
      scores: { '2026-06-10T08:00:00.000Z': { costMinutes: 12, preferred: true, neutralReason: null, period: 'morning' } },
      counterfactualOrder: ['2026-06-10T08:00:00.000Z'],
      cheaperAlternativeExisted: true,
      elementsSpent: 2,
      ms: 40,
    };
    const checkAvailability: ToolAdapter = {
      name: 'check_availability',
      description: 'Check slots',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots: [{ start: '2026-06-10T08:00:00.000Z', end: '2026-06-10T08:30:00.000Z' }], timezone: 'UTC' },
        availability: { slots: [{ start: '2026-06-10T08:00:00.000Z', end: '2026-06-10T08:30:00.000Z' }], timezone: 'UTC' },
        measurement: { grouping: scoring },
      }),
    };
    mockGetToolsForTenant.mockResolvedValueOnce([checkAvailability]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: {} }],
      })
      .mockResolvedValueOnce({ content: 'Here are some times:', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });

    const result = await agent.run(
      'when can I book?',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    const toolMsg = (mockProvider.chat as any).mock.calls[1][0].find((m: any) => m.role === 'tool');
    expect(toolMsg.content).not.toContain('preferred');
    expect(toolMsg.content).not.toContain('costMinutes');
    expect(toolMsg.content).not.toContain('lp4-1');
    // ...and it is not merely dropped. The offer record needs it at the dispatch boundary.
    if (result.type === 'response') {
      expect(result.offer?.scoring).toEqual(scoring);
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
        availability: {
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
        availability: { slots: [{ start: '2026-06-10T08:00:00.000Z', end: '2026-06-10T08:30:00.000Z' }], timezone: 'UTC' },
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
    if (result.type === 'response') {
      expect(result.quickReplies).toBeUndefined();
      expect(result.validationContext?.bookingRecorded).toBe(true);
    }
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
        availability: { slots: [{ start: '2026-06-10T08:00:00.000Z', end: '2026-06-10T08:30:00.000Z' }], timezone: 'UTC' },
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

  it('retries a wrong-address reply once with tools disabled', async () => {
    const requestAppointment: ToolAdapter = {
      name: 'request_appointment',
      description: 'Request',
      parameters: { type: 'object', properties: {} },
      hasSideEffects: true,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { requested: true },
        replyFact: {
          kind: 'booking_address',
          address: 'Turnhoutsebaan 100, 2140 Antwerpen',
          use: 'request',
          alternatives: ['Kerkstraat 12, 2060 Antwerpen'],
        },
      }),
    };
    mockGetToolsForTenant.mockResolvedValue([requestAppointment]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'request_appointment', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: 'Although you mentioned Kerkstraat 12, 2060 Antwerpen, your request was sent for Turnhoutsebaan 100, 2140 Antwerpen.',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        content: 'Your request was sent for Turnhoutsebaan 100, 2140 Antwerpen.',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'request an appointment',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true } } } as any,
      [],
    );

    expect(result).toMatchObject({
      type: 'response',
      content: 'Your request was sent for Turnhoutsebaan 100, 2140 Antwerpen.',
    });
    expect(mockProvider.chat).toHaveBeenCalledTimes(3);
    expect((mockProvider.chat as any).mock.calls[2][1].tools).toBeUndefined();
    expect(JSON.stringify(mockTraceSave.mock.calls.at(-1)?.[0])).not.toContain('replyFact');
  });

  it('strips the affordance from the saved trace, so Google text and the address query never reach the audit log (#98)', async () => {
    const check: ToolAdapter = {
      name: 'check_availability',
      description: 'check',
      parameters: {},
      hasSideEffects: false,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { slots: [], timezone: 'Europe/Brussels' },
        affordance: {
          kind: 'address_picker' as const,
          reason: 'unverified' as const,
          query: 'Kerkstraat 12',
          options: [{ id: 'a1b2', placeId: 'ChIJ_one', text: 'Turnhoutsebaan 100, 2140 Antwerpen' }],
        },
      }),
    };
    mockGetToolsForTenant.mockResolvedValue([check]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'check_availability', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: 'Here are some available times.',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'when can you come out',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true } } } as any,
      [],
    );

    // The affordance still reaches the response — only the persisted trace is scrubbed.
    expect(result).toMatchObject({ affordance: { kind: 'address_picker', reason: 'unverified' } });

    const savedTrace = JSON.stringify(mockTraceSave.mock.calls.at(-1)?.[0]);
    expect(savedTrace).not.toContain('Turnhoutsebaan'); // Google suggestion text (ADR-0014)
    expect(savedTrace).not.toContain('Kerkstraat');     // the customer's typed address (query)
    expect(savedTrace).not.toContain('ChIJ_one');       // the offered option's placeId
  });

  it('accepts a reply that states the authoritative address', async () => {
    const requestAppointment: ToolAdapter = {
      name: 'request_appointment',
      description: 'Request',
      parameters: {},
      hasSideEffects: true,
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { requested: true },
        replyFact: {
          kind: 'booking_address',
          address: 'Turnhoutsebaan 100, 2140 Antwerpen',
          use: 'request',
          alternatives: ['Kerkstraat 12, 2060 Antwerpen'],
        },
      }),
    };
    mockGetToolsForTenant.mockResolvedValue([requestAppointment]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'request_appointment', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: 'Your request was sent for Turnhoutsebaan 100, Antwerpen.',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'request an appointment',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true } } } as any,
      [],
    );

    expect(result).toMatchObject({
      type: 'response',
      content: 'Your request was sent for Turnhoutsebaan 100, Antwerpen.',
    });
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['check_availability', 'availability', 'Here are the available times for Turnhoutsebaan 100, 2140 Antwerpen.'],
    ['create_booking', 'confirmed_booking', 'Your booking is confirmed for Turnhoutsebaan 100, 2140 Antwerpen.'],
    ['request_appointment', 'request', 'Your appointment request has been sent for Turnhoutsebaan 100, 2140 Antwerpen.'],
  ] as const)('uses a deterministic %s fallback after a second invalid reply', async (name, use, expected) => {
    const addressTool: ToolAdapter = {
      name,
      description: name,
      parameters: {},
      hasSideEffects: name !== 'check_availability',
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: name === 'check_availability' ? { slots: [], timezone: 'Europe/Brussels' } : { ok: true },
        ...(name === 'check_availability'
          ? { affordance: { kind: 'address_picker' as const, reason: 'unverified' as const } }
          : {}),
        replyFact: {
          kind: 'booking_address',
          address: 'Turnhoutsebaan 100, 2140 Antwerpen',
          use,
          alternatives: ['Kerkstraat 12, 2060 Antwerpen'],
        },
      }),
    };
    mockGetToolsForTenant.mockResolvedValue([addressTool]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name, arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: 'This used Kerkstraat 12, 2060 Antwerpen.',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        content: 'Still Kerkstraat 12, 2060 Antwerpen.',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'continue',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true } } } as any,
      [],
    );

    expect(result).toMatchObject({ type: 'response', content: expected });
    if (name === 'check_availability') {
      expect(result).toMatchObject({
        affordance: { kind: 'address_picker', reason: 'unverified' },
      });
    }
  });

  it('does not execute tool calls emitted during the tools-disabled correction', async () => {
    const execute = vi.fn().mockResolvedValue({
      success: true,
      data: { requested: true },
      replyFact: {
        kind: 'booking_address',
        address: 'Turnhoutsebaan 100, 2140 Antwerpen',
        use: 'request',
        alternatives: ['Kerkstraat 12, 2060 Antwerpen'],
      },
    });
    const requestAppointment: ToolAdapter = {
      name: 'request_appointment',
      description: 'Request',
      parameters: {},
      hasSideEffects: true,
      execute,
    };
    mockGetToolsForTenant.mockResolvedValue([requestAppointment]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'request_appointment', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: 'Sent for Kerkstraat 12, 2060 Antwerpen.',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_2', name: 'request_appointment', arguments: {} }],
      });

    const result = await agent.run(
      'continue',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true } } } as any,
      [],
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      type: 'response',
      content: 'Your appointment request has been sent for Turnhoutsebaan 100, 2140 Antwerpen.',
    });
  });

  it('rejects conflicting authoritative addresses without choosing one', async () => {
    const tool = (name: string, address: string): ToolAdapter => ({
      name,
      description: name,
      parameters: {},
      hasSideEffects: name === 'request_appointment',
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: name === 'check_availability' ? { slots: [], timezone: 'UTC' } : { requested: true },
        replyFact: { kind: 'booking_address', address, use: name === 'check_availability' ? 'availability' : 'request', alternatives: [] },
      }),
    });
    const availability = tool('check_availability', 'Turnhoutsebaan 100, 2140 Antwerpen');
    const request = tool('request_appointment', 'Kerkstraat 12, 2060 Antwerpen');
    mockGetToolsForTenant.mockResolvedValue([availability, request]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'tc_1', name: 'check_availability', arguments: {} },
          { id: 'tc_2', name: 'request_appointment', arguments: {} },
        ],
      })
      .mockResolvedValueOnce({
        content: 'Done.',
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'continue',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true } } } as any,
      [],
    );

    expect(result).toMatchObject({
      type: 'response',
      content: "Sorry, I can't safely confirm which address was used. Please verify the appointment address with the business.",
    });
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
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

  it('does not latch handoffRequested when session is not bot-owned', async () => {
    const escalate: ToolAdapter = {
      name: 'escalate_to_human',
      description: 'Escalate',
      parameters: { type: 'object', properties: { reason: { type: 'string' } } },
      hasSideEffects: true,
      execute: vi.fn().mockResolvedValue({ success: true, data: { escalated: true } }),
    };
    mockGetToolsForTenant.mockResolvedValue([escalate]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'escalate_to_human', arguments: { reason: 'asked for a person' } }],
      })
      .mockResolvedValueOnce({
        content: 'Let me get someone.',
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'I want a human',
      { id: 's1', tenantId: 't1', status: 'handoff', ownership: 'human_owned' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    expect(result.handoffRequested).toBeUndefined();
    expect(escalate.execute).toHaveBeenCalledWith(
      { reason: 'asked for a person' },
      expect.objectContaining({ botOwned: false }),
    );
  });

  it('latches handoffRequested when escalate succeeds on a bot-owned session', async () => {
    const escalate: ToolAdapter = {
      name: 'escalate_to_human',
      description: 'Escalate',
      parameters: { type: 'object', properties: { reason: { type: 'string' } } },
      hasSideEffects: true,
      execute: vi.fn().mockResolvedValue({ success: true, data: { escalated: true } }),
    };
    mockGetToolsForTenant.mockResolvedValue([escalate]);
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'escalate_to_human', arguments: { reason: 'asked for a person' } }],
      })
      .mockResolvedValueOnce({
        content: 'Connecting you now.',
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'I want a human',
      { id: 's1', tenantId: 't1', status: 'bot', ownership: 'bot_owned' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    expect(result.handoffRequested).toBe(true);
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
