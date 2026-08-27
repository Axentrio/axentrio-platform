import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Since #86 the controller resolves a NAMED Agent (defaulting to the anchor) rather than the
// anchor by construction, so the seam these tests mock moved with it.
const resolveTargetBot = vi.fn();
const replaceBotSettingsSection = vi.fn();
vi.mock('../../services/bot-config.service', () => ({
  resolveTargetBot: (...a: any[]) => resolveTargetBot(...a),
  replaceBotSettingsSection: (...a: any[]) => replaceBotSettingsSection(...a),
}));

const requireFeature = vi.fn();
vi.mock('../../billing/enforce', () => ({ requireFeature: (...a: any[]) => requireFeature(...a) }));

// The config READ now answers "may travel time be switched on", which needs the entitlement.
// Mocked at the seam rather than by teaching the DataSource stub about tenants: this file is
// about the controller, and `getEntitlements` has its own tests.
const getEntitlements = vi.fn(async (..._a: any[]) => ({ features: { travelTime: true } }));
vi.mock('../../billing/entitlements', () => ({ getEntitlements: (...a: any[]) => getEntitlements(...a) }));

const resolveItineraryKey = vi.fn(async () => 'gcal:owner@acme.com');
const itineraryKeyIsShared = vi.fn(async () => false);
vi.mock('../../scheduler/itinerary-key', () => ({
  resolveItineraryKey: (...a: any[]) => resolveItineraryKey(...(a as [])),
  itineraryKeyIsShared: (...a: any[]) => itineraryKeyIsShared(...(a as [])),
}));

// Only `config.travel` is overridden — the controller's dependency graph pulls in the
// calendar services, which read half a dozen other config sections and fail to load
// against a stub.
const { travelConfig } = vi.hoisted(() => ({
  travelConfig: { googleMapsApiKey: 'key-1' as string | undefined, monthlyElementCapPerTenant: 5000 },
}));
vi.mock('../../config/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/environment')>();
  return { ...actual, config: { ...actual.config, travel: travelConfig } };
});

const etFindOne = vi.fn();
const etSave = vi.fn((x) => x);
const etUpdate = vi.fn(async (_where: any, _patch: any) => ({ affected: 1 }));
const etCount = vi.fn(async () => 0);
const etFind = vi.fn(async () => []);
const ruleFindOne = vi.fn();
const ruleSave = vi.fn((x) => x);
const managerQuery = vi.fn(async (..._a: any[]) => [] as any[]);
const bsFindOne = vi.fn(async () => null as any);
const bsSave = vi.fn((x) => x);
// PR 1a: a venue write resolves the tenant's operating country for the
// businessTimezone recompute. BE = the platform default.
const tenantFindOne = vi.fn(async () => ({ id: 'ten-1', operatingCountry: 'BE' } as any));
function repoFor(entity: any) {
  const name = entity?.name || entity;
  if (name === 'ServiceType') return { findOne: etFindOne, find: etFind, count: etCount, create: (d: any) => d, save: etSave, update: etUpdate };
  if (name === 'AvailabilityRule') return { findOne: ruleFindOne, create: (d: any) => d, save: ruleSave };
  if (name === 'BookingSettings') return { findOne: bsFindOne, create: (d: any) => d, save: bsSave };
  if (name === 'Tenant') return { findOne: tenantFindOne };
  return {};
}
/** The booking-settings upsert now runs inside a transaction (PR 1a: the venue
 *  and the businessTimezone it implies commit together), so upsert-shape
 *  assertions scan BOTH the datasource handle and the transaction manager's. */
const allQueryCalls = () => [...dsQuery.mock.calls, ...managerQuery.mock.calls];
// `query` was missing here, and no test exercised the booking-settings upsert — so the one
// statement in this controller that hand-computes positional parameters was covered by
// nothing at all, and a mock that lacked the method still went green.
const dsQuery = vi.fn(async (..._a: any[]) => [] as any[]);
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => repoFor(entity),
    manager: { getRepository: (entity: any) => repoFor(entity) },
    query: (...a: any[]) => dsQuery(...a),
    transaction: (cb: any) => cb({ query: managerQuery, getRepository: (entity: any) => repoFor(entity) }),
  },
}));

