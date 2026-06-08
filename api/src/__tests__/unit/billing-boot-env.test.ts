/**
 * Boot-time Stripe env-var validation.
 *
 * `src/config/environment.ts` calls `process.exit(1)` ONLY in production when
 * any of the five Stripe vars is empty. In development the check downgrades
 * to a warning so local devs can boot the API before Stripe credentials are
 * provisioned. `NODE_ENV=test` skips the check entirely.
 *
 * `SKIP_BILLING_BOOT_CHECK=true` further downgrades the production check to a
 * warning — last-resort escape hatch for early prod deploys.
 *
 * We invoke the validator logic via a child Node process with env vars
 * adjusted, so each case gets a clean import of environment.ts.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

const REQUIRED = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ESSENTIAL',
  'STRIPE_PRICE_PRO',
  'STRIPE_PRICE_ENTERPRISE',
] as const;

function runBootCheck(envOverrides: Record<string, string | undefined>): {
  status: number | null;
  stderr: string;
} {
  // Minimum env to get past pre-Stripe validation in environment.ts. We
  // load real .env values for everything else and only override the bits
  // under test. NODE_ENV=production is the only mode where missing Stripe
  // vars exit non-zero; dev/test only warn.
  //
  // In production NODE_ENV, environment.ts also requires non-default values
  // for JWT_SECRET (≥32 chars), JWT_REFRESH_SECRET (≥32), ENCRYPTION_KEY
  // (≥32), CLERK_SECRET_KEY (≠ dev default), and WIDGET_API_KEY (≠ dev
  // default). Populate dummies so we exercise the Stripe check, not those.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'a'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(32),
    CLERK_SECRET_KEY: 'sk_test_dummy_clerk_secret_for_boot_test',
    WIDGET_API_KEY: 'widget-prod-dummy',
    // Production also requires an explicit CORS allowlist (no "*") and a 32+ char
    // META_OAUTH_JWT_SECRET — set valid dummies (instead of inheriting the runner's
    // env) so the boot reaches the Stripe check rather than throwing on those first.
    CORS_ORIGIN: 'https://app.example.com',
    META_OAUTH_JWT_SECRET: 'a'.repeat(32),
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
    it(`exits non-zero in production when ${missing} is missing`, () => {
      // Provide placeholder values for the other three, blank out the
      // one under test. (NODE_ENV=production set in runBootCheck.)
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

  it('exits zero in production when all five Stripe vars are present', () => {
    const overrides: Record<string, string> = {};
    for (const k of REQUIRED) overrides[k] = `dummy_${k.toLowerCase()}`;
    const { status } = runBootCheck(overrides);
    expect(status).toBe(0);
  });

  it('exits zero (with warning) when SKIP_BILLING_BOOT_CHECK=true even if vars are missing', () => {
    // Clear all five required vars but flip the escape hatch.
    const overrides: Record<string, string | undefined> = {
      SKIP_BILLING_BOOT_CHECK: 'true',
    };
    for (const k of REQUIRED) overrides[k] = '';
    const { status, stderr } = runBootCheck(overrides);
    expect(status).toBe(0);
    expect(stderr).toMatch(/SKIP_BILLING_BOOT_CHECK=true/);
  });

  it('boots in development (warn-only) even when all five Stripe vars are missing', () => {
    // Local-dev escape: missing Stripe creds should NOT block server startup
    // when NODE_ENV=development. A warning is logged; the boot proceeds.
    const overrides: Record<string, string | undefined> = {
      NODE_ENV: 'development',
    };
    for (const k of REQUIRED) overrides[k] = '';
    const { status, stderr } = runBootCheck(overrides);
    expect(status).toBe(0);
    expect(stderr).toMatch(/\[non-production boot\]/);
  });
});
