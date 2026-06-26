import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { LLMProvider } from '../../llm/llm.types';

// agent.service computes `bookingConfigured` (the 9th positional arg of
// promptBuilder.build) from an AvailabilityRule.findOne + a ServiceType.find when
// the booking tools are loaded. These tests assert that arg without depending on
// prompt wording — modelled on agent-service.test.ts.

const mockProvider: LLMProvider = { chat: vi.fn() };
const mockGetProvider = vi.fn().mockReturnValue(mockProvider);
vi.mock('../../llm/provider-factory', () => ({
  getProvider: (...args: any[]) => mockGetProvider(...args),
}));

// Per-entity repo stub: AvailabilityRule.findOne + ServiceType.find are what the
// booking-config check reads. Each test sets these before calling run().
let availabilityRuleRow: { timezone: string } | null = null;
let serviceTypeRows: Array<{ id: string; bookingMode: string }> = [];
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => {
      const name = entity?.name;
      if (name === 'AvailabilityRule') return { findOne: async () => availabilityRuleRow };
      if (name === 'ServiceType') return { find: async () => serviceTypeRows };
      // ConversationBinding / other repos used by run(): harmless empties.
      return { find: async () => [], findOne: async () => null };
    },
  },
}));

vi.mock('../../services/bot-config.service', () => ({
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

const mockMetering = { record: vi.fn(), isOverBudget: vi.fn().mockResolvedValue(false) };
const mockTraceLogger = { save: vi.fn() };

const createBooking: ToolAdapter = {
  name: 'create_booking',
  description: 'Create booking',
  parameters: { type: 'object', properties: {} },
  hasSideEffects: true,
  execute: vi.fn().mockResolvedValue({ success: true }),
};
const mockGetToolsForTenant = vi.fn().mockResolvedValue([createBooking]);
const mockToolRegistry = { getToolsForTenant: mockGetToolsForTenant, getBuiltinToolNames: vi.fn() };

const mockPromptBuilder = { build: vi.fn().mockReturnValue('You are TestBot.') };

describe('AgentService bookingConfigured signal', () => {
  let agent: AgentService;

  beforeEach(() => {
    agent = new AgentService(
      mockToolRegistry as any,
      mockPromptBuilder as any,
      mockMetering as any,
      mockTraceLogger as any,
    );
    vi.clearAllMocks();
    (mockMetering.isOverBudget as any).mockResolvedValue(false);
    mockGetToolsForTenant.mockResolvedValue([createBooking]);
    (mockProvider.chat as any).mockResolvedValue({
      content: 'Hi!',
      usage: { promptTokens: 10, completionTokens: 5 },
      finishReason: 'stop',
    });
  });

  it('availability rule + auto service ⇒ build() gets bookingConfigured === true', async () => {
    availabilityRuleRow = { timezone: 'Europe/Brussels' };
    serviceTypeRows = [{ id: 'svc-1', bookingMode: 'auto' }];

    await agent.run(
      'book me in',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(mockPromptBuilder.build).toHaveBeenCalled();
    const args = mockPromptBuilder.build.mock.calls[0];
    expect(args[8]).toBe(true);
  });

  it('no availability rule + no services ⇒ build() gets bookingConfigured === false', async () => {
    availabilityRuleRow = null;
    serviceTypeRows = [];

    await agent.run(
      'book me in',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(mockPromptBuilder.build).toHaveBeenCalled();
    const args = mockPromptBuilder.build.mock.calls[0];
    expect(args[8]).toBe(false);
  });
});
