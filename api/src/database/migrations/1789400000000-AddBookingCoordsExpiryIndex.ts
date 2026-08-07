import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index the column the coordinate-expiry sweep scans.
 *
 * Migration 1789300000000 added `customer_coords_at`; nothing read it in bulk until the
 * daily sweep in `booking/travel/coordinate-retention.service.ts`, which asks the one
 * question this index answers — which bookings still hold coordinates past the licence's
 * thirty days (ADR-0014). Without it that is a sequential scan of every booking the
 * platform has ever taken, once a day, for ever.
 *
 * THE PREDICATE IS THE SWEEP'S FIRST CONDITION, CHARACTER FOR CHARACTER, and the `OR` in it
 * is load-bearing rather than sloppy. A partial index is only usable where the planner can
 * prove the query's predicate implies the index's, and `(lat IS NOT NULL OR lng IS NOT NULL)`
 * does NOT imply `lat IS NOT NULL` — so an index narrowed to the lat column alone is one
 * Postgres builds, maintains, and then ignores. Verified on 50k seeded rows: with the narrow
 * predicate the plan is a Seq Scan removing 49,833 rows; with this one it is an index scan.
 * Narrowing it later, to "tidy it up", silently restores the sequential scan.
 *
 * Only a booking placed for a travel-enabled Agent ever carries coordinates, so this covers a
 * small fraction of the table today and none of it at all until the first tenant is entitled.
 * It also shrinks as the sweep works: a swept row loses its coordinates and drops out.
 *
 * NULLs are indexed by a btree, so the `customer_coords_at IS NULL` arm — coordinates with
 * no stamp, which can only come from hand-edited or imported data and whose age therefore
 * cannot be shown to be inside the window — is served by the same index rather than forcing
 * a scan that would defeat the point.
 *
 * NOT `CONCURRENTLY`, for the reason spelled out on 1787800000000: TypeORM runs migrations
 * inside a transaction and `CREATE INDEX CONCURRENTLY` cannot run in one. A plain build
 * takes a brief SHARE lock on a table holding thousands of rows at SMB scale, and the
 * partial predicate matches almost none of them.
 */
export class AddBookingCoordsExpiryIndex1789400000000 implements MigrationInterface {
  name = 'AddBookingCoordsExpiryIndex1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_bookings_coords_expiry"
        ON "chatbot_bookings" ("customer_coords_at")
        WHERE "customer_lat" IS NOT NULL OR "customer_lng" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_bookings_coords_expiry"`);
  }
}
