import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Freeze the organizer for bookings that predate `organizer_email`.
 *
 * The previous migration added the column but left old rows null, reasoning that their
 * invite had already gone out and must keep matching. That reasoning was half right and the
 * conclusion was wrong: a null row still resolves its organizer LIVE from `ai.supportEmail`
 * on every reschedule and cancel, so those bookings keep exactly the bug the column exists
 * to remove — edit that setting and their cancellations silently stop working.
 *
 * Backfilling the address the OLD resolution produces right now changes nothing about what
 * is sent today, and freezes it against a future settings edit. Strictly better than null.
 *
 * Only rows that can still receive an update are touched: a cancelled booking has already
 * had its final message.
 */
export class BackfillBookingOrganizer1788900000000 implements MigrationInterface {
  name = 'BackfillBookingOrganizer1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE chatbot_bookings b
         SET organizer_email = NULLIF(bot.settings->'ai'->>'supportEmail', '')
        FROM chatbot_bots bot
       WHERE bot.id = b.bot_id
         AND b.organizer_email IS NULL
         AND b.status IN ('pending', 'confirmed', 'request_created')
         AND NULLIF(bot.settings->'ai'->>'supportEmail', '') IS NOT NULL
    `);
    // A bot with no supportEmail keeps NULL, which the sender already resolves to the
    // platform address — the same value, so there is nothing to freeze.
  }

  public async down(): Promise<void> {
    // Deliberately empty. Reverting would re-expose the live-resolution bug, and the column
    // itself is dropped by the migration that created it.
  }
}
