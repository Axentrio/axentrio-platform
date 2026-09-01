import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ledger was narrower than the values it has to hold.
 *
 * `subject` is `Confirmed: ${service.name}` and `ServiceType.name` allows 255, so a
 * long service name produced a 266-character subject that overflowed varchar(255).
 * `recipient_email` allowed 255 while `normalizeCustomerEmail` accepts 320. Either
 * overflow threw inside the ledger insert, and `sendOrReport` swallows a throw, so
 * the customer silently got no invite.
 *
 * Widening only. The down migration narrows back to 255 and will fail if a longer
 * row already exists by then; that is the honest inverse, not a data loss.
 */
export class WidenEmailDeliveryText1794600000000 implements MigrationInterface {
  name = 'WidenEmailDeliveryText1794600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE email_deliveries
        ALTER COLUMN subject TYPE varchar(320),
        ALTER COLUMN recipient_email TYPE varchar(320)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE email_deliveries
        ALTER COLUMN subject TYPE varchar(255),
        ALTER COLUMN recipient_email TYPE varchar(255)
    `);
  }
}
