import { testFileDatabaseUrl } from './worker-database';

/**
 * First setup file — runs before `setup.ts` and before any test-file imports.
 *
 * Points DATABASE_URL at a per-worker database (`chatbot_test_<workerId>`) so
 * Vitest can run files in parallel without the per-test TRUNCATE in one worker
 * wiping another worker's rows. This MUST happen before `setup.ts` statically
 * imports the data source (which reads DATABASE_URL at import time), hence the
 * split into its own setupFile that imports no app code.
 */
const testDatabaseBaseUrl = process.env.TEST_DATABASE_BASE_URL ?? process.env.TEST_DATABASE_URL;
if (!testDatabaseBaseUrl) {
  throw new Error('TEST_DATABASE_BASE_URL must be set for integration tests');
}

// VITEST_POOL_ID is a recycled concurrency slot. VITEST_WORKER_ID identifies this file process
// for the run and therefore cannot share its database or Redis namespace with another file.
const workerId = process.env.VITEST_WORKER_ID ?? '0';

// TEST_DATABASE_URL remains the immutable suite base. Replacing it with the derived URL made the
// meaning of the variable depend on which setup context read it and allowed repeated suffixing.
process.env.TEST_DATABASE_BASE_URL = testDatabaseBaseUrl;
process.env.TEST_DATABASE_URL = testDatabaseBaseUrl;
process.env.DATABASE_URL = testFileDatabaseUrl(testDatabaseBaseUrl, workerId);

// The DATABASE is per worker; REDIS was not. Four workers shared one unprefixed keyspace, so a
// cache, lock or counter written by one was read by another — against a DIFFERENT database. Any
// key that is not tenant-scoped collides outright, and the symptom is a failure in whichever file
// happened to be running, which reads as flake and moves every run.
//
// Same worker id as the database above, so a worker's two stores always agree about whose data
// they hold.
const testRunId = process.env.TEST_RUN_ID ?? 'local';
process.env.REDIS_KEY_PREFIX = `test:${testRunId}:${workerId}:`;

// Point app Redis clients at the test service while retaining keyPrefix support. The REDIS_URL
// constructor branch intentionally does not apply keyPrefix, so expand TEST_REDIS_URL into the
// individual test-only settings before config is imported.
if (process.env.TEST_REDIS_URL) {
  const redis = new URL(process.env.TEST_REDIS_URL);
  delete process.env.REDIS_URL;
  process.env.REDIS_HOST = redis.hostname;
  process.env.REDIS_PORT = redis.port || '6379';
  if (redis.password) process.env.REDIS_PASSWORD = redis.password;
  else delete process.env.REDIS_PASSWORD;
  process.env.REDIS_DB = redis.pathname.replace(/^\//, '') || '0';
}

// Integration tests fire many requests per file through the global IP rate
// limiter (default 100/window) — raise it far past any single file so tests
// aren't throttled with spurious 429s. Must be set before config is imported.
process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS ?? '1000000';
