/**
 * Why a run ended, recorded where the operator can read it.
 *
 * Found by driving production on 2026-08-13: a booking conversation answered the address
 * question, and the next turn replied with the tenant's handoff fallback. The trace said
 * `finishReason: 'error'` and nothing else — `iterations: []`, `totalTokens: 0`, and no error
 * anywhere on the row. `totalLatencyMs` was 0 too, but that is `iterations.reduce(...)` over an
 * empty array, so it says nothing about whether the provider was ever called.
 *
 * The result: five candidate causes (upstream quota, throttling, an LLM timeout, a thrown budget
 * check, a fault in the run setup) and no way to tell them apart without reproducing a live
 * failure. `finishReason` names the SHAPE of the ending; nothing named the CAUSE.
 *
 * These tests pin the cause onto the trace. They are deliberately about the record rather than
 * the reply — the customer-facing behaviour is already covered by `agent-infra-failure.test.ts`,
 * and the fallback text must NOT start carrying diagnostic detail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { LLMProvider } from '../../llm/llm.types';

const mockProvider: LLMProvider = { chat: vi.fn() };
vi.mock('../../billing/token-budget.service', () => ({
  isTokenBudgetExhausted: vi.fn().mockResolvedValue(false),
  recordTokenUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../llm/provider-factory', () => ({ getProvider: () => mockProvider }));
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

/** The trace the run actually persisted — the record this suite is about. */
const savedTrace = () => (mockTraceLogger.save as any).mock.calls.at(-1)?.[0];

const run = (agent: AgentService) =>
  agent.run(
    'hello',
    { id: 's1', tenantId: 't1', botId: 'bot-1', status: 'bot' } as any,
    { id: 't1', settings: { ai: { enabled: true } } } as any,
    [],
  );

describe('AgentService — the trace records WHY a run ended', () => {
  let agent: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new AgentService(mockToolRegistry as any, mockPromptBuilder as any, mockMetering as any, mockTraceLogger as any);
    vi.stubEnv('COMPOSABLE_TEMPLATES_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('classifies an exhausted balance as an upstream fault, with the provider message kept', async () => {
    (mockProvider.chat as any).mockRejectedValue(
      Object.assign(new Error('429 You have no credits remaining.'), {
        status: 429, code: 'credit_balance_exhausted', type: 'insufficient_quota',
      }),
    );

    await run(agent);

    expect(savedTrace().terminal).toMatchObject({
      result: 'error',
      error: { kind: 'upstream_quota', message: expect.stringContaining('no credits remaining') },
    });
  });

  it('tells throttling apart from an exhausted balance', async () => {
    (mockProvider.chat as any).mockRejectedValue(
      Object.assign(new Error('429 Rate limit reached'), { status: 429, code: 'rate_limit_exceeded' }),
    );

    await run(agent);

    expect(savedTrace().terminal.error.kind).toBe('upstream_rate_limit');
  });

  it('records a bot fault as its own kind, so it is not read as a provider outage', async () => {
    (mockProvider.chat as any).mockRejectedValue(new Error('prompt composition blew up'));

    await run(agent);

    expect(savedTrace().terminal).toMatchObject({
      result: 'error',
      error: { kind: 'bot_fault', message: 'prompt composition blew up' },
    });
  });

  it('records the ordinary ending too, so a missing `terminal` means a lost trace and nothing else', async () => {
    (mockProvider.chat as any).mockResolvedValue({
      content: 'Hello there.', finishReason: 'stop', toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    await run(agent);

    expect(savedTrace().terminal).toMatchObject({ result: 'completed' });
    expect(savedTrace().terminal.error).toBeUndefined();
  });

  it('keeps the diagnostic off the reply the customer reads', async () => {
    (mockProvider.chat as any).mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'));

    const res = await run(agent);

    expect(res.type).toBe('error');
    expect(res.type === 'error' && res.fallbackMessage).not.toContain('ECONNREFUSED');
  });

  it('classifies a provider 5xx as an upstream server error, not a bot fault', async () => {
    (mockProvider.chat as any).mockRejectedValue(
      Object.assign(new Error('503 Service Unavailable'), { status: 503 }),
    );

    const res = await run(agent);

    expect(savedTrace().terminal.error.kind).toBe('upstream_server_error');
    // An upstream failure must not be reported as one conversation going wrong.
    expect(res.type === 'error' && res.infraFailure).toBe(true);
  });

  it('names an unreachable provider as upstream_unreachable, not a bot fault', async () => {
    (mockProvider.chat as any).mockRejectedValue(
      Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }),
    );

    const res = await run(agent);

    expect(savedTrace().terminal.error.kind).toBe('upstream_unreachable');
    expect(res.type === 'error' && res.infraFailure).toBe(true);
  });

  it('retries the provider once on a transient 5xx and completes when the retry succeeds', async () => {
    (mockProvider.chat as any)
      .mockRejectedValueOnce(Object.assign(new Error('502 Bad Gateway'), { status: 502 }))
      .mockResolvedValueOnce({
        content: 'Booked.', finishReason: 'stop', toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      });

    const res = await run(agent);

    expect((mockProvider.chat as any).mock.calls.length).toBe(2); // one retry
    expect(res.type).toBe('response');
    expect(savedTrace().terminal).toMatchObject({ result: 'completed' });
  });

  it('does NOT retry a bot fault (a deterministic error will not clear)', async () => {
    (mockProvider.chat as any).mockRejectedValue(new Error('prompt composition blew up'));

    await run(agent);

    expect((mockProvider.chat as any).mock.calls.length).toBe(1); // no retry
    expect(savedTrace().terminal.error.kind).toBe('bot_fault');
  });
});
