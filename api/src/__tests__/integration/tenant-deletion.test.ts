/**
 * Self-service account deletion, against a real DB.
 *
 * Weighted towards what must SURVIVE and what must NOT be processed during
 * dormancy: the deletion itself is a list of statements, but the promise is that
 * the workspace stops answering immediately, that cancelling is exact, and that
 * the accounting records outlive the erasure.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import {
  DELETION_DORMANCY_DAYS,
  cancelTenantDeletion,
  executeTenantDeletion,
  getDeletionRequest,
  requestTenantDeletion,
  sweepDueTenantDeletions,
} from '../../tenants/tenant-deletion.service';
import { openLegalHold, releaseLegalHold } from '../../compliance/legal-hold.service';
import {
  createTestAnchorBot,
  createTestMessage,
  createTestParticipant,
  createTestSession,
  createTestTenant,
  createTestUser,
} from '../helpers/factories';

const botStatus = async (botId: string) => {
  const [row] = await AppDataSource.query(`SELECT status FROM chatbot_bots WHERE id = $1`, [botId]);
  return row?.status;
};

const exists = async (table: string, id: string) =>
  (await AppDataSource.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).length > 0;

describe('requestTenantDeletion', () => {
  it('pauses the tenant\'s active bots and schedules the window from the REQUEST', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant);
    const admin = await createTestUser(tenant.id, { role: 'admin' });

    const state = await requestTenantDeletion(tenant.id, admin.id);

    expect(await botStatus(bot.id)).toBe('paused');
    const days = (new Date(state.scheduledFor!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(DELETION_DORMANCY_DAYS - 0.1);
    expect(days).toBeLessThanOrEqual(DELETION_DORMANCY_DAYS + 0.1);
    expect(state.daysRemaining).toBe(DELETION_DORMANCY_DAYS);
  });

  it('does not extend the window on a second request', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant);
    const admin = await createTestUser(tenant.id, { role: 'admin' });

    const first = await requestTenantDeletion(tenant.id, admin.id);
    // Push the schedule back to prove the second call leaves it alone.
    await AppDataSource.query(
      `UPDATE tenants SET deletion_scheduled_for = now() + interval '1 day' WHERE id = $1`,
      [tenant.id],
    );
    const second = await requestTenantDeletion(tenant.id, admin.id);

    expect(second.scheduledFor).not.toBe(first.scheduledFor);
    expect(second.daysRemaining).toBe(1);
    expect(await botStatus(bot.id)).toBe('paused');
  });
});

describe('cancelTenantDeletion', () => {
  it('resumes exactly the bots the request paused, and leaves a deliberate pause alone', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const anchor = await createTestAnchorBot(tenant);
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    // A bot the owner had already paused BEFORE asking to delete.
    const repo = AppDataSource.getRepository(Bot);
    const parked = await repo.save(
      repo.create({
        tenantId: tenant.id,
        name: 'Parked',
        publicKey: `pk-${Date.now()}`,
        status: 'paused',
        isDefault: false,
        settings: {},
      }),
    );

    await requestTenantDeletion(tenant.id, admin.id);
    const state = await cancelTenantDeletion(tenant.id, admin.id);

    expect(state.requestedAt).toBeNull();
    expect(state.scheduledFor).toBeNull();
    expect(await botStatus(anchor.id)).toBe('active');
    expect(await botStatus(parked.id)).toBe('paused');
  });
});

describe('executeTenantDeletion', () => {
  it('purges the content, anonymises the row, and keeps the proof', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    const session = await createTestSession(tenant.id);
    const participant = await createTestParticipant(session.id, { type: 'user' });
    const message = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'My name is Achraf',
    });

    await requestTenantDeletion(tenant.id, admin.id);
    const counts = await executeTenantDeletion(tenant.id);

    // Content gone.
    expect(await exists('chat_sessions', session.id)).toBe(false);
    expect(await exists('messages', message.id)).toBe(false);
    expect(await exists('participants', participant.id)).toBe(false);
    expect(counts.chat_sessions).toBe(1);
    expect(counts.messages).toBe(1);

    // The row survives, with nothing identifying left on it.
    const [row] = await AppDataSource.query(
      `SELECT name, slug, settings, deleted_at, deletion_scheduled_for FROM tenants WHERE id = $1`,
      [tenant.id],
    );
    expect(row).toBeTruthy();
    expect(row.name).toBe('Deleted workspace');
    expect(row.settings).toEqual({});
    expect(row.deleted_at).not.toBeNull();
    expect(row.deletion_scheduled_for).toBeNull();

    // The proof of the deletion outlives it.
    const events = await AppDataSource.query(
      `SELECT event_type FROM compliance_events WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant.id],
    );
    expect(events.map((e: { event_type: string }) => e.event_type)).toContain('tenant.deleted');
  });
});

describe('sweepDueTenantDeletions', () => {
  it('executes only the tenants whose window has closed', async () => {
    const due = await createTestTenant({ tier: 'pro' });
    const notYet = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(due);
    await createTestAnchorBot(notYet);
    const dueAdmin = await createTestUser(due.id, { role: 'admin' });
    const notYetAdmin = await createTestUser(notYet.id, { role: 'admin' });
    await requestTenantDeletion(due.id, dueAdmin.id);
    await requestTenantDeletion(notYet.id, notYetAdmin.id);
    // Only the first window is in the past.
    await AppDataSource.query(
      `UPDATE tenants SET deletion_scheduled_for = now() - interval '1 minute' WHERE id = $1`,
      [due.id],
    );

    const result = await sweepDueTenantDeletions();

    expect(result.tenants).toBeGreaterThanOrEqual(1);
    const [gone] = await AppDataSource.query(`SELECT name FROM tenants WHERE id = $1`, [due.id]);
    const [kept] = await AppDataSource.query(`SELECT name FROM tenants WHERE id = $1`, [notYet.id]);
    expect(gone.name).toBe('Deleted workspace');
    expect(kept.name).not.toBe('Deleted workspace');
    expect((await getDeletionRequest(notYet.id)).scheduledFor).not.toBeNull();
  });
});

describe('sweepDueTenantDeletions — a live dispute wins', () => {
  it('skips a workspace whose window has closed while a legal hold is open', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    await requestTenantDeletion(tenant.id, admin.id);
    await AppDataSource.query(
      `UPDATE tenants SET deletion_scheduled_for = now() - interval '1 minute' WHERE id = $1`,
      [tenant.id],
    );
    const hold = await openLegalHold({
      tenantId: tenant.id,
      reason: 'claim 1234 is live and needs this workspace',
      scope: { all: true },
      openedBy: admin.id,
      reviewDueAt: new Date(Date.now() + 90 * 86_400_000),
    });

    await sweepDueTenantDeletions();

    // The rows are evidence; deleting them would destroy what the hold preserves.
    const [row] = await AppDataSource.query(`SELECT name FROM tenants WHERE id = $1`, [tenant.id]);
    expect(row.name).not.toBe('Deleted workspace');

    // Releasing the hold lets the next run proceed — nothing is lost by waiting.
    await releaseLegalHold({
      tenantId: tenant.id,
      holdId: hold.id,
      releasedBy: admin.id,
      releaseReason: 'settled',
    });
    await sweepDueTenantDeletions();
    const [after] = await AppDataSource.query(`SELECT name FROM tenants WHERE id = $1`, [tenant.id]);
    expect(after.name).toBe('Deleted workspace');
  });
});