const sendSuccess = vi.fn();
vi.mock('../../utils/response', () => ({ sendSuccess: (...a: any[]) => sendSuccess(...a) }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { updateSchedulerConfig, getSchedulerConfig, createService, updateService, listPresets, applyPreset, reorderServices } from '../../scheduler/scheduler.controller';
import { serviceInputSchema, serviceCreateSchema, serviceUpdateSchema } from '../../schemas/scheduler.schema';

/**
 * The config READ tells the screen why travel cannot be switched on.
 *
 * The WRITE already refuses each of these with a 409, so this is not the enforcement — it is
 * the difference between a screen that explains itself and one that lets an owner flip a
 * switch, wait, and read an error. The shared-diary case matters most: it is the feature's one
 * genuinely harmful state, it arrives months later when somebody connects a calendar, and the
 * fix ("give each Agent its own calendar") is an action the owner can only take if told.
 */
describe('scheduler.controller — why travel time cannot be switched on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', name: 'Valyro', settings: { integrations: {} } });
    etFindOne.mockResolvedValue(null);
    etFind.mockResolvedValue([]);
    ruleFindOne.mockResolvedValue(null);
    bsFindOne.mockResolvedValue(null);
    resolveItineraryKey.mockResolvedValue('gcal:owner@acme.com');
  });

  const read = async () => {
    await getSchedulerConfig({ tenantId: 'ten-1' } as any, res);
    return sendSuccess.mock.calls.at(-1)?.[1] as any;
  };

  it('is null when all four gates would pass', async () => {
    itineraryKeyIsShared.mockResolvedValue(false);
    getEntitlements.mockResolvedValue({ features: { travelTime: true } } as any);
    expect((await read()).travel.blockedReason).toBeNull();
  });

  it('reports a shared diary, which is the one an owner can act on', async () => {
    itineraryKeyIsShared.mockResolvedValue(true);
    getEntitlements.mockResolvedValue({ features: { travelTime: true } } as any);
    expect((await read()).travel.blockedReason).toBe('shared_itinerary');
  });

  it('reports the entitlement BEFORE asking about diaries', async () => {
    // Cheapest-first, and it also stops an unentitled tenant being told to go and rearrange
    // their calendars for a capability they have not bought.
    itineraryKeyIsShared.mockClear();
    getEntitlements.mockResolvedValue({ features: { travelTime: false } } as any);
    expect((await read()).travel.blockedReason).toBe('not_entitled');
    expect(itineraryKeyIsShared).not.toHaveBeenCalled();
  });

  it('does not refuse an unrelated Save just because travel is already on and now blocked', async () => {
    // THE LOCKOUT. A tenant enables travel, somebody connects a second Agent to the calendar
    // months later, and the stored preference is deliberately left alone — travel goes inert
    // and returns by itself when the diaries separate. The editor keeps sending `enabled: true`,
    // so gating on the VALUE rather than on a TRANSITION made every Save of the whole page 409:
    // venue, opening hours and the pause switch with it. An owner locked out of their booking
    // settings by a state they did not create and could not clear.
    bsFindOne.mockResolvedValue({ travelTimeEnabled: true } as any);
    itineraryKeyIsShared.mockResolvedValue(true);
    getEntitlements.mockResolvedValue({ features: { travelTime: true } } as any);

    await expect(
      updateSchedulerConfig(
        { tenantId: 'ten-1', body: { venueAddress: { city: 'Gent' }, travel: { enabled: true } } } as any,
        res
      )
    ).resolves.not.toThrow();
  });

  it('still refuses to switch travel ON while the diary is shared', async () => {
    bsFindOne.mockResolvedValue({ travelTimeEnabled: false } as any);
    itineraryKeyIsShared.mockResolvedValue(true);
    getEntitlements.mockResolvedValue({ features: { travelTime: true } } as any);

    await expect(
      updateSchedulerConfig({ tenantId: 'ten-1', body: { travel: { enabled: true } } } as any, res)
    ).rejects.toMatchObject({ code: 'TRAVEL_SHARED_ITINERARY' });
  });

  it('names the Agent these settings belong to', async () => {
    // Every field on that object is the DEFAULT Agent's, because that is the only row the
    // endpoint can write (#86). An owner of several Agents edits one and cannot otherwise tell.
    getEntitlements.mockResolvedValue({ features: { travelTime: true } } as any);
    expect((await read()).agent).toMatchObject({ id: expect.any(String) });
  });
});

const res: any = {};

describe('scheduler.controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: { integrations: {} } });
    etFindOne.mockResolvedValue(null);
    ruleFindOne.mockResolvedValue(null);
  });

  it('sets provider=internal (gated), upserts event type and availability', async () => {
    const req: any = {
      tenantId: 'ten-1',
      body: {
        provider: 'internal',
        eventType: { name: 'Intro call', durationMin: 30 },
        availability: { timezone: 'Europe/Brussels', weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] } },
      },
    };
    await updateSchedulerConfig(req, res);

    expect(requireFeature).toHaveBeenCalledWith('ten-1', 'bookings', expect.any(String));
    // Bot id FIRST since #86: the provider used to be written onto the anchor's settings
    // whatever Agent was being edited, so editing Agent B mutated Agent A.
    expect(replaceBotSettingsSection).toHaveBeenCalledWith('bot-1', 'ten-1', 'integrations', { provider: 'internal' });
    // Event type saved with a derived slug. The inheritable timing fields are NOT stamped
    // with schema defaults any more — an unsent maxHorizonDays stays undefined so the
    // service inherits the business default, which is the whole point of making them
    // nullable. A default here would have made "unset" unreachable.
    expect(etSave).toHaveBeenCalledOnce();
    expect(etSave.mock.calls[0][0]).toMatchObject({ name: 'Intro call', slug: 'intro-call', durationMin: 30 });
    expect(etSave.mock.calls[0][0].maxHorizonDays).toBeUndefined();
    expect(ruleSave).toHaveBeenCalledOnce();
    expect(ruleSave.mock.calls[0][0]).toMatchObject({ timezone: 'Europe/Brussels', slotGranularityMin: 30 });
    expect(sendSuccess).toHaveBeenCalled();
  });

  it('accepts availability without timezone and derives the server-owned value', async () => {
    const req: any = {
      tenantId: 'ten-1',
      body: { availability: { weeklyHours: { fri: [{ start: '09:00', end: '17:00' }] } } },
    };

    await updateSchedulerConfig(req, res);

    expect(ruleSave).toHaveBeenCalledOnce();
    expect(ruleSave.mock.calls[0][0]).toMatchObject({ timezone: 'Europe/Brussels' });
  });

  it('gates every write and normalizes a legacy calcom provider input to internal', async () => {
    // Cal.com is shelved: a `provider: 'calcom'` payload is still Pro+-gated and
    // persisted as internal rather than re-enabling the Cal.com path.
    const req: any = { tenantId: 'ten-1', body: { provider: 'calcom' } };
    await updateSchedulerConfig(req, res);
    expect(requireFeature).toHaveBeenCalledWith('ten-1', 'bookings', expect.any(String));
    // Bot id FIRST since #86: the provider used to be written onto the anchor's settings
    // whatever Agent was being edited, so editing Agent B mutated Agent A.
    expect(replaceBotSettingsSection).toHaveBeenCalledWith('bot-1', 'ten-1', 'integrations', { provider: 'internal' });
  });

  it('rejects an empty update', async () => {
    const req: any = { tenantId: 'ten-1', body: {} };
    await expect(updateSchedulerConfig(req, res)).rejects.toBeTruthy();
  });

  it('reads the current config shape', async () => {
    etFindOne.mockResolvedValue({ id: 'et-1', name: 'Intro call' });
    ruleFindOne.mockResolvedValue({ id: 'r-1', timezone: 'Europe/Brussels' });
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: { integrations: { provider: 'internal' } } });
    const req: any = { tenantId: 'ten-1' };
    await getSchedulerConfig(req, res);
    expect(sendSuccess.mock.calls[0][1]).toMatchObject({
      provider: 'internal',
      eventType: { id: 'et-1' },
      availability: { id: 'r-1' },
    });
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('intake questions schema (P3a)', () => {
  const base = { name: 'Cut', durationMin: 30 };

  it('strips options off a text question (preprocess) instead of 400ing', () => {
    const out = serviceInputSchema.parse({ ...base, intakeQuestions: [{ label: 'Notes', type: 'text', required: false, options: ['stale'] }] });
    expect(out.intakeQuestions![0]).not.toHaveProperty('options');
  });

  it('requires 2–10 options for a choice question', () => {
    expect(() => serviceInputSchema.parse({ ...base, intakeQuestions: [{ label: 'Size', type: 'choice', required: true, options: ['S'] }] })).toThrow();
    expect(() => serviceInputSchema.parse({ ...base, intakeQuestions: [{ label: 'Size', type: 'choice', required: true, options: ['S', 'M'] }] })).not.toThrow();
  });

  it('rejects duplicate options case-insensitively after trim', () => {
    expect(() => serviceInputSchema.parse({ ...base, intakeQuestions: [{ label: 'X', type: 'choice', required: false, options: ['VIP', ' vip '] }] })).toThrow();
  });

  it('rejects more than 8 questions and whitespace-only labels', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ label: `q${i}`, type: 'text', required: false }));
    expect(() => serviceInputSchema.parse({ ...base, intakeQuestions: nine })).toThrow();
    expect(() => serviceInputSchema.parse({ ...base, intakeQuestions: [{ label: '   ', type: 'text', required: false }] })).toThrow();
  });

  it('rejects an explicit null (clearing is [], never null)', () => {
    expect(() => serviceInputSchema.parse({ ...base, intakeQuestions: null })).toThrow();
  });
});

