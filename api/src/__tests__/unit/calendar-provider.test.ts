/**
 * P6c — CalendarProvider port resolution.
 *
 * providerFor maps a credential provider to its adapter; resolveCalendarProvider
 * picks the adapter for the bot's single active credential (null when none,
 * most-recent + warn when somehow >1). The adapters themselves just delegate to
 * the per-provider services (covered by their own suites).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const find = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ find }) },
}));
// Calendar sync now gates on resolved entitlements (D9); resolve via the
// real pure resolver on 'pro' (calendarSync on) so sync stays live.
vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../billing/entitlements')>();
  return { ...actual, getEntitlements: vi.fn(async () => actual.entitlementsFor('pro')) };
});

vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// The adapters reference these at module load; stub so importing the port is cheap.
vi.mock('../../integrations/google/google-calendar.service', () => ({
  getGoogleBusyForBot: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  resolveCalendarIdentity: vi.fn(),
}));
vi.mock('../../integrations/microsoft/outlook-events.service', () => ({
  getOutlookBusyForBot: vi.fn(),
  createOutlookEvent: vi.fn(),
  updateOutlookEvent: vi.fn(),
  deleteOutlookEvent: vi.fn(),
}));
vi.mock('../../integrations/microsoft/outlook-calendar.service', () => ({
  resolveOutlookIdentity: vi.fn(),
}));

import { providerFor, resolveCalendarProvider, hasHealthyCalendarConnection } from '../../scheduler/calendar-provider';

beforeEach(() => vi.clearAllMocks());

describe('providerFor', () => {
  it('maps google and microsoft', () => {
    expect(providerFor('google').providerType).toBe('google');
    expect(providerFor('microsoft').providerType).toBe('microsoft');
  });
});

describe('resolveCalendarProvider', () => {
  it('returns null when the bot has no active credential', async () => {
    find.mockResolvedValue([]);
    expect(await resolveCalendarProvider('b1')).toBeNull();
  });

  it('returns the microsoft adapter for an active microsoft credential', async () => {
    find.mockResolvedValue([{ provider: 'microsoft' }]);
    expect((await resolveCalendarProvider('b1'))?.providerType).toBe('microsoft');
  });

  it('returns the google adapter for an active google credential', async () => {
    find.mockResolvedValue([{ provider: 'google' }]);
    expect((await resolveCalendarProvider('b1'))?.providerType).toBe('google');
  });

  it('uses the most-recent (first, ordered DESC) when >1 active', async () => {
    find.mockResolvedValue([{ provider: 'microsoft' }, { provider: 'google' }]);
    expect((await resolveCalendarProvider('b1'))?.providerType).toBe('microsoft');
  });
});

describe('hasHealthyCalendarConnection (auto-confirm gate)', () => {
  it('returns true for an active microsoft/outlook credential (the Outlook regression fix)', async () => {
    find.mockResolvedValue([{ provider: 'microsoft', reauthRequired: false }]);
    expect(await hasHealthyCalendarConnection('b1')).toBe(true);
  });

  it('returns true for an active google credential', async () => {
    find.mockResolvedValue([{ provider: 'google', reauthRequired: false }]);
    expect(await hasHealthyCalendarConnection('b1')).toBe(true);
  });

  it('returns false when the bot has no active credential', async () => {
    find.mockResolvedValue([]);
    expect(await hasHealthyCalendarConnection('b1')).toBe(false);
  });

  it('returns false when the credential is flagged reauth-required (dead link)', async () => {
    find.mockResolvedValue([{ provider: 'microsoft', reauthRequired: true }]);
    expect(await hasHealthyCalendarConnection('b1')).toBe(false);
  });
});
