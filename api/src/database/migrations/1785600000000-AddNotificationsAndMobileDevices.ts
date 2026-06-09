import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mobile notifications + push.
 *
 * Purely additive — creates three NEW tables (no changes to existing schema):
 *   - notifications: DB-backed operator notifications (replaces the in-memory store)
 *   - mobile_devices: registered push targets
 *   - notification_deliveries: per-device delivery tracking
 *
 * Uses CREATE TABLE IF NOT EXISTS so it is safe to (re-)run. gen_random_uuid()
 * is built into Postgres 13+ (no extension required).
 */
export class AddNotificationsAndMobileDevices1785600000000 implements MigrationInterface {
  name = 'AddNotificationsAndMobileDevices1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "recipient_user_id" uuid NOT NULL,
        "type" varchar(64) NOT NULL,
        "title" varchar(200) NOT NULL,
        "message" text NOT NULL,
        "data" jsonb,
        "read_at" timestamptz,
        "dedupe_key" varchar(255),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notifications" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_notifications_dedupe_key"
        ON "notifications" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_notifications_recipient"
        ON "notifications" ("tenant_id", "recipient_user_id", "read_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mobile_devices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "clerk_user_id" varchar(255),
        "expo_push_token" varchar(255) NOT NULL,
        "native_token" varchar(255),
        "platform" varchar(16) NOT NULL,
        "device_id" varchar(255),
        "app_version" varchar(32),
        "build_number" varchar(32),
        "runtime_version" varchar(64),
        "locale" varchar(16),
        "timezone" varchar(64),
        "permission_status" varchar(24),
        "environment" varchar(16),
        "last_seen_at" timestamptz,
        "revoked_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_mobile_devices" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_mobile_devices_expo_token"
        ON "mobile_devices" ("expo_push_token")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_mobile_devices_tenant_user"
        ON "mobile_devices" ("tenant_id", "user_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_deliveries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "notification_id" uuid NOT NULL,
        "device_id" uuid NOT NULL,
        "status" varchar(24) NOT NULL DEFAULT 'pending',
        "ticket_id" varchar(255),
        "receipt_id" varchar(255),
        "error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notification_deliveries" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_notification_deliveries_notification"
        ON "notification_deliveries" ("notification_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_notification_deliveries_device"
        ON "notification_deliveries" ("device_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_deliveries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mobile_devices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications"`);
  }
}
