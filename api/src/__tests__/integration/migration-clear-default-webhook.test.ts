/**
 * Executes the ClearAutoProvisionedDefaultWebhook migration's up() against the
 * real test DB (integration tests use the schema directly and never run the
 * migration SQL). Guards that the cleanup nulls ONLY rows equal to the
 * configured default and leaves genuinely custom webhooks intact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { ClearAutoProvisionedDefaultWebhook1784900000000 } from '../../database/migrations/1784900000000-ClearAutoProvisionedDefaultWebhook';
import { createTestTenant } from '../helpers/factories';

const DEFAULT_URL = 'http://n8n.test.internal:5678/webhook/chatbot-platform';

async function runMigration() {
  const migration = new ClearAutoProvisionedDefaultWebhook1784900000000();
  const qr = AppDataSource.createQueryRunner();
  try {
    await qr.connect();
    await migration.up(qr); // must not throw
    await migration.up(qr); // idempotent re-run
  } finally {
    await qr.release();
  }
}

describe('ClearAutoProvisionedDefaultWebhook migration', () => {
  // Snapshot the webhook env vars so mutating them here can't leak into other
  // test files sharing this worker.
  const ENV_KEYS = ['N8N_DEFAULT_WEBHOOK_URL', 'WEBHOOK_URL', 'N8N_WEBHOOK_URL'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('nulls webhook_url equal to the default but leaves custom URLs intact', async () => {
    process.env.N8N_DEFAULT_WEBHOOK_URL = DEFAULT_URL;

    const provisioned = await createTestTenant({ webhookUrl: DEFAULT_URL });
    const custom = await createTestTenant({ webhookUrl: 'https://acme.example.com/n8n/hook' });
    const none = await createTestTenant({ webhookUrl: undefined });

    await runMigration();

    const repo = AppDataSource.getRepository(Tenant);
    const reloadedProvisioned = await repo.findOneByOrFail({ id: provisioned.id });
    const reloadedCustom = await repo.findOneByOrFail({ id: custom.id });
    const reloadedNone = await repo.findOneByOrFail({ id: none.id });

    expect(reloadedProvisioned.webhookUrl ?? null).toBeNull();
    expect(reloadedCustom.webhookUrl).toBe('https://acme.example.com/n8n/hook');
    expect(reloadedNone.webhookUrl ?? null).toBeNull();
  });

  it('is a no-op when no default is configured', async () => {
    // No N8N_DEFAULT_WEBHOOK_URL / WEBHOOK_URL / N8N_WEBHOOK_URL set here.
    delete process.env.N8N_DEFAULT_WEBHOOK_URL;
    delete process.env.WEBHOOK_URL;
    delete process.env.N8N_WEBHOOK_URL;

    const tenant = await createTestTenant({ webhookUrl: DEFAULT_URL });

    await runMigration();

    const reloaded = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: tenant.id });
    expect(reloaded.webhookUrl).toBe(DEFAULT_URL);
  });
});
