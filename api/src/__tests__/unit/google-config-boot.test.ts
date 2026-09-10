/**
 * Boot-time Google env validation.
 *
 * The contract under test, from `src/config/environment.ts`:
 *
 *   - No Google key is required on its own. A deployment that sells no calendar
 *     sync and no Drive import boots with none of them.
 *   - A feature configured IN PART is refused in production, because the portal
 *     then offers a connect button that fails in front of a customer.
 *
 * Each case boots a child Node process with its own env, so the module-level
 * check in environment.ts runs once per case. Same approach as
 * `billing-boot-env.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

const GOOGLE_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'GOOGLE_STORAGE_CLIENT_ID',
  'GOOGLE_STORAGE_CLIENT_SECRET',
  'GOOGLE_STORAGE_REDIRECT_URI',
  'GOOGLE_PICKER_API_KEY',
  'STORAGE_OAUTH_STATE_SECRET',
  'GOOGLE_MAPS_API_KEY',
] as const;

function runBootCheck(envOverrides: Record<string, string | undefined>): {
  status: number | null;
  stderr: string;
} {
  // Production is the only mode that exits non-zero. Supply valid dummies for
  // every other production guard (JWT/encryption/CORS/Stripe) so the boot
  // reaches the Google check instead of stopping earlier.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'a'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(32),
    CLERK_SECRET_KEY: 'sk_test_dummy_clerk_secret_for_boot_test',
    WIDGET_API_KEY: 'widget-prod-dummy',
    CORS_ORIGIN: 'https://app.example.com',
    META_OAUTH_JWT_SECRET: 'a'.repeat(32),
    STRIPE_SECRET_KEY: 'sk_dummy',
    STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    STRIPE_PRICE_ESSENTIAL: 'price_dummy_essential',
    STRIPE_PRICE_PRO: 'price_dummy_pro',
    STRIPE_PRICE_ENTERPRISE: 'price_dummy_enterprise',
    ...envOverrides,
  };
  // A blank string is not the same as absent for this check's `.trim()` test,
  // but dotenv can refill a deleted key from the developer's own .env file.
  // Blank every Google key first, then apply the case's overrides.
  for (const key of GOOGLE_KEYS) {
    if (!(key in envOverrides)) env[key] = '';
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
  }

  const apiRoot = path.resolve(__dirname, '../../..');
  const result = spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', "require('./src/config/environment');"],
    { cwd: apiRoot, env, encoding: 'utf8', timeout: 30_000 },
  );
  return { status: result.status, stderr: result.stderr ?? '' };
}

describe('Boot-time Google env validation', () => {
  it('refuses a half-configured calendar client and names the missing key', () => {
    const { status, stderr } = runBootCheck({
      GOOGLE_CLIENT_ID: 'dummy-client-id',
      GOOGLE_CLIENT_SECRET: 'dummy-client-secret',
      GOOGLE_REDIRECT_URI: '',
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain('GOOGLE_REDIRECT_URI');
    expect(stderr).toMatch(/Google Calendar sync/);
  });

  it('refuses a Drive import that has OAuth but no Picker key', () => {
    const { status, stderr } = runBootCheck({
      GOOGLE_STORAGE_CLIENT_ID: 'dummy-storage-id',
      GOOGLE_STORAGE_CLIENT_SECRET: 'dummy-storage-secret',
      GOOGLE_STORAGE_REDIRECT_URI: 'https://api.example.com/api/v1/knowledge/storage/google/callback',
      STORAGE_OAUTH_STATE_SECRET: 'dummy-state-secret',
      GOOGLE_PICKER_API_KEY: '',
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain('GOOGLE_PICKER_API_KEY');
    expect(stderr).toMatch(/Google Drive knowledge import/);
  });

  it('boots with NO Google key at all - every Google feature is optional', () => {
    const { status, stderr } = runBootCheck({});
    expect(status).toBe(0);
    expect(stderr).not.toMatch(/Google configuration error/);
  });

  it('boots with a complete calendar client and nothing else', () => {
    const { status } = runBootCheck({
      GOOGLE_CLIENT_ID: 'dummy-client-id',
      GOOGLE_CLIENT_SECRET: 'dummy-client-secret',
      GOOGLE_REDIRECT_URI: 'https://api.example.com/api/v1/integrations/google/callback',
    });
    expect(status).toBe(0);
  });
});
