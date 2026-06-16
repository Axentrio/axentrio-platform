import { describe, it, expect } from 'vitest';
import { usesCustomWebhook } from '../../services/turn-coalescer';
import { config } from '../../config/environment';
import { createTestTenant } from '../helpers/factories';

/**
 * issue #37 — custom-webhook tenants must NOT be coalesced (the coalescer's
 * runTurn path is platform-agent only). scheduleTurn routes them to the legacy
 * inline forward when usesCustomWebhook() is true.
 */
describe('coalescer · usesCustomWebhook (issue #37)', () => {
  it('true for a tenant with an explicit custom webhook URL', async () => {
    const t = await createTestTenant({ webhookUrl: 'https://example.com/my-n8n-hook' });
    expect(await usesCustomWebhook(t.id)).toBe(true);
  });

  it('false when no webhook URL is set (platform-agent tenant)', async () => {
    const t = await createTestTenant(); // factory sets no webhookUrl
    expect(await usesCustomWebhook(t.id)).toBe(false);
  });

  it('false for a localhost webhook (dev leftover)', async () => {
    const t = await createTestTenant({ webhookUrl: 'http://localhost:5678/webhook' });
    expect(await usesCustomWebhook(t.id)).toBe(false);
  });

  it('false for the platform default webhook URL (auto-provision artifact)', async () => {
    const def = config.n8n.defaultWebhookUrl;
    if (!def) return; // no default configured in this env → nothing to assert
    const t = await createTestTenant({ webhookUrl: def });
    expect(await usesCustomWebhook(t.id)).toBe(false);
  });
});
