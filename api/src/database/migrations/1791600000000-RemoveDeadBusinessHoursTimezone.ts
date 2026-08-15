import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remove the dead business-hours timezone key, TZ PR1c.
 *
 * The write schema no longer accepts `settings.businessHours.timezone` as of this release.
 * The server-owned, geography-derived `businessTimezone` is the authority, so this migration
 * scrubs the now-orphaned historical JSON key and prevents anything from resurrecting a stale
 * client-authored value from old rows. It is a bounded, idempotent update because migrations
 * run on boot (`migrationsRun: true` in production).
 */
export class RemoveDeadBusinessHoursTimezone1791600000000 implements MigrationInterface {
  name = 'RemoveDeadBusinessHoursTimezone1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE chatbot_bots
         SET settings = settings #- '{businessHours,timezone}'
       WHERE settings -> 'businessHours' ? 'timezone'
    `);
  }

  public async down(): Promise<void> {
    // No-op: the removed key was dead data (nothing has read it since TZ PR1a) - there is
    // nothing worth restoring.
  }
}
