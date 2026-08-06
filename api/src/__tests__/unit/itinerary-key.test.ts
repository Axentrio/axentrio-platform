/**
 * Unit tests for the itinerary key — whose day a booking sits in (ADR-0016).
 *
 * The resolver's only I/O is `resolveStoredCalendarIdentity`, so calendar-provider is
 * mocked and the derivation is asserted directly. `calendar-rekey` (which owns
 * `conflictKeyFor`) touches the data source at import time, hence the stubs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { resolveStoredCalendarIdentity } = vi.hoisted(() => ({ resolveStoredCalendarIdentity: vi.fn() }));
vi.mock('../../scheduler/calendar-provider', () => ({ resolveStoredCalendarIdentity }));
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ query: vi.fn() }) },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { resolveItineraryKey } from '../../scheduler/itinerary-key';

describe('resolveItineraryKey', () => {
  beforeEach(() => resolveStoredCalendarIdentity.mockReset());

  it('falls back to a bot-scoped key when no calendar is connected', async () => {
    resolveStoredCalendarIdentity.mockResolvedValue(null);
    expect(await resolveItineraryKey('b1')).toBe('bot:b1');
  });

  it('uses the connected Google calendar identity', async () => {
    resolveStoredCalendarIdentity.mockResolvedValue({ identity: 'owner@acme.com', providerType: 'google' });
    expect(await resolveItineraryKey('b1')).toBe('gcal:owner@acme.com');
  });

  it('uses the connected Outlook account id', async () => {
    resolveStoredCalendarIdentity.mockResolvedValue({ identity: 'acct-123', providerType: 'microsoft' });
    expect(await resolveItineraryKey('b1')).toBe('mscal:acct-123');
  });

  it('stays bot-scoped for a legacy credential with no resolvable identity', async () => {
    // Never `gcal:primary`, which would collide across every tenant on the platform.
    resolveStoredCalendarIdentity.mockResolvedValue({ identity: null, providerType: 'google' });
    expect(await resolveItineraryKey('b1')).toBe('bot:b1');
  });

  it('gives two bots on one real calendar ONE key', async () => {
    // The reason travel scopes to this and not to a bot id: their bookings are one
    // person's day, so the drive between them is a drive that has to happen.
    resolveStoredCalendarIdentity.mockResolvedValue({ identity: 'shared@acme.com', providerType: 'google' });
    const a = await resolveItineraryKey('bot-a');
    const b = await resolveItineraryKey('bot-b');
    expect(a).toBe(b);
  });

  it('separates two bots with no shared calendar', async () => {
    resolveStoredCalendarIdentity.mockResolvedValue(null);
    expect(await resolveItineraryKey('bot-a')).not.toBe(await resolveItineraryKey('bot-b'));
  });
});
