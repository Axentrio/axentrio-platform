/**
 * Boot-time Stripe env-var validation.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Unit:
 *   "boot-time env-var validation fails non-zero when any required Stripe
 *    var is missing."
 *
 * src/config/environment.ts calls `process.exit(1)` on first import when
 * any of the four Stripe vars is empty (outside NODE_ENV=test). We can't
 * test that directly because Vitest itself runs with NODE_ENV=test which
 * intentionally bypasses the check.
 *
 * Instead, we invoke the validator logic via a child Node process with
 * env vars adjusted, so each case gets a clean import of environment.ts.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

const REQUIRED = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_PRO_USD_MONTHLY',
  'STRIPE_PRICE_PREMIUM_USD_MONTHLY',
] as const;

function runBootCheck(envOverrides: Record<string, string | undefined>): {
  status: number | null;
  stderr: string;
} {
  // Minimum env to get past pre-Stripe validation in environment.ts. We
  // load real .env values for everything else and only override the bits
  // under test, so the test stays focused on the Stripe fail-fast logic.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Force production-like check (test mode bypasses Stripe validation).
    NODE_ENV: 'development',
    ...envOverrides,
  };
  // Remove keys explicitly set to undefined so dotenv defaults don't refill.
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
  }

  // ts-node's CommonJS register hook honors implicit .ts resolution via
  // require(), unlike the ESM dynamic-import path which is strict about
  // explicit extensions. Use require here so the test runs without tsx.
  const apiRoot = path.resolve(__dirname, '../../..');
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      "require('./src/config/environment');",
    ],
    {
      cwd: apiRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  return { status: result.status, stderr: result.stderr ?? '' };
}

describe('Boot-time Stripe env validation', () => {
  for (const missing of REQUIRED) {
    it(`exits non-zero when ${missing} is missing`, () => {
      // Provide placeholder values for the other three, blank out the
      // one under test.
      const overrides: Record<string, string | undefined> = {};
      for (const k of REQUIRED) {
        overrides[k] = k === missing ? '' : `dummy_${k.toLowerCase()}`;
      }
      const { status, stderr } = runBootCheck(overrides);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/Billing configuration error/);
      expect(stderr).toContain(missing);
    });
  }

  it('exits zero when all four Stripe vars are present', () => {
    const overrides: Record<string, string> = {};
    for (const k of REQUIRED) overrides[k] = `dummy_${k.toLowerCase()}`;
    const { status } = runBootCheck(overrides);
    expect(status).toBe(0);
  });

  it('exits zero (with warning) when SKIP_BILLING_BOOT_CHECK=true even if vars are missing', () => {
    // Clear all four required vars but flip the escape hatch.
    const overrides: Record<string, string | undefined> = {
      SKIP_BILLING_BOOT_CHECK: 'true',
    };
    for (const k of REQUIRED) overrides[k] = '';
    const { status, stderr } = runBootCheck(overrides);
    expect(status).toBe(0);
    expect(stderr).toMatch(/SKIP_BILLING_BOOT_CHECK=true/);
  });
});
