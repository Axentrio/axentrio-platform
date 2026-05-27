import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subscription/feature-access epic — M0 PR10.
 *
 * Adds an `attempt` column to `webhook_delivery_logs` so the outbound
 * delivery path can persist one row per delivery attempt (not just per
 * event). M11 (Enterprise CRM stand-in) and M0 PR11 (demand-signal
 * telemetry) both depend on this attempt-level visibility.
 *
 * The remaining columns required by the hardened deliver flow
 * (`tenantId`, `event`, `url`, `status`, `httpStatus`, `error`,
 * `requestBody`, `createdAt`) already exist on the entity from earlier
 * migrations; only `attempt` is new.
 *
 * See .scratch/plan-m0-foundation-reshape.md § PR10 for the full spec.
 */
export class HardenWebhookDeliveryLog1782200000000 implements MigrationInterface {
  name = 'HardenWebhookDeliveryLog1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_delivery_logs" ADD COLUMN IF NOT EXISTS "attempt" integer NOT NULL DEFAULT 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_delivery_logs" DROP COLUMN IF EXISTS "attempt"`,
    );
  }
}
