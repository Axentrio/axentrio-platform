/**
 * Per-test-file setup. `env-setup.ts` has already rewritten DATABASE_URL to this
 * worker's database, so importing AppDataSource here binds it to that database.
 *
 * AppDataSource is imported statically (not dynamically inside beforeAll): setup
 * files are evaluated before the test file, so this resolves to the REAL module
 * even for test files that later `vi.mock('../../database/data-source')`.
 */
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for integration tests');
}

import { DataSource } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { INSTALL_TRANSCRIPT_REVISION_TRIGGER } from '../database/sql/transcript-revision.sql';
import { beforeAll, afterEach } from 'vitest';

// Worker DB name derived the same way env-setup.ts did.
const workerDbName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, '');

async function ensureWorkerDatabase(): Promise<void> {
  const adminUrl = new URL(process.env.DATABASE_URL!);
  adminUrl.pathname = '/postgres';
  const admin = new DataSource({ type: 'postgres', url: adminUrl.toString(), logging: false });
  await admin.initialize();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [workerDbName]);
  if (exists.length === 0) {
    await admin.query(`CREATE DATABASE "${workerDbName}"`);
  }
  await admin.destroy();
}

beforeAll(async () => {
  if (AppDataSource.isInitialized) return;

  await ensureWorkerDatabase();
  await AppDataSource.initialize();
  // Extensions must exist before synchronize() creates vector / trigram columns.
  await AppDataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  try {
    await AppDataSource.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch {
    console.warn('pgvector extension not available — skipping (knowledge base features will not work in tests)');
  }
  try {
    await AppDataSource.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } catch {
    console.warn('pg_trgm extension not available — Copilot lexical retrieval tests will fail');
  }
  // Idempotent: creates only missing tables/columns. afterEach keeps rows clean.
  await AppDataSource.synchronize();

  // Triggers are NOT part of entity metadata, so synchronize() cannot create them.
  // Installed from the same shared DDL the migration uses, so the test schema behaves
  // like prod: without this the transcript revision would never bump under test and
  // every enrichment compare-and-swap assertion would pass while proving nothing.
  for (const stmt of INSTALL_TRANSCRIPT_REVISION_TRIGGER) {
    await AppDataSource.query(stmt);
  }
});

afterEach(async () => {
  if (!AppDataSource.isInitialized) return;
  const tables = AppDataSource.entityMetadatas.map((e) => e.tableName);
  if (!tables.length) return;

  // Truncate only the tables that actually hold rows.
  //
  // TRUNCATE assigns a FRESH relfilenode per table and the dropped files are
  // unlinked only at CHECKPOINT, so blanket-truncating every table after every
  // test creates roughly (tables x tests) files per run — ~100k for this suite.
  // On the RAM-backed PGDATA that outruns even a 30s checkpoint and PGDATA hits
  // "No space left on device"; the failed TRUNCATE then cascades into unrelated
  // duplicate-key failures, so the suite fails in a different place each run and
  // reads as flaky. (Seen locally as 2 -> 164 -> 169 failures across identical
  // runs; the docker-compose tuning already in place cannot fix it because the
  // real ceiling is the Docker VM's memory, not the tmpfs `size`.)
  //
  // Most files here never touch Postgres — pure unit tests still paid the full
  // truncate after every single test. Probing costs a scan of an empty table
  // (zero pages, microseconds); creating a file does not.
  //
  // EXACT, not an estimate: pg_class.reltuples would be cheaper still but is a
  // stale planner statistic, and a missed truncate leaks rows into the next test
  // — trading a loud failure for a silent one.
  const probe = tables
    .map((t) => `SELECT '${t}' AS t WHERE EXISTS (SELECT 1 FROM "${t}")`)
    .join(' UNION ALL ');
  const dirty: Array<{ t: string }> = await AppDataSource.query(probe);
  if (!dirty.length) return;

  // CASCADE still covers referencing tables; any that hold rows are in this list
  // already, and truncating an empty one is a no-op.
  await AppDataSource.query(
    `TRUNCATE TABLE ${dirty.map((r) => `"${r.t}"`).join(', ')} CASCADE`,
  );
});
