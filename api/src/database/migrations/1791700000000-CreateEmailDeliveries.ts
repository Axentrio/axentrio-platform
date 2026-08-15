import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEmailDeliveries1791700000000 implements MigrationInterface {
  name = 'CreateEmailDeliveries1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS email_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        recipient_user_id uuid,
        recipient_email varchar(255) NOT NULL,
        subject varchar(255) NOT NULL,
        kind varchar(64) NOT NULL,
        related_id uuid NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'pending',
        attempt_count int NOT NULL DEFAULT 0,
        idempotency_key varchar(255) NOT NULL,
        provider_message_id varchar(255),
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_email_deliveries_status'
             AND conrelid = 'email_deliveries'::regclass
        ) THEN
          ALTER TABLE email_deliveries
            ADD CONSTRAINT ck_email_deliveries_status CHECK (
              status IN ('pending', 'sent', 'failed')
            );
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_email_deliveries_tenant_id
        ON email_deliveries (tenant_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_email_deliveries_related_id
        ON email_deliveries (related_id)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_email_deliveries_idempotency_key
        ON email_deliveries (idempotency_key)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS email_deliveries`);
  }
}
