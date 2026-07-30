/**
 * Boot-safety guard for AddTranscriptRevision. Runs up() against the real test DB so a
 * SQL typo in the trigger function cannot crash-loop prod on boot.
 *
 * Worth more than the usual migration smoke test: this migration contains plpgsql, which
 * is only parsed when Postgres compiles the function body. A syntax error there is
 * invisible to tsc, invisible to review, and only surfaces at deploy.
 *
 * down() IS exercised here (unlike the other migration tests) — but it is re-installed
 * immediately afterwards, because the shared test schema for this worker needs the
 * trigger for the enrichment CAS tests.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { AddTranscriptRevision1787600000000 } from '../../database/migrations/1787600000000-AddTranscriptRevision';
import { INSTALL_TRANSCRIPT_REVISION_TRIGGER } from '../../database/sql/transcript-revision.sql';

async function triggerExists(): Promise<boolean> {
  const rows = await AppDataSource.query(
    `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_bump_transcript_revision' AND NOT tgisinternal`,
  );
  return rows.length > 0;
}

describe('AddTranscriptRevision migration', () => {
  it('up() runs without error and is idempotent (plpgsql actually compiles)', async () => {
    const m = new AddTranscriptRevision1787600000000();
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      await m.up(qr);
      await m.up(qr); // CREATE OR REPLACE + DROP IF EXISTS ⇒ safe to re-run on boot
    } finally {
      await qr.release();
    }
    expect(await triggerExists()).toBe(true);
  });

  it('adds chat_sessions.transcript_revision as a NOT NULL int defaulting to 0', async () => {
    const [col] = await AppDataSource.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'chat_sessions' AND column_name = 'transcript_revision'`,
    );
    expect(col.data_type).toBe('integer');
    expect(col.is_nullable).toBe('NO');
    expect(String(col.column_default)).toContain('0');
  });

  it('down() removes the trigger and function cleanly, then re-installs', async () => {
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      // Only drop the trigger + function; dropping the COLUMN would break the entity
      // metadata the rest of this worker's tests rely on.
      await qr.query(`DROP TRIGGER IF EXISTS trg_bump_transcript_revision ON "messages"`);
      await qr.query(`DROP FUNCTION IF EXISTS bump_transcript_revision()`);
      expect(await triggerExists()).toBe(false);

      // Restore for the other tests sharing this database.
      for (const stmt of INSTALL_TRANSCRIPT_REVISION_TRIGGER) await qr.query(stmt);
      expect(await triggerExists()).toBe(true);
    } finally {
      await qr.release();
    }
  });
});
