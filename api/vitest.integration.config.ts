import base from './vitest.config';

/**
 * CI integration job. Same serial + per-file database model as the full suite.
 * Replaces `include` (do not mergeConfig — Vite concatenates arrays).
 */
export default {
  ...base,
  test: {
    ...base.test,
    include: ['src/__tests__/integration/**/*.test.ts'],
  },
};
