import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionPerformanceIndexes1774800000000 implements MigrationInterface {
  name = 'AddSessionPerformanceIndexes1774800000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_chat_sessions_tenant_status_created"
       ON "chat_sessions" ("tenant_id", "status", "created_at")`
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_chat_sessions_tenant_last_activity"
       ON "chat_sessions" ("tenant_id", "last_activity_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_chat_sessions_tenant_status_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_chat_sessions_tenant_last_activity"`);
  }
}
