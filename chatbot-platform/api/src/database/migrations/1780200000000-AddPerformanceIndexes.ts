import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPerformanceIndexes1780200000000 implements MigrationInterface {
  name = 'AddPerformanceIndexes1780200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Inbox sort: sessions ordered by last_activity_at per tenant
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_tenant_activity
      ON chat_sessions (tenant_id, last_activity_at DESC)
    `);

    // Last message preview: DISTINCT ON (session_id) ORDER BY created_at DESC
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_created_desc
      ON messages (session_id, created_at DESC)
    `);

    // Agent inbox: filter by assigned agent on active sessions
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent_activity
      ON chat_sessions (assigned_agent_id, last_activity_at DESC)
      WHERE status != 'closed'
    `);

    // Stale session cleanup: status + last_activity_at for the batch UPDATE
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_stale_cleanup
      ON chat_sessions (status, last_activity_at)
      WHERE status IN ('bot', 'waiting')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_chat_sessions_stale_cleanup`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_chat_sessions_agent_activity`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_messages_session_created_desc`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_chat_sessions_tenant_activity`);
  }
}
