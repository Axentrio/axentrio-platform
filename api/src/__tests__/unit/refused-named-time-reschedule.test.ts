/**
 * A reschedule time the notice refused must not come back a turn later.
 *
 * The booking path has had this memory since `refused-named-time.ts` landed, but
 * `reschedule_booking` carries the time in `newStartTime`, and the recorder read only
 * `startDate` / `startTime` / `preferredTime`. So a refused MOVE set the in-run flag and
 * persisted nothing, and the next turn re-offered the hour it had just refused.
 *
 * The refusal texts are the provider's own: `REQUEST_OUTSIDE_WINDOW` from a move the owner
 * approves, and `SLOT_UNAVAILABLE` with the not-offerable message from an auto-mode move or an
 * auto-book create. A TAKEN slot is the opposite case: it can free up, so it is never kept.
 *
 * Redis is faked in memory here, exactly as `refused-named-time.test.ts` fakes it, so the
 * real store, the real 24-hour `PX` expiry argument and the real "moved off that date"
 * rule all run. Nothing asserts a Redis call: every test reads what the customer is shown.
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
import {
  SLOT_NOT_OFFERABLE,
  SLOT_NOT_OFFERABLE_ON_RESCHEDULE,
  SLOT_TAKEN_ON_RESCHEDULE,
  rescheduleTooSoon,
} from '../../booking/booking-providers/slot-messages';

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

/** Monday 12 October 2026, 10:00 and 10:30 Brussels: the refused day, once its 10:00 is free again. */
const FREED_SLOTS = [
  { start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T08:30:00.000Z' },
  { start: '2026-10-12T08:30:00.000Z', end: '2026-10-12T09:00:00.000Z' },
];

function availability(slots: typeof MOVE_SLOTS) {
  return {
    success: true,
    data: { slots, timezone: 'Europe/Brussels' },
    availability: { slots, timezone: 'Europe/Brussels' },
  };
}

function refusal(error: string) {
  return { success: false, error, errorSafeForModel: true };
}

/**
 * A 14-day notice: from `NOW` the first time it takes is 19 October 09:00 UTC, so the provider
 * sends the customer to that week and 12 October is too soon.
 */
const NOTICE_REFUSAL = refusal(`REQUEST_OUTSIDE_WINDOW: ${rescheduleTooSoon('2026-10-19', '2026-10-25')}`);
const AUTO_MOVE_NOTICE_REFUSAL = refusal(`SLOT_UNAVAILABLE: ${SLOT_NOT_OFFERABLE_ON_RESCHEDULE}`);
const AUTO_CREATE_NOTICE_REFUSAL = refusal(`SLOT_UNAVAILABLE: ${SLOT_NOT_OFFERABLE}`);
const MOVE_SLOT_TAKEN = refusal(`SLOT_UNAVAILABLE: ${SLOT_TAKEN_ON_RESCHEDULE}`);

const SESSION = { id: 's-move', tenantId: 't1', status: 'bot' };
const TENANT = { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } };

/**
 * The customer names the HOUR only; the tool argument carries the day. That split is why the
 * recorder takes the date from the tool argument, and it is the shape that makes the memory
 * load-bearing: an unanchored "10:00" matches any day's 10:00 by clock alone.
 *
 * Monday 12 October 2026 at 10:00 is the time turn one refuses.
 */
const REFUSED_MOVE = 'Kan je mijn afspraak naar 10:00 verplaatsen?';
const REFUSED_CREATE = 'Kan ik om 10:00 langskomen?';
const TURN_ONE_REPLY = 'Dat tijdstip neemt het bedrijf niet aan.';

interface TurnOne {
  message: string;
  tool: string;
  args: Record<string, unknown>;
  result: ReturnType<typeof refusal>;
}

const MOVE = (result: ReturnType<typeof refusal>): TurnOne => ({
  message: REFUSED_MOVE,
  tool: 'reschedule_booking',
  args: { bookingId: 'bk-1', newStartTime: '2026-10-12T10:00:00' },
  result,
});

