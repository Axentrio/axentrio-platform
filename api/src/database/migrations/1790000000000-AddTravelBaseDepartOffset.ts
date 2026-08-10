import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #91 - when the van actually leaves the premises.
 *
 * `travel_start_from_base` gates the day's first job against the business's own address, and it
 * has always departed at the day's OPENING instant. That silently equates two different times:
 * when the owner leaves the premises, and the earliest a customer may be booked. They are not the
 * same. An owner who opens at 09:00 can leave the workshop at 08:30 and be at the first job at
 * 09:00, which is what a plumber actually does - but the rule as built rules out a job at opening
 * for ANY positive drive, so the owner loses the first slot of every day. Found on a live diary:
 * a venue 14 minutes from the customer made 09:30 the earliest offer on a completely empty day.
 *
 * DEFAULT 0, so every existing Agent behaves exactly as it does today. An owner who leaves early
 * sets the offset and gets their opening slot back, while #76's actual protection - not being
 * offered an 08:00 an hour's drive away - still fires, just against the instant the van moves.
 */
export class AddTravelBaseDepartOffset1790000000000 implements MigrationInterface {
  name = 'AddTravelBaseDepartOffset1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NOT NULL with a default rather than nullable: "how early does the van leave" always has an
    // answer, and zero is it. A null would mean "unknown", which no reader could act on and every
    // reader would have to coalesce.
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD COLUMN IF NOT EXISTS "travel_base_depart_offset_min" integer NOT NULL DEFAULT 0
    `);
    // `IF NOT EXISTS` above would silently accept a column left behind by a partial deploy with
    // the wrong nullability or default, so both are restated rather than assumed.
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ALTER COLUMN "travel_base_depart_offset_min" SET DEFAULT 0
    `);
    await queryRunner.query(`
      UPDATE "chatbot_booking_settings" SET "travel_base_depart_offset_min" = 0
       WHERE "travel_base_depart_offset_min" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ALTER COLUMN "travel_base_depart_offset_min" SET NOT NULL
    `);
    // The RANGE is a safety property, not input validation, which is why it lives here as well as
    // in the API. This number moves a feasibility gate: an out-of-range row departs arbitrarily
    // early and can clear a first job nobody can reach. The read path clamps too - three layers,
    // because only one of them is the one that will still be true in a year.
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP CONSTRAINT IF EXISTS "ck_booking_settings_base_depart_offset"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD CONSTRAINT "ck_booking_settings_base_depart_offset"
        CHECK ("travel_base_depart_offset_min" BETWEEN 0 AND 240)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP CONSTRAINT IF EXISTS "ck_booking_settings_base_depart_offset"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP COLUMN IF EXISTS "travel_base_depart_offset_min"
    `);
  }
}
