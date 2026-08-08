/**
 * #88 - the rekey was untestable, so nothing had ever tested it.
 *
 * `rekeyBotBookings` rewrites the diary identity of an Agent's future Bookings whenever a
 * calendar is connected, switched or disconnected. Its SELECT filters on
 * `upper(blocked_range) > now()`, and `blocked_range` did not exist in the test schema -
 * the `Booking` entity does not map a range type, and `synchronize()` builds the schema from
 * entity metadata. So the query raised `column ... does not exist`, every caller swallowed it
 * in the `.catch()` that makes a failed rekey non-fatal, and the function did NOTHING in every
 * test in this repository. Anything that appeared to cover it was passing against code that
 * never ran.
 *
 * `setup.ts` now installs the column and the exclusion constraint after `synchronize()`.
 *
 * WHY IT IS WORTH TESTING AT ALL. The Minimum Gap check and the travel gate's neighbour scan
 * are both scoped by `calendar_key`. A Booking left on a stale key is invisible to them - and
 * it still blocks its own range through the exclusion constraint, so it never appears as a
 * double-booking. It appears as a gap that was not enforced, against a job nobody could see.
 * Since #86 a calendar is connected per Agent, so a rekey aimed at the wrong Agent rewrites
 * the identity of Bookings nobody touched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';

// The rekey re-checks whether travel has just gone inert on a shared diary. That is
// observability riding along, not the thing under test, and its real module reaches for the
// notification and entitlement graph.
vi.mock('../../booking/travel/travel-eligibility', () => ({
  warnIfTravelItineraryNowShared: vi.fn().mockResolvedValue(undefined),
}));

import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { rekeyBotBookings, conflictKeyFor } from '../../scheduler/calendar-rekey';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

let tenant: Tenant;
let anchorId: string;

async function seedAgent(t: Tenant, name: string): Promise<string> {
  const repo = AppDataSource.getRepository(Bot);
  const bot = await repo.save(
    repo.create({
      tenantId: t.id,
      name,
      publicKey: `pk-${randomBytes(4).toString('hex')}`,
      status: 'active',
      isDefault: false,
      settings: {} as Bot['settings'],
    })
  );
  return bot.id;
}

/**
 * One Booking, written the way the engine writes them: `blocked_range` through raw SQL.
 *
 * Hours are passed as an offset from now so "future" and "past" are the property under test
 * rather than a fixed date that goes stale.
 */
async function seedBooking(input: {
  botId: string;
  calendarKey: string;
  startHoursFromNow: number;
  durationHours?: number;
  status?: 'pending' | 'confirmed' | 'cancelled';
}): Promise<string> {
  const id = randomUUID();
  const start = new Date(Date.now() + input.startHoursFromNow * 3_600_000);
  const end = new Date(start.getTime() + (input.durationHours ?? 1) * 3_600_000);
  await AppDataSource.query(
    `INSERT INTO chatbot_bookings
       (id, tenant_id, bot_id, provider, status, start_utc, end_utc, calendar_key,
        blocked_range, ics_uid, created_at, updated_at)
     VALUES ($1, $2, $3, 'internal', $4, $5, $6, $7, tstzrange($5, $6, '[)'), $8, now(), now())`,
    [id, tenant.id, input.botId, input.status ?? 'confirmed', start, end, input.calendarKey, `uid-${id}`]
  );
  return id;
}

const keyOf = async (id: string): Promise<string> => {
  const rows = await AppDataSource.query(`SELECT calendar_key FROM chatbot_bookings WHERE id = $1`, [id]);
  return rows[0].calendar_key;
};

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  anchorId = (await createTestAnchorBot(tenant)).id;
});

describe('the rekey can actually run now', () => {
  it('selects rows at all - the query that used to raise', async () => {
    // The guard for the whole file. If `blocked_range` goes missing again this fails here,
    // loudly, instead of every test below passing against a rekey that never ran.
    const booking = await seedBooking({ botId: anchorId, calendarKey: `bot:${anchorId}`, startHoursFromNow: 24 });
    await rekeyBotBookings(anchorId, 'gcal:owner@example.com');
    expect(await keyOf(booking)).toBe('gcal:owner@example.com');
  });
});

