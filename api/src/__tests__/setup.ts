/**
 * Per-test-file setup. `env-setup.ts` has already pointed DATABASE_URL at this
 * file process's database, so importing AppDataSource here binds it there.
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
import { assertTestSchemaReady } from './test-schema';
import {
  testFileDatabaseName,
  testTemplateDatabaseName,
} from './worker-database';
import { beforeAll, afterAll, afterEach } from 'vitest';

const testDatabaseBaseUrl = process.env.TEST_DATABASE_BASE_URL ?? process.env.TEST_DATABASE_URL;
const workerId = process.env.VITEST_WORKER_ID ?? '0';
const fileDatabase = testFileDatabaseName(testDatabaseBaseUrl, workerId);
const templateDatabase = testTemplateDatabaseName(testDatabaseBaseUrl);

async function adminDataSource(): Promise<DataSource> {
  const adminUrl = new URL(testDatabaseBaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new DataSource({ type: 'postgres', url: adminUrl.toString(), logging: false });
  await admin.initialize();
  return admin;
}

beforeAll(async () => {
  if (AppDataSource.isInitialized) return;

  const admin = await adminDataSource();
  try {
    await admin.query(`CREATE DATABASE "${fileDatabase}" TEMPLATE "${templateDatabase}"`);
  } finally {
    await admin.destroy();
  }
  await AppDataSource.initialize();
  await assertTestSchemaReady(AppDataSource);
});

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  const admin = await adminDataSource();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [fileDatabase],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${fileDatabase}"`);
  } finally {
    await admin.destroy();
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