describe('intake questions id reconciliation (P3a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: {} });
    etFindOne.mockResolvedValue(null);
  });

  it('mints fresh uuids for every question on create', async () => {
    const req: any = {
      tenantId: 'ten-1',
      body: { name: 'Cut', durationMin: 30, intakeQuestions: [
        { id: 'client-temp-1', label: 'Occasion?', type: 'text', required: true },
        { label: 'Length?', type: 'choice', required: false, options: ['Short', 'Long'] },
      ] },
    };
    await createService(req, res);
    const saved = etSave.mock.calls[0][0];
    expect(saved.intakeQuestions).toHaveLength(2);
    expect(saved.intakeQuestions[0].id).toMatch(UUID_RE);
    expect(saved.intakeQuestions[0].id).not.toBe('client-temp-1'); // client id never honored on create
    expect(saved.intakeQuestions[1]).toMatchObject({ type: 'choice', options: ['Short', 'Long'] });
  });

  it('preserves the authoring fields through reconciliation', async () => {
    // reconcileIntakeQuestions rebuilds each question FIELD BY FIELD rather than spreading,
    // deliberately, so a client cannot invent properties. The cost is that a field added to
    // the type and forgotten here is silently discarded on every save, with no error
    // anywhere — which is exactly what happened to all four of these the first time.
    const req: any = {
      tenantId: 'ten-1',
      body: { name: 'Cut', durationMin: 30, intakeQuestions: [
        {
          label: 'Which floor?', type: 'text', required: true,
          aiInstruction: 'Only if it is a flat', exampleAnswer: 'Second',
          active: false, includeInCalendar: false,
        },
      ] },
    };
    await createService(req, res);
    expect(etSave.mock.calls[0][0].intakeQuestions[0]).toMatchObject({
      label: 'Which floor?',
      aiInstruction: 'Only if it is a flat',
      exampleAnswer: 'Second',
      active: false,
      includeInCalendar: false,
    });
  });

  it('stores no key for the default true values', async () => {
    // Absent means "ask it" and "show it". Writing them explicitly would add noise to every
    // stored question for no change in meaning, and would make the absent case look like a
    // legacy row rather than the norm.
    const req: any = {
      tenantId: 'ten-1',
      body: { name: 'Cut', durationMin: 30, intakeQuestions: [
        { label: 'Which floor?', type: 'text', required: true, active: true, includeInCalendar: true },
      ] },
    };
    await createService(req, res);
    const q = etSave.mock.calls[0][0].intakeQuestions[0];
    expect(q).not.toHaveProperty('active');
    expect(q).not.toHaveProperty('includeInCalendar');
  });

  it('drops a whitespace-only steer rather than storing it', async () => {
    const req: any = {
      tenantId: 'ten-1',
      body: { name: 'Cut', durationMin: 30, intakeQuestions: [
        { label: 'Which floor?', type: 'text', required: true, aiInstruction: '   ' },
      ] },
    };
    await createService(req, res);
    expect(etSave.mock.calls[0][0].intakeQuestions[0]).not.toHaveProperty('aiInstruction');
  });

  it('keeps a matching stored id, remints an unknown id, drops an absent one', async () => {
    etFindOne.mockResolvedValue({
      id: 'svc-1', botId: 'bot-1',
      intakeQuestions: [
        { id: 'stored-keep', label: 'Old keep', type: 'text', required: false },
        { id: 'stored-drop', label: 'Old drop', type: 'text', required: false },
      ],
    });
    const req: any = {
      tenantId: 'ten-1', params: { id: 'svc-1' },
      body: { intakeQuestions: [
        { id: 'stored-keep', label: 'Renamed', type: 'text', required: true },
        { id: 'forged-zzz', label: 'New one', type: 'text', required: false },
      ] },
    };
    await updateService(req, res);
    const saved = etSave.mock.calls[0][0];
    expect(saved.intakeQuestions.map((q: any) => q.id)).toEqual(['stored-keep', expect.stringMatching(UUID_RE)]);
    expect(saved.intakeQuestions[1].id).not.toBe('forged-zzz');
    expect(saved.intakeQuestions.find((q: any) => q.id === 'stored-drop')).toBeUndefined();
  });

  it('collapses [] to null (clear) and leaves questions untouched when the key is absent', async () => {
    etFindOne.mockResolvedValue({ id: 'svc-1', botId: 'bot-1', intakeQuestions: [{ id: 's1', label: 'Q', type: 'text', required: false }] });
    await updateService({ tenantId: 'ten-1', params: { id: 'svc-1' }, body: { intakeQuestions: [] } } as any, res);
    expect(etSave.mock.calls[0][0].intakeQuestions).toBeNull();

    etSave.mockClear();
    etFindOne.mockResolvedValue({ id: 'svc-1', botId: 'bot-1', intakeQuestions: [{ id: 's1', label: 'Q', type: 'text', required: false }] });
    await updateService({ tenantId: 'ten-1', params: { id: 'svc-1' }, body: { description: 'x' } } as any, res);
    expect(etSave.mock.calls[0][0].intakeQuestions).toEqual([{ id: 's1', label: 'Q', type: 'text', required: false }]);
  });

  it('first occurrence wins on a duplicate submitted id', async () => {
    etFindOne.mockResolvedValue({ id: 'svc-1', botId: 'bot-1', intakeQuestions: [{ id: 'dup', label: 'Q', type: 'text', required: false }] });
    const req: any = {
      tenantId: 'ten-1', params: { id: 'svc-1' },
      body: { intakeQuestions: [
        { id: 'dup', label: 'first', type: 'text', required: false },
        { id: 'dup', label: 'second', type: 'text', required: false },
      ] },
    };
    await updateService(req, res);
    const ids = etSave.mock.calls[0][0].intakeQuestions.map((q: any) => q.id);
    expect(ids[0]).toBe('dup');
    expect(ids[1]).toMatch(UUID_RE);
    expect(ids[1]).not.toBe('dup');
  });
});

