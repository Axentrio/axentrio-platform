import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Geographic grouping stops being a switch and becomes a choice of PERIOD.
 *
 * `travel_prefer_clusters` is a boolean, and the partner spec asks for three options - No
 * grouping, Half day, Full day. A boolean holds two, so this is a column change rather than a
 * settings change. (Their original spec had a fourth, Week; they removed it on 2026-08-11 because
 * their own Full Day and Week examples described the same behaviour.)
 *
 * ## The mapping is exact, not a guess
 *
 * The boolean's two states ARE two of the three values: on meant "group within the half day",
 * because the half day is the only period ever implemented (`half-day.ts`), and off meant "do not
 * group". So `true -> half_day` and `false -> none` loses nothing and invents nothing, and `down`
 * maps `half_day -> true` with everything else false.
 *
 * ## Why `full_day` is not accepted yet
 *
 * The constraint below permits `none` and `half_day` only. Full Day needs the anchor bucketing in
 * `insertion-scorer` to produce one bucket per day instead of two, and until that lands a stored
 * `full_day` would be a value the engine silently treats as no grouping at all. An owner who
 * picked it would be told the platform was doing something it was not. The value is added in the
 * change that implements it, and the constraint is what makes that impossible to forget.
 *
 * ## The old column goes
 *
 * Kept-but-unread is how two sources of truth start. Migrations run on container boot before the
 * new code serves, so there is no window in which the old code meets the new schema, and `down`
 * restores the boolean from the enum rather than from a backup.
 */
export class GroupingPeriod1790400000000 implements MigrationInterface {
  name = 'GroupingPeriod1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // TEXT with a CHECK rather than a Postgres enum type: adding a value to an enum type is a
    // schema change that cannot run inside every transaction, and this list is expected to grow
    // by exactly one. A CHECK is edited by any migration without ceremony.
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD COLUMN IF NOT EXISTS "travel_grouping_period" text NOT NULL DEFAULT 'none'
    `);
    await queryRunner.query(`
      UPDATE "chatbot_booking_settings"
         SET "travel_grouping_period" = 'half_day'
       WHERE "travel_prefer_clusters" = true
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD CONSTRAINT "ck_booking_settings_grouping_period"
        CHECK ("travel_grouping_period" IN ('none', 'half_day'))
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP COLUMN IF EXISTS "travel_prefer_clusters"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD COLUMN IF NOT EXISTS "travel_prefer_clusters" boolean NOT NULL DEFAULT false
    `);
    // Anything that is not `none` was grouping, so it comes back as the boolean's `true`. Today
    // that is only `half_day`; written this way so a later value does not silently revert to off.
    await queryRunner.query(`
      UPDATE "chatbot_booking_settings"
         SET "travel_prefer_clusters" = true
       WHERE "travel_grouping_period" <> 'none'
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP CONSTRAINT IF EXISTS "ck_booking_settings_grouping_period"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP COLUMN IF EXISTS "travel_grouping_period"
    `);
  }
}
