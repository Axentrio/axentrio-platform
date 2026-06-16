import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Turn-coalescer durable "answered" high-water mark (plan-message-coalescer.md).
 *
 * Two nullable columns on chat_sessions record the (created_at, id) of the newest
 * USER message a completed coalesced run consumed. "Unanswered" is then defined by
 * the tuple compare (created_at, id) > (last_coalesced_answer_at,
 * last_coalesced_answer_message_id) — independent of bot-reply ordering, and
 * durable across Redis flush/restart. Nullable, no backfill: null ⇒ everything
 * unanswered, which self-heals on the first run. Idempotent.
 *
 * Also adds a composite index (session_id, created_at, id) on messages to back the
 * newest-unanswered query (the existing index is (session_id, created_at) only).
 */
export class AddCoalescedAnswerWatermark1786700000000 implements MigrationInterface {
  name = 'AddCoalescedAnswerWatermark1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chat_sessions"
        ADD COLUMN IF NOT EXISTS "last_coalesced_answer_at" timestamptz NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_sessions"
        ADD COLUMN IF NOT EXISTS "last_coalesced_answer_message_id" uuid NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_session_created_id"
        ON "messages" ("session_id", "created_at", "id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_session_created_id"`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "last_coalesced_answer_message_id"`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "last_coalesced_answer_at"`);
  }
}
