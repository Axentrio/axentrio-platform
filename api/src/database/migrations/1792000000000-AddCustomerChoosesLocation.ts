import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #149 — per-service "customer can choose" location for Both businesses.
 *
 * A Service in a Both catalog can happen at the premises OR at the Booking
 * Customer's address, and the customer picks at booking time. That is a new
 * owner FACT, not a stored mode: `resolveServiceLocationMode` still projects
 * who travels. Default false so every existing Service keeps today's behaviour.
 */
export class AddCustomerChoosesLocation1792000000000 implements MigrationInterface {
  name = 'AddCustomerChoosesLocation1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ADD COLUMN IF NOT EXISTS "customer_chooses_location" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        DROP COLUMN IF EXISTS "customer_chooses_location"
    `);
  }
}
