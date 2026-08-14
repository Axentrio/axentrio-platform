import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the durable ownership and human-control policy foundation for ChatSession.
 *
 * Ownership is deliberately separate from the existing `status` column. Current readers keep
 * using the legacy status state, while the later conversation command service will own writes to
 * this new state machine. The policy fields are nullable because this migration only makes the
 * future state representable; a later command-service migration will define the lifecycle rules.
 *
 * The duration CHECK is also declared on ChatSession. Test databases are built with TypeORM's
 * `synchronize()` rather than by running migrations, so the entity and migration must carry the
 * same invariant.
 */
export class AddSessionOwnershipColumns1791300000000 implements MigrationInterface {
  name = 'AddSessionOwnershipColumns1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NOT NULL + DEFAULT backfills existing rows in place (PG 11+), without a table rewrite.
    await queryRunner.query(`
      ALTER TABLE chat_sessions
        ADD COLUMN IF NOT EXISTS ownership varchar(24) NOT NULL DEFAULT 'bot_owned',
        ADD COLUMN IF NOT EXISTS ownership_version integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS human_control_mode varchar(16),
        ADD COLUMN IF NOT EXISTS human_control_duration_hours integer,
        ADD COLUMN IF NOT EXISTS human_control_until timestamptz,
        ADD COLUMN IF NOT EXISTS human_control_started_at timestamptz
    `);

    // Map the legacy status onto durable ownership. An ASSIGNED agent on a live conversation
    // (handoff accepted, OR an `active` human-served session — `assignAgent()` sets status='active')
    // means a human owns it: err towards human_owned so the AI stays out of a session a human
    // touched. Other rows keep the bot_owned default and need no write.
    await queryRunner.query(`
      UPDATE chat_sessions
         SET ownership = CASE
           WHEN status = 'closed' THEN 'closed'
           WHEN assigned_agent_id IS NOT NULL AND status IN ('handoff', 'active') THEN 'human_owned'
           WHEN status = 'handoff' THEN 'handoff_requested'
           ELSE 'bot_owned'
         END
       WHERE status IN ('closed', 'handoff', 'active')
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'chk_chat_sessions_human_control_duration_hours'
             AND conrelid = 'chat_sessions'::regclass
        ) THEN
          ALTER TABLE chat_sessions
            ADD CONSTRAINT chk_chat_sessions_human_control_duration_hours
            CHECK ("human_control_duration_hours" IS NULL OR ("human_control_duration_hours" >= 1 AND "human_control_duration_hours" <= 24));
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chat_sessions
        DROP CONSTRAINT IF EXISTS chk_chat_sessions_human_control_duration_hours
    `);
    await queryRunner.query(`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS ownership`);
    await queryRunner.query(`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS ownership_version`);
    await queryRunner.query(`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS human_control_mode`);
    await queryRunner.query(`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS human_control_duration_hours`);
    await queryRunner.query(`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS human_control_until`);
    await queryRunner.query(`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS human_control_started_at`);
  }
}
