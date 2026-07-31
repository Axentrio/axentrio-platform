/**
 * Lead retention sweep.
 *
 * This is the only feature on this branch that DELETES customer data automatically, so
 * the tests are weighted towards what it must refuse to do. The default-keep behaviour
 * and the two carve-outs get more coverage than the deletion itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hooks = vi.hoisted(() => ({ emitted: [] as unknown[], notifications: [] as unknown[] }));
vi.mock('../../webhooks/webhook.emitter', async () => {
  const actual = await vi.importActual<typeof import('../../webhooks/webhook.emitter')>(
    '../../webhooks/webhook.emitter',
  );
  return { ...actual, emitWebhookEvent: (e: unknown) => { hooks.emitted.push(e); } };
});
vi.mock('../../services/notification.service', () => ({
  notificationService: {
    createForTenant: vi.fn(async (n: unknown) => { hooks.notifications.push(n); }),
  },
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { Booking } from '../../database/entities/Booking';
import {
  sweepLeadRetention,
  readRetentionDays,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from '../../leads/lead-retention.service';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const uniq = () => Math.random().toString(36).slice(2, 10);

async function tenantWithRetention(days: number | null) {
  const tenant = await createTestTenant({ tier: 'pro' });
  if (days !== null) {
    await AppDataSource.query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('leadRetentionDays', $2::int) WHERE id = $1`,
      [tenant.id, days],
    );
  }
  return tenant;
}

/** Seed a lead aged `ageDays` in the past. */
async function seedLead(tenantId: string, ageDays: number, over: Partial<Lead> = {}) {
  const repo = AppDataSource.getRepository(Lead);
  const s = uniq();
  const lead = await repo.save(
    repo.create({
      tenantId,
      name: 'Achraf',
      email: `r${s}@example.com`,
      phone: '32475464421',
      dedupeKey: `email:r${s}@example.com`,
      source: 'tool',
      notes: 'Blocked drain',
      ...over,
    }),
  );
  await AppDataSource.query(
    `UPDATE chatbot_leads SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
    [lead.id, String(ageDays)],
  );
  return lead;
}

async function isErased(id: string) {
  const [row] = await AppDataSource.query(
    `SELECT name, status, deleted_at FROM chatbot_leads WHERE id = $1`,
    [id],
  );
  return row.name === null && row.status === 'erased' && row.deleted_at !== null;
}

beforeEach(() => {
  hooks.emitted = [];
  hooks.notifications = [];
});

describe('readRetentionDays — fails towards KEEPING data', () => {
  it('treats an unset value as keep-forever', () => {
    expect(readRetentionDays(null)).toBeNull();
    expect(readRetentionDays({})).toBeNull();
  });

  it('treats a malformed or out-of-range stored value as keep-forever, never as a default', () => {
    // Hand-edited jsonb must not be able to trigger aggressive deletion.
    expect(readRetentionDays({ leadRetentionDays: 'ninety' })).toBeNull();
    expect(readRetentionDays({ leadRetentionDays: 1 })).toBeNull();
    expect(readRetentionDays({ leadRetentionDays: MIN_RETENTION_DAYS - 1 })).toBeNull();
    expect(readRetentionDays({ leadRetentionDays: MAX_RETENTION_DAYS + 1 })).toBeNull();
    expect(readRetentionDays({ leadRetentionDays: Number.NaN })).toBeNull();
  });

  it('accepts a value inside the guard rails', () => {
    expect(readRetentionDays({ leadRetentionDays: 90 })).toBe(90);
  });
});

describe('sweepLeadRetention — does nothing unless a tenant opted in', () => {
  it('leaves an ancient lead alone when no retention is configured', async () => {
    // The most important test here: nothing is deleted on deploy.
    const tenant = await tenantWithRetention(null);
    const lead = await seedLead(tenant.id, 3650);

    await sweepLeadRetention();

    expect(await isErased(lead.id)).toBe(false);
    expect(hooks.notifications).toHaveLength(0);
  });

  it('leaves a lead younger than the configured period alone', async () => {
    const tenant = await tenantWithRetention(90);
    const lead = await seedLead(tenant.id, 30);
    await sweepLeadRetention();
    expect(await isErased(lead.id)).toBe(false);
  });
});

describe('sweepLeadRetention — erases through the erasure path, not a DELETE', () => {
  it('erases a lead past the period and emits lead.deleted', async () => {
    const tenant = await tenantWithRetention(90);
    const lead = await seedLead(tenant.id, 120);

    const res = await sweepLeadRetention();
    expect(res.erased).toBeGreaterThanOrEqual(1);
    expect(await isErased(lead.id)).toBe(true);

    // Going through eraseLead is what makes retention honest downstream: a connected
    // CRM is told to drop its copy too.
    const deleted = hooks.emitted.filter((e) => (e as { type: string }).type === 'lead.deleted');
    expect(deleted.length).toBeGreaterThanOrEqual(1);
  });

  it('notifies the tenant ONCE per run rather than per lead', async () => {
    // Invisible bulk deletion of customer records is how you get a support ticket
    // nobody can answer.
    const tenant = await tenantWithRetention(90);
    for (let i = 0; i < 3; i++) await seedLead(tenant.id, 200);

    await sweepLeadRetention();

    const mine = hooks.notifications.filter(
      (n) => (n as { tenantId: string }).tenantId === tenant.id,
    );
    expect(mine).toHaveLength(1);
    expect((mine[0] as { data: { erased: number } }).data.erased).toBe(3);
  });

  it('is idempotent — a second run does not re-erase or re-notify', async () => {
    const tenant = await tenantWithRetention(90);
    await seedLead(tenant.id, 200);

    await sweepLeadRetention();
    hooks.notifications = [];
    const second = await sweepLeadRetention();

    expect(second.erased).toBe(0);
    expect(hooks.notifications.filter((n) => (n as { tenantId: string }).tenantId === tenant.id)).toHaveLength(0);
  });
});

describe('sweepLeadRetention — carve-outs: age alone is not enough reason', () => {
  it('SKIPS a lead with a live future booking — the business still has to serve it', async () => {
    const tenant = await tenantWithRetention(90);
    const bot = await createTestAnchorBot(tenant as Tenant);
    const lead = await seedLead(tenant.id, 200);

    const bookings = AppDataSource.getRepository(Booking);
    await bookings.save(
      bookings.create({
        tenantId: tenant.id,
        botId: bot.id,
        leadId: lead.id,
        status: 'confirmed',
        startUtc: new Date(Date.now() + 7 * 86_400_000), // future
        endUtc: new Date(Date.now() + 7 * 86_400_000 + 3600_000),
        calendarKey: 'cal',
        icsUid: `ics-${uniq()}`,
      }),
    );

    const res = await sweepLeadRetention();
    expect(res.skippedLiveBooking).toBeGreaterThanOrEqual(1);
    expect(await isErased(lead.id)).toBe(false);
  });

  it('does NOT skip for a cancelled or past booking', async () => {
    const tenant = await tenantWithRetention(90);
    const bot = await createTestAnchorBot(tenant as Tenant);
    const lead = await seedLead(tenant.id, 200);

    const bookings = AppDataSource.getRepository(Booking);
    await bookings.save(
      bookings.create({
        tenantId: tenant.id,
        botId: bot.id,
        leadId: lead.id,
        status: 'cancelled',
        startUtc: new Date(Date.now() + 7 * 86_400_000),
        endUtc: new Date(Date.now() + 7 * 86_400_000 + 3600_000),
        calendarKey: 'cal',
        icsUid: `ics-${uniq()}`,
      }),
    );

    await sweepLeadRetention();
    expect(await isErased(lead.id)).toBe(true);
  });

  it('SKIPS a lead a human manually scored — someone looked at it', async () => {
    const tenant = await tenantWithRetention(90);
    const lead = await seedLead(tenant.id, 200);
    await AppDataSource.query(`UPDATE chatbot_leads SET readiness_override = 80 WHERE id = $1`, [lead.id]);

    const res = await sweepLeadRetention();
    expect(res.skippedManuallyScored).toBeGreaterThanOrEqual(1);
    expect(await isErased(lead.id)).toBe(false);
  });
});

describe('sweepLeadRetention — scoping', () => {
  it('does not touch another tenant, even one with an ancient lead', async () => {
    const configured = await tenantWithRetention(90);
    const untouched = await tenantWithRetention(null);
    await seedLead(configured.id, 200);
    const theirs = await seedLead(untouched.id, 3650);

    await sweepLeadRetention();
    expect(await isErased(theirs.id)).toBe(false);
  });
});
