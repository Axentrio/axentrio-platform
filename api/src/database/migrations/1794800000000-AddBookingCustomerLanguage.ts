import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store the chat language on each booking row so customer-facing emails, ICS
 * descriptions, and the manage page stay in the language used at creation.
 */
export class AddBookingCustomerLanguage1794800000000 implements MigrationInterface {
  name = 'AddBookingCustomerLanguage1794800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chatbot_bookings" ADD COLUMN IF NOT EXISTS "customer_language" varchar(16)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chatbot_bookings" DROP COLUMN IF EXISTS "customer_language"`);
  }
}