const CREATE = (result: ReturnType<typeof refusal>): TurnOne => ({
  message: REFUSED_CREATE,
  tool: 'create_booking',
  args: { startTime: '2026-10-12T10:00:00', name: 'Ada', email: 'ada@example.com' },
  result,
});

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

  /** Turn one: the customer names a time and the booking tool refuses it. */
  async function refuse(turn: TurnOne) {
    getToolsForTenant.mockResolvedValueOnce([
      toolReturning(turn.tool, turn.result, true),
      toolReturning('check_availability', availability(MOVE_SLOTS), false),
    ]);
    mockProvider.chat
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: turn.tool, arguments: turn.args }],
      })
      .mockResolvedValueOnce({
        content: TURN_ONE_REPLY,
        usage: { promptTokens: 60, completionTokens: 10 },
        finishReason: 'stop',
      });

    const first = await agent.run(turn.message, SESSION as never, TENANT as never, []);
    expect(first.type).toBe('response');
    return [
      { role: 'user' as const, content: turn.message },
      { role: 'assistant' as const, content: TURN_ONE_REPLY },
    ];
  }

  /** Turn two: a fresh availability list, and whatever the customer says next. */
  async function nextTurn(
    message: string,
    history: Awaited<ReturnType<typeof refuse>>,
    slots = MOVE_SLOTS,
  ) {
    const day = slots[0].start.slice(0, 10);
    getToolsForTenant.mockResolvedValueOnce([toolReturning('check_availability', availability(slots), false)]);
    mockProvider.chat
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_2', name: 'check_availability', arguments: { startDate: day, endDate: day } }],
      })
      .mockResolvedValueOnce({
        content: 'Kies hieronder een moment.',
        usage: { promptTokens: 60, completionTokens: 10 },
        finishReason: 'stop',
      });
    return agent.run(message, SESSION as never, TENANT as never, history);
  }

  function chipsOf(reply: Awaited<ReturnType<typeof nextTurn>>): unknown[] {
    expect(reply.type).toBe('response');
    return reply.type === 'response' ? reply.quickReplies ?? [] : [];
  }

  it('still lists the times on a later ja, instead of treating the refused hour as chosen', async () => {
    const history = await refuse(MOVE(NOTICE_REFUSAL));

    // Their "10:00" carries no day, so it matches Tuesday's 10:00 on the clock alone. Read
    // as a choice, the reply ships with NO times under "Kies hieronder een moment" and the
    // customer is asked to pick from an empty list - the hour they picked being the one the
    // notice refused a turn earlier.
    expect(chipsOf(await nextTurn('ja', history))).toHaveLength(2);
  });

  it('takes a different day the customer names, and stops listing times again', async () => {
    const history = await refuse(MOVE(NOTICE_REFUSAL));

    // Naming another day ends the refusal: 10:30 on Tuesday is free, they picked it, and
    // re-listing the same two hours under it is the loop the chips exist to avoid.
    expect(chipsOf(await nextTurn('dinsdag 20 oktober 2026 om 10:30 dan', history))).toHaveLength(0);
  });

  it.each([
    ['an auto-mode move', MOVE(AUTO_MOVE_NOTICE_REFUSAL)],
    ['an auto-book create', CREATE(AUTO_CREATE_NOTICE_REFUSAL)],
  ])('keeps a notice refusal of %s, which says SLOT_UNAVAILABLE, for the next turn', async (_label, turn) => {
    const history = await refuse(turn);

    // No change Request stands between the customer and the rule here, so the provider
    // answers with the not-offerable message. The rule is the same one: 12 October is inside
    // the notice, and a later "ja" must not read Tuesday's 10:00 as the hour they chose.
    expect(chipsOf(await nextTurn('ja', history))).toHaveLength(2);
  });

  it('forgets a move refused because the slot was taken, so the freed hour is offered as theirs', async () => {
    const history = await refuse(MOVE(MOVE_SLOT_TAKEN));

    // Somebody else held 12 October 10:00. By the next turn it is free again, and the check
    // lists it. That is the customer's own hour: kept as a refusal, it would come back as
    // retry chips under a "choose" for 24 hours, while the time they asked for is bookable.
    expect(chipsOf(await nextTurn('ja', history, FREED_SLOTS))).toHaveLength(0);
  });
});