describe('locationType side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: {} });
    etFindOne.mockResolvedValue(null);
  });

  it('forces customer_location to require an address on create', async () => {
    await createService(
      {
        tenantId: 'ten-1',
        body: { name: 'Visit', durationMin: 60, locationType: 'customer_location', customerAddressRequired: false },
      } as any,
      res,
    );
    expect(etSave.mock.calls[0][0]).toMatchObject({
      locationType: 'customer_location',
      customerAddressRequired: true,
      customerChoosesLocation: false,
    });
  });

  it('clears the address flag for business_location on create', async () => {
    await createService(
      {
        tenantId: 'ten-1',
        body: { name: 'Cut', durationMin: 30, locationType: 'business_location', customerAddressRequired: true },
      } as any,
      res,
    );
    expect(etSave.mock.calls[0][0]).toMatchObject({
      locationType: 'business_location',
      customerAddressRequired: false,
    });
  });
});

describe('presets endpoints (P4a)', () => {
  const res: any = {};
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: {} });
    etFindOne.mockResolvedValue(null); // uniqueSlug → base slug first try
    etCount.mockResolvedValue(0); // empty catalog
    etFind.mockResolvedValue([]); // re-read
    ruleFindOne.mockResolvedValue(null); // no existing availability
    managerQuery.mockResolvedValue([]);
  });

  it('lists preset summaries (gated)', async () => {
    await listPresets({ tenantId: 'ten-1' } as any, res);
    expect(requireFeature).toHaveBeenCalledWith('ten-1', 'bookings', expect.any(String));
    const payload = sendSuccess.mock.calls[0][1];
    expect(payload.presets.length).toBeGreaterThanOrEqual(5);
    expect(payload.presets[0]).toMatchObject({ key: expect.any(String), serviceCount: expect.any(Number) });
  });

  it('applies a preset on an empty catalog: seeds services in order + inserts availability', async () => {
    await applyPreset({ tenantId: 'ten-1', params: { key: 'barber' } } as any, res);
    // per-bot advisory lock taken to serialize concurrent applies
    expect(managerQuery.mock.calls.some((c) => String(c[0]).includes('pg_advisory_xact_lock'))).toBe(true);
    // Barber has 3 services, created with sortOrder 0,1,2
    expect(etSave).toHaveBeenCalledTimes(3);
    expect(etSave.mock.calls.map((c) => c[0].sortOrder)).toEqual([0, 1, 2]);
    // availability inserted via raw ON CONFLICT, jsonb params JSON-stringified
    const insert = managerQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_availability_rules'));
    expect(insert).toBeDefined();
    expect(insert![1]).toContain('Europe/Brussels');
    expect(insert![1].some((p: any) => typeof p === 'string' && p.startsWith('{') && p.includes('mon'))).toBe(true);
  });

  it('preserves an existing AvailabilityRule (no insert)', async () => {
    ruleFindOne.mockResolvedValue({ id: 'r-1' });
    await applyPreset({ tenantId: 'ten-1', params: { key: 'barber' } } as any, res);
    expect(etSave).toHaveBeenCalledTimes(3); // services still seeded
    const insert = managerQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_availability_rules'));
    expect(insert).toBeUndefined();
  });

  it('rejects a non-empty catalog with 409 CATALOG_NOT_EMPTY', async () => {
    etCount.mockResolvedValue(2);
    await expect(applyPreset({ tenantId: 'ten-1', params: { key: 'barber' } } as any, res)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_NOT_EMPTY',
    });
    expect(etSave).not.toHaveBeenCalled();
  });

  it('rejects an unknown preset key with 404 PRESET_NOT_FOUND', async () => {
    await expect(applyPreset({ tenantId: 'ten-1', params: { key: 'nope' } } as any, res)).rejects.toMatchObject({
      statusCode: 404,
      code: 'PRESET_NOT_FOUND',
    });
  });
});

/**
 * The booking-settings upsert: one statement, eighteen positional parameters, and the
 * parameter numbers computed in a loop from `params.length`. A column bound one slot off
 * writes the minimum gap into the default buffer and nothing ever throws — which is why
 * these assertions decode the generated SQL rather than matching it as a string.
 */
