/**
 * The coordinate-expiry sweep (ADR-0014).
 *
 * Against real Postgres, because the whole feature is one statement and a mocked query proves
 * only that the string was passed along. The weight is on the two ways it can be wrong in a
 * direction nobody notices: deleting a position that was still ours, and KEEPING one that was
 * not. The second is the licence breach, and it is the silent one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const audits = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn(async (...args: unknown[]) => {
    audits.entries.push(args);
  }),
}));

import { AppDataSource } from '../../database/data-source';
import { Booking } from '../../database/entities/Booking';
import {
  sweepExpiredCoordinates,
  COORDINATE_DELETE_AGE_MS,
  FUTURE_STAMP_TOLERANCE_MS,
  SWEEP_INTERVAL_MS,
} from '../../booking/travel/coordinate-retention.service';
import { COORDINATE_MAX_AGE_MS, storedPlace } from '../../booking/travel/booking-place';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const DAY_MS = 24 * 60 * 60 * 1000;
const GENT = { lat: 51.05, lng: 3.72 };

let tenant: Tenant;
let botId: string;

/** A booking placed at Gent, stamped `coordsAt`. */
async function seedPlaced(coordsAt: Date | null, over: Partial<Booking> = {}) {
  const repo = AppDataSource.getRepository(Booking);
  return repo.save(
    repo.create({
      tenantId: tenant.id,
      botId,
      status: 'confirmed',
      startUtc: new Date('2026-10-04T09:00:00Z'),
      endUtc: new Date('2026-10-04T10:00:00Z'),
      calendarKey: 'cal',
      icsUid: `ics-${Math.random().toString(36).slice(2, 10)}`,
      customerAddress: 'Kerkstraat 12, 9000 Gent',
      customerPlaceId: 'ChIJ_place',
      customerLat: GENT.lat,
      customerLng: GENT.lng,
      customerCoordsAt: coordsAt,
      customerAddressVerified: 'Kerkstraat 12, 9000 Gent, Belgium',
      geocodePrecision: 'rooftop',
      locationSource: 'geocoded',
      ...over,
    })
  );
}

const reload = (id: string) => AppDataSource.getRepository(Booking).findOneByOrFail({ id });

beforeEach(async () => {
  audits.entries.length = 0;
  vi.clearAllMocks();
  // Several tests count over the whole table rather than one row, which is safe because the
  // shared `afterEach` truncates every dirty table and each worker holds its own database.
  tenant = await createTestTenant({ tier: 'pro' });
  const bot = await createTestAnchorBot(tenant);
  botId = bot.id;
});

describe('what the sweep removes', () => {
  it('deletes coordinates past the licence window and keeps the durable identity', async () => {
    const booking = await seedPlaced(new Date(Date.now() - 31 * DAY_MS));

    const result = await sweepExpiredCoordinates();
    expect(result.cleared).toBe(1);

    const after = await reload(booking.id);
    expect(after.customerLat).toBeNull();
    expect(after.customerLng).toBeNull();
    expect(after.customerCoordsAt).toBeNull();
    // The half the licence permits for ever, and the half a later audit of a gate decision
    // needs. Sweeping these too would make re-resolution impossible and the row unreadable.
    expect(after.customerPlaceId).toBe('ChIJ_place');
    expect(after.customerAddress).toBe('Kerkstraat 12, 9000 Gent');
    expect(after.customerAddressVerified).toBe('Kerkstraat 12, 9000 Gent, Belgium');
    expect(after.geocodePrecision).toBe('rooftop');
  });

  it('leaves coordinates inside the window alone', async () => {
    const booking = await seedPlaced(new Date(Date.now() - 2 * DAY_MS));

    expect((await sweepExpiredCoordinates()).cleared).toBe(0);
    expect((await reload(booking.id)).customerLat).toBe(GENT.lat);
  });

  it('deletes a whole day BEFORE the licence expires, so a daily run never overshoots', async () => {
    // The row a naive `> 30 days` predicate keeps: 29.5 days old, and 30.5 by the time the
    // sweep next runs. Deleting a full interval early is what makes the worst case land on
    // the limit instead of past it.
    const booking = await seedPlaced(new Date(Date.now() - COORDINATE_DELETE_AGE_MS - 60_000));
    // The invariant, not just the inequality: a row that ages out the instant after one run
    // must still be inside the licence when the next one reaches it. Loosen either constant
    // without the other and this is what says so.
    expect(COORDINATE_DELETE_AGE_MS + SWEEP_INTERVAL_MS).toBeLessThanOrEqual(COORDINATE_MAX_AGE_MS);

    expect((await sweepExpiredCoordinates()).cleared).toBe(1);
    expect((await reload(booking.id)).customerLat).toBeNull();
  });

  it('deletes coordinates whose age cannot be established at all', async () => {
    // No stamp: hand-edited or imported. `storedPlace` already refuses to use it, and a
    // position we will not read but will not delete is one held for ever in secret.
    const booking = await seedPlaced(null);
    expect(storedPlace(await reload(booking.id))).toBeNull();

    expect((await sweepExpiredCoordinates()).cleared).toBe(1);
    expect((await reload(booking.id)).customerLat).toBeNull();
  });

  it('deletes a stamp far enough in the future that it could never age out', async () => {
    const booking = await seedPlaced(new Date(Date.now() + 30 * DAY_MS));

    expect((await sweepExpiredCoordinates()).cleared).toBe(1);
    expect((await reload(booking.id)).customerLat).toBeNull();
  });

  it('tolerates the seconds of clock skew between two app instances', async () => {
    // A stamp a minute ahead is unusable for a minute and then fine. Deleting it would throw
    // away coordinates that were about to correct themselves and charge for them again.
    const booking = await seedPlaced(new Date(Date.now() + FUTURE_STAMP_TOLERANCE_MS / 2));

    expect((await sweepExpiredCoordinates()).cleared).toBe(0);
    expect((await reload(booking.id)).customerLat).toBe(GENT.lat);
  });

  it('ignores a booking that never had coordinates', async () => {
    const booking = await seedPlaced(null, {
      customerLat: null,
      customerLng: null,
      customerPlaceId: null,
    });

    expect((await sweepExpiredCoordinates()).cleared).toBe(0);
    expect((await reload(booking.id)).customerAddress).toBe('Kerkstraat 12, 9000 Gent');
  });

  it('sweeps a cancelled booking too — the licence does not care about status', async () => {
    const booking = await seedPlaced(new Date(Date.now() - 31 * DAY_MS), { status: 'cancelled' });

    expect((await sweepExpiredCoordinates()).cleared).toBe(1);
    expect((await reload(booking.id)).customerLat).toBeNull();
  });
});

