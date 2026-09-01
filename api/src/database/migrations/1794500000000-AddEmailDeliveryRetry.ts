import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store a rebuildable payload on failed booking emails and a next-attempt clock
 * so a sweeper can retry the customer invite after a Resend outage.
 */
export class AddEmailDeliveryRetry1794500000000 implements MigrationInterface {
  name = 'AddEmailDeliveryRetry1794500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE email_deliveries
        ADD COLUMN IF NOT EXISTS payload jsonb,
        ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_email_deliveries_retry
        ON email_deliveries (next_attempt_at)
        WHERE status = 'failed' AND payload IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS ix_email_deliveries_retry`);
    await queryRunner.query(`
      ALTER TABLE email_deliveries
        DROP COLUMN IF EXISTS payload,
        DROP COLUMN IF EXISTS next_attempt_at
    `);
  }
}
