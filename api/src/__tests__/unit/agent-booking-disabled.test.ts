/**
 * When booking is in a tenant's plan but switched OFF (the module is inactive,
 * so the agent has no booking tools or SERVICES section), the agent injects
 * BOOKING_DISABLED_SECTION so the bot declines cleanly instead of improvising a
 * dead-end booking flow. Never-entitled tenants get no such section.
 *
 * Asserts on the `moduleSections` arg handed to PromptBuilder.build (the prompt
 * builder itself is stubbed), keeping this independent of prompt wording.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import { BOOKING_DISABLED_SECTION } from '../../modules/booking.module';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { LLMProvider } from '../../llm/llm.types';

const mockProvider: LLMProvider = { chat: vi.fn() };
vi.mock('../../llm/provider-factory', () => ({ getProvider: () => mockProvider }));
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ find: async () => [], findOne: async () => null }) },
}));
vi.mock('../../services/bot-config.service', () => ({
  getLlmRuntimeConfigForSession: async () => ({
    bot: { id: 'bot-anchor' },
    botSettings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
    botAiSettings: { enabled: true, provider: 'openai', model: 'gpt-4o' },
    apiKey: 'sk-test',
  }),
}));

// No active modules → booking module inactive (the toggled-off / disabled state).
vi.mock('../../modules', () => ({ listActiveModules: async () => [] }));

// Drive the entitled-vs-not distinction.
const ent = { entitledFeatures: { bookings: true } as Record<string, boolean> };
vi.mock('../../billing/entitlements', () => ({ getEntitlements: async () => ent }));

const kbSearch: ToolAdapter = {
  name: 'kb_search',
  description: 'Search KB',
  parameters: { type: 'object', properties: {} },
  hasSideEffects: false,
  execute: vi.fn().mockResolvedValue({ success: true, data: { chunks: [] } }),
};
// No create_booking tool → bookingActive === false.
const mockToolRegistry = { getToolsForTenant: async () => [kbSearch], getBuiltinToolNames: vi.fn() };
const mockPromptBuilder = { build: vi.fn().mockReturnValue('You are TestBot.') };
const mockMetering = { record: vi.fn(), isOverBudget: vi.fn().mockResolvedValue(false) };
const mockTraceLogger = { save: vi.fn() };

const SESSION = { id: 's1', tenantId: 't1', status: 'bot' } as any;
const TENANT = { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any;

function moduleSectionsFromLastBuild(): string[] {
  return (mockPromptBuilder.build as any).mock.calls[0][4] as string[];
}

describe('AgentService — booking-disabled guardrail', () => {
  let agent: AgentService;
  beforeEach(() => {
    agent = new AgentService(mockToolRegistry as any, mockPromptBuilder as any, mockMetering as any, mockTraceLogger as any);
    vi.clearAllMocks();
    (mockProvider.chat as any).mockResolvedValue({ content: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });
    ent.entitledFeatures.bookings = true;
  });

  it('injects the guardrail when booking is entitled but inactive (toggled off)', async () => {
    await agent.run('can you book me an appointment?', SESSION, TENANT, []);
    expect(moduleSectionsFromLastBuild()).toContain(BOOKING_DISABLED_SECTION);
  });

  it('does NOT inject the guardrail when the tenant is not entitled to booking', async () => {
    ent.entitledFeatures.bookings = false;
    await agent.run('can you book me an appointment?', SESSION, TENANT, []);
    expect(moduleSectionsFromLastBuild()).not.toContain(BOOKING_DISABLED_SECTION);
  });
});