describe('scheduler.controller · booking settings upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: { integrations: {} } });
    etFindOne.mockResolvedValue(null);
    ruleFindOne.mockResolvedValue(null);
    bsFindOne.mockResolvedValue(null);
  });

  const RULE_COLUMNS: Record<string, string> = {
    maxBookingsPerDay: 'max_bookings_per_day',
    maxBookedMinutesPerDay: 'max_booked_minutes_per_day',
    minGapMin: 'min_gap_min',
    defaultBufferBeforeMin: 'default_buffer_before_min',
    defaultBufferAfterMin: 'default_buffer_after_min',
    defaultMinNoticeMin: 'default_min_notice_min',
    defaultMaxHorizonDays: 'default_max_horizon_days',
  };

  const save = async (body: Record<string, unknown>) => {
    await updateSchedulerConfig({ tenantId: 'ten-1', body } as any, res);
    const call = allQueryCalls().find((c) => String(c[0]).includes('chatbot_booking_settings'));
    return call ? { sql: String(call[0]), params: call[1] as unknown[] } : null;
  };

  /** Resolve what a column actually binds to, by reading its CASE arm out of the SQL. */
  const bound = (q: { sql: string; params: unknown[] }, column: string) => {
    const m = new RegExp(`(?:^|, )${column} = CASE WHEN \\$(\\d+) THEN \\$(\\d+) ELSE`).exec(q.sql);
    if (!m) throw new Error(`no update arm for ${column}`);
    return { provided: q.params[Number(m[1]) - 1], value: q.params[Number(m[2]) - 1] };
  };

  it('writes nothing when the payload touches neither area nor rules', async () => {
    const q = await save({ availability: { timezone: 'Europe/Brussels', weeklyHours: {} } });
    expect(q).toBeNull();
  });

  it('binds every rule to its OWN value and its OWN provided flag', async () => {
    const values: Record<string, number> = {
      maxBookingsPerDay: 4,
      maxBookedMinutesPerDay: 420,
      minGapMin: 15,
      defaultBufferBeforeMin: 5,
      defaultBufferAfterMin: 10,
      defaultMinNoticeMin: 120,
      defaultMaxHorizonDays: 30,
    };
    const q = (await save({ bookingRules: values }))!;
    // Distinct values on purpose — an off-by-one in the parameter numbering swaps two of
    // these and every "is it a number" assertion would still pass.
    for (const [key, column] of Object.entries(RULE_COLUMNS)) {
      expect({ column, ...bound(q, column) }).toEqual({ column, provided: true, value: values[key] });
    }
  });

  it('distinguishes an untouched rule from one explicitly cleared', async () => {
    // The single hardest thing this statement has to do. An omitted key must keep whatever
    // is stored; an explicit null must erase it. Collapsing the two loses either the
    // owner's saved limits or their ability to remove one.
    const q = (await save({ bookingRules: { minGapMin: null, defaultMinNoticeMin: 90 } }))!;
    expect(bound(q, 'min_gap_min')).toEqual({ provided: true, value: null });
    expect(bound(q, 'default_min_notice_min')).toEqual({ provided: true, value: 90 });
    expect(bound(q, 'max_bookings_per_day')).toEqual({ provided: false, value: null });
    expect(bound(q, 'default_max_horizon_days')).toEqual({ provided: false, value: null });
  });

  it('treats an explicit 0 as provided, not as absent', async () => {
    // `br[key] ?? null` is correct; `br[key] || null` would turn a deliberate zero-minute
    // notice period into "leave it alone".
    const q = (await save({ bookingRules: { defaultMinNoticeMin: 0, defaultBufferAfterMin: 0 } }))!;
    expect(bound(q, 'default_min_notice_min')).toEqual({ provided: true, value: 0 });
    expect(bound(q, 'default_buffer_after_min')).toEqual({ provided: true, value: 0 });
  });

  it('clears the service area on an empty array rather than ignoring it', async () => {
    // `[]` IS the clear gesture, so a truthiness check here strands an owner with an area
    // they can never remove.
    const q = (await save({ serviceArea: [] }))!;
    expect(q.params[2]).toBe('[]');
    expect(q.params[3]).toBe(true);
  });

  it('leaves the stored area untouched when only rules are sent', async () => {
    const q = (await save({ bookingRules: { minGapMin: 15 } }))!;
    expect(q.params[3]).toBe(false);
    expect(q.sql).toContain('service_area = CASE WHEN $4 THEN');
  });

  it('serialises a real area and upserts on the bot, not the tenant', async () => {
    const area = [{ kind: 'municipality', id: '41002', label: 'Aalst' }];
    const q = (await save({ serviceArea: area }))!;
    expect(q.params[0]).toBe('ten-1');
    expect(q.params[1]).toBe('bot-1');
    expect(JSON.parse(q.params[2] as string)).toEqual(area);
    // The unique index is on bot_id — conflicting on anything else lets two concurrent
    // first-writes for the same bot race to a 23505.
    expect(q.sql).toContain('ON CONFLICT (bot_id) DO UPDATE SET');
  });
});

describe('scheduler.controller · venue address upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: { integrations: {} } });
    etFindOne.mockResolvedValue(null);
    ruleFindOne.mockResolvedValue(null);
    bsFindOne.mockResolvedValue(null);
  });

  const VENUE_COLUMNS = ['venue_street', 'venue_postal_code', 'venue_city', 'venue_country'];

  const save = async (body: Record<string, unknown>) => {
    await updateSchedulerConfig({ tenantId: 'ten-1', body } as any, res);
    const call = allQueryCalls().find((c) => String(c[0]).includes('chatbot_booking_settings'));
    return call ? { sql: String(call[0]), params: call[1] as unknown[] } : null;
  };

  const bound = (q: { sql: string; params: unknown[] }, column: string) => {
    const m = new RegExp(`(?:^|, )${column} = CASE WHEN \\$(\\d+) THEN \\$(\\d+) ELSE`).exec(q.sql);
    if (!m) throw new Error(`no update arm for ${column}`);
    return { provided: q.params[Number(m[1]) - 1], value: q.params[Number(m[2]) - 1] };
  };

  it('writes a venue on its own, without any other section', async () => {
    // The venue must be a sufficient reason to touch the row — it is the only thing on the
    // screen a brand-new tenant is likely to fill in first.
    const q = (await save({
      venueAddress: { street: 'Grote Markt 1', postalCode: '9300', city: 'Aalst', country: 'BE' },
    }))!;
    expect(bound(q, 'venue_street')).toEqual({ provided: true, value: 'Grote Markt 1' });
    expect(bound(q, 'venue_postal_code')).toEqual({ provided: true, value: '9300' });
    expect(bound(q, 'venue_city')).toEqual({ provided: true, value: 'Aalst' });
    expect(bound(q, 'venue_country')).toEqual({ provided: true, value: 'BE' });
  });

  it('leaves the stored venue alone when the payload does not mention it', async () => {
    // Saving the capacity rules must not erase an address the owner set weeks ago.
    const q = (await save({ bookingRules: { minGapMin: 15 } }))!;
    for (const c of VENUE_COLUMNS) expect(bound(q, c)).toEqual({ provided: false, value: null });
  });

  it('clears every component on an explicit null', async () => {
    const q = (await save({ venueAddress: null }))!;
    for (const c of VENUE_COLUMNS) expect(bound(q, c)).toEqual({ provided: true, value: null });
  });

  it('stores a partial venue without inventing the missing parts', async () => {
    const q = (await save({ venueAddress: { city: 'Aalst' } }))!;
    expect(bound(q, 'venue_city')).toEqual({ provided: true, value: 'Aalst' });
    expect(bound(q, 'venue_street')).toEqual({ provided: true, value: null });
  });

  it('treats a whitespace-only component as empty', async () => {
    const q = (await save({ venueAddress: { street: '   ', city: 'Aalst' } }))!;
    expect(bound(q, 'venue_street')).toEqual({ provided: true, value: null });
  });

  it('does not disturb the booking rules when only the venue is sent', async () => {
    // The two share one statement; a venue-only save must not blank the capacity ceilings.
    const q = (await save({ venueAddress: { city: 'Aalst' } }))!;
    expect(bound(q, 'min_gap_min')).toEqual({ provided: false, value: null });
    expect(bound(q, 'max_bookings_per_day')).toEqual({ provided: false, value: null });
  });

  it('rejects a country code that is not two letters', async () => {
    await expect(
      updateSchedulerConfig({ tenantId: 'ten-1', body: { venueAddress: { country: 'Belgium' } } } as any, res),
    ).rejects.toBeDefined();
  });
});

