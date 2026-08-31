import { spawnSync } from 'child_process';
import path from 'path';
import { parse as parsePgConnectionString } from 'pg-connection-string';
import { describe, expect, it } from 'vitest';
import { resolveDatabaseSsl } from '../../config/environment';

const remoteUrl = 'postgresql://axentrio:secret@p.crunchybridge.com:5432/axentrio';
const composeUrl = 'postgresql://postgres:secret@postgres:5432/axentrio_staging';
const disabledUrl = `${remoteUrl}?sslmode=disable`;

describe('resolveDatabaseSsl', () => {
  it('turns TLS off when sslmode=disable, even on a remote host', () => {
    const parsed = parsePgConnectionString(disabledUrl);
    expect(resolveDatabaseSsl({
      nodeEnv: 'staging',
      host: parsed.host,
      databaseUrl: disabledUrl,
      dbSsl: true,
    })).toBe(false);
  });

  it('turns TLS off for the Docker compose host postgres', () => {
    const parsed = parsePgConnectionString(composeUrl);
    expect(parsed.host).toBe('postgres');
    expect(resolveDatabaseSsl({
      nodeEnv: 'staging',
      host: parsed.host,
      databaseUrl: composeUrl,
      dbSsl: true,
    })).toBe(false);
  });

  it('turns TLS on for a normal remote DATABASE_URL', () => {
    const parsed = parsePgConnectionString(remoteUrl);
    expect(parsed.host).toBe('p.crunchybridge.com');
    expect(resolveDatabaseSsl({
      nodeEnv: 'production',
      host: parsed.host,
      databaseUrl: remoteUrl,
      dbSsl: false,
    })).toBe(true);
  });

  it('honours DB_SSL when there is no DATABASE_URL', () => {
    expect(resolveDatabaseSsl({
      nodeEnv: 'staging',
      host: 'db.internal',
      dbSsl: true,
    })).toBe(true);
    expect(resolveDatabaseSsl({
      nodeEnv: 'staging',
      host: 'db.internal',
      dbSsl: false,
    })).toBe(false);
  });

  it('does not let DB_SSL turn off TLS on a remote DATABASE_URL', () => {
    const parsed = parsePgConnectionString(remoteUrl);
    expect(resolveDatabaseSsl({
      nodeEnv: 'production',
      host: parsed.host,
      databaseUrl: remoteUrl,
      dbSsl: false,
    })).toBe(true);
  });

  it('keeps TLS off on loopback hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      expect(resolveDatabaseSsl({
        nodeEnv: 'production',
        host,
        databaseUrl: `postgresql://postgres:secret@${host}:5432/axentrio`,
        dbSsl: true,
      })).toBe(false);
    }
  });

  it('keeps TLS off in NODE_ENV=test even for a remote URL', () => {
    const parsed = parsePgConnectionString(remoteUrl);
    expect(resolveDatabaseSsl({
      nodeEnv: 'test',
      host: parsed.host,
      databaseUrl: remoteUrl,
      dbSsl: true,
    })).toBe(false);
  });
});

const apiRoot = path.resolve(__dirname, '../../..');

function readConfigSsl(envOverrides: Record<string, string>): boolean {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'staging',
    JWT_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'a'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(32),
    CLERK_SECRET_KEY: 'sk_test_dummy_clerk_secret_for_boot_test',
    WIDGET_API_KEY: 'widget-prod-dummy',
    CORS_ORIGIN: 'https://app.example.com',
    META_OAUTH_JWT_SECRET: 'a'.repeat(32),
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    STRIPE_PRICE_ESSENTIAL: 'price_essential',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_PRICE_ENTERPRISE: 'price_enterprise',
    ...envOverrides,
  };

  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      "console.log(JSON.stringify(require('./src/config/environment').config.database.ssl));",
    ],
    { cwd: apiRoot, env, encoding: 'utf8', timeout: 30_000 },
  );

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as boolean;
}

describe('config.database.ssl', () => {
  it('is false for sslmode=disable on a remote URL', () => {
    expect(readConfigSsl({ DATABASE_URL: disabledUrl })).toBe(false);
  });

  it('is false for the compose host postgres', () => {
    expect(readConfigSsl({ DATABASE_URL: composeUrl })).toBe(false);
  });

  it('is true for a normal remote DATABASE_URL', () => {
    expect(readConfigSsl({ NODE_ENV: 'production', DATABASE_URL: remoteUrl })).toBe(true);
  });

  it('follows DB_SSL when DATABASE_URL is empty', () => {
    expect(readConfigSsl({
      DATABASE_URL: '',
      DB_HOST: 'db.internal',
      DB_SSL: 'true',
    })).toBe(true);
    expect(readConfigSsl({
      DATABASE_URL: '',
      DB_HOST: 'db.internal',
      DB_SSL: 'false',
    })).toBe(false);
  });
});
