/**
 * Two customers, one second, one diary — against a real Postgres.
 *
 * WHY THIS CANNOT BE A UNIT TEST. The claim is that the advisory lock serialises two
 * transactions and that the second one therefore SEES what the first wrote. A mocked
 * `EntityManager` proves neither: it cannot block, and it cannot show one transaction's
 * uncommitted insert becoming visible to another after commit. The only honest way to test a
 * lock is to take it twice.
 *
 * WHAT IT IS PROVING. `EXCLUDE USING gist` on `(calendar_key, blocked_range)` is the guarantee
 * that two customers cannot hold the same TIME. It understands overlap and nothing else, so it
 * has nothing to say about two bookings forty minutes apart and eighty kilometres apart — which
 * both pass every pre-lock check when they are confirmed in the same breath, because when each
 * one looked, the other did not exist yet. Travel feasibility is the one constraint in this
 * provider that a database constraint cannot express, and the in-lock re-read is the whole of
 * its protection.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Booking } from '../../database/entities/Booking';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';
import { loadStoredNeighbours } from '../../booking/travel/travel-neighbours';
import { assessSlotRouted, replayLookup } from '../../booking/travel/travel-gate';
import type { ActiveTravelEligibility } from '../../booking/travel/travel-eligibility';

/** Real Belgian coordinates: ~87 km apart, so nothing crosses it in ten minutes. */
const GENT = { lat: 51.0543, lng: 3.7174 };
const LIEGE = { lat: 50.6326, lng: 5.5797 };

let tenant: Tenant;
let botId: string;
let key: string;

const eligibility = (): ActiveTravelEligibility => ({
  active: true,
  tenantId: tenant.id,
  itineraryKey: key as ActiveTravelEligibility['itineraryKey'],
  slackMin: 0,
  startFromBase: false, maxDetourMin: null, baseDepartOffsetMin: 0,
});

/** Write a held booking straight in, already placed, as the pre-lock pass would have left it. */
async function held(startIso: string, endIso: string, point: { lat: number; lng: number }) {
  const repo = AppDataSource.getRepository(Booking);
  return repo.save(
    repo.create({
      tenantId: tenant.id,
      botId,
      status: 'confirmed',
      startUtc: new Date(startIso),
      endUtc: new Date(endIso),
      calendarKey: key,
      icsUid: `ics-${Math.random().toString(36).slice(2, 10)}`,
      customerAddress: 'seeded',
      customerPlaceId: 'ChIJ_seed',
      customerLat: point.lat,
      customerLng: point.lng,
      customerCoordsAt: new Date(),
      customerAddressVerified: 'seeded, Belgium',
      geocodePrecision: 'rooftop',
      locationSource: 'geocoded',
    })
  );
}

/** Stamp the range the entity does not carry, so the seeded row is visible to the diary query. */
async function stampRange(id: string, startIso: string, endIso: string) {
  await AppDataSource.query(
    `UPDATE chatbot_bookings SET blocked_range = tstzrange($2,$3,'[)') WHERE id = $1`,
    [id, startIso, endIso]
  );
}

/**
 * One booker: take the lock, re-read the diary, judge, and insert only if it clears.
 *
 * This is `createBooking`'s transaction with everything that is not the race stripped out — the
 * lock, the stored re-read, the verdict, the write. `hold` lets the test park a transaction
 * mid-flight so the second one is genuinely contending for the lock rather than politely
 * following it.
 */
async function book(
  at: { start: string; end: string; point: { lat: number; lng: number } },
  hold?: () => Promise<void>
): Promise<'written' | 'refused'> {
  return AppDataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    if (hold) await hold();
    const neighbours = await loadStoredNeighbours(manager, {
      eligibility: eligibility(),
      from: new Date(at.start),
      to: new Date(at.end),
      venue: null,
    });
    // The SHIPPED in-lock path: `assessSlotRouted` with a replay lookup over an empty
    // snapshot, which is exactly what `assertTravelFeasible` does inside the transaction.
    // Calling the sync `assessSlot` here made this test a divergent copy of the thing it
    // claims to cover — it would have stayed green through a change to the real gate.
    const { verdict } = await assessSlotRouted({
      candidate: {
        blockedStart: new Date(at.start),
        blockedEnd: new Date(at.end),
        point: at.point,
        coarse: false,
      },
      neighbours,
      slackMin: 0,
      lookup: replayLookup({}),
    });
    if (verdict !== 'clear') return 'refused';
    await manager.query(
      `INSERT INTO chatbot_bookings
         (tenant_id, bot_id, provider, booking_mode, status, start_utc, end_utc,
          blocked_range, calendar_key, ics_uid, customer_address,
          customer_place_id, customer_lat, customer_lng, customer_coords_at,
          customer_address_verified, geocode_precision, location_source)
       VALUES ($1,$2,'internal','auto','confirmed',$3,$4, tstzrange($3,$4,'[)'),$5,$6,'raced',
               'ChIJ_race',$7,$8,now(),'raced, Belgium','rooftop','geocoded')`,
      [tenant.id, botId, at.start, at.end, key, `ics-${Math.random().toString(36).slice(2, 10)}`, at.point.lat, at.point.lng]
    );
    return 'written';
  });
}

