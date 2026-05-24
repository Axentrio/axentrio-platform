import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inbound Stripe webhook idempotency table — `chatbot_stripe_webhook_events`.
 *
 * Per `.scratch/plan-m0-foundation-reshape.md` § PR9: the existing
 * `webhook_event_log` table is channel-messaging-specific (Meta/Instagram/
 * Telegram) with NOT NULL columns (`channelConnectionId`, `channel`,
 * `dedupeKey`) that do not apply to Stripe billing events. Rather than
 * weaken those constraints, this migration creates a dedicated sibling
 * table for inbound Stripe events.
 *
 * `chatbot_` prefix because n8n shares this Postgres `public` schema —
 * unprefixed names carry silent collision risk. All constraints/indexes
 * explicitly named.
 *
 * The advisory-lock + SAVEPOINT concurrency contract is implemented in
 * `src/billing/events.ts` (`runStripeWebhookIdempotent`); this migration
 * just provides the schema.
 */
export class ExtendWebhookEventLogForStripeIdempotency1782500000000
  implements MigrationInterface
{
  name = 'ExtendWebhookEventLogForStripeIdempotency1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_stripe_webhook_events" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "provider" varchar(32) NOT NULL,
        "event_id" varchar(255) NOT NULL,
        "event_type" varchar(128) NOT NULL,
        "status" varchar(32) NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "subscription_id" varchar(255),
        "tenant_id" uuid,
        "payload" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "processed_at" timestamptz
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_stripe_webhook_events_provider_event"
         ON "chatbot_stripe_webhook_events" ("provider", "event_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_chatbot_stripe_webhook_events_status_created"
         ON "chatbot_stripe_webhook_events" ("status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_chatbot_stripe_webhook_events_tenant_created"
         ON "chatbot_stripe_webhook_events" ("tenant_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_stripe_webhook_events"`);
  }
}
