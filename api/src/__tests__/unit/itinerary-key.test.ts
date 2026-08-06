/**
 * Unit tests for the itinerary key — whose day a booking sits in (ADR-0016).
 *
 * The resolver's only I/O is `resolveStoredCalendarIdentity`, so calendar-provider is
 * mocked and the derivation is asserted directly. `calendar-rekey` (which owns
 * `conflictKeyFor`) touches the data source at import time, hence the stubs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { resolveStoredCalendarIdentity, dsQuery } = vi.hoisted(() => ({
  resolveStoredCalendarIdentity: vi.fn(),
  dsQuery: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
}));
vi.mock('../../scheduler/calendar-provider', () => ({ resolveStoredCalendarIdentity }));
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ query: vi.fn() }), query: (...a: unknown[]) => dsQuery(...a) },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { resolveItineraryKey, itineraryKeyIsShared } from '../../scheduler/itinerary-key';

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

/**
 * The one state in which travel enforcement leaves a business WORSE OFF than not having
 * it: two bots on one diary, so the gate strips slots for journeys neither of them makes.
 */
describe('itineraryKeyIsShared', () => {
  beforeEach(() => {
    resolveStoredCalendarIdentity.mockReset();
    dsQuery.mockReset();
    dsQuery.mockResolvedValue([]);
  });

  it('answers a bot-scoped key without touching the database', async () => {
    // `bot:<id>` embeds the bot's own id, so no other bot can produce it. A business with
    // no connected calendar is provably its own itinerary — not a lookup, an identity.
    expect(await itineraryKeyIsShared('ten-1', 'bot-a', 'bot:bot-a')).toBe(false);
    expect(dsQuery).not.toHaveBeenCalled();
  });

  it('is false when the tenant has no other bot with a connected calendar', async () => {
    dsQuery.mockResolvedValue([]);
    expect(await itineraryKeyIsShared('ten-1', 'bot-a', 'gcal:owner@acme.com')).toBe(false);
    expect(resolveStoredCalendarIdentity).not.toHaveBeenCalled();
  });

  it('is true when a sibling bot resolves to the same key', async () => {
    dsQuery.mockResolvedValue([{ id: 'bot-b' }]);
    resolveStoredCalendarIdentity.mockResolvedValue({ identity: 'owner@acme.com', providerType: 'google' });
    expect(await itineraryKeyIsShared('ten-1', 'bot-a', 'gcal:owner@acme.com')).toBe(true);
  });

  it('is false when a sibling is on a different calendar', async () => {
    dsQuery.mockResolvedValue([{ id: 'bot-b' }]);
    resolveStoredCalendarIdentity.mockResolvedValue({ identity: 'other@acme.com', providerType: 'google' });
    expect(await itineraryKeyIsShared('ten-1', 'bot-a', 'gcal:owner@acme.com')).toBe(false);
  });

  it('does not confuse one identity across two providers', async () => {
    dsQuery.mockResolvedValue([{ id: 'bot-b' }]);
    resolveStoredCalendarIdentity.mockResolvedValue({ identity: 'owner@acme.com', providerType: 'microsoft' });
    expect(await itineraryKeyIsShared('ten-1', 'bot-a', 'gcal:owner@acme.com')).toBe(false);
  });

  it('excludes the bot itself and soft-deleted siblings in the query', async () => {
    await itineraryKeyIsShared('ten-1', 'bot-a', 'gcal:owner@acme.com');
    const [sql, params] = dsQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/b\.id <> \$2/);
    expect(sql).toMatch(/b\.deleted_at IS NULL/);
    expect(sql).toMatch(/c\.status = 'active'/);
    expect(params).toEqual(['ten-1', 'bot-a']);
  });
});