describe('how the sweep behaves as a job', () => {
  it('is idempotent — a second run finds nothing left to do', async () => {
    await seedPlaced(new Date(Date.now() - 31 * DAY_MS));

    expect((await sweepExpiredCoordinates()).cleared).toBe(1);
    // Nulling the stamp alongside the coordinates is what makes this true. Leaving it would
    // re-select the same row for ever and report a deletion every day.
    expect((await sweepExpiredCoordinates()).cleared).toBe(0);
  });

  it('drains a backlog larger than one batch', async () => {
    for (let i = 0; i < 5; i += 1) await seedPlaced(new Date(Date.now() - (31 + i) * DAY_MS));

    const result = await sweepExpiredCoordinates({ batchSize: 2 });
    expect(result.cleared).toBe(5);
    expect(result.batches).toBeGreaterThan(1);
    expect(result.reachedBatchCeiling).toBe(false);
    const [{ left }] = await AppDataSource.query(
      `SELECT count(*)::int AS left FROM chatbot_bookings WHERE customer_lat IS NOT NULL`
    );
    expect(left).toBe(0);
  });

  it('records what it removed, per tenant', async () => {
    // AC-4: it must be possible to tell the job ran and what it took. The audit row is the
    // durable half of that; the log line is the half that also reports the empty runs.
    const other = await createTestTenant({ tier: 'pro' });
    const otherBot = await createTestAnchorBot(other);
    await seedPlaced(new Date(Date.now() - 31 * DAY_MS));
    await seedPlaced(new Date(Date.now() - 40 * DAY_MS), {
      tenantId: other.id,
      botId: otherBot.id,
    });

    const result = await sweepExpiredCoordinates();
    expect(result).toMatchObject({ cleared: 2, tenants: 2 });
    expect(audits.entries).toHaveLength(2);
    const [actor, action, entityType, entityId, tenantId, meta] = audits.entries[0] as [
      string,
      string,
      string,
      string,
      string,
      { cleared: number },
    ];
    expect({ actor, action, entityType }).toEqual({
      actor: 'system',
      action: 'bookings.coordinates_expired',
      entityType: 'tenant',
    });
    expect(entityId).toBe(tenantId);
    expect(meta.cleared).toBe(1);
  });
});

describe('a far-future booking made before this ticket', () => {
  it('loses its coordinates and reads as needing re-resolution, identity intact', async () => {
    // AC-5. The booking is 45 days into a 60-day horizon: it was placed when it was made and
    // its position aged out before anybody looked at the day again. What the sweep leaves
    // behind has to be exactly what the read path already treats as "resolve me" — a place id
    // and no coordinates — or the far-future half of the feature stops working silently.
    const booking = await seedPlaced(new Date(Date.now() - 45 * DAY_MS), {
      startUtc: new Date(Date.now() + 45 * DAY_MS),
      endUtc: new Date(Date.now() + 45 * DAY_MS + 3_600_000),
    });

    await sweepExpiredCoordinates();

    const after = await reload(booking.id);
    expect(storedPlace(after)).toBeNull();
    expect(after.customerPlaceId).toBe('ChIJ_place');
  });
});
