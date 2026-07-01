import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { LLMProvider } from '../../llm/llm.types';

// Composable-templates Phase 3b — when SKILL_STATE_ENABLED is on, an entitled-but-
// UNCONFIGURED booking skill has its tools physically dropped before the model
// sees them (no phantom bookings). When off, behaviour is unchanged. The drop keys
// off the resolved skill STATE, which keys off the active modules — so booking must
// be entitlement-active here (mocked) AND unconfigured (no availability rule/service).

const mockProvider: LLMProvider = { chat: vi.fn() };
vi.mock('../../llm/provider-factory', () => ({ getProvider: () => mockProvider }));

// Unconfigured: no availability rule, no bookable services.
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({ find: async () => [], findOne: async () => null }),
  },
}));

// Booking is feature-gated; make the tenant entitled so listActiveModules returns
// the (real, registered) booking module as active.
vi.mock('../../billing/entitlements', () => ({
  getEntitlements: async () => ({ billable: true, features: { bookings: true } }),
  invalidateEntitlements: async () => {},
}));

vi.mock('../../services/bot-config.service', () => ({
  getLlmRuntimeConfigForSession: async () => ({
    bot: { id: 'bot-1' } as any,
    botSettings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } as any,
    botAiSettings: { enabled: true, provider: 'openai', model: 'gpt-4o' } as any,
    apiKey: 'sk-test',
  }),
  getBotConfigForSession: async () => ({
    bot: { id: 'bot-1' } as any,
    settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } as any,
  }),
}));

const createBooking: ToolAdapter = {
  name: 'create_booking',
  description: 'Create booking',
  parameters: { type: 'object', properties: {} },
  hasSideEffects: true,
  execute: vi.fn().mockResolvedValue({ success: true }),
};
const kbSearch: ToolAdapter = {
  name: 'kb_search',
  description: 'Search KB',
  parameters: { type: 'object', properties: {} },
  hasSideEffects: false,
  execute: vi.fn().mockResolvedValue({}),
};

const mockGetToolsForTenant = vi.fn();
const mockToolRegistry = { getToolsForTenant: mockGetToolsForTenant, getBuiltinToolNames: vi.fn() };
const mockPromptBuilder = { build: vi.fn().mockReturnValue('You are TestBot.') };
const mockMetering = { record: vi.fn(), isOverBudget: vi.fn().mockResolvedValue(false) };
const mockTraceLogger = { save: vi.fn() };

const run = (agent: AgentService) =>
  agent.run(
    'book me in',
    { id: 's1', tenantId: 't1', status: 'bot' } as any,
    { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
    [],
  );

const buildToolNames = () =>
  (mockPromptBuilder.build.mock.calls[0][2] as ToolAdapter[]).map((t) => t.name);

describe('AgentService — Phase 3b skill-state tool-drop', () => {
  let agent: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new AgentService(mockToolRegistry as any, mockPromptBuilder as any, mockMetering as any, mockTraceLogger as any);
    mockGetToolsForTenant.mockResolvedValue([createBooking, kbSearch]);
    (mockProvider.chat as any).mockResolvedValue({ content: 'Hi!', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('flag OFF (default): unconfigured booking keeps its tools (unchanged behaviour)', async () => {
    await run(agent);
    expect(buildToolNames()).toContain('create_booking');
  });

  it('flag ON: unconfigured booking has its tools dropped, other tools kept', async () => {
    vi.stubEnv('SKILL_STATE_ENABLED', 'true');
    await run(agent);
    const names = buildToolNames();
    expect(names).not.toContain('create_booking');
    expect(names).toContain('kb_search');
  });
});
