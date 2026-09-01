import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SV: the customer email is the address the ICS calendar invite goes to, so a
 * Service requires it by default. Postgres fills every existing row with true,
 * which switches the flag on for services that already exist; the owner unticks
 * it per service.
 */
export class AddCustomerEmailRequired1794300000000 implements MigrationInterface {
  name = 'AddCustomerEmailRequired1794300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ADD COLUMN IF NOT EXISTS "customer_email_required" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        DROP COLUMN IF EXISTS "customer_email_required"
    `);
  }
}