describe('two bookings that cannot both be driven to', () => {
  beforeAll(async () => {
    // `blocked_range` is a `tstzrange` created by migration and NOT by TypeORM's synchronize,
    // which is how the test schema is built — so it is simply absent here. Add it, and the
    // exclusion constraint with it, because the point of this file is the gap BETWEEN two
    // bookings and the constraint is what proves that gap is not the thing being tested: both
    // pairs below satisfy the constraint, and only one of them satisfies travel.
    await AppDataSource.query(
      `ALTER TABLE chatbot_bookings ADD COLUMN IF NOT EXISTS blocked_range tstzrange`
    );
    await AppDataSource.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await AppDataSource.query(
      `DO $$ BEGIN
         ALTER TABLE chatbot_bookings ADD CONSTRAINT chatbot_bookings_no_overlap
           EXCLUDE USING gist ("calendar_key" WITH =, "blocked_range" WITH &&)
           WHERE (status IN ('pending','confirmed'));
       EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;`
    );
  });

  beforeEach(async () => {
    tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    botId = bot.id;
    // Unique per test so parallel workers cannot contend on one another's lock.
    key = `race:${tenant.id}`;
  });

  it('lets exactly ONE of two concurrent bookers through', async () => {
    // Gent at 10:00, Liège at 10:40. Neither overlaps the other, so the exclusion constraint is
    // satisfied by both; ~87 km in ten minutes of clearance is not, and only the travel check
    // can say so. Both start before either has committed.
    let release: () => void = () => {};
    const firstIsInside = new Promise<void>((r) => (release = r));

    const gent = book(
      { start: '2026-09-01T10:00:00Z', end: '2026-09-01T10:30:00Z', point: GENT },
      async () => {
        release();
        // Long enough that the second booker is provably blocked on the lock rather than
        // merely slower.
        await new Promise((r) => setTimeout(r, 150));
      }
    );
    await firstIsInside;
    const liege = book({ start: '2026-09-01T10:40:00Z', end: '2026-09-01T11:10:00Z', point: LIEGE });

    const outcomes = await Promise.all([gent, liege]);
    expect(outcomes.filter((o) => o === 'written')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'refused')).toHaveLength(1);

    const rows: Array<{ n: number }> = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM chatbot_bookings WHERE calendar_key = $1`,
      [key]
    );
    expect(rows[0].n).toBe(1);
  });

  it('lets BOTH through when the two are next door to each other', async () => {
    // The same race, the same lock, a reachable pair. Serialising must not become refusing:
    // a gate that blocks whatever it serialises is just a slower way of losing bookings.
    const a = book({ start: '2026-09-01T10:00:00Z', end: '2026-09-01T10:30:00Z', point: GENT });
    const b = book({
      start: '2026-09-01T10:40:00Z',
      end: '2026-09-01T11:10:00Z',
      point: { lat: GENT.lat + 0.001, lng: GENT.lng + 0.001 },
    });
    const outcomes = await Promise.all([a, b]);
    expect(outcomes).toEqual(['written', 'written']);
  });

  it('refuses against a neighbour it cannot place, rather than clearing past it', async () => {
    // A held booking with no coordinates at all. `loadStoredNeighbours` may not geocode, so it
    // reads `unresolved` — which never clears a slot. Reading it as "no constraint" is the
    // fail-open the four location classes exist to prevent.
    await held('2026-09-01T09:00:00Z', '2026-09-01T09:50:00Z', GENT).then(async (b) => {
      await stampRange(b.id, '2026-09-01T09:00:00Z', '2026-09-01T09:50:00Z');
      await AppDataSource.getRepository(Booking).update(b.id, {
        customerLat: null,
        customerLng: null,
        customerCoordsAt: null,
        customerPlaceId: null,
        customerAddress: 'somewhere nobody placed',
      });
    });
    const outcome = await book({
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T10:30:00Z',
      point: LIEGE,
    });
    expect(outcome).toBe('refused');
  });

  it('ignores a booking on a DIFFERENT diary, however close in time', async () => {
    // The itinerary key is what makes travel a claim about one person's day. Another driver's
    // job is not this driver's constraint.
    const other = await held('2026-09-01T09:50:00Z', '2026-09-01T10:00:00Z', LIEGE);
    await stampRange(other.id, '2026-09-01T09:50:00Z', '2026-09-01T10:00:00Z');
    await AppDataSource.getRepository(Booking).update(other.id, { calendarKey: `${key}:other` });
    const outcome = await book({
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T10:30:00Z',
      point: GENT,
    });
    expect(outcome).toBe('written');
  });
});
