import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every column travel-time aware scheduling needs, in one migration — including the two
 * that v1 will not read.
 *
 * ONE migration on purpose. `travel_max_detour_min` and `travel_prefer_clusters` belong to
 * day-scoring, which is deferred (plan §13), so they ship unused. Two nullable columns
 * nobody queries is a smaller cost than a guaranteed second schema change a fortnight
 * later, and the alternative is not "no columns" — it is the same ALTER, run again, on a
 * bigger table, for a feature whose shape is already decided.
 *
 * Everything is nullable or defaulted, so every pre-existing row reads as "unknown
 * location" and behaves exactly as it does today. There is no backfill: coordinates are
 * resolved lazily on read with write-back (plan §6.10), which never geocodes history
 * nobody will query.
 *
 * Note the split of identity from position on `chatbot_bookings`. `customer_place_id` is
 * Google's durable id and may be stored indefinitely; `customer_lat`/`customer_lng` are a
 * derived cache the Maps terms permit for 30 consecutive days and no longer (ADR-0014),
 * which is why the timestamp beside them is load-bearing rather than bookkeeping — it is
 * what the deletion job reads. `geocode_precision` is load-bearing too: an `approximate`
 * result is a town centre, and a town centre can prove a drive impossible but can never
 * prove one fine.
 *
 * `chatbot_travel_usage` is the spend guard, and it is a TABLE rather than a Redis counter
 * for one reason: a cap that forgets its total on deploy is not a cap. It exists before
 * anything can spend, which is the whole point of landing it in this migration.
 */
export class AddTravelTimeSchema1789300000000 implements MigrationInterface {
  name = 'AddTravelTimeSchema1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `customer_place_id` is TEXT and not a bounded varchar, because Google documents that
    // "there is no maximum length for place IDs". A guessed ceiling would turn a perfectly
    // valid Google answer into a failed INSERT on the customer's booking, and the durable
    // identity is the one field on this row we are licensed to keep indefinitely.
    await queryRunner.query(`
      ALTER TABLE chatbot_bookings
        ADD COLUMN IF NOT EXISTS customer_place_id text,
        ADD COLUMN IF NOT EXISTS customer_lat double precision,
        ADD COLUMN IF NOT EXISTS customer_lng double precision,
        ADD COLUMN IF NOT EXISTS customer_coords_at timestamptz,
        ADD COLUMN IF NOT EXISTS customer_address_verified varchar(512),
        ADD COLUMN IF NOT EXISTS geocode_precision varchar(24),
        ADD COLUMN IF NOT EXISTS location_source varchar(16),
        ADD COLUMN IF NOT EXISTS travel_check varchar(24)
    `);

    await queryRunner.query(`
      ALTER TABLE chatbot_booking_settings
        ADD COLUMN IF NOT EXISTS travel_time_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS travel_slack_min int,
        ADD COLUMN IF NOT EXISTS travel_start_from_base boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS venue_lat double precision,
        ADD COLUMN IF NOT EXISTS venue_lng double precision,
        ADD COLUMN IF NOT EXISTS travel_max_detour_min int,
        ADD COLUMN IF NOT EXISTS travel_prefer_clusters boolean NOT NULL DEFAULT false
    `);

    // The period is the first day of a UTC calendar month, not a rolling window: a spend
    // guard has to be explainable to whoever pays the Google bill, and the bill arrives
    // monthly. `elements` counts billable Google units, not requests — one Route Matrix
    // call prices per origin×destination pair.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chatbot_travel_usage (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        period_start date NOT NULL,
        elements int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // UNIQUE, not merely an index: it is the ON CONFLICT target that makes the increment a
    // single atomic statement. Without it two concurrent bookings each insert a row and the
    // total silently halves.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_travel_usage_tenant_period
        ON chatbot_travel_usage (tenant_id, period_start)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS chatbot_travel_usage`);
    await queryRunner.query(`
      ALTER TABLE chatbot_booking_settings
        DROP COLUMN IF EXISTS travel_time_enabled,
        DROP COLUMN IF EXISTS travel_slack_min,
        DROP COLUMN IF EXISTS travel_start_from_base,
        DROP COLUMN IF EXISTS venue_lat,
        DROP COLUMN IF EXISTS venue_lng,
        DROP COLUMN IF EXISTS travel_max_detour_min,
        DROP COLUMN IF EXISTS travel_prefer_clusters
    `);
    await queryRunner.query(`
      ALTER TABLE chatbot_bookings
        DROP COLUMN IF EXISTS customer_place_id,
        DROP COLUMN IF EXISTS customer_lat,
        DROP COLUMN IF EXISTS customer_lng,
        DROP COLUMN IF EXISTS customer_coords_at,
        DROP COLUMN IF EXISTS customer_address_verified,
        DROP COLUMN IF EXISTS geocode_precision,
        DROP COLUMN IF EXISTS location_source,
        DROP COLUMN IF EXISTS travel_check
    `);
  }
}
