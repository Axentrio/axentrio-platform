/**
 * First setup file — runs before `setup.ts` and before any test-file imports.
 *
 * Points DATABASE_URL at a per-worker database (`chatbot_test_<workerId>`) so
 * Vitest can run files in parallel without the per-test TRUNCATE in one worker
 * wiping another worker's rows. This MUST happen before `setup.ts` statically
 * imports the data source (which reads DATABASE_URL at import time), hence the
 * split into its own setupFile that imports no app code.
 */
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for integration tests');
}

// Vitest assigns each worker a stable 1-based id, reused across files.
const workerId = process.env.VITEST_POOL_ID ?? '1';

const baseUrl = new URL(process.env.TEST_DATABASE_URL);
const baseDbName = baseUrl.pathname.replace(/^\//, '') || 'chatbot_test';
const workerUrl = new URL(baseUrl.toString());
workerUrl.pathname = `/${baseDbName}_${workerId}`;

process.env.DATABASE_URL = workerUrl.toString();
process.env.TEST_DATABASE_URL = workerUrl.toString();
