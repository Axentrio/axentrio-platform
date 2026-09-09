/**
 * Replaying erasures after a restore.
 *
 * Simulating the restore is the point of these cases: a dump is immutable, so the
 * way to test the replay is to put a row back the way the dump would have it and
 * prove the replay erases it again.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../webhooks/webhook.emitter', async () => {
  const actual = await vi.importActual<typeof import('../../webhooks/webhook.emitter')>(
    '../../webhooks/webhook.emitter',
  );
  return { ...actual, emitWebhookEvent: vi.fn() };
});
vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { eraseLead } from '../../leads/lead-erasure.service';
import { replayErasuresSince } from '../../compliance/replay-erasures.service';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';

async function seedLead(tenantId: string) {
  const repo = AppDataSource.getRepository(Lead);
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  return repo.save(
    repo.create({
      tenantId,
      name: 'Achraf Peeters',
      email: `r${stamp}@example.com`,
      phone: '32475464421',
      externalUserId: '32475464421',
      dedupeKey: `email:r${stamp}@example.com`,
      source: 'tool',
    }),
  );
}

/** Put the row back the way the dump would have it. */
async function simulateRestore(lead: Lead) {
  await AppDataSource.query(
    `UPDATE chatbot_leads
        SET name = 'Achraf Peeters', email = $2, phone = '32475464421',
            external_user_id = '32475464421', dedupe_key = $3,
            status = 'new', deleted_at = NULL
      WHERE id = $1`,
    [lead.id, lead.email, lead.dedupeKey],
  );
}

const leadRow = async (id: string) =>
  (
    await AppDataSource.query(`SELECT name, status, deleted_at FROM chatbot_leads WHERE id = $1`, [
      id,
    ])
  )[0];

describe('replayErasuresSince', () => {
  it('re-erases a subject the restore brought back', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const lead = await seedLead(tenant.id);
    await eraseLead(AppDataSource, tenant.id, lead.id);
    await simulateRestore(lead);
    expect((await leadRow(lead.id)).name).toBe('Achraf Peeters'); // the "restore" worked

    const result = await replayErasuresSince(new Date(Date.now() - 60_000));

    expect(result.leadsErased).toBeGreaterThanOrEqual(1);
    const after = await leadRow(lead.id);
    expect(after.name).toBeNull();
    expect(after.status).toBe('erased');
    expect(after.deleted_at).not.toBeNull();
  });

  it('records the replay itself as proof', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const lead = await seedLead(tenant.id);
    await eraseLead(AppDataSource, tenant.id, lead.id);
    await simulateRestore(lead);
    const since = new Date(Date.now() - 60_000);

    await replayErasuresSince(since);

    const events = await AppDataSource.query(
      `SELECT event_type, details FROM compliance_events
        WHERE event_type = 'erasure.replayed' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].details.leadsErased).toBeGreaterThanOrEqual(1);
  });

  it('--dry-run reports the candidates and changes nothing', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const lead = await seedLead(tenant.id);
    await eraseLead(AppDataSource, tenant.id, lead.id);
    await simulateRestore(lead);

    const result = await replayErasuresSince(new Date(Date.now() - 60_000), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.leadsErased).toBe(0);
    expect((await leadRow(lead.id)).name).toBe('Achraf Peeters'); // untouched
  });

  it('ignores events older than the dump timestamp', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const lead = await seedLead(tenant.id);
    await eraseLead(AppDataSource, tenant.id, lead.id);
    await simulateRestore(lead);

    // A dump taken AFTER the erasure already contains the erased state, so there
    // is nothing to replay.
    const result = await replayErasuresSince(new Date(Date.now() + 60_000));

    expect(result.candidates).toBe(0);
    expect((await leadRow(lead.id)).name).toBe('Achraf Peeters');
  });

  it('is idempotent — replaying twice does not fail or double-count', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const lead = await seedLead(tenant.id);
    await eraseLead(AppDataSource, tenant.id, lead.id);
    await simulateRestore(lead);
    const since = new Date(Date.now() - 60_000);

    const first = await replayErasuresSince(since);
    const second = await replayErasuresSince(since);

    expect(first.leadsErased).toBeGreaterThanOrEqual(1);
    // The row is already a husk, so the second pass has nothing to do.
    expect(second.leadsErased).toBe(0);
    expect(second.failures).toEqual([]);
  });
});
