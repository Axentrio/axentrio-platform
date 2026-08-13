/**
 * Vitest Global Setup
 * Runs once before the entire test suite (not per file).
 *
 * Replaces every worker database once, before any test file starts. Test files
 * then initialise the schema once per worker (see setup.ts) and only clean data.
 *
 * The stable worker names used to survive across runs while setup.ts repeatedly
 * synchronized them once PER FILE. That made schema state order-dependent and
 * performed hundreds of DDL repair passes during one suite. Holding an advisory
 * lock for the run also prevents two local suites from dropping each other's
 * worker databases.
 */
import { DataSource } from 'typeorm';
import { TEST_WORKER_COUNT, workerDatabaseName } from './worker-database';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for integration tests');
}

const SUITE_LOCK = 1_780_813_001;
let admin: DataSource | null = null;

export async function setup() {
  const adminUrl = new URL(TEST_DATABASE_URL!);
  adminUrl.pathname = '/postgres';
  admin = new DataSource({ type: 'postgres', url: adminUrl.toString(), logging: false });
  await admin.initialize();
  await admin.query('SELECT pg_advisory_lock($1)', [SUITE_LOCK]);

  for (let workerId = 1; workerId <= TEST_WORKER_COUNT; workerId++) {
    const database = workerDatabaseName(TEST_DATABASE_URL!, workerId);
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.query(`CREATE DATABASE "${database}"`);
  }
}

export async function teardown() {
  if (!admin?.isInitialized) return;
  await admin.query('SELECT pg_advisory_unlock($1)', [SUITE_LOCK]);
  await admin.destroy();
  admin = null;
}