describe('whose Bookings move', () => {
  it('moves the named Agent\'s future Bookings and leaves another Agent\'s alone', async () => {
    // Since #86 a calendar is connected per Agent, so aiming a rekey at the wrong one would
    // rewrite the diary identity of Bookings nobody touched.
    const other = await seedAgent(tenant, 'Second driver');
    const mine = await seedBooking({ botId: anchorId, calendarKey: `bot:${anchorId}`, startHoursFromNow: 24 });
    const theirs = await seedBooking({ botId: other, calendarKey: `bot:${other}`, startHoursFromNow: 26 });

    await rekeyBotBookings(anchorId, 'gcal:owner@example.com');

    expect(await keyOf(mine)).toBe('gcal:owner@example.com');
    expect(await keyOf(theirs)).toBe(`bot:${other}`);
  });

  it('leaves a Booking whose range has already passed', async () => {
    // Rewriting history buys nothing: the gap and neighbour scans only ask about the future,
    // and a past row on a new key could collide with a live one for no reason.
    const past = await seedBooking({ botId: anchorId, calendarKey: `bot:${anchorId}`, startHoursFromNow: -48 });
    const future = await seedBooking({ botId: anchorId, calendarKey: `bot:${anchorId}`, startHoursFromNow: 24 });

    await rekeyBotBookings(anchorId, 'gcal:owner@example.com');

    expect(await keyOf(past)).toBe(`bot:${anchorId}`);
    expect(await keyOf(future)).toBe('gcal:owner@example.com');
  });

  it('leaves a cancelled Booking, which holds no time', async () => {
    const cancelled = await seedBooking({
      botId: anchorId,
      calendarKey: `bot:${anchorId}`,
      startHoursFromNow: 24,
      status: 'cancelled',
    });
    await rekeyBotBookings(anchorId, 'gcal:owner@example.com');
    expect(await keyOf(cancelled)).toBe(`bot:${anchorId}`);
  });

  it('is a no-op when the key is already the new one', async () => {
    const booking = await seedBooking({ botId: anchorId, calendarKey: 'gcal:owner@example.com', startHoursFromNow: 24 });
    await rekeyBotBookings(anchorId, 'gcal:owner@example.com');
    expect(await keyOf(booking)).toBe('gcal:owner@example.com');
  });
});

describe('a rekey that would collide', () => {
  it('leaves the colliding Booking on its old key and moves the rest', async () => {
    // Two Agents already double-booked against each other, discovered only when they are
    // pointed at one real calendar. The overlap is a PRE-EXISTING double-booking being
    // surfaced, not created here - so the rekey must neither merge, drop, nor abort. It
    // strands the one row and reports it.
    const other = await seedAgent(tenant, 'Second driver');
    const shared = 'gcal:shared@example.com';

    // Already on the destination key, holding 10:00-11:00.
    await seedBooking({ botId: other, calendarKey: shared, startHoursFromNow: 24 });
    // The anchor's overlapping row, and a clean one that must still move.
    const colliding = await seedBooking({ botId: anchorId, calendarKey: `bot:${anchorId}`, startHoursFromNow: 24 });
    const clean = await seedBooking({ botId: anchorId, calendarKey: `bot:${anchorId}`, startHoursFromNow: 48 });

    await rekeyBotBookings(anchorId, shared);

    expect(await keyOf(colliding)).toBe(`bot:${anchorId}`);
    expect(await keyOf(clean)).toBe(shared);
  });

  it('does not stop at the first collision', async () => {
    // Ordering must not decide who gets rekeyed. A `throw` here instead of the 23P01 branch
    // would leave everything after the first collision on a stale key.
    const other = await seedAgent(tenant, 'Second driver');
    const shared = 'gcal:shared@example.com';
    await seedBooking({ botId: other, calendarKey: shared, startHoursFromNow: 24 });
    await seedBooking({ botId: other, calendarKey: shared, startHoursFromNow: 48 });

    const collideA = await seedBooking({ botId: anchorId, calendarKey: `bot:${anchorId}`, startHoursFromNow: 24 });
    const collideB = await seedBooking({ botId: anchorId, calendarKey: `bot:${anchorId}`, startHoursFromNow: 48 });
    const clean = await seedBooking({ botId: anchorId, calendarKey: `bot:${anchorId}`, startHoursFromNow: 72 });

    await rekeyBotBookings(anchorId, shared);

    expect(await keyOf(collideA)).toBe(`bot:${anchorId}`);
    expect(await keyOf(collideB)).toBe(`bot:${anchorId}`);
    expect(await keyOf(clean)).toBe(shared);
  });
});

describe('the key itself', () => {
  it.each([
    [null, 'google', `bot:`],
    ['owner@example.com', 'google', 'gcal:owner@example.com'],
    ['account-123', 'microsoft', 'mscal:account-123'],
  ])('identity %s on %s becomes %s', (identity, provider, expected) => {
    const key = conflictKeyFor('BOT', identity as string | null, provider as 'google' | 'microsoft');
    // The provider prefix is what stops one identity string colliding across providers.
    expect(key).toBe(expected === 'bot:' ? 'bot:BOT' : expected);
  });
});
