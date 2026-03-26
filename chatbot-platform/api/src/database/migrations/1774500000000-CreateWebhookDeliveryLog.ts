import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebhookDeliveryLog1774500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum types
    await queryRunner.query(`
      CREATE TYPE webhook_delivery_direction AS ENUM ('inbound', 'outbound')
    `);
    await queryRunner.query(`
      CREATE TYPE webhook_delivery_status AS ENUM ('success', 'failed', 'retrying', 'dropped')
    `);

    await queryRunner.query(`
      CREATE TABLE webhook_delivery_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        event VARCHAR(100) NOT NULL,
        direction webhook_delivery_direction NOT NULL,
        url VARCHAR(500) NOT NULL,
        status webhook_delivery_status NOT NULL,
        http_status INT,
        duration_ms INT NOT NULL DEFAULT 0,
        error TEXT,
        request_body JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_webhook_delivery_tenant_created
      ON webhook_delivery_logs (tenant_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS webhook_delivery_logs`);
    await queryRunner.query(`DROP TYPE IF EXISTS webhook_delivery_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS webhook_delivery_direction`);
  }
}
