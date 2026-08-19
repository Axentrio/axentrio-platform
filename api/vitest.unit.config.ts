import { defineConfig } from 'vitest/config';
import path from 'path';
import dotenv from 'dotenv';

// Unit files do not clone Postgres. Load the test env for JWT / Stripe dummies
// only. Do not copy TEST_DATABASE_URL onto DATABASE_URL. That would invite a
// real connection from a mis-filed test.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
dotenv.config({ path: path.resolve(__dirname, '.env.test'), override: !process.env.CI });
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://unit:unit@127.0.0.1:1/unit_unused';
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/__tests__/unit/**/*.test.ts',
      'src/services/notification-prefs.service.test.ts',
    ],
    setupFiles: ['./src/__tests__/silence-logs.ts'],
    testTimeout: 10000,
    // Isolated module graphs (default) keep vi.mock per file. No shared
    // database, Redis, or process-global provider, so files can run together.
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
