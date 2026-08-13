/**
 * Vitest Global Setup
 * Runs once before the entire test suite (not per file).
 *
 * Builds one immutable schema template before any test file starts. Every file
 * process clones it into a disposable database in setup.ts.
 *
 * The stable worker names used to survive across runs while setup.ts repeatedly
 * synchronized them once PER FILE. That made schema state order-dependent and
 * performed hundreds of DDL repair passes during one suite. Holding an advisory
 * lock for the run also prevents two local suites from dropping each other's
 * worker databases.
 */
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { prepareTestSchema } from './test-schema';
import {
  testFileDatabasePrefix,
  testTemplateDatabaseName,
} from './worker-database';
import Redis from 'ioredis';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for integration tests');
}

const SUITE_LOCK = 1_780_813_001;
let admin: DataSource | null = null;

async function dropDatabase(database: string): Promise<void> {
  if (!admin) return;
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
}

async function cleanupFileDatabases(): Promise<void> {
  if (!admin) return;
  const prefix = testFileDatabasePrefix(TEST_DATABASE_URL!);
  const rows = await admin.query(
    `SELECT datname FROM pg_database WHERE datname LIKE $1`,
    [`${prefix}%`],
  ) as Array<{ datname: string }>;
  for (const { datname } of rows) {
    // The query prefix is narrow; the numeric suffix check is the destructive-operation fence.
    if (!new RegExp(`^${prefix}\\d+$`).test(datname)) continue;
    await dropDatabase(datname);
  }
}

async function cleanupRunRedis(): Promise<void> {
  const redisUrl = process.env.TEST_REDIS_URL;
  const runId = process.env.TEST_RUN_ID;
  if (!redisUrl || !runId) return;
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `test:${runId}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  } catch (error) {
    // Redis is not required by every focused test. Teardown must not turn an
    // otherwise-green DB-only run red when the optional test service is down.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[test teardown] Redis cleanup skipped: ${message}`);
  } finally {
    redis.disconnect();
  }
}

export async function setup() {
  const adminUrl = new URL(TEST_DATABASE_URL!);
  adminUrl.pathname = '/postgres';
  admin = new DataSource({ type: 'postgres', url: adminUrl.toString(), logging: false });
  await admin.initialize();
  await admin.query('SELECT pg_advisory_lock($1)', [SUITE_LOCK]);

  await cleanupFileDatabases();
  const templateDatabase = testTemplateDatabaseName(TEST_DATABASE_URL!);
  await dropDatabase(templateDatabase);
  await admin.query(`CREATE DATABASE "${templateDatabase}"`);

  // synchronize() is substantial DDL. Build it once, fully, before workers exist; PostgreSQL
  // clones give every file process the exact same completed schema.
  const template = new DataSource({
    ...AppDataSource.options,
    database: templateDatabase,
    migrations: [],
    migrationsRun: false,
    synchronize: false,
  } as DataSourceOptions);
  try {
    await template.initialize();
    await prepareTestSchema(template);
  } finally {
    if (template.isInitialized) await template.destroy();
  }
}

export async function teardown() {
  if (!admin?.isInitialized) return;
  await cleanupFileDatabases();
  await dropDatabase(testTemplateDatabaseName(TEST_DATABASE_URL!));
  await cleanupRunRedis();
  await admin.query('SELECT pg_advisory_unlock($1)', [SUITE_LOCK]);
  await admin.destroy();
  admin = null;
}
