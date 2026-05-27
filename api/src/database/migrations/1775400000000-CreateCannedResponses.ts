import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCannedResponses1775400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE canned_responses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "createdByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
        title VARCHAR(100) NOT NULL,
        shortcut VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        category VARCHAR(50),
        tags VARCHAR(50)[] NOT NULL DEFAULT '{}',
        scope VARCHAR(10) NOT NULL DEFAULT 'personal' CHECK (scope IN ('shared', 'personal')),
        "usageCount" INT NOT NULL DEFAULT 0,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`CREATE INDEX idx_canned_responses_tenant_active ON canned_responses("tenantId", "isActive")`);
    await queryRunner.query(`CREATE INDEX idx_canned_responses_tenant_scope ON canned_responses("tenantId", scope)`);
    await queryRunner.query(`CREATE UNIQUE INDEX idx_canned_responses_shared_shortcut ON canned_responses("tenantId", shortcut) WHERE scope = 'shared' AND "isActive" = true`);
    await queryRunner.query(`CREATE UNIQUE INDEX idx_canned_responses_personal_shortcut ON canned_responses("createdByUserId", shortcut) WHERE scope = 'personal' AND "isActive" = true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS canned_responses`);
  }
}
