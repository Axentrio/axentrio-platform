import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { LLMProvider } from '../../llm/llm.types';

// Composable-templates Phase 4 — runtime bridge. A bound template that pins an
// authored module ref ({moduleId, moduleVersion}) must surface that pinned
// ModuleVersion's prose to the composer as `authoredModules`, but ONLY when the
// module's bound skill resolves `ready` (entitled ∧ enabled ∧ configured). When
// the skill is unconfigured the prose is withheld.

// Mutable readiness toggle the hoisted data-source mock reads (drives whether
// booking resolves configured/ready).
const h = vi.hoisted(() => ({ bookingConfigured: true }));

const mockProvider: LLMProvider = { chat: vi.fn() };
vi.mock('../../llm/provider-factory', () => ({ getProvider: () => mockProvider }));

// Repo branch by entity name: Module/ModuleVersion feed the Phase-4 bridge; the
// AvailabilityRule + ServiceType pair drive bookingConfigured (→ skill readiness).
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => {
      const name = entity?.name;
      if (name === 'Module') return { find: async () => [{ id: 'mod-booking', skillIds: ['booking'] }] };
      if (name === 'ModuleVersion')
        return { find: async () => [{ moduleId: 'mod-booking', version: 1, prose: 'Booking workflow prose.' }] };
      if (name === 'AvailabilityRule')
        return { findOne: async () => (h.bookingConfigured ? { timezone: 'Europe/London' } : null) };
      if (name === 'ServiceType')
        return { find: async () => (h.bookingConfigured ? [{ id: 'svc-1', bookingMode: 'auto' }] : []) };
      return { find: async () => [], findOne: async () => null };
    },
  },
}));

// Booking is feature-gated; entitle the tenant so listActiveModules returns the
// (real, registered) booking module as active.
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
}));

// Override only resolveBoundTemplates so the bound template carries a pinned
// authored module ref; keep selectSkillIds + the config helpers real.
vi.mock('../../templates/template-resolver', async (importActual) => {
  const actual = await importActual<typeof import('../../templates/template-resolver')>();
  return {
    ...actual,
    resolveBoundTemplates: vi.fn(async () => [
      {
        templateId: 'tmpl-1',
        body: '',
        config: {},
        resolvedVersion: 1,
        category: null,
        expectedModules: ['booking'],
        selectedModuleRefs: [{ moduleId: 'mod-booking', moduleVersion: 1 }],
        pinnedButUnavailable: false,
        templateUnavailable: false,
      },
    ]),
  };
});

const createBooking: ToolAdapter = {
  name: 'create_booking',
  description: 'Create booking',
  parameters: { type: 'object', properties: {} },
  hasSideEffects: true,
  execute: vi.fn().mockResolvedValue({ success: true }),
};

const mockGetToolsForTenant = vi.fn();
const mockToolRegistry = { getToolsForTenant: mockGetToolsForTenant, getBuiltinToolNames: vi.fn() };
const mockLedger = { getIncluded: () => [], getExcluded: () => [], getAllowedTools: () => [] };
const mockPromptBuilder = { build: vi.fn().mockReturnValue({ prompt: 'You are TestBot.', ledger: mockLedger }) };
const mockMetering = { record: vi.fn(), isOverBudget: vi.fn().mockResolvedValue(false) };
const mockTraceLogger = { save: vi.fn() };

const run = (agent: AgentService) =>
  agent.run(
    'book me in',
    { id: 's1', tenantId: 't1', status: 'bot' } as any,
    { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
    [],
  );

// authoredModules is the 12th positional arg to promptBuilder.build (index 11).
const buildAuthoredModules = () =>
  mockPromptBuilder.build.mock.calls[0][11] as { id: string; prose: string }[] | undefined;

describe('AgentService — Phase 4 authored module prose bridge', () => {
  let agent: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    h.bookingConfigured = true;
    agent = new AgentService(mockToolRegistry as any, mockPromptBuilder as any, mockMetering as any, mockTraceLogger as any);
    mockGetToolsForTenant.mockResolvedValue([createBooking]);
    (mockProvider.chat as any).mockResolvedValue({
      content: 'Hi!',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });
  });

  it('ready skill: surfaces the pinned ModuleVersion prose as authoredModules', async () => {
    await run(agent);
    expect(buildAuthoredModules()).toEqual([{ id: 'mod-booking', prose: 'Booking workflow prose.' }]);
  });

  it('unconfigured skill: withholds the prose (authoredModules empty)', async () => {
    h.bookingConfigured = false;
    await run(agent);
    expect(buildAuthoredModules()).toEqual([]);
  });
});
