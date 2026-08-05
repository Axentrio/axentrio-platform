import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give a business somewhere to put the address customers actually come to.
 *
 * Until now the only address the platform stored was the VAT/legal one captured during
 * onboarding, and the invite path deliberately refused to use it: it is tenant-wide,
 * write-once, unvalidated, and for a sole trader is frequently their home. The calendar
 * event therefore carried the literal string "In person" as its LOCATION, which is not a
 * venue — RFC 5545 §3.8.1.7 defines LOCATION as "the intended venue for the activity".
 *
 * Four nullable columns, no default, NO BACKFILL. Empty is the correct starting state and
 * is required rather than merely preferred: GDPR Art. 25(2) says personal data must not be
 * made accessible to an indefinite number of people by default, and copying the registered
 * address in here would do precisely that for every existing tenant at once, silently.
 * A venue appears on invites only after an owner types one into the settings screen.
 *
 * On `chatbot_booking_settings` rather than the tenant because that is already where every
 * business-level booking fact lives (service area, the capacity ceilings, the timing
 * defaults) and it is already reachable through the anchor-bot scoping the settings editor
 * uses. A tenant running two bots enters this twice; that is the accepted cost.
 */
export class AddVenueAddress1789000000000 implements MigrationInterface {
  name = 'AddVenueAddress1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_booking_settings
        ADD COLUMN IF NOT EXISTS venue_street varchar(200),
        ADD COLUMN IF NOT EXISTS venue_postal_code varchar(200),
        ADD COLUMN IF NOT EXISTS venue_city varchar(200),
        ADD COLUMN IF NOT EXISTS venue_country varchar(2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_booking_settings
        DROP COLUMN IF EXISTS venue_street,
        DROP COLUMN IF EXISTS venue_postal_code,
        DROP COLUMN IF EXISTS venue_city,
        DROP COLUMN IF EXISTS venue_country
    `);
  }
}
