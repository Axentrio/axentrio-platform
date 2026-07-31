import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Expression index for per-lead CRM sync status.
 *
 * `GET /leads/:id/sync` answers "did this lead reach my CRM?" by finding the delivery
 * attempts whose payload carries that lead id. `webhook_delivery_logs` is indexed on
 * (tenant_id, created_at) only, so without this the lookup scans every delivery this
 * tenant has ever made and filters on a jsonb path.
 *
 * Same class of mistake as the missing `chatbot_bookings.lead_id` index earlier in this
 * branch — added up front this time rather than found in review.
 *
 * The expression must match the query EXACTLY (`-> 'lead' ->> 'leadId'`) or Postgres
 * will not use it. Partial on rows that actually carry a lead payload: booking and
 * conversation events share this table and can never satisfy the predicate, so keeping
 * them out costs nothing and keeps the index small.
 */
export class AddWebhookLeadIndex1787900000000 implements MigrationInterface {
  name = 'AddWebhookLeadIndex1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_webhook_logs_lead"
        ON "webhook_delivery_logs" ((request_body -> 'lead' ->> 'leadId'))
        WHERE request_body -> 'lead' ->> 'leadId' IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_webhook_logs_lead"`);
  }
}
