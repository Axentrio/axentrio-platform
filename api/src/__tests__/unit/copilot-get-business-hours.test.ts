/**
 * Unit: getBusinessHours copilot tool.
 *
 * The bug this guards: the assistant used to answer "opening hours not
 * configured" from onboarding state even when hours WERE set. This tool reads
 * the anchor bot's settings.businessHours directly, so `configured` reflects
 * the real value, not the wizard.
 */
import { describe, it, expect } from 'vitest';
import { getBusinessHours } from '../../copilot/tools/getBusinessHours';
import type { CopilotToolContext } from '../../copilot/tools/types';

function ctxWithBot(bot: unknown): CopilotToolContext {
  return {
    tenantId: 't1',
    userId: 'u1',
    manager: { findOne: async () => bot },
  } as unknown as CopilotToolContext;
}

const openMon = { day: 'monday', open: '09:00', close: '17:00', closed: false };
const closedSun = { day: 'sunday', open: '', close: '', closed: true };

describe('getBusinessHours', () => {
  it('returns empty/unconfigured when the tenant has no bot', async () => {
    const res = await getBusinessHours.execute({}, ctxWithBot(null));
    expect(res).toEqual({
      configured: false,
      enabled: false,
      timezone: null,
      schedule: [],
      hasDateOverrides: false,
    });
  });

  it('reports configured hours (enabled + an open day) with the schedule', async () => {
    const res = await getBusinessHours.execute(
      {},
      ctxWithBot({
        settings: {
          businessHours: {
            enabled: true,
            timezone: 'Europe/Brussels',
            schedule: [openMon, closedSun],
          },
        },
      }),
    );
    expect(res.configured).toBe(true);
    expect(res.enabled).toBe(true);
    expect(res.timezone).toBe('Europe/Brussels');
    expect(res.schedule).toEqual([openMon, closedSun]);
    expect(res.hasDateOverrides).toBe(false);
  });

  it('is NOT configured when hours exist but are disabled', async () => {
    const res = await getBusinessHours.execute(
      {},
      ctxWithBot({
        settings: {
          businessHours: { enabled: false, timezone: 'Europe/Brussels', schedule: [openMon] },
        },
      }),
    );
    expect(res.configured).toBe(false);
    expect(res.enabled).toBe(false);
    // schedule still surfaced so the assistant can say "set, but turned off".
    expect(res.schedule).toEqual([openMon]);
  });

  it('is NOT configured when enabled but every day is closed', async () => {
    const res = await getBusinessHours.execute(
      {},
      ctxWithBot({
        settings: { businessHours: { enabled: true, timezone: 'UTC', schedule: [closedSun] } },
      }),
    );
    expect(res.configured).toBe(false);
    expect(res.enabled).toBe(true);
  });

  it('flags date overrides and null timezone', async () => {
    const res = await getBusinessHours.execute(
      {},
      ctxWithBot({
        settings: {
          businessHours: {
            enabled: true,
            timezone: '  ',
            schedule: [openMon],
            dateOverrides: [{ date: '2026-12-25', closed: true }],
          },
        },
      }),
    );
    expect(res.hasDateOverrides).toBe(true);
    expect(res.timezone).toBeNull();
  });
});
