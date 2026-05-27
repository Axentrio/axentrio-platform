import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/unit/**/*.test.ts'],
    testTimeout: 10000,
    fileParallelism: false,
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
