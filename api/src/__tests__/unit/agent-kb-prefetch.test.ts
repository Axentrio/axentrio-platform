/**
 * The OPENING turn must arrive with knowledge-base context already in the prompt.
 *
 * The composer has always accepted a `kbContext` block, but the agent passed
 * `undefined`, leaving retrieval to the model volunteering `kb_search`. It doesn't:
 * the KNOWLEDGE block says "you MUST call kb_search BEFORE answering" and the tool
 * description says "Call this FIRST", and a live production turn still answered
 * "Valyro biedt diensten aan op het gebied van [specifieke diensten niet vermeld]"
 * — one LLM call, zero tool calls — with the company's website indexed and attached.
 *
 * These pin the shape of the deterministic seed: first turn only (cost), gated on
 * the tool being present (entitlement), and fail-open (a retrieval outage must never
 * cost the customer a reply).
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

const mockSearchKnowledge = vi.fn();
vi.mock('../../llm/rag.service', () => ({
  searchKnowledge: (...a: unknown[]) => mockSearchKnowledge(...a),
}));
vi.mock('../../knowledge/bot-knowledge-bases', () => ({
  getBotKnowledgeBaseIds: async () => ['kb-1'],
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ find: async () => [], findOne: async () => null }) },
}));
vi.mock('../../billing/entitlements', () => ({
  getEntitlements: async () => ({ billable: true, features: { lead_capture: true } }),
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
    { templateId: 'tpl-1', resolvedVersion: 1, selectedSkillIds: [], expectedModules: [], skillProse: {}, variables: [], category: null, body: 'Body.' },
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

const mockGetToolsForTenant = vi.fn();
const mockToolRegistry = { getToolsForTenant: mockGetToolsForTenant, getBuiltinToolNames: vi.fn() };
const mockPromptBuilder = {
  build: vi.fn((
    _tenant: unknown,
    settings: { ai?: { extraInfo?: string } },
    _tools: unknown,
    kbContext?: string,
    moduleSections?: string[],
    _customerName?: string,
    templateBody?: string,
  ) => ({
    prompt: [
      settings.ai?.extraInfo,
      templateBody,
      ...(moduleSections ?? []),
      kbContext,
    ].filter(Boolean).join('\n'),
    ledger: undefined,
  })),
};
const mockMetering = { record: vi.fn(), isOverBudget: vi.fn().mockResolvedValue(false) };
const mockTraceLogger = { save: vi.fn() };

/** promptBuilder.build(tenant, settings, tools, kbContext, …) — kbContext is arg 3. */
const kbContextArg = () => mockPromptBuilder.build.mock.calls[0][3] as string | undefined;

const run = (agent: AgentService, history: unknown[] = []) =>
  agent.run(
    'wat voor diensten bieden jullie aan?',
    { id: 's1', tenantId: 't1', botId: 'bot-1', status: 'bot' } as any,
    { id: 't1', settings: { ai: { enabled: true } } } as any,
    history as any,
  );

describe('AgentService — knowledge pre-fetch on the opening turn', () => {
  let agent: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new AgentService(mockToolRegistry as any, mockPromptBuilder as any, mockMetering as any, mockTraceLogger as any);
    mockGetToolsForTenant.mockResolvedValue([tool('kb_search')]);
    (mockProvider.chat as any).mockResolvedValue({ content: 'Hi!', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });
    mockSearchKnowledge.mockResolvedValue({
      chunks: [{ id: 'c1', title: 'Valyro website', content: 'Valyro helpt bedrijven om voorspelbaar te groeien.', similarity: 0.9, metadata: {} }],
      totalChunks: 1,
    });
    vi.stubEnv('COMPOSABLE_TEMPLATES_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('puts retrieved knowledge in the prompt without waiting for a tool call', async () => {
    await run(agent);

    expect(mockSearchKnowledge).toHaveBeenCalledTimes(1);
    expect(kbContextArg()).toContain('Valyro helpt bedrijven om voorspelbaar te groeien.');
    expect(kbContextArg()).toContain('Valyro website');
  });

  it('marks price context when retrieved knowledge contains a currency amount', async () => {
    mockSearchKnowledge.mockResolvedValue({
      chunks: [{ id: 'c1', title: 'Prices', content: 'A consultation costs €30.', similarity: 0.9, metadata: {} }],
      totalChunks: 1,
    });

    const result = await run(agent);

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.validationContext).toEqual({
        bookingRecorded: false,
        priceContextLoaded: true,
      });
    }
  });

  it('marks price context from the assembled system prompt', async () => {
    mockPromptBuilder.build.mockReturnValueOnce({
      prompt: 'The template and additional context say a consultation costs €40.',
      ledger: undefined,
    });

    const result = await run(agent);

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.validationContext?.priceContextLoaded).toBe(true);
    }
  });

  it('marks price context from conversation history', async () => {
    const result = await run(agent, [
      { role: 'user', content: 'Earlier you said the consultation costs €35.' },
    ]);

    expect(result.type).toBe('response');
    if (result.type === 'response') {
      expect(result.validationContext?.priceContextLoaded).toBe(true);
    }
  });

  it('scopes retrieval to the bot\'s attached knowledge bases', async () => {
    await run(agent);

    // searchKnowledge(dataSource, tenantId, query, history, maxChunks, kbIds, terms)
    const call = mockSearchKnowledge.mock.calls[0];
    expect(call[1]).toBe('t1');
    expect(call[2]).toBe('wat voor diensten bieden jullie aan?');
    expect(call[5]).toEqual(['kb-1']);
  });

  it('passes empty history, which is what keeps rewriteQuery from spending an LLM call', async () => {
    await run(agent);

    expect(mockSearchKnowledge.mock.calls[0][3]).toEqual([]);
  });

  it('does NOT pre-fetch on later turns — the tool covers those', async () => {
    await run(agent, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);

    expect(mockSearchKnowledge).not.toHaveBeenCalled();
    expect(kbContextArg()).toBeUndefined();
  });

  it('does NOT pre-fetch when the bot has no kb_search tool', async () => {
    // Plan or skill selection withheld the tool; KB content must not arrive anyway.
    mockGetToolsForTenant.mockResolvedValue([tool('capture_lead')]);

    await run(agent);

    expect(mockSearchKnowledge).not.toHaveBeenCalled();
    expect(kbContextArg()).toBeUndefined();
  });

  it('still answers when retrieval throws', async () => {
    mockSearchKnowledge.mockRejectedValue(new Error('pgvector down'));

    const res = await run(agent);

    expect(res.type).toBe('response');
    expect(kbContextArg()).toBeUndefined();
  });

  it('sends no knowledge block when the search finds nothing', async () => {
    mockSearchKnowledge.mockResolvedValue({ chunks: [], totalChunks: 0 });

    await run(agent);

    expect(kbContextArg()).toBeUndefined();
  });
});
