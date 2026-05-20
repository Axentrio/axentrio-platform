import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/__tests__/unit/error-handler.test.ts',
      'src/__tests__/unit/middleware-typed-errors.test.ts',
      'src/__tests__/unit/middleware-rate-limit-timeout.test.ts',
      'src/__tests__/integration/error-envelope-wire.test.ts',
      'src/__tests__/integration/middleware-envelope-wire.test.ts',
      'src/__tests__/integration/timeout-wire.test.ts',
      'src/__tests__/integration/zod-validation-wire.test.ts',
      'src/__tests__/integration/rate-limit-wire.test.ts',
      'src/__tests__/integration/route-phase3a-wire.test.ts',
      'src/__tests__/integration/route-phase3b-wire.test.ts',
      'src/__tests__/integration/envelope-gap-coverage.test.ts',
      'src/__tests__/integration/envelope-dev-mode.test.ts',
    ],
    testTimeout: 10000,
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
