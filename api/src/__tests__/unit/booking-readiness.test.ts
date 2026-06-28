import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (before the module-under-test import) ──────────────────────────────
//
// The booking `check` reads:
//   ServiceType.find        — active + onlineBookable services (gate filter)
//   AvailabilityRule.findOne — the bot's rule
//   BotTemplateVersion.findOne — expectedModules for the RESOLVED bound version
//   loadActiveCredential (calendar-provider) — the active calendar credential
//   resolveBoundTemplates (template-resolver) — the bot's resolved bindings
// We stub each so we can drive the truth table + enrichment cases.

const { state } = vi.hoisted(() => ({
  state: {
    serviceRows: [] as Array<{ id: string; bookingMode: string }>,
    ruleRow: null as any,
    templateVersionRow: null as any, // { expectedModules: string[] } | null
    activeCredential: null as any, // { provider, reauthRequired } | null
    resolvedTemplates: [] as Array<{ templateId: string | null; resolvedVersion: number | null }>,
  },
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => {
      const name = entity?.name;
      if (name === 'ServiceType') return { find: async () => state.serviceRows };
      if (name === 'AvailabilityRule') return { findOne: async () => state.ruleRow };
      if (name === 'BotTemplateVersion') return { findOne: async () => state.templateVersionRow };
      return { find: async () => [], findOne: async () => null };
    },
  },
}));

vi.mock('../../scheduler/calendar-provider', () => ({
  loadActiveCredential: async () => state.activeCredential,
}));

