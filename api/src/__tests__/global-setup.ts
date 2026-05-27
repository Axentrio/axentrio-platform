/**
 * Vitest Global Setup
 * Runs once before the entire test suite (not per file).
 *
 * Schema creation is now per-worker (see setup.ts): each worker drops/creates
 * its own `chatbot_test_<id>` database so files can run in parallel without
 * truncating each other's rows. Here we just fail fast if the server is
 * unreachable, so a misconfigured DATABASE_URL surfaces once rather than in
 * every worker.
 */
import { DataSource } from 'typeorm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for integration tests');
}

export async function setup() {
  const adminUrl = new URL(TEST_DATABASE_URL!);
  adminUrl.pathname = '/postgres';
  const ds = new DataSource({ type: 'postgres', url: adminUrl.toString(), logging: false });
  await ds.initialize();
  await ds.query('SELECT 1');
  await ds.destroy();
}

export async function teardown() {
  // Worker databases persist for inspection; they are dropped/recreated next run.
}