describe('scheduler.controller · pause switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: { integrations: {} } });
    etFindOne.mockResolvedValue(null);
    ruleFindOne.mockResolvedValue(null);
    bsFindOne.mockResolvedValue(null);
  });

  const save = async (body: Record<string, unknown>) => {
    await updateSchedulerConfig({ tenantId: 'ten-1', body } as any, res);
    const call = allQueryCalls().find((c) => String(c[0]).includes('chatbot_booking_settings'));
    return call ? { sql: String(call[0]), params: call[1] as unknown[] } : null;
  };

  const bound = (q: { sql: string; params: unknown[] }, column: string) => {
    const m = new RegExp(`(?:^|, )${column} = CASE WHEN \\$(\\d+) THEN \\$(\\d+) ELSE`).exec(q.sql);
    if (!m) throw new Error(`no update arm for ${column}`);
    return { provided: q.params[Number(m[1]) - 1], value: q.params[Number(m[2]) - 1] };
  };

  it('is a sufficient reason to write on its own', async () => {
    const q = (await save({ bookingsPaused: true }))!;
    expect(bound(q, 'bookings_paused')).toEqual({ provided: true, value: true });
  });

  it('binds a real boolean on the INSERT arm, never null', async () => {
    // The column is NOT NULL, so it cannot ride the nullable RULE_COLUMNS loop — a null
    // here fails the very first write for a bot with no settings row.
    const q = (await save({ bookingsPaused: false }))!;
    const m = /bookings_paused[\s\S]*?VALUES/.exec(q.sql);
    expect(m).toBeTruthy();
    expect(q.params.some((p) => p === null && false)).toBe(false);
    expect(bound(q, 'bookings_paused').value).toBe(false);
  });

  it('leaves the stored value alone when the payload does not mention it', async () => {
    // Saving the venue must not un-pause a business.
    const q = (await save({ venueAddress: { city: 'Aalst' } }))!;
    expect(bound(q, 'bookings_paused')).toEqual({ provided: false, value: false });
  });

  it('is returned by readConfig so the portal cannot hydrate it wrong', async () => {
    bsFindOne.mockResolvedValue({ bookingsPaused: true } as never);
    await getSchedulerConfig({ tenantId: 'ten-1' } as any, res);
    expect(sendSuccess.mock.calls[0][1]).toMatchObject({ bookingsPaused: true });
  });

  it('reads a missing settings row as NOT paused', async () => {
    bsFindOne.mockResolvedValue(null);
    await getSchedulerConfig({ tenantId: 'ten-1' } as any, res);
    expect(sendSuccess.mock.calls[0][1]).toMatchObject({ bookingsPaused: false });
  });
});

/**
 * The travel-time switch: gates 2 and 3 of the five that stand in front of a paid external
 * dependency. Switching it ON is the only direction that is ever refused.
 */
