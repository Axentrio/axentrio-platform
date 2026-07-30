import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  INSTALL_TRANSCRIPT_REVISION_TRIGGER,
  DROP_BUMP_TRIGGER,
  DROP_BUMP_FUNCTION,
} from '../sql/transcript-revision.sql';

/**
 * Story 3 Release B — a monotonic transcript revision per chat session.
 *
 * The enrichment job reads a transcript, calls a model, then writes structured
 * fields. Between the read and the write, the transcript can change: a new message
 * arrives, an operator edits one, a message is deleted, or two commits land out of
 * order. Committing anyway means persisting a reading of a conversation that no
 * longer exists.
 *
 * A `(created_at, id)` high-water mark cannot detect that — it only ever moves
 * forward on INSERT and is blind to edits and deletes. So instead every mutation of
 * a session's messages bumps `chat_sessions.transcript_revision`, and enrichment
 * commits with a compare-and-swap against the value it read. If the revision moved,
 * the write is refused and the work is requeued.
 *
 * WHY A TRIGGER, not application code: there are nine distinct message-writing call
 * sites in api/src (widget, socket handler, channel inbound, agent replies, forwarding
 * service, canned responses, …). A TS-side bump would be forgotten by exactly one of
 * them, and the failure mode is silent — stale enrichment, not an error. The trigger
 * cannot be bypassed by any writer, present or future, including raw SQL.
 *
 * Cost: one extra UPDATE on chat_sessions per message. That row is already updated
 * per message (`last_activity_at`, `message_count`), so this adds no new row lock.
 *
 * Backfill: `transcript_revision` starts at 0 for existing sessions. That is correct
 * rather than lazy — no existing session has been enriched, so there is no prior
 * revision to be consistent with, and the first enrichment of any session simply
 * reads whatever the current value is.
 */
export class AddTranscriptRevision1787600000000 implements MigrationInterface {
  name = 'AddTranscriptRevision1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "transcript_revision" int NOT NULL DEFAULT 0`,
    );

    // Shared with src/__tests__/setup.ts so the migration-built (prod) schema and the
    // synchronize-built (test) schema install the SAME trigger. A trigger cannot come
    // from entity metadata, so without that sharing the test schema would silently
    // lack it and every compare-and-swap test would be vacuous.
    for (const stmt of INSTALL_TRANSCRIPT_REVISION_TRIGGER) {
      await queryRunner.query(stmt);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(DROP_BUMP_TRIGGER);
    await queryRunner.query(DROP_BUMP_FUNCTION);
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "transcript_revision"`);
  }
}
