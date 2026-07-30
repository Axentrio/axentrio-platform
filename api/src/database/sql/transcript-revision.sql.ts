/**
 * The transcript-revision trigger DDL, in ONE place.
 *
 * A trigger cannot be expressed in TypeORM entity metadata, so `synchronize()` — how
 * the integration test schema is built — will never create it. Left to the migration
 * alone, the trigger would exist in prod and NOT in test: the revision would never
 * bump under test, every compare-and-swap would trivially succeed, and the tests that
 * are supposed to prove enrichment refuses stale writes would pass while proving
 * nothing.
 *
 * So both the migration and `src/__tests__/setup.ts` import these constants. They
 * cannot drift, and the test schema behaves like prod.
 */

/** Bumps `chat_sessions.transcript_revision` for the affected session. */
export const CREATE_BUMP_FUNCTION = `
CREATE OR REPLACE FUNCTION bump_transcript_revision() RETURNS trigger AS $$
BEGIN
  UPDATE chat_sessions
     SET transcript_revision = transcript_revision + 1
   WHERE id = COALESCE(NEW.session_id, OLD.session_id);
  RETURN NULL; -- AFTER trigger; return value is ignored
END;
$$ LANGUAGE plpgsql;
`;

export const DROP_BUMP_TRIGGER = `DROP TRIGGER IF EXISTS trg_bump_transcript_revision ON "messages"`;

/**
 * AFTER so a rolled-back insert leaves no phantom bump. Fires on UPDATE and DELETE
 * too — an edited or removed message changes what the model would read, which a
 * forward-only high-water mark cannot detect.
 */
export const CREATE_BUMP_TRIGGER = `
CREATE TRIGGER trg_bump_transcript_revision
AFTER INSERT OR UPDATE OR DELETE ON "messages"
FOR EACH ROW EXECUTE FUNCTION bump_transcript_revision();
`;

export const DROP_BUMP_FUNCTION = `DROP FUNCTION IF EXISTS bump_transcript_revision()`;

/** Install (idempotent). Used by the migration and by the test bootstrap. */
export const INSTALL_TRANSCRIPT_REVISION_TRIGGER: readonly string[] = [
  CREATE_BUMP_FUNCTION,
  DROP_BUMP_TRIGGER,
  CREATE_BUMP_TRIGGER,
];
