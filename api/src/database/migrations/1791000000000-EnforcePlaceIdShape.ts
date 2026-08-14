import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A place id is a durable Google identity or it is absent. It is never the empty string.
 *
 * `bookingPlaceColumns` already coerces a blank id to NULL (`booking-place.ts:281`), and every
 * writer goes through it: both raw INSERT paths in `internal.provider.ts` (confirmed at :2109,
 * request at :2384) and the lazy write-back in `booking-place.ts`. Production was measured on
 * 2026-08-13 and is clean — 164 bookings, 89 NULL, 75 real ids, zero blanks.
 *
 * So this migration fixes nothing. It stops the column from drifting back.
 *
 * The distinction matters more than it looks. NULL means "we have no durable identity for this
 * address"; `''` means the same thing while being TRUTHY in JavaScript, so `booking.customerPlaceId
 * ? resolvePlaceId(...) : geocode(...)` takes the wrong branch and asks Google to resolve an empty
 * id. ADR-0014 makes `place_id` the one value permitted to outlive the 30-day coordinate window and
 * the handle the retention sweep re-resolves through, which puts a falsy-but-truthy value directly
 * on the path that keeps a far-future appointment locatable.
 *
 * The backfill is a no-op against today's data and is kept anyway: it covers a writer that lands
 * between this deploy and the constraint, and any environment whose history differs from
 * production's.
 */
export class EnforcePlaceIdShape1791000000000 implements MigrationInterface {
  name = 'EnforcePlaceIdShape1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE chatbot_bookings
         SET customer_place_id = NULL
       WHERE customer_place_id IS NOT NULL
         AND btrim(customer_place_id) = ''
    `);

    // Guarded like `ck_address_question_lifecycle_v1`: a re-run must not fail the boot, and a
    // failed migration here crash-loops the API rather than degrading one request.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'chk_chatbot_bookings_place_id_not_blank'
             AND conrelid = 'chatbot_bookings'::regclass
        ) THEN
          ALTER TABLE chatbot_bookings
            ADD CONSTRAINT chk_chatbot_bookings_place_id_not_blank
            CHECK (customer_place_id IS NULL OR btrim(customer_place_id) <> '');
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_bookings
        DROP CONSTRAINT IF EXISTS chk_chatbot_bookings_place_id_not_blank
    `);
  }
}
