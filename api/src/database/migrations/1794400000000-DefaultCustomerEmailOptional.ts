import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `AddCustomerEmailRequired1794300000000` added the column with `DEFAULT true`, so the deploy
 * that ran it turned every existing service of every tenant into an email-required service at
 * once. Bots then refused to book for customers who had never been asked for an email, on
 * catalogs whose owners had chosen nothing.
 *
 * A new flag starts off. The owner turns it on for the services that need the calendar invite
 * to reach someone, which is what the portal toggle is for.
 *
 * Every stored row is reset, not a selected few. The toggle reached production about fifteen
 * minutes before this, so a row saying `true` records the migration's default and not an
 * owner's decision. `updated_at` cannot tell the two apart: it moves for any edit, and the
 * column is `timestamp without time zone`, so a cutoff would also depend on the session
 * timezone of whoever ran it.
 */
export class DefaultCustomerEmailOptional1794400000000 implements MigrationInterface {
  name = 'DefaultCustomerEmailOptional1794400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ALTER COLUMN "customer_email_required" SET DEFAULT false
    `);
    await queryRunner.query(`
      UPDATE "chatbot_service_types" SET "customer_email_required" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ALTER COLUMN "customer_email_required" SET DEFAULT true
    `);
  }
}
