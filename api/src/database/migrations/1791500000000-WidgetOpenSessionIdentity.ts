import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One non-closed widget session per stable customer identity (B-PR4a, pilot
 * operations capability B5).
 *
 * ORDER IS LOAD-BEARING. Step 1 remediates the duplicates that already exist
 * in production ('anonymous' visitors, two-tab races, the dead status='active'
 * resolve filter). Step 2 then builds the partial unique index. If the index
 * ran first it would fail on the dirty data and crash-loop every boot, because
 * migrations run on boot (migrationsRun) inside a transaction that would roll
 * back and retry forever.
 *
 * Remediation keeps, per (tenant_id, bot_id, visitor_id), the most recently
 * active non-closed WIDGET session (last_activity_at DESC, created_at DESC)
 * and closes the rest with a machine-readable metadata note
 * (metadata.closedReason = 'b4a_dedup') so B-PR4b's possible-duplicates audit
 * can find them. down() drops the index only - it never reopens the closed
 * sessions (that history is a fact, not schema).
 *
 * Only source='widget' rows are touched or indexed: external channel sessions
 * (source = 'telegram' | 'messenger' | ...) keep their one-thread invariant
 * via the conversation_bindings unique key and are invisible to this index.
 *
 * Literals are untyped on purpose: status is a pg enum in some environments
 * and a varchar in others (see the migrations-test-vs-prod-schema gotcha);
 * `status <> 'closed'` resolves correctly against both. No enum casts.
 *
 * Boot-window race (deploy assumption): if an old instance inserted a fresh
 * duplicate between the remediation UPDATE and the index build, the CREATE
 * INDEX fails, the migration transaction rolls back, and boot retries -
 * remediation then re-runs against the new state and converges (worst case
 * one extra restart, never a crash-loop). In this deploy model that window is
 * theoretical anyway: old widget clients send only random visitorIds (which
 * cannot collide), and migrations run before the server accepts traffic. The
 * pre-deploy dup-count gate confirms the data is clean before this ships.
 */
export class WidgetOpenSessionIdentity1791500000000 implements MigrationInterface {
  name = 'WidgetOpenSessionIdentity1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // STEP 1 - remediate duplicate non-closed widget sessions per identity.
    // rn = 1 is the survivor; everything else is closed with the audit note.
    // ended_at is set only where it was null (a closed session with no end
    // time would be a new inconsistency, not a smaller one).
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY tenant_id, bot_id, visitor_id
                 ORDER BY last_activity_at DESC NULLS LAST, created_at DESC, id DESC
               ) AS rn
          FROM chat_sessions
         WHERE status <> 'closed'
           AND source = 'widget'
      )
      UPDATE chat_sessions s
         SET status = 'closed',
             ownership = 'closed',
             ended_at = COALESCE(s.ended_at, now()),
             metadata = COALESCE(s.metadata, '{}'::jsonb)
                        || jsonb_build_object('closedReason', 'b4a_dedup'),
             updated_at = now()
        FROM ranked r
       WHERE s.id = r.id
         AND r.rn > 1
    `);

    // STEP 2 - the invariant. Plain CREATE (not CONCURRENTLY): migrations run
    // inside a transaction, and step 1 just cleaned the exact rows that could
    // make this fail. IF NOT EXISTS keeps a re-run (and the synchronized test
    // schema, which mirrors this index from the entity) idempotent.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_sessions_widget_open
        ON chat_sessions (tenant_id, bot_id, visitor_id)
        WHERE status <> 'closed' AND source = 'widget'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the index only. Sessions closed by remediation STAY closed -
    // reopening them would recreate the duplicate-thread state on purpose.
    await queryRunner.query(`DROP INDEX IF EXISTS uq_chat_sessions_widget_open`);
  }
}
