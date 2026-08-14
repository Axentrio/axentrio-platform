/**
 * A place id is a durable Google identity or it is absent. It is never `''`.
 *
 * Against real Postgres, because the guarantee IS the database constraint. The application
 * already coerces correctly (`bookingPlaceColumns` at `booking-place.ts:281`, on every writer:
 * both raw INSERT paths in `internal.provider.ts` and the lazy write-back). Production was
 * measured on 2026-08-13 and is clean — 164 bookings, 89 NULL, 75 real ids, zero blanks. So
 * nothing here is fixing a live defect; these tests are what stops the column drifting back.
 *
 * Why the shape matters more than it looks: NULL means "no durable identity for this address",
 * and `''` means exactly the same thing while being TRUTHY in JavaScript. Every
 * `customerPlaceId ? resolvePlaceId(...) : geocode(...)` then takes the wrong branch and asks
 * Google to resolve an empty id. ADR-0014 makes `place_id` the one value permitted to outlive
 * the 30-day coordinate window and the handle the retention sweep re-resolves through, which
 * puts a falsy-but-truthy value directly on the path that keeps a far-future appointment
 * locatable.
 *
 * NOTE ON SCHEMA SOURCE: this suite's schema comes from `synchronize()`, not from migrations, so
 * it exercises the entity's `@Check`. Migration 1791000000000 carries the identical predicate for
 * production, and its SQL was verified by hand against Postgres 15 — backfill, rejection of `''`
 * and of whitespace-only, acceptance of NULL and of a real id, an idempotent re-run, and `down()`.
 * A constraint declared in only one of the two places is the exact drift this file guards.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Booking } from '../../database/entities/Booking';
import { bookingPlaceColumns } from '../../booking/travel/booking-place';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

let tenant: Tenant;
let botId: string;

/** The columns every booking needs, with the place identity left to the caller. */
function bookingRow(over: Partial<Booking> = {}): Partial<Booking> {
  return {
    tenantId: tenant.id,
    botId,
    status: 'confirmed',
    startUtc: new Date('2026-10-04T09:00:00Z'),
    endUtc: new Date('2026-10-04T10:00:00Z'),
    calendarKey: 'cal',
    icsUid: `ics-${Math.random().toString(36).slice(2, 10)}`,
    customerAddress: 'Kerkstraat 12, 9000 Gent',
    ...over,
  };
}

const save = (over: Partial<Booking> = {}) => {
  const repo = AppDataSource.getRepository(Booking);
  return repo.save(repo.create(bookingRow(over)));
};

beforeEach(async () => {
  tenant = await createTestTenant({ tier: 'pro' });
  const bot = await createTestAnchorBot(tenant);
  botId = bot.id;
});

describe('the identities a booking may carry', () => {
  it('a PICKED address keeps its durable Google id', async () => {
    const row = await save({
      customerPlaceId: 'ChIJW_Ft2A73w0cR1aTxfSpmk2Q',
      locationSource: 'pin',
    });
    expect(row.customerPlaceId).toBe('ChIJW_Ft2A73w0cR1aTxfSpmk2Q');
  });

  it('a TYPED address that was geocoded keeps the id geocoding returned', async () => {
    const row = await save({
      customerPlaceId: 'ChIJ_geocoded',
      locationSource: 'geocoded',
    });
    expect(row.customerPlaceId).toBe('ChIJ_geocoded');
  });

  it('an ABSENT identity is NULL, not empty', async () => {
    const row = await save({ customerPlaceId: null });
    const reloaded = await AppDataSource.getRepository(Booking).findOneByOrFail({ id: row.id });
    expect(reloaded.customerPlaceId).toBeNull();
  });
});

describe('the shapes the column refuses', () => {
  it('rejects the empty string outright', async () => {
    await expect(save({ customerPlaceId: '' })).rejects.toThrow(
      /chk_chatbot_bookings_place_id_not_blank/,
    );
  });

  it('rejects a whitespace-only id, which is the same absence wearing a disguise', async () => {
    await expect(save({ customerPlaceId: '   ' })).rejects.toThrow(
      /chk_chatbot_bookings_place_id_not_blank/,
    );
  });

  it('refuses to let an UPDATE blank an id that was already durable', async () => {
    // The write-back path updates in place, so the constraint has to hold on UPDATE too and
    // not only on INSERT.
    const row = await save({ customerPlaceId: 'ChIJ_real' });
    await expect(
      AppDataSource.getRepository(Booking).update(row.id, { customerPlaceId: '' }),
    ).rejects.toThrow(/chk_chatbot_bookings_place_id_not_blank/);
  });
});

describe('the application agrees with the column', () => {
  // If these ever disagree, the constraint starts rejecting writes the code believes are fine,
  // which turns a shape guarantee into an outage. Same predicate, both sides.
  it('coerces a blank Google id to NULL before it reaches the column', () => {
    const columns = bookingPlaceColumns({
      applies: true,
      outcome: 'placed',
      place: {
        placeId: '   ',
        lat: 51.05,
        lng: 3.72,
        precision: 'rooftop',
        formattedAddress: 'Kerkstraat 12, 9000 Gent, Belgium',
      },
    } as never);
    expect(columns.placeId).toBeNull();
  });

  it('writes NULL when no placement applies at all', () => {
    const columns = bookingPlaceColumns({ applies: false } as never);
    expect(columns.placeId).toBeNull();
  });
});
