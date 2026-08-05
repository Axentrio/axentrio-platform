import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Let a service INHERIT its timing from the business instead of restating it.
 *
 * Two halves. The four per-service timing columns become nullable with no DB default, so
 * "unset" becomes expressible at all — until now they were NOT NULL with defaults and zod
 * re-defaulted them on every write, which is exactly why a business-level default was
 * impossible: nothing could tell 0 from "not specified".
 *
 * The second half adds the business-level values they fall back to.
 *
 * EXISTING ROWS ARE LEFT ALONE ON PURPOSE. Dropping NOT NULL does not blank anything, so
 * every current service keeps the numbers its owner is already relying on. Inheritance
 * applies to services created or explicitly cleared from here on — silently re-pointing
 * live services at a new default would change availability under a running business.
 */
export class ServiceTimingInheritance1788800000000 implements MigrationInterface {
  name = 'ServiceTimingInheritance1788800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ALTER COLUMN "buffer_before_min" DROP NOT NULL,
        ALTER COLUMN "buffer_before_min" DROP DEFAULT,
        ALTER COLUMN "buffer_after_min"  DROP NOT NULL,
        ALTER COLUMN "buffer_after_min"  DROP DEFAULT,
        ALTER COLUMN "min_notice_min"    DROP NOT NULL,
        ALTER COLUMN "min_notice_min"    DROP DEFAULT,
        ALTER COLUMN "max_horizon_days"  DROP NOT NULL,
        ALTER COLUMN "max_horizon_days"  DROP DEFAULT
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD COLUMN IF NOT EXISTS "default_buffer_before_min" int,
        ADD COLUMN IF NOT EXISTS "default_buffer_after_min"  int,
        ADD COLUMN IF NOT EXISTS "default_min_notice_min"    int,
        ADD COLUMN IF NOT EXISTS "default_max_horizon_days"  int
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the NOT NULL contract, filling any inherited nulls with the platform
    // fallbacks the resolver uses, so the constraint can be re-applied safely.
    await queryRunner.query(`
      UPDATE "chatbot_service_types" SET
        "buffer_before_min" = COALESCE("buffer_before_min", 0),
        "buffer_after_min"  = COALESCE("buffer_after_min", 0),
        "min_notice_min"    = COALESCE("min_notice_min", 0),
        "max_horizon_days"  = COALESCE("max_horizon_days", 60)
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ALTER COLUMN "buffer_before_min" SET DEFAULT 0,
        ALTER COLUMN "buffer_before_min" SET NOT NULL,
        ALTER COLUMN "buffer_after_min"  SET DEFAULT 0,
        ALTER COLUMN "buffer_after_min"  SET NOT NULL,
        ALTER COLUMN "min_notice_min"    SET DEFAULT 0,
        ALTER COLUMN "min_notice_min"    SET NOT NULL,
        ALTER COLUMN "max_horizon_days"  SET DEFAULT 60,
        ALTER COLUMN "max_horizon_days"  SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP COLUMN IF EXISTS "default_buffer_before_min",
        DROP COLUMN IF EXISTS "default_buffer_after_min",
        DROP COLUMN IF EXISTS "default_min_notice_min",
        DROP COLUMN IF EXISTS "default_max_horizon_days"
    `);
  }
}