describe('scheduler.controller · travel time switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: { integrations: {} } });
    etFindOne.mockResolvedValue(null);
    ruleFindOne.mockResolvedValue(null);
    bsFindOne.mockResolvedValue(null);
    resolveItineraryKey.mockResolvedValue('gcal:owner@acme.com');
    itineraryKeyIsShared.mockResolvedValue(false);
    travelConfig.googleMapsApiKey = 'key-1';
  });

  // `clearAllMocks` wipes calls but keeps implementations, so an unentitled stub set inside
  // a test here would follow the suite into every describe below it.
  afterEach(() => requireFeature.mockReset());

  const save = async (body: Record<string, unknown>) => {
    await updateSchedulerConfig({ tenantId: 'ten-1', body } as any, res);
    const call = allQueryCalls().find((c) => String(c[0]).includes('chatbot_booking_settings'));
    return call ? { sql: String(call[0]), params: call[1] as unknown[] } : null;
  };

  const bound = (q: { sql: string; params: unknown[] }, column: string) => {
    const m = new RegExp(`(?:^|, )${column} = CASE WHEN \\$(\\d+) THEN \\$(\\d+) ELSE`).exec(q.sql);
    if (!m) throw new Error(`no update arm for ${column}`);
    return { provided: q.params[Number(m[1]) - 1], value: q.params[Number(m[2]) - 1] };
  };

  it('writes all three settings and is a sufficient reason to write on its own', async () => {
    const q = (await save({ travel: { enabled: true, slackMin: 10, startFromBase: true } }))!;
    expect(bound(q, 'travel_time_enabled')).toEqual({ provided: true, value: true });
    expect(bound(q, 'travel_slack_min')).toEqual({ provided: true, value: 10 });
    expect(bound(q, 'travel_start_from_base')).toEqual({ provided: true, value: true });
  });

  it('requires the separately-sold travelTime grant to switch on', async () => {
    await save({ travel: { enabled: true } });
    expect(requireFeature).toHaveBeenCalledWith('ten-1', 'travelTime', expect.any(String));
  });

  it('refuses on a platform with no Maps key, WITHOUT consulting the entitlement resolver', async () => {
    // Cheapest gate first here too. Arming a switch the platform cannot honour is a worse
    // answer than saying so, and an unentitled tenant must not be told to upgrade for a
    // capability that would still be inert afterwards.
    travelConfig.googleMapsApiKey = undefined;
    await expect(
      updateSchedulerConfig({ tenantId: 'ten-1', body: { travel: { enabled: true } } } as any, res)
    ).rejects.toMatchObject({ statusCode: 503, code: 'TRAVEL_UNAVAILABLE' });
    expect(requireFeature).not.toHaveBeenCalledWith('ten-1', 'travelTime', expect.any(String));
    expect(resolveItineraryKey).not.toHaveBeenCalled();
  });

  it('still lets travel be switched OFF on a platform with no Maps key', async () => {
    travelConfig.googleMapsApiKey = undefined;
    const q = (await save({ travel: { enabled: false } }))!;
    expect(bound(q, 'travel_time_enabled')).toEqual({ provided: true, value: false });
  });

  it('refuses to switch on while another bot shares the diary, and says why', async () => {
    // Under a shared key the two bots' bookings read as one person's day, so the business
    // would find times held back for journeys neither of them makes.
    itineraryKeyIsShared.mockResolvedValue(true);
    await expect(
      updateSchedulerConfig({ tenantId: 'ten-1', body: { travel: { enabled: true } } } as any, res)
    ).rejects.toMatchObject({ statusCode: 409, code: 'TRAVEL_SHARED_ITINERARY' });
    expect(itineraryKeyIsShared).toHaveBeenCalledWith('ten-1', 'bot-1', 'gcal:owner@acme.com');
  });

  it('writes NOTHING when the enable is refused, not even the fields that rode along', async () => {
    itineraryKeyIsShared.mockResolvedValue(true);
    await updateSchedulerConfig(
      { tenantId: 'ten-1', body: { travel: { enabled: true, slackMin: 15 } } } as any,
      res
    ).catch(() => undefined);
    expect(allQueryCalls().some((c) => String(c[0]).includes('chatbot_booking_settings'))).toBe(false);
  });

  it('never refuses switching OFF', async () => {
    // A tenant who has since lost the entitlement, or connected a second bot to their
    // calendar, must still be able to turn it off.
    itineraryKeyIsShared.mockResolvedValue(true);
    requireFeature.mockImplementation(async (_t: string, feature: string) => {
      if (feature === 'travelTime') throw new Error('not entitled');
    });
    const q = (await save({ travel: { enabled: false } }))!;
    expect(bound(q, 'travel_time_enabled')).toEqual({ provided: true, value: false });
    expect(requireFeature).not.toHaveBeenCalledWith('ten-1', 'travelTime', expect.any(String));
  });

  it('binds real booleans on the INSERT arm — both columns are NOT NULL', async () => {
    const q = (await save({ travel: { enabled: false } }))!;
    expect(bound(q, 'travel_time_enabled').value).toBe(false);
    expect(bound(q, 'travel_start_from_base').value).toBe(false);
  });

  it('clears the slack on an explicit null', async () => {
    const q = (await save({ travel: { slackMin: null } }))!;
    expect(bound(q, 'travel_slack_min')).toEqual({ provided: true, value: null });
  });

  it('leaves a stored slack alone when the travel payload does not mention it', async () => {
    const q = (await save({ travel: { enabled: true } }))!;
    expect(bound(q, 'travel_slack_min')).toEqual({ provided: false, value: null });
  });

  it('leaves every travel setting alone when the payload does not mention travel', async () => {
    // Saving the venue must not switch travel time on or off.
    const q = (await save({ venueAddress: { city: 'Aalst' } }))!;
    expect(bound(q, 'travel_time_enabled')).toEqual({ provided: false, value: false });
    expect(bound(q, 'travel_start_from_base')).toEqual({ provided: false, value: false });
  });

  it('is returned by readConfig so the portal cannot hydrate it wrong', async () => {
    bsFindOne.mockResolvedValue({ travelTimeEnabled: true, travelSlackMin: 10, travelStartFromBase: true } as never);
    await getSchedulerConfig({ tenantId: 'ten-1' } as any, res);
    expect(sendSuccess.mock.calls[0][1]).toMatchObject({
      travel: { enabled: true, slackMin: 10, startFromBase: true },
    });
  });

  it('reads a missing settings row as off, with no slack', async () => {
    bsFindOne.mockResolvedValue(null);
    await getSchedulerConfig({ tenantId: 'ten-1' } as any, res);
    expect(sendSuccess.mock.calls[0][1]).toMatchObject({
      travel: { enabled: false, slackMin: null, startFromBase: false },
    });
  });
});

/**
 * Reordering the service catalog.
 *
 * Every service is created at sortOrder 0, and three of the queries that order by it had no
 * tiebreak — so the order the assistant listed services in was whatever Postgres happened to
 * return, free to differ between runs, while the portal showed a stable one. The owner
 * arranged their catalog and the customer heard something else.
 */
