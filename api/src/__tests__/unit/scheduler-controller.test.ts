import { describe, it, expect, beforeEach, vi } from 'vitest';

const getAnchorBotConfig = vi.fn();
const replaceAnchorBotSettingsSection = vi.fn();
vi.mock('../../services/bot-config.service', () => ({
  getAnchorBotConfig: (...a: any[]) => getAnchorBotConfig(...a),
  replaceAnchorBotSettingsSection: (...a: any[]) => replaceAnchorBotSettingsSection(...a),
}));

const requireFeature = vi.fn();
vi.mock('../../billing/enforce', () => ({ requireFeature: (...a: any[]) => requireFeature(...a) }));

const etFindOne = vi.fn();
const etSave = vi.fn((x) => x);
const etCount = vi.fn(async () => 0);
const etFind = vi.fn(async () => []);
const ruleFindOne = vi.fn();
const ruleSave = vi.fn((x) => x);
const managerQuery = vi.fn(async (..._a: any[]) => [] as any[]);
function repoFor(entity: any) {
  const name = entity?.name || entity;
  if (name === 'ServiceType') return { findOne: etFindOne, find: etFind, count: etCount, create: (d: any) => d, save: etSave };
  if (name === 'AvailabilityRule') return { findOne: ruleFindOne, create: (d: any) => d, save: ruleSave };
  return {};
}
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => repoFor(entity),
    manager: { getRepository: (entity: any) => repoFor(entity) },
    transaction: (cb: any) => cb({ query: managerQuery, getRepository: (entity: any) => repoFor(entity) }),
  },
}));

const sendSuccess = vi.fn();
vi.mock('../../utils/response', () => ({ sendSuccess: (...a: any[]) => sendSuccess(...a) }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { updateSchedulerConfig, getSchedulerConfig, createService, updateService, listPresets, applyPreset } from '../../scheduler/scheduler.controller';
import { serviceInputSchema } from '../../schemas/scheduler.schema';

const res: any = {};

describe('scheduler.controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAnchorBotConfig.mockResolvedValue({ bot: { id: 'bot-1' }, settings: { integrations: {} } });
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
    expect(replaceAnchorBotSettingsSection).toHaveBeenCalledWith('ten-1', 'integrations', { provider: 'internal' });
    // event type saved with a derived slug + schema defaults
    expect(etSave).toHaveBeenCalledOnce();
    expect(etSave.mock.calls[0][0]).toMatchObject({ name: 'Intro call', slug: 'intro-call', durationMin: 30, maxHorizonDays: 60 });
    expect(ruleSave).toHaveBeenCalledOnce();
    expect(ruleSave.mock.calls[0][0]).toMatchObject({ timezone: 'Europe/Brussels', slotGranularityMin: 30 });
    expect(sendSuccess).toHaveBeenCalled();
  });

  it('gates every write and normalizes a legacy calcom provider input to internal', async () => {
    // Cal.com is shelved: a `provider: 'calcom'` payload is still Pro+-gated and
    // persisted as internal rather than re-enabling the Cal.com path.
    const req: any = { tenantId: 'ten-1', body: { provider: 'calcom' } };
    await updateSchedulerConfig(req, res);
    expect(requireFeature).toHaveBeenCalledWith('ten-1', 'bookings', expect.any(String));
    expect(replaceAnchorBotSettingsSection).toHaveBeenCalledWith('ten-1', 'integrations', { provider: 'internal' });
  });

  it('rejects an empty update', async () => {
    const req: any = { tenantId: 'ten-1', body: {} };
    await expect(updateSchedulerConfig(req, res)).rejects.toBeTruthy();
  });

  it('reads the current config shape', async () => {
    etFindOne.mockResolvedValue({ id: 'et-1', name: 'Intro call' });
    ruleFindOne.mockResolvedValue({ id: 'r-1', timezone: 'Europe/Brussels' });
    getAnchorBotConfig.mockResolvedValue({ bot: { id: 'bot-1' }, settings: { integrations: { provider: 'internal' } } });
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
    getAnchorBotConfig.mockResolvedValue({ bot: { id: 'bot-1' }, settings: {} });
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

describe('presets endpoints (P4a)', () => {
  const res: any = {};
  beforeEach(() => {
    vi.clearAllMocks();
    getAnchorBotConfig.mockResolvedValue({ bot: { id: 'bot-1' }, settings: {} });
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
