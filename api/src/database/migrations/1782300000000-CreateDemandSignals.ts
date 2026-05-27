import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subscription/feature-access epic — M0 PR11.
 *
 * Creates `chatbot_demand_signals` — the storage backing for Coming Soon
 * `Notify me` / `Contact Sales` clicks. The `chatbot_` prefix is required
 * because n8n shares this Postgres `public` schema; unprefixed table names
 * carry silent collision risk.
 *
 * All constraints/indexes are explicitly named in this migration (no auto-
 * generated names) for the same reason — predictable naming + no surprise
 * collisions with n8n migrations.
 */
export class CreateDemandSignals1782300000000 implements MigrationInterface {
  name = 'CreateDemandSignals1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE chatbot_demand_signals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        feature VARCHAR(64) NOT NULL,
        current_tier VARCHAR(32) NOT NULL,
        locale VARCHAR(8) NOT NULL,
        context JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_chatbot_demand_signals_tenant
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX idx_chatbot_demand_signals_tenant_feature_created
       ON chatbot_demand_signals (tenant_id, feature, created_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS chatbot_demand_signals`);
  }
}
