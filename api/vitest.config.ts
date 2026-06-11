import { defineConfig } from 'vitest/config';
import path from 'path';
import dotenv from 'dotenv';

// Load .env.test. Locally we override so a stale parent-shell value can't
// poison the test env. In CI the workflow injects TEST_DATABASE_URL itself
// (pointing at the service container on :5432), so we must NOT override —
// otherwise .env.test's local :5433 value clobbers it and tests can't connect.
dotenv.config({ path: path.resolve(__dirname, '.env.test'), override: !process.env.CI });

// `src/config/environment.ts` calls `dotenv.config({ path: .env })` on
// import, which would otherwise pull the production DATABASE_URL into the
// test process. Pin DATABASE_URL to TEST_DATABASE_URL here so the variable
// is already set before environment.ts runs — dotenv won't overwrite a
// pre-set value.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./src/__tests__/global-setup.ts'],
    setupFiles: ['./src/__tests__/env-setup.ts', './src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Files run in parallel; each worker uses its own database (see setup.ts),
    // so the per-test TRUNCATE stays isolated to that worker.
    fileParallelism: true,
    // Cap worker count. Vitest defaults to ~one fork per core; on a high-core
    // machine that spins up many worker databases at once, whose concurrent
    // startup overwhelms the shared test Postgres (disk/connection contention)
    // and surfaces latent timing races — failures CI never sees on its 2-core
    // runner. 4 keeps local runs as reliable as CI; min(4, cores) makes it a
    // no-op in CI. Paired with the enlarged tmpfs in docker-compose.test.yml.
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/database/migrations/**'],
      thresholds: {
        lines: 20,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@config': path.resolve(__dirname, 'src/config'),
      '@middleware': path.resolve(__dirname, 'src/middleware'),
      '@routes': path.resolve(__dirname, 'src/routes'),
      '@websocket': path.resolve(__dirname, 'src/websocket'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },
});
