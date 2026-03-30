import { defineConfig } from 'vitest/config';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '.env.test') });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./src/__tests__/global-setup.ts'],
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
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