vi.mock('../../templates/template-resolver', () => ({
  resolveBoundTemplates: async () => state.resolvedTemplates,
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  isBookingConfigured,
  type BookingServiceGate,
} from '../../scheduler/booking-readiness';
import {
  bookingReadiness,
  parseHHMM,
  isValidWindow,
  hasNonEmptyWeeklyHours,
  hasUpcomingOpenOverride,
  hasEffectiveHours,
} from '../../readiness/capabilities/booking.readiness';
import type { ReadinessBotCtx, ReadinessResult } from '../../readiness/registry';

// ── Step 1: the no-op extraction truth table ─────────────────────────────────
//
// isBookingConfigured is the pure extraction of the former inline
// `agent.service.ts` expression:
//   bookingConfigured = hasRequestService || (hasAutoService && !!rule)

/** The literal expression the agent used inline before the extraction. */
function oldInline(services: Array<{ bookingMode: string }>, hasRule: boolean): boolean {
  const hasRequestService = services.some((s) => s.bookingMode === 'request');
  const hasAutoService = services.some((s) => s.bookingMode !== 'request');
  return hasRequestService || (hasAutoService && !!hasRule);
}

describe('isBookingConfigured — truth table (no-op extraction)', () => {
  const cells: Array<{
    label: string;
    services: BookingServiceGate[];
    hasRule: boolean;
    expected: boolean;
  }> = [
    { label: 'no service', services: [], hasRule: false, expected: false },
    { label: 'no service (but a rule exists)', services: [], hasRule: true, expected: false },
    { label: 'request-only (no rule)', services: [{ bookingMode: 'request' }], hasRule: false, expected: true },
    { label: 'request-only (rule exists)', services: [{ bookingMode: 'request' }], hasRule: true, expected: true },
    { label: 'auto + no rule', services: [{ bookingMode: 'auto' }], hasRule: false, expected: false },
    { label: 'auto + rule', services: [{ bookingMode: 'auto' }], hasRule: true, expected: true },
    {
      label: 'request + auto (no rule) — request makes it bookable',
      services: [{ bookingMode: 'request' }, { bookingMode: 'auto' }],
      hasRule: false,
      expected: true,
    },
  ];

  for (const c of cells) {
    it(`${c.label} ⇒ ${c.expected}`, () => {
      const got = isBookingConfigured(c.services, c.hasRule);
      expect(got).toBe(c.expected); // documented value
      expect(got).toBe(oldInline(c.services, c.hasRule)); // === OLD inline (no-op guarantee)
    });
  }

  it('treats any non-"request" mode as auto (matches the inline `!== request`)', () => {
    expect(isBookingConfigured([{ bookingMode: 'unknown' }], false)).toBe(false);
    expect(isBookingConfigured([{ bookingMode: 'unknown' }], true)).toBe(true);
  });
});

// ── Effective-hours helpers (numeric HH:MM parse, NOT lexicographic) ─────────

describe('parseHHMM / isValidWindow / hasNonEmptyWeeklyHours', () => {
  it('parses HH:MM to minutes-since-midnight; allows 24:00; rejects malformed', () => {
    expect(parseHHMM('09:00')).toBe(540);
    expect(parseHHMM('9:00')).toBe(540); // single-digit hour
    expect(parseHHMM('17:00')).toBe(1020);
    expect(parseHHMM('24:00')).toBe(1440); // allowed end marker
    expect(parseHHMM('24:01')).toBeNull();
    expect(parseHHMM('25:00')).toBeNull();
    expect(parseHHMM('09:60')).toBeNull();
    expect(parseHHMM('nine')).toBeNull();
    expect(parseHHMM('')).toBeNull();
  });

  it('isValidWindow requires numeric start < end (not lexicographic)', () => {
    expect(isValidWindow({ start: '09:00', end: '17:00' })).toBe(true);
    // Lexicographic compare would mis-rank '9:00' > '17:00'; numeric parse fixes it.
    expect(isValidWindow({ start: '9:00', end: '17:00' })).toBe(true);
    expect(isValidWindow({ start: '17:00', end: '09:00' })).toBe(false); // start >= end
    expect(isValidWindow({ start: '09:00', end: '09:00' })).toBe(false); // equal
    expect(isValidWindow({ start: 'x', end: '17:00' })).toBe(false); // un-parseable
    expect(isValidWindow(undefined)).toBe(false);
  });

  it('hasNonEmptyWeeklyHours — ≥1 weekday with a VALID window', () => {
    expect(hasNonEmptyWeeklyHours({ mon: [{ start: '09:00', end: '17:00' }] })).toBe(true);
    expect(hasNonEmptyWeeklyHours({ mon: [{ start: '9:00', end: '17:00' }] })).toBe(true);
    expect(hasNonEmptyWeeklyHours({ mon: [] })).toBe(false); // key present, empty array
    expect(hasNonEmptyWeeklyHours({})).toBe(false);
    expect(hasNonEmptyWeeklyHours(null)).toBe(false);
    expect(hasNonEmptyWeeklyHours(undefined)).toBe(false);
    // only malformed/empty windows
    expect(hasNonEmptyWeeklyHours({ mon: [{ start: '17:00', end: '09:00' }] })).toBe(false);
  });
});

describe('hasUpcomingOpenOverride / hasEffectiveHours — dateOverride cases', () => {
  const TODAY = '2026-06-29';
  const ruleWith = (overrides: any): any => ({
    availabilityMode: 'business_hours',
    weeklyHours: {},
    dateOverrides: overrides,
    timezone: 'UTC',
  });

  it('future non-closed override with a valid window ⇒ effective hours (any mode)', () => {
    const rule = ruleWith([{ date: '2026-07-01', windows: [{ start: '09:00', end: '12:00' }] }]);
    expect(hasUpcomingOpenOverride(rule, TODAY)).toBe(true);
    expect(hasEffectiveHours(rule, TODAY)).toBe(true);
  });

  it('today counts as upcoming', () => {
    const rule = ruleWith([{ date: TODAY, windows: [{ start: '09:00', end: '12:00' }] }]);
    expect(hasUpcomingOpenOverride(rule, TODAY)).toBe(true);
  });

  it('only PAST or closed overrides ⇒ no effective hours', () => {
    const past = ruleWith([{ date: '2026-01-01', windows: [{ start: '09:00', end: '12:00' }] }]);
    expect(hasUpcomingOpenOverride(past, TODAY)).toBe(false);
    expect(hasEffectiveHours(past, TODAY)).toBe(false);
    const closed = ruleWith([{ date: '2026-07-01', closed: true, windows: [{ start: '09:00', end: '12:00' }] }]);
    expect(hasUpcomingOpenOverride(closed, TODAY)).toBe(false);
    expect(hasEffectiveHours(closed, TODAY)).toBe(false);
  });

  it('always_open ⇒ effective hours regardless of weeklyHours/overrides', () => {
    expect(hasEffectiveHours({ availabilityMode: 'always_open', weeklyHours: {}, dateOverrides: [], timezone: 'UTC' } as any, TODAY)).toBe(true);
  });

  it('business_hours with empty weeklyHours and no upcoming override ⇒ NOT effective', () => {
    expect(hasEffectiveHours(ruleWith([]), TODAY)).toBe(false);
  });

  it('null rule ⇒ NOT effective', () => {
    expect(hasEffectiveHours(null, TODAY)).toBe(false);
  });
});

// ── check(): the anti-lying guarantee + enrichment ───────────────────────────

function ctxWith(overrides: Partial<{ calendarSync: boolean }> = {}): ReadinessBotCtx {
  return {
    tenantId: 't1',
    bot: { id: 'bot-1', templateBindings: [], templateId: null } as any,
    entitlements: {
      features: { bookings: true, calendarSync: overrides.calendarSync ?? true },
    } as any,
  };
}

const HEALTHY_CAL = { provider: 'google', reauthRequired: false };
const WEEKLY_OPEN = { mon: [{ start: '09:00', end: '17:00' }] };

function ruleBusinessHours(weeklyHours: any = WEEKLY_OPEN): any {
  return { availabilityMode: 'business_hours', weeklyHours, dateOverrides: [], timezone: 'UTC' };
}

beforeEach(() => {
  state.serviceRows = [];
  state.ruleRow = null;
  state.templateVersionRow = null;
  state.activeCredential = null;
  state.resolvedTemplates = [];
});

async function runCheck(ctx?: ReadinessBotCtx): Promise<ReadinessResult> {
  const out = await bookingReadiness.check(ctx ?? ctxWith());
  expect(out).toHaveLength(1);
  return out[0];
}

describe('bookingReadiness.appliesTo', () => {
  it('true iff effective bookings feature is true (pure read)', () => {
    expect(bookingReadiness.appliesTo(ctxWith())).toBe(true);
    const off = { tenantId: 't1', bot: { id: 'b' } as any, entitlements: { features: { bookings: false } } as any };
    expect(bookingReadiness.appliesTo(off)).toBe(false);
  });
});

describe('bookingReadiness.check — anti-lying: state==="live" iff isBookingConfigured', () => {
  const cells: Array<{ label: string; services: any[]; rule: any }> = [
    { label: 'no service', services: [], rule: null },
    { label: 'request-only', services: [{ id: 's', bookingMode: 'request' }], rule: null },
    { label: 'auto + no rule', services: [{ id: 's', bookingMode: 'auto' }], rule: null },
    { label: 'auto + rule', services: [{ id: 's', bookingMode: 'auto' }], rule: ruleBusinessHours() },
  ];
  for (const c of cells) {
    it(`${c.label}: check live === isBookingConfigured`, async () => {
      state.serviceRows = c.services;
      state.ruleRow = c.rule;
      state.activeCredential = HEALTHY_CAL;
      const r = await runCheck();
      const expectedLive = isBookingConfigured(c.services, !!c.rule);
      expect(r.state === 'live').toBe(expectedLive);
    });
  }
});

describe('bookingReadiness.check — request-only-ONLY bot has NO auto-confirm enrichment', () => {
  it('live, missingSteps [], willAutoConfirm false, NO calendar/sync/hours attention, NO calendar query', async () => {
    state.serviceRows = [{ id: 's', bookingMode: 'request' }];
    state.ruleRow = null;
    // A credential exists, but the check must NOT query it for a request-only bot.
    const loadSpy = vi.spyOn(await import('../../scheduler/calendar-provider'), 'loadActiveCredential');
    const r = await runCheck();
    expect(r.state).toBe('live');
    expect(r.missingSteps).toEqual([]);
    expect(r.detail?.willAutoConfirm).toBe(false);
    const codes = (r.attention ?? []).map((a) => a.code);
    expect(codes).not.toContain('calendar_not_connected');
    expect(codes).not.toContain('calendar_sync_disabled');
    expect(codes).not.toContain('availability_hours_missing');
    expect(r.detail?.calendar).toBeUndefined();
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });
});

describe('bookingReadiness.check — missingSteps empty when live (auto degraded)', () => {
  it('request + auto, no calendar ⇒ live, missingSteps [], calendar blocker in attention', async () => {
    state.serviceRows = [{ id: 'r', bookingMode: 'request' }, { id: 'a', bookingMode: 'auto' }];
    state.ruleRow = ruleBusinessHours();
    state.activeCredential = null; // no calendar
    const r = await runCheck();
    expect(r.state).toBe('live');
    expect(r.missingSteps).toEqual([]);
    expect(r.detail?.willAutoConfirm).toBe(false);
    expect((r.attention ?? []).map((a) => a.code)).toContain('calendar_not_connected');
  });

  it('auto-ONLY, no rule ⇒ not_ready and the rule IS a missingStep', async () => {
    state.serviceRows = [{ id: 'a', bookingMode: 'auto' }];
    state.ruleRow = null;
    const r = await runCheck();
    expect(r.state).toBe('not_ready');
    expect(r.missingSteps.map((s) => s.id)).toContain('set_hours');
  });

  it('no service ⇒ not_ready with add_service missingStep', async () => {
    state.serviceRows = [];
    state.ruleRow = null;
    const r = await runCheck();
    expect(r.state).toBe('not_ready');
    expect(r.missingSteps.map((s) => s.id)).toContain('add_service');
  });
});

describe('bookingReadiness.check — willAutoConfirm cases', () => {
  beforeEach(() => {
    state.serviceRows = [{ id: 'a', bookingMode: 'auto' }];
    state.ruleRow = ruleBusinessHours();
  });

  it('auto + effective hours + healthy + sync ⇒ willAutoConfirm true, no attention', async () => {
    state.activeCredential = HEALTHY_CAL;
    const r = await runCheck();
    expect(r.state).toBe('live');
    expect(r.detail?.willAutoConfirm).toBe(true);
    expect(r.attention).toBeUndefined();
    expect(r.detail?.calendar).toEqual({ state: 'healthy', provider: 'google' });
  });

  it('Outlook-only healthy + sync ⇒ willAutoConfirm true (provider-agnostic)', async () => {
    state.activeCredential = { provider: 'microsoft', reauthRequired: false };
    const r = await runCheck();
    expect(r.detail?.willAutoConfirm).toBe(true);
    expect((r.detail?.calendar as any)?.provider).toBe('microsoft');
  });

  it('empty weeklyHours business_hours ⇒ live but willAutoConfirm false + availability_hours_missing', async () => {
    state.ruleRow = ruleBusinessHours({}); // hasRule=true yet hasEffectiveHours=false
    state.activeCredential = HEALTHY_CAL;
    const r = await runCheck();
    expect(r.state).toBe('live'); // live keeps mirroring rule existence
    expect(r.detail?.willAutoConfirm).toBe(false);
    expect((r.attention ?? []).map((a) => a.code)).toContain('availability_hours_missing');
  });

  it('always_open ⇒ effective hours, hours step suppressed', async () => {
    state.ruleRow = { availabilityMode: 'always_open', weeklyHours: {}, dateOverrides: [], timezone: 'UTC' };
    state.activeCredential = HEALTHY_CAL;
    const r = await runCheck();
    expect(r.detail?.willAutoConfirm).toBe(true);
    expect((r.attention ?? []).map((a) => a.code)).not.toContain('availability_hours_missing');
  });

  it('calendar reauth_required ⇒ false + calendar_reauth_required attention/CTA Reconnect', async () => {
    state.activeCredential = { provider: 'google', reauthRequired: true };
    const r = await runCheck();
    expect(r.detail?.willAutoConfirm).toBe(false);
    expect((r.detail?.calendar as any)?.state).toBe('reauth_required');
    const att = (r.attention ?? []).find((a) => a.code === 'calendar_reauth_required');
    expect(att).toBeDefined();
    expect(att?.cta?.label).toMatch(/Reconnect/i);
  });

  it('calendar none ⇒ false + calendar_not_connected attention/CTA Connect', async () => {
    state.activeCredential = null;
    const r = await runCheck();
    expect(r.detail?.willAutoConfirm).toBe(false);
    expect((r.detail?.calendar as any)?.state).toBe('none');
    const att = (r.attention ?? []).find((a) => a.code === 'calendar_not_connected');
    expect(att?.cta?.label).toMatch(/Connect/i);
  });

  it('healthy but calendarSync disabled ⇒ false + calendar_sync_disabled attention', async () => {
    state.activeCredential = HEALTHY_CAL;
    const r = await runCheck(ctxWith({ calendarSync: false }));
    expect(r.detail?.willAutoConfirm).toBe(false);
    expect((r.attention ?? []).map((a) => a.code)).toContain('calendar_sync_disabled');
  });
});

describe('bookingReadiness.check — detail.bookingTemplateActive from RESOLVED version', () => {
  beforeEach(() => {
    // A live request-only bot — template lookup is independent of state.
    state.serviceRows = [{ id: 'r', bookingMode: 'request' }];
    state.ruleRow = null;
  });

  it('booking expected on the resolved version ⇒ true', async () => {
    state.resolvedTemplates = [{ templateId: 'tmpl-1', resolvedVersion: 3 }];
    state.templateVersionRow = { expectedModules: ['booking'] };
    const r = await runCheck();
    expect(r.detail?.bookingTemplateActive).toBe(true);
  });

  it('booking expected only on an OLDER (non-resolved) version ⇒ false (no published-version union)', async () => {
    state.resolvedTemplates = [{ templateId: 'tmpl-1', resolvedVersion: 5 }];
    // The findOne is scoped to the resolved (templateId, version=5); that row does NOT expect booking.
    state.templateVersionRow = { expectedModules: ['answering'] };
    const r = await runCheck();
    expect(r.detail?.bookingTemplateActive).toBe(false);
  });

  it('no booking template bound ⇒ false', async () => {
    state.resolvedTemplates = [];
    const r = await runCheck();
    expect(r.detail?.bookingTemplateActive).toBe(false);
  });
});
