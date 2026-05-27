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
});

afterEach(async () => {
  if (!AppDataSource.isInitialized) return;
  const tableNames = AppDataSource.entityMetadatas
    .map((entity) => `"${entity.tableName}"`)
    .join(', ');
  if (tableNames) {
    await AppDataSource.query(`TRUNCATE TABLE ${tableNames} CASCADE`);
  }
});
