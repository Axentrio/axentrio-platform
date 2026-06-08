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
const ruleFindOne = vi.fn();
const ruleSave = vi.fn((x) => x);
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => {
      const name = entity?.name || entity;
      if (name === 'ServiceType') return { findOne: etFindOne, find: async () => [], create: (d: any) => d, save: etSave };
      if (name === 'AvailabilityRule') return { findOne: ruleFindOne, create: (d: any) => d, save: ruleSave };
      return {};
    },
  },
}));

const sendSuccess = vi.fn();
vi.mock('../../utils/response', () => ({ sendSuccess: (...a: any[]) => sendSuccess(...a) }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { updateSchedulerConfig, getSchedulerConfig } from '../../scheduler/scheduler.controller';

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

    expect(requireFeature).toHaveBeenCalledWith('ten-1', 'calendarIntegrations', expect.any(String));
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
    expect(requireFeature).toHaveBeenCalledWith('ten-1', 'calendarIntegrations', expect.any(String));
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
