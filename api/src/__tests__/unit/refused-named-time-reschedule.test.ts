/**
 * A reschedule time the horizon refused must not come back a turn later.
 *
 * The booking path has had this memory since `refused-named-time.ts` landed, but
 * `reschedule_booking` carries the time in `newStartTime`, and the recorder read only
 * `startDate` / `startTime` / `preferredTime`. So a refused MOVE set the in-run flag and
 * persisted nothing, and the next turn re-offered the hour it had just refused.
 *
 * Redis is faked in memory here, exactly as `refused-named-time.test.ts` fakes it, so the
 * real store, the real 24-hour `PX` expiry argument and the real "moved off that date"
 * rule all run. Nothing asserts a Redis call: both tests read what the customer is shown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `set` writes the map before it returns, and `rememberRefusedNamedTime` calls it before
// its first await, so a fire-and-forget refusal is on record the moment the run records it.
// No flush, no timer.
const store = new Map<string, string>();
vi.mock('../../config/redis', () => ({
  getRedisClient: () => ({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    },
    del: async (k: string) => {
      store.delete(k);
      return 1;
    },
  }),
}));

const availabilityChecked = vi.hoisted(() => ({
  peekAvailabilityChecked: vi.fn(async (): Promise<string[] | null> => []),
  rememberAvailabilityChecked: vi.fn(async () => undefined),
  availabilityCheckedFor: vi.fn(async (): Promise<boolean | null> => null),
}));
vi.mock('../../booking/booking-providers/availability-checked', () => availabilityChecked);

const tokenBudget = vi.hoisted(() => ({
  isTokenBudgetExhausted: vi.fn().mockResolvedValue(false),
  recordTokenUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../billing/token-budget.service', () => tokenBudget);

const mockProvider = { chat: vi.fn() };
vi.mock('../../llm/provider-factory', () => ({ getProvider: () => mockProvider }));

vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ find: async () => [] }) },
}));

vi.mock('../../llm/localize', () => ({
  localizeMessage: async (message: string) => message,
}));

const BOT_CONFIG = {
  bot: { id: 'bot-anchor' },
  settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } },
};
vi.mock('../../services/bot-config.service', () => ({
  getLlmRuntimeConfigForSession: async () => ({
    bot: BOT_CONFIG.bot,
    botSettings: BOT_CONFIG.settings,
    botAiSettings: BOT_CONFIG.settings.ai,
    apiKey: 'sk-test',
  }),
  getBotConfigForSession: async () => BOT_CONFIG,
}));

import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter, ToolResult } from '../../agent/tool-adapter';
import { createBlockLedger } from '../../llm/block-ledger';

/**
 * Every date here is read against the clock, because a slot in the past is offerable to
 * nobody. `NOW` pins it, so "the customer named a free time" stays the same fact next year.
 */
const NOW = new Date('2026-10-05T09:00:00.000Z');

/** Tuesday 20 October 2026, 10:00 and 10:30 Brussels. */
const MOVE_SLOTS = [
  { start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T08:30:00.000Z' },
  { start: '2026-10-20T08:30:00.000Z', end: '2026-10-20T09:00:00.000Z' },
];

const AVAILABILITY_RESULT = {
  success: true,
  data: { slots: MOVE_SLOTS, timezone: 'Europe/Brussels' },
  availability: { slots: MOVE_SLOTS, timezone: 'Europe/Brussels' },
};

const HORIZON_REFUSAL = {
  success: false,
  error:
    'REQUEST_OUTSIDE_WINDOW: That time is further ahead than the business books. The existing appointment has NOT been changed.',
  errorSafeForModel: true,
};

const SESSION = { id: 's-move', tenantId: 't1', status: 'bot' };
const TENANT = { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } };

/**
 * The customer names the HOUR only; `newStartTime` carries the day. That split is why the
 * recorder takes the date from the tool argument, and it is the shape that makes the memory
 * load-bearing: an unanchored "10:00" matches any day's 10:00 by clock alone.
 *
 * Monday 12 October 2026 at 10:00 is the move the horizon refuses in turn one.
 */
