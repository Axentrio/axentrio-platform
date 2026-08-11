import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The venue's durable identity, so the travel base stops being re-guessed from text.
 *
 * `venueLocation` geocodes the four venue fields joined into a line, every time. That was the
 * right call while nothing could offer a better answer - its own comment says so, and names the
 * three reasons: the precision arrives with the answer, the cache expires inside the licence
 * window, and the cache key IS the normalised address so an edited address is a different key.
 * It ends with "persisting a venue point properly belongs with the screen that edits one",
 * which is exactly what this column is for.
 *
 * ## Why an id and not a point
 *
 * `venue_lat` / `venue_lng` already exist and nothing writes them, deliberately:
 * `coordinate-retention.service.ts` warns that they carry no timestamp, so no age could be
 * observed, and ADR-0014 permits coordinates for 30 consecutive days only. A `place_id` is not a
 * coordinate - Google permits keeping it indefinitely - so storing identity rather than position
 * inherits no retention obligation and needs no sweep branch. Coordinates keep being re-derived
 * on demand, from the id instead of from the text.
 *
 * ## Nullable, and it stays that way
 *
 * Every existing row has an address that was typed, not chosen, and there is no honest id to
 * backfill: inventing one would mean geocoding text nobody verified and then calling the result
 * verified. Null means "this venue was typed", and `venueLocation` falls back to exactly the
 * behaviour it has today. Rows only gain an id when an owner picks a suggestion.
 */
export class AddVenuePlaceId1790300000000 implements MigrationInterface {
  name = 'AddVenuePlaceId1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // TEXT, matching `chatbot_bookings.customer_place_id`: Google documents no maximum length
    // for a place id, so a varchar ceiling would be a guess that truncates one silently.
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD COLUMN IF NOT EXISTS "venue_place_id" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP COLUMN IF EXISTS "venue_place_id"
    `);
  }
}
