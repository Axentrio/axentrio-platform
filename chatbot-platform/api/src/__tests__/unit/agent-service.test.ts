import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter, ToolContext } from '../../agent/tool-adapter';
import type { LLMProvider, ChatMessage, LLMOptions, LLMResponse } from '../../llm/llm.types';

// Create mock dependencies
const mockProvider: LLMProvider = {
  chat: vi.fn(),
};

const mockGetProvider = vi.fn().mockReturnValue(mockProvider);
vi.mock('../../llm/provider-factory', () => ({
  getProvider: (...args: any[]) => mockGetProvider(...args),
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
