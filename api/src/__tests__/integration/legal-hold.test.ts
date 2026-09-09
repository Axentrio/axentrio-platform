/**
 * Legal holds: the exception that has to work, because the sweeps are otherwise
 * deaf to everything but age.
 *
 * The cases are weighted towards the boundary: a hold protects what it NAMES and
 * nothing else, and releasing it hands the rows back to the sweeps.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { AppDataSource } from '../../database/data-source';
import {
  holdPredicate,
  listLegalHolds,
  openLegalHold,
  releaseLegalHold,
} from '../../compliance/legal-hold.service';
import { sweepConversationRetention } from '../../conversations/conversation-retention.service';
import { sweepLeadRetention } from '../../leads/lead-retention.service';
import { createTestSession, createTestTenant } from '../helpers/factories';
import { Lead } from '../../database/entities/Lead';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

async function tenantWithRetention(days = 365) {
  const tenant = await createTestTenant({ tier: 'pro' });
  await AppDataSource.query(
    `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb)
        || jsonb_build_object('conversationRetentionDays', $2::int, 'leadRetentionDays', $2::int)
      WHERE id = $1`,
    [tenant.id, days],
  );
  return tenant;
}

async function oldSession(tenantId: string, ageDays = 400) {
  const session = await createTestSession(tenantId);
  await AppDataSource.query(
    `UPDATE chat_sessions SET last_activity_at = now() - ($2 || ' days')::interval WHERE id = $1`,
    [session.id, String(ageDays)],
  );
  return session;
}

async function oldLead(tenantId: string, ageDays = 400) {
  const repo = AppDataSource.getRepository(Lead);
  const lead = await repo.save(
    repo.create({
      tenantId,
      name: 'Achraf',
      email: `h${Date.now()}@example.com`,
      dedupeKey: `email:h${Date.now()}@example.com`,
      source: 'tool',
    }),
  );
  await AppDataSource.query(
    `UPDATE chatbot_leads SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
    [lead.id, String(ageDays)],
  );
  return lead;
}

const sessionExists = async (id: string) =>
  (await AppDataSource.query(`SELECT 1 FROM chat_sessions WHERE id = $1`, [id])).length > 0;

describe('openLegalHold', () => {
  it('refuses a hold with no reason, no scope, or a past review date', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const base = { tenantId: tenant.id, openedBy: tenant.id, reviewDueAt: inDays(30) };

    await expect(openLegalHold({ ...base, reason: 'dispute', scope: { all: true } })).rejects.toThrow(
      /reason/i,
    );
    await expect(
      openLegalHold({ ...base, reason: 'a real dispute about invoice 12', scope: {} }),
    ).rejects.toThrow(/name what it protects/i);
    await expect(
      openLegalHold({
        ...base,
        reason: 'a real dispute about invoice 12',
        scope: { all: true },
        reviewDueAt: inDays(-1),
      }),
    ).rejects.toThrow(/review/i);
  });

  it('records the hold in compliance_events', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const hold = await openLegalHold({
      tenantId: tenant.id,
      reason: 'county court claim 1234',
      scope: { all: true },
      openedBy: tenant.id,
      reviewDueAt: inDays(90),
    });

    const events = await AppDataSource.query(
      `SELECT event_type FROM compliance_events WHERE subject_id = $1`,
      [hold.id],
    );
    expect(events.map((e: { event_type: string }) => e.event_type)).toContain('legal_hold.opened');
  });
});

describe('the sweeps honour an open hold', () => {
  it('protects a named session, and only that one', async () => {
    const tenant = await tenantWithRetention();
    const held = await oldSession(tenant.id);
    const free = await oldSession(tenant.id);
    await openLegalHold({
      tenantId: tenant.id,
      reason: 'claim 1234 needs this conversation',
      scope: { sessionIds: [held.id] },
      openedBy: tenant.id,
      reviewDueAt: inDays(90),
    });

    await sweepConversationRetention();

    expect(await sessionExists(held.id)).toBe(true);
    expect(await sessionExists(free.id)).toBe(false);
  });

  it('{ all: true } freezes the whole workspace', async () => {
    const tenant = await tenantWithRetention();
    const one = await oldSession(tenant.id);
    const two = await oldSession(tenant.id);
    await openLegalHold({
      tenantId: tenant.id,
      reason: 'regulator has asked for everything',
      scope: { all: true },
      openedBy: tenant.id,
      reviewDueAt: inDays(90),
    });

    await sweepConversationRetention();

    expect(await sessionExists(one.id)).toBe(true);
    expect(await sessionExists(two.id)).toBe(true);
  });

  it('releasing the hold hands the rows back to the sweep', async () => {
    const tenant = await tenantWithRetention();
    const session = await oldSession(tenant.id);
    const hold = await openLegalHold({
      tenantId: tenant.id,
      reason: 'claim 1234 needs this conversation',
      scope: { sessionIds: [session.id] },
      openedBy: tenant.id,
      reviewDueAt: inDays(90),
    });

    await sweepConversationRetention();
    expect(await sessionExists(session.id)).toBe(true);

    await releaseLegalHold({
      tenantId: tenant.id,
      holdId: hold.id,
      releasedBy: tenant.id,
      releaseReason: 'claim settled',
    });
    await sweepConversationRetention();

    expect(await sessionExists(session.id)).toBe(false);
  });

  it('protects a held lead from lead retention', async () => {
    const tenant = await tenantWithRetention();
    const held = await oldLead(tenant.id);
    const free = await oldLead(tenant.id);
    await openLegalHold({
      tenantId: tenant.id,
      reason: 'claim 1234 needs this lead',
      scope: { leadIds: [held.id] },
      openedBy: tenant.id,
      reviewDueAt: inDays(90),
    });

    await sweepLeadRetention();

    const rows = await AppDataSource.query(
      `SELECT id, status FROM chatbot_leads WHERE id = ANY($1::uuid[])`,
      [[held.id, free.id]],
    );
    const byId = new Map(rows.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(byId.get(held.id)).not.toBe('erased');
    expect(byId.get(free.id)).toBe('erased');
  });

  it('lists only the active holds when asked', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const keep = await openLegalHold({
      tenantId: tenant.id,
      reason: 'claim 1 is live',
      scope: { all: true },
      openedBy: tenant.id,
      reviewDueAt: inDays(90),
    });
    const gone = await openLegalHold({
      tenantId: tenant.id,
      reason: 'claim 2 is live',
      scope: { all: true },
      openedBy: tenant.id,
      reviewDueAt: inDays(90),
    });
    await releaseLegalHold({
      tenantId: tenant.id,
      holdId: gone.id,
      releasedBy: tenant.id,
      releaseReason: 'settled',
    });

    const active = await listLegalHolds(tenant.id, { activeOnly: true });
    expect(active.map((h) => h.id)).toEqual([keep.id]);
  });
});

describe('holdPredicate', () => {
  it('is one definition of "protected" for every sweep', () => {
    const sql = holdPredicate('l', 'id', 'leadIds');
    expect(sql).toContain('legal_holds');
    expect(sql).toContain('h.released_at IS NULL');
    expect(sql).toContain("h.scope->'leadIds' ? l.id::text");
  });
});
