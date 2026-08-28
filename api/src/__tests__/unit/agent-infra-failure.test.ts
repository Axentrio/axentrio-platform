/**
 * A provider outage is not this bot going wrong.
 *
 * Every agent error used to escalate as `bot_error`, which sets the session to
 * `handoff` — and handoff SILENCES the bot until a 60-minute sweep, a timer each
 * new customer message pushes further out. When the platform key ran out of
 * credit on 2026-08-03 that turned one provider fault into: every conversation
 * parked at once, every customer left on "Something went wrong", and the one who
 * kept trying kept extending their own dead air.
 *
 * So the agent has to say WHICH kind of failure it was. The operator is told by
 * the health probe; the conversation stays with the bot, ready to answer as soon
 * as the provider recovers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { LLMProvider } from '../../llm/llm.types';

const mockProvider: LLMProvider = { chat: vi.fn() };
vi.mock('../../llm/provider-factory', () => ({ getProvider: () => mockProvider }));
vi.mock('../../billing/token-budget.service', () => ({
  isTokenBudgetExhausted: vi.fn().mockResolvedValue(false),
  recordTokenUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../llm/block-ledger', () => ({ buildPromptTrace: () => ({}) }));
vi.mock('../../llm/rag.service', () => ({ searchKnowledge: async () => ({ chunks: [], totalChunks: 0 }) }));
vi.mock('../../knowledge/bot-knowledge-bases', () => ({ getBotKnowledgeBaseIds: async () => [] }));
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ find: async () => [], findOne: async () => null }) },
}));
vi.mock('../../billing/entitlements', () => ({
  getEntitlements: async () => ({ billable: true, features: {} }),
  invalidateEntitlements: async () => {},
}));
vi.mock('../../services/bot-config.service', () => ({
  getLlmRuntimeConfigForSession: async () => ({
    bot: { id: 'bot-1' } as any,
    botSettings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } as any,
    botAiSettings: { enabled: true, provider: 'openai', model: 'gpt-4o' } as any,
    apiKey: 'sk-test',
  }),
  getBotConfigForSession: async () => ({ bot: { id: 'bot-1' } as any, settings: { ai: { enabled: true } } as any }),
}));
vi.mock('../../templates/template-resolver', () => ({
  resolveBoundTemplates: async () => [
    { templateId: 't1', resolvedVersion: 1, selectedSkillIds: [], expectedModules: [], skillProse: {}, variables: [], category: null, body: 'Body.' },
  ],
  composeTemplateBodies: () => 'Body.',
  effectiveConfigFromList: () => ({}),
  withEffectiveConfig: (s: any) => s,
  templateUnavailabilityReason: () => null,
  // The runtime asks `effectiveSkillIds` for a bot's skills (#103). These suites are not about
  // skill policy, so the stub mirrors the explicit path: whatever the template selected.
  effectiveSkillIds: (resolved: any[]) => resolved.flatMap((r: any) => r.selectedSkillIds ?? []),
}));

const tool = (name: string): ToolAdapter => ({
  name, description: name, parameters: { type: 'object', properties: {} },
  hasSideEffects: false, execute: vi.fn().mockResolvedValue({ success: true }),
});

const mockToolRegistry = { getToolsForTenant: vi.fn().mockResolvedValue([tool('kb_search')]), getBuiltinToolNames: vi.fn() };
const mockPromptBuilder = { build: vi.fn().mockReturnValue({ prompt: 'You are TestBot.', ledger: undefined }) };
const mockMetering = { record: vi.fn(), isOverBudget: vi.fn().mockResolvedValue(false) };
const mockTraceLogger = { save: vi.fn() };

const run = (agent: AgentService) =>
  agent.run(
    'hello',
    { id: 's1', tenantId: 't1', botId: 'bot-1', status: 'bot' } as any,
    { id: 't1', settings: { ai: { enabled: true } } } as any,
    [],
  );

describe('AgentService — upstream failures are flagged, not blamed on the bot', () => {
  let agent: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new AgentService(mockToolRegistry as any, mockPromptBuilder as any, mockMetering as any, mockTraceLogger as any);
    vi.stubEnv('COMPOSABLE_TEMPLATES_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('flags an exhausted balance as infrastructure, so it is never handed to a human', async () => {
    // The exact error from the 2026-08-03 outage.
    (mockProvider.chat as any).mockRejectedValue(
      Object.assign(new Error('429 You have no credits remaining.'), {
        status: 429, code: 'credit_balance_exhausted', type: 'insufficient_quota',
      }),
    );

    const res = await run(agent);

    expect(res.type).toBe('error');
    expect(res).toMatchObject({ infraFailure: true });
  });

  it('flags upstream throttling the same way', async () => {
    (mockProvider.chat as any).mockRejectedValue(
      Object.assign(new Error('429 Rate limit reached'), { status: 429, code: 'rate_limit_exceeded' }),
    );

    expect(await run(agent)).toMatchObject({ type: 'error', infraFailure: true });
  });

  it('does NOT flag a genuine bot fault — those must still reach a human', async () => {
    (mockProvider.chat as any).mockRejectedValue(new Error('prompt composition blew up'));

    const res = await run(agent);

    expect(res.type).toBe('error');
    expect(res).toMatchObject({ infraFailure: false });
  });

  it('still returns the tenant-authored fallback to the customer either way', async () => {
    (mockProvider.chat as any).mockRejectedValue(
      Object.assign(new Error('429'), { status: 429, code: 'insufficient_quota' }),
    );

    const res = await run(agent);

    expect(res.type === 'error' && res.fallbackMessage.length).toBeTruthy();
  });
});
