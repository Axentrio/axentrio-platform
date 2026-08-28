import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { LLMProvider } from '../../llm/llm.types';

// `{openingHours}` must be fed by exactly ONE source per bot: operational
// Bot.settings.businessHours when configured, else the booking AvailabilityRule.
// The leftover-rule trap: an entitled-but-not-selected booking skill used to
// quote a stale availability rule and silently discard the businessHours the
// tenant set (which is also what the pre-AI off-hours gate uses). Operational
// hours now win even for a booking bot — AvailabilityRule still governs slots.

const mockProvider: LLMProvider = { chat: vi.fn() };
vi.mock('../../llm/provider-factory', () => ({ getProvider: () => mockProvider }));
vi.mock('../../billing/token-budget.service', () => ({
  isTokenBudgetExhausted: vi.fn().mockResolvedValue(false),
  recordTokenUsage: vi.fn().mockResolvedValue(undefined),
}));

// promptBuilder is stubbed, so there's no real block ledger to summarise. Without
// this the agent loop throws before it ever reaches the egress guard.
vi.mock('../../llm/block-ledger', () => ({ buildPromptTrace: () => ({}) }));

// The bot HAS a leftover booking availability rule (09:00–17:00 daily).
const RULE = {
  timezone: 'Europe/Brussels',
  availabilityMode: 'business_hours',
  weeklyHours: {
    mon: [{ start: '09:00', end: '17:00' }],
    tue: [{ start: '09:00', end: '17:00' }],
  },
};
// ...and one genuinely bookable service, so booking resolves CONFIGURED. Without it
// the skill-state drop removes the booking tools before the model sees them.
const SERVICE = {
  id: 'svc-1',
  name: 'Consult',
  bookingMode: 'auto',
  durationMin: 30,
  isActive: true,
  onlineBookable: true,
  priceDisplayType: 'none',
  customerAddressRequired: false,
};
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name?: string }) => {
      if (entity?.name === 'AvailabilityRule') return { findOne: async () => RULE };
      if (entity?.name === 'ServiceType') return { find: async () => [SERVICE], findOne: async () => SERVICE };
      return { find: async () => [], findOne: async () => null };
    },
  },
}));

// Tenant is entitled to booking, so listActiveModules reports the real booking
// module as active — but the bound template must still be the authority.
vi.mock('../../billing/entitlements', () => ({
  getEntitlements: async () => ({ billable: true, features: { bookings: true, lead_capture: true } }),
  invalidateEntitlements: async () => {},
}));

// …and the tenant set business hours in Settings.
const BUSINESS_HOURS = {
  enabled: true,
  timezone: 'Europe/Brussels',
  schedule: [
    { day: 'monday', open: '03:03', close: '19:19', closed: false },
    { day: 'tuesday', open: '03:03', close: '19:19', closed: false },
  ],
};
vi.mock('../../services/bot-config.service', () => ({
  getLlmRuntimeConfigForSession: async () => ({
    bot: { id: 'bot-1' } as any,
    botSettings: { businessHours: BUSINESS_HOURS, ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } as any,
    botAiSettings: { enabled: true, provider: 'openai', model: 'gpt-4o' } as any,
    apiKey: 'sk-test',
  }),
  getBotConfigForSession: async () => ({
    bot: { id: 'bot-1' } as any,
    settings: { businessHours: BUSINESS_HOURS, ai: { enabled: true } } as any,
  }),
}));

// The bound template selects lead capture ONLY — booking is entitled but not selected.
vi.mock('../../templates/template-resolver', () => ({
  resolveBoundTemplates: async () => [
    { templateId: 'tpl-1', resolvedVersion: 1, selectedSkillIds: ['lead_capture'], expectedModules: [], skillProse: {}, variables: [], category: null, body: 'Body.' },
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
const mockPromptBuilder = { build: vi.fn().mockReturnValue({ prompt: 'You are TestBot.', ledger: undefined }) };
const mockMetering = { record: vi.fn(), isOverBudget: vi.fn().mockResolvedValue(false) };
const mockTraceLogger = { save: vi.fn() };

const run = (agent: AgentService) =>
  agent.run('when are you open?', { id: 's1', tenantId: 't1', status: 'bot' } as any,
    { id: 't1', settings: { ai: { enabled: true } } } as any, []);

/** promptBuilder.build(…, specialties, skillProse, liveFields) — liveFields is arg 12. */
const liveFields = () =>
  mockPromptBuilder.build.mock.calls[0][12] as { services?: string; openingHours?: string; bookingHours?: string };
const toolNames = () => (mockPromptBuilder.build.mock.calls[0][2] as ToolAdapter[]).map((t) => t.name);

describe('AgentService — which source feeds {openingHours}', () => {
  let agent: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new AgentService(mockToolRegistry as any, mockPromptBuilder as any, mockMetering as any, mockTraceLogger as any);
    mockGetToolsForTenant.mockResolvedValue([tool('create_booking'), tool('check_availability'), tool('capture_lead'), tool('kb_search')]);
    (mockProvider.chat as any).mockResolvedValue({ content: 'Hi!', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });
    vi.stubEnv('COMPOSABLE_TEMPLATES_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a template that doesn't select booking gets NO booking tools", async () => {
    await run(agent);
    expect(toolNames()).not.toContain('create_booking');
    expect(toolNames()).toContain('capture_lead');
  });

  it("a bot without the booking skill uses the tenant's businessHours, not the leftover availability rule", async () => {
    await run(agent);
    const { openingHours, bookingHours } = liveFields();
    expect(openingHours).toContain('03:03');   // the businessHours the tenant actually set
    expect(openingHours).not.toContain('09:00'); // …not the booking rule it cannot use
    expect(bookingHours).toBe('');             // leftover rule must not feed {bookingHours}
  });

  it('a bot without the booking skill never advertises bookable services', async () => {
    await run(agent);
    expect(liveFields().services).toBe('');
  });

  // The tool-gate moved above `bookingActive`. The false-booking-claim guard must
  // NOT be narrowed with it: a bot whose template dropped its booking tools is the
  // likeliest to hallucinate "I've booked you in", and must still be corrected.
  it('a non-booking bot that falsely claims a booking is still caught', async () => {
    (mockProvider.chat as any).mockResolvedValue({
      content: "I've booked your appointment for Tuesday.",
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });
    const res: any = await run(agent);
    // it never reaches the customer: either corrected mid-run, or the safe fallback
    expect(res.content).not.toContain("I've booked");
    expect((mockProvider.chat as any).mock.calls.length).toBeGreaterThan(1); // correction re-run
  });

  it('a booking bot with operational hours configured speaks those, not the availability rule', async () => {
    const resolver = await import('../../templates/template-resolver');
    vi.spyOn(resolver, 'resolveBoundTemplates').mockResolvedValue([
      { templateId: 'tpl-1', resolvedVersion: 1, selectedSkillIds: ['booking'], expectedModules: [], skillProse: {}, variables: [], category: null, body: 'Body.' },
    ] as any);
    await run(agent);
    expect(toolNames()).toContain('create_booking');
    const { openingHours, bookingHours } = liveFields();
    expect(openingHours).toContain('03:03'); // operational hours win when both stores exist
    expect(openingHours).not.toContain('09:00');
    expect(bookingHours).toContain('09:00'); // {bookingHours} still uses the availability rule
    expect(bookingHours).not.toContain('03:03');
    // No travel service in the catalog ⇒ false; the flag still reaches the composer.
    expect(liveFields()).toMatchObject({ hasTravelServices: false });
  });
});
