import { defineConfig } from 'vitest/config';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'node:crypto';

const isNotificationPrefsUnitRun = process.argv.some((arg) =>
  arg.endsWith('src/services/notification-prefs.service.test.ts'),
);

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
  process.env.TEST_DATABASE_BASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
process.env.TEST_RUN_ID = crypto.randomBytes(8).toString('hex');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: isNotificationPrefsUnitRun ? undefined : ['./src/__tests__/global-setup.ts'],
    setupFiles: isNotificationPrefsUnitRun
      ? []
      : ['./src/__tests__/env-setup.ts', './src/__tests__/silence-logs.ts', './src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.ts', 'src/services/notification-prefs.service.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Integration files exercise process-global seams (module mocks, provider
    // singletons, queues and Redis). Parallel file processes produced moving,
    // order-dependent failures even after each file received its own database.
    // A focused file and the whole suite must therefore use the same execution
    // model: one file at a time, each with a fresh database cloned in setup.ts.
    fileParallelism: false,
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