const REFUSED_MOVE = 'Kan je mijn afspraak naar 10:00 verplaatsen?';
const TURN_ONE_REPLY = 'Dat tijdstip neemt het bedrijf niet aan.';

/**
 * A fresh adapter per turn, because each turn asserts against its own call record and a
 * shared `vi.fn` would carry the previous turn's calls into it.
 */
function toolReturning(name: string, result: unknown, hasSideEffects: boolean): ToolAdapter {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    hasSideEffects,
    execute: vi.fn().mockResolvedValue(result as ToolResult),
  } as unknown as ToolAdapter;
}

describe('a refused reschedule time is remembered for the conversation', () => {
  let agent: AgentService;
  let getToolsForTenant: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.clear();
    // Date only: the run awaits real promises, and faking the timer queue would hang them.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    tokenBudget.isTokenBudgetExhausted.mockResolvedValue(false);
    availabilityChecked.peekAvailabilityChecked.mockResolvedValue([]);
    getToolsForTenant = vi.fn();
    agent = new AgentService(
      { getToolsForTenant, getBuiltinToolNames: vi.fn() } as never,
      { build: vi.fn().mockReturnValue({ prompt: 'You are TestBot.', ledger: createBlockLedger([]) }) } as never,
      { record: vi.fn(), isOverBudget: vi.fn().mockResolvedValue(false) } as never,
      { save: vi.fn() } as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Turn one: the customer names a move time and the horizon refuses it. */
  async function refuseTheMove(): Promise<void> {
    getToolsForTenant.mockResolvedValueOnce([
      toolReturning('reschedule_booking', HORIZON_REFUSAL, true),
      toolReturning('check_availability', AVAILABILITY_RESULT, false),
    ]);
    mockProvider.chat
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'tc_1',
            name: 'reschedule_booking',
            arguments: { bookingId: 'bk-1', newStartTime: '2026-10-12T10:00:00' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: TURN_ONE_REPLY,
        usage: { promptTokens: 60, completionTokens: 10 },
        finishReason: 'stop',
      });

    const first = await agent.run(REFUSED_MOVE, SESSION as never, TENANT as never, []);
    expect(first.type).toBe('response');
  }

  const historyAfterRefusal = [
    { role: 'user' as const, content: REFUSED_MOVE },
    { role: 'assistant' as const, content: TURN_ONE_REPLY },
  ];

  /** Turn two: a fresh availability list, and whatever the customer says next. */
  async function nextTurn(message: string) {
    getToolsForTenant.mockResolvedValueOnce([toolReturning('check_availability', AVAILABILITY_RESULT, false)]);
    mockProvider.chat
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'tc_2', name: 'check_availability', arguments: { startDate: '2026-10-20', endDate: '2026-10-20' } },
        ],
      })
      .mockResolvedValueOnce({
        content: 'Kies hieronder een moment.',
        usage: { promptTokens: 60, completionTokens: 10 },
        finishReason: 'stop',
      });
    return agent.run(message, SESSION as never, TENANT as never, historyAfterRefusal);
  }

  it('still lists the times on a later ja, instead of treating the refused hour as chosen', async () => {
    await refuseTheMove();

    // Their "10:00" carries no day, so it matches Tuesday's 10:00 on the clock alone. Read
    // as a choice, the reply ships with NO times under "Kies hieronder een moment" and the
    // customer is asked to pick from an empty list - the hour they picked being the one the
    // horizon refused a turn earlier.
    const later = await nextTurn('ja');

    expect(later.type).toBe('response');
    if (later.type === 'response') {
      expect(later.quickReplies ?? []).toHaveLength(2);
    }
  });

  it('takes a different day the customer names, and stops listing times again', async () => {
    await refuseTheMove();

    // Naming another day ends the refusal: 10:30 on Tuesday is free, they picked it, and
    // re-listing the same two hours under it is the loop the chips exist to avoid.
    const later = await nextTurn('dinsdag 20 oktober 2026 om 10:30 dan');

    expect(later.type).toBe('response');
    if (later.type === 'response') {
      expect(later.quickReplies ?? []).toHaveLength(0);
    }
  });
});
