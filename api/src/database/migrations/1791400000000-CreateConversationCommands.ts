import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Idempotency store for the conversation command service (B-PR2b).
 *
 * One row per committed command that carried a client idempotency key, unique on
 * (session_id, command, idempotency_key). The row is inserted inside the command
 * transaction, so its existence == "the transition committed"; a retry replays
 * the stored result instead of re-applying the transition.
 *
 * ON DELETE CASCADE mirrors the entity: the admin bulk-delete path removes
 * chat_sessions with raw SQL and must not be blocked by command bookkeeping.
 */
export class CreateConversationCommands1791400000000 implements MigrationInterface {
  name = 'CreateConversationCommands1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS conversation_commands (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL,
        tenant_id uuid NOT NULL,
        command varchar(32) NOT NULL,
        idempotency_key varchar(128) NOT NULL,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_conversation_commands_session
          FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_commands_session_command_key
        ON conversation_commands (session_id, command, idempotency_key)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS conversation_commands`);
  }
}