describe('scheduler.controller · reorder services', () => {
  // Real uuids: the schema requires them, which is what stops a garbage payload
  // renumbering the catalog.
  const ID = {
    a: 'aaaaaaaa-0000-4000-8000-000000000001',
    b: 'bbbbbbbb-0000-4000-8000-000000000002',
    c: 'cccccccc-0000-4000-8000-000000000003',
    other: 'dddddddd-0000-4000-8000-000000000004',
  };
  const svcRows = (ids: string[]) =>
    ids.map((id, i) => ({ id, botId: 'bot-1', sortOrder: i, createdAt: new Date(2026, 0, i + 1) }));

  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: {} });
    etFindOne.mockResolvedValue(null);
    ruleFindOne.mockResolvedValue(null);
    bsFindOne.mockResolvedValue(null);
  });

  const reorder = async (serviceIds: string[], stored = svcRows([ID.a, ID.b, ID.c])) => {
    etFind.mockResolvedValue(stored as never);
    await reorderServices({ tenantId: 'ten-1', body: { serviceIds } } as any, res);
    return etUpdate.mock.calls.map((c: any) => [c[0].id as string, c[1].sortOrder as number]);
  };

  it('assigns positions from the ARRAY, not from client-supplied numbers', async () => {
    const writes = await reorder([ID.c, ID.a, ID.b]);
    expect(new Map(writes as [string, number][])).toEqual(new Map([[ID.c, 0], [ID.a, 1], [ID.b, 2]]));
  });

  it('writes nothing for a service already in the right place', async () => {
    // Renumbering every row on every save would churn updated_at across the catalog.
    const writes = await reorder([ID.a, ID.b, ID.c]);
    expect(writes).toEqual([]);
  });

  it('ignores an id belonging to someone else’s catalog', async () => {
    // A stale tab is normal; it must not be able to renumber another bot's services.
    const writes = await reorder([ID.c, ID.other, ID.a, ID.b]);
    expect(writes.map((w) => w[0])).not.toContain(ID.other);
    expect(new Map(writes as [string, number][])).toEqual(new Map([[ID.c, 0], [ID.a, 1], [ID.b, 2]]));
  });

  it('keeps unmentioned services after the ones that were mentioned', async () => {
    // A client on an older catalog must not silently drop a service to the bottom at random.
    const writes = await reorder([ID.c], svcRows([ID.a, ID.b, ID.c]));
    expect(new Map(writes as [string, number][])).toEqual(new Map([[ID.c, 0], [ID.a, 1], [ID.b, 2]]));
  });

  it('is gated on the bookings feature like every other scheduler write', async () => {
    await reorder([ID.a]);
    expect(requireFeature).toHaveBeenCalledWith('ten-1', 'bookings', expect.any(String));
  });

  it('rejects a non-uuid id rather than renumbering on garbage', async () => {
    await expect(
      reorderServices({ tenantId: 'ten-1', body: { serviceIds: ['nope'] } } as any, res)
    ).rejects.toBeDefined();
  });
});

/**
 * Clearing an optional service field.
 *
 * The schema accepted only `undefined` for these, and undefined does not survive
 * JSON.stringify — so blanking a description dropped the key, `Object.assign` left the row
 * untouched, and the old text kept reaching the prompt, the invite and the customer with no
 * error anywhere. `null` has to be accepted AND written.
 */
describe('scheduler.controller · clearing optional service fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: {} });
  });

  it('accepts null for every clearable field', () => {
    const r = serviceUpdateSchema.safeParse({
      category: null, description: null, priceNote: null, preparationInstructions: null,
      fixedPrice: null, minPrice: null, maxPrice: null, maxBookingsPerDay: null,
    });
    expect(r.success).toBe(true);
  });

  it('WRITES the null through to the row rather than skipping it', async () => {
    etFindOne.mockResolvedValue({ id: 'svc-1', botId: 'bot-1', name: 'Repair', description: 'old text', priceNote: 'per hour' });
    await updateService(
      { tenantId: 'ten-1', params: { id: 'svc-1' }, body: { description: null, priceNote: null } } as any,
      res,
    );
    const saved = etSave.mock.calls[0][0];
    expect(saved.description).toBeNull();
    expect(saved.priceNote).toBeNull();
  });

  it('leaves a field the payload does not mention', async () => {
    // Partial update semantics still hold: only what was SENT changes.
    etFindOne.mockResolvedValue({ id: 'svc-1', botId: 'bot-1', name: 'Repair', description: 'old text', priceNote: 'per hour' });
    await updateService({ tenantId: 'ten-1', params: { id: 'svc-1' }, body: { description: null } } as any, res);
    const saved = etSave.mock.calls[0][0];
    expect(saved.description).toBeNull();
    expect(saved.priceNote).toBe('per hour');
  });
});

/**
 * The optional discount layer. The payload-only refine proves what it can (percentage ≤ 100,
 * enable-with-type-and-value, ordered window); the merged-row check in updateService catches
 * the partial-PUT combinations the payload cannot see.
 */
describe('scheduler.controller · service discount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetBot.mockResolvedValue({ id: 'bot-1', settings: {} });
  });

  const base = { name: 'Repair', durationMin: 30 };

  it('accepts a fully configured discount on create', () => {
    const r = serviceCreateSchema.safeParse({
      ...base, discountEnabled: true, discountType: 'percentage', discountValue: 20,
      discountStartOn: '2026-06-01', discountEndOn: '2026-06-30',
    });
    expect(r.success).toBe(true);
  });

  it('rejects enabling a discount with no type or value', () => {
    expect(serviceCreateSchema.safeParse({ ...base, discountEnabled: true }).success).toBe(false);
    expect(serviceCreateSchema.safeParse({ ...base, discountEnabled: true, discountType: 'fixed' }).success).toBe(false);
  });

  it('rejects a percentage over 100 even without the enabled flag', () => {
    expect(serviceUpdateSchema.safeParse({ discountType: 'percentage', discountValue: 150 }).success).toBe(false);
  });

  it('rejects an inverted date window', () => {
    const r = serviceCreateSchema.safeParse({
      ...base, discountEnabled: true, discountType: 'percentage', discountValue: 10,
      discountStartOn: '2026-06-16', discountEndOn: '2026-06-15',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a merged row that a partial PUT leaves half-configured', async () => {
    // Stored row is a valid enabled discount; the PUT nulls the type but leaves it enabled.
    etFindOne.mockResolvedValue({
      id: 'svc-1', botId: 'bot-1', name: 'Repair',
      discountEnabled: true, discountType: 'percentage', discountValue: 20,
    });
    await expect(
      updateService({ tenantId: 'ten-1', params: { id: 'svc-1' }, body: { discountType: null } } as any, res),
    ).rejects.toThrow(/discount/i);
    expect(etSave).not.toHaveBeenCalled();
  });

  it('saves a valid discount enabled through a PUT', async () => {
    etFindOne.mockResolvedValue({ id: 'svc-1', botId: 'bot-1', name: 'Repair', discountEnabled: false });
    await updateService(
      { tenantId: 'ten-1', params: { id: 'svc-1' }, body: { discountEnabled: true, discountType: 'fixed', discountValue: 15 } } as any,
      res,
    );
    const saved = etSave.mock.calls[0][0];
    expect(saved.discountEnabled).toBe(true);
    expect(saved.discountType).toBe('fixed');
    expect(saved.discountValue).toBe(15);
  });
});
