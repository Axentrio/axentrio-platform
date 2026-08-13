import type { DataSource } from 'typeorm';
import { INSTALL_BOOKING_BLOCKED_RANGE } from '../database/sql/booking-blocked-range.sql';
import { INSTALL_TRANSCRIPT_REVISION_TRIGGER } from '../database/sql/transcript-revision.sql';

export const TEST_SCHEMA_SENTINEL = '_vitest_schema_ready';

/** Build the complete synchronize-based test schema before any test worker starts. */
export async function prepareTestSchema(dataSource: DataSource): Promise<void> {
  // Extensions must exist before synchronize() creates vector / trigram columns.
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  try {
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch {
    console.warn('pgvector extension not available — skipping (knowledge base features will not work in tests)');
  }
  try {
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } catch {
    console.warn('pg_trgm extension not available — Copilot lexical retrieval tests will fail');
  }

  await dataSource.synchronize();

  // Triggers and the blocked range are migration-owned DDL that entity synchronization cannot
  // express. Install the same shared SQL production migrations use.
  for (const stmt of INSTALL_TRANSCRIPT_REVISION_TRIGGER) {
    await dataSource.query(stmt);
  }
  for (const stmt of INSTALL_BOOKING_BLOCKED_RANGE) {
    await dataSource.query(stmt);
  }

  // Created last. A clone carrying this table therefore carries the complete schema above.
  await dataSource.query(
    `CREATE TABLE "${TEST_SCHEMA_SENTINEL}" (ready boolean NOT NULL DEFAULT true)`,
  );
}

export async function assertTestSchemaReady(dataSource: DataSource): Promise<void> {
  const [{ ready }] = await dataSource.query(
    `SELECT to_regclass('public.${TEST_SCHEMA_SENTINEL}') IS NOT NULL AS ready`,
  );
  if (!ready) {
    throw new Error('Vitest worker database started without the schema prepared by global setup');
  }
}
