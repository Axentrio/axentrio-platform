import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3a: per-service intake questions on ServiceType.
 *
 * A single additive, nullable jsonb column — every existing service row stays
 * NULL, which the entity and prompt read as "no questions" (today's behavior).
 * No backfill, no default; the `Booking.intake_answers` write side already
 * exists from the keystone.
 */
export class AddIntakeQuestionsToServiceType1785300000000 implements MigrationInterface {
  name = 'AddIntakeQuestionsToServiceType1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_service_types
        ADD COLUMN IF NOT EXISTS intake_questions jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_service_types
        DROP COLUMN IF EXISTS intake_questions
    `);
  }
}
