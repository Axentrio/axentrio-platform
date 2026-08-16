import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Handoff-notification outbox (ADR-0018). Additive: a new table only, so `up`
 * is a pure create and `down` a pure drop. The claim index covers the worker's
 * `status = 'pending' AND next_attempt_at <= now()` scan; the unique index keeps
 * one row per handoff.
 */
export class CreateNotificationOutbox1791800000000 implements MigrationInterface {
  name = 'CreateNotificationOutbox1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        kind varchar(64) NOT NULL,
        related_id uuid NOT NULL,
        payload jsonb NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'pending',
        attempt_count int NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_notification_outbox_status'
             AND conrelid = 'notification_outbox'::regclass
        ) THEN
          ALTER TABLE notification_outbox
            ADD CONSTRAINT ck_notification_outbox_status CHECK (
              status IN ('pending', 'sent', 'dead')
            );
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_notification_outbox_claim
        ON notification_outbox (status, next_attempt_at)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_outbox_kind_related
        ON notification_outbox (kind, related_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS notification_outbox`);
  }
}
