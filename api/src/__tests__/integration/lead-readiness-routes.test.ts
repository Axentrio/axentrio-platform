/**
 * Readiness override (PATCH /leads/:id) + the readiness projection, and boot-safety for
 * the migration that adds the override column.
 */
import { describe, it, expect, vi } from 'vitest';
import { configureMockAuth, createAuthMocks } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({ clerkMiddleware: () => (_r: any, _s: any, n: any) => n() }));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { AddLeadReadinessOverride1787700000000 } from '../../database/migrations/1787700000000-AddLeadReadinessOverride';
import { createTestTenant, createTestUser } from '../helpers/factories';

async function seed(tier: 'pro' | 'enterprise' = 'enterprise') {
  const tenant = await createTestTenant({ tier });
  const user = await createTestUser(tenant.id, { role: 'admin' });
  configureMockAuth(auth, {
    tenantId: tenant.id,
    userId: user.id,
    agentId: user.id,
    role: 'admin',
  });
  const repo = AppDataSource.getRepository(Lead);
  const s = Math.random().toString(36).slice(2, 8);
  const lead = await repo.save(
    repo.create({
      tenantId: tenant.id,
      name: 'Achraf',
      phone: '32475464421',
      email: `r${s}@example.com`,
      dedupeKey: `email:r${s}@example.com`,
      notes: 'Blocked drain',
      source: 'tool',
    }),
  );
  return { tenant, lead };
}

describe('AddLeadReadinessOverride migration', () => {
  it('up() runs cleanly and is idempotent', async () => {
    const m = new AddLeadReadinessOverride1787700000000();
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      await m.up(qr);
      await m.up(qr);
    } finally {
      await qr.release();
    }
    const cols = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chatbot_leads' AND column_name LIKE 'readiness%'`,
    );
    expect(cols.map((c: { column_name: string }) => c.column_name).sort()).toEqual([
      'readiness_override',
      'readiness_override_at',
      'readiness_override_by',
    ]);
  });

  it('rejects an out-of-range override at the DB layer', async () => {
    const { lead } = await seed();
    await expect(
      AppDataSource.query(`UPDATE chatbot_leads SET readiness_override = 200 WHERE id = $1`, [lead.id]),
    ).rejects.toThrow();
  });
});

describe('readiness projection', () => {
  it('returns an explainable score with its components', async () => {
    await seed();
    const res = await request(app).get('/api/v1/leads');
    expect(res.status).toBe(200);
    const row = res.body.data.leads[0];
    expect(row.readiness.source).toBe('computed');
    expect(row.readiness.score).toBeGreaterThan(0);
    // Every point must be attributable — an unexplained score about a person is
    // indefensible when the owner disagrees with it.
    const summed = row.readiness.components.reduce((n: number, c: { points: number }) => n + c.points, 0);
    expect(summed).toBeGreaterThanOrEqual(row.readiness.score);
    expect(row.readiness.components.map((c: { key: string }) => c.key)).toContain('reachable');
  });

  it('is withheld from a tenant without leadEnrichment (it rides the Pro field set)', async () => {
    await seed('pro');
    await AppDataSource.query(
      `UPDATE tenants SET feature_toggles = '{"leadCapture":true}'::jsonb, tier = 'essential' WHERE id = $1`,
      [auth.tenantId],
    );
    const res = await request(app).get('/api/v1/leads');
    expect(res.status).toBe(200);
    expect(res.body.data.leads[0]).not.toHaveProperty('readiness');
  });
});

describe('PATCH /leads/:id — readiness override', () => {
  it('accepts an override and records who set it', async () => {
    const { lead } = await seed();
    const res = await request(app).patch(`/api/v1/leads/${lead.id}`).send({ readinessOverride: 15 });
    expect(res.status).toBe(200);
    expect(res.body.data.readinessOverride).toBe(15);

    const [row] = await AppDataSource.query(
      `SELECT readiness_override, readiness_override_by, readiness_override_at FROM chatbot_leads WHERE id = $1`,
      [lead.id],
    );
    expect(row.readiness_override).toBe(15);
    expect(row.readiness_override_by).toBe(auth.userId);
    expect(row.readiness_override_at).not.toBeNull();
  });

  it('a human override WINS over the computed score', async () => {
    const { lead } = await seed();
    await request(app).patch(`/api/v1/leads/${lead.id}`).send({ readinessOverride: 5 });

    const res = await request(app).get('/api/v1/leads');
    const row = res.body.data.leads.find((l: { id: string }) => l.id === lead.id);
    expect(row.readiness.score).toBe(5);
    expect(row.readiness.source).toBe('human');
  });

  it('null clears the override and returns to the computed score', async () => {
    // Without a way back, a mistaken override would be permanent.
    const { lead } = await seed();
    await request(app).patch(`/api/v1/leads/${lead.id}`).send({ readinessOverride: 5 });
    await request(app).patch(`/api/v1/leads/${lead.id}`).send({ readinessOverride: null });

    const res = await request(app).get('/api/v1/leads');
    const row = res.body.data.leads.find((l: { id: string }) => l.id === lead.id);
    expect(row.readiness.source).toBe('computed');
    expect(row.readiness.score).toBeGreaterThan(5);
  });

  it('rejects a non-integer or out-of-range override', async () => {
    const { lead } = await seed();
    for (const bad of [101, -1, 'high', 12.5]) {
      const res = await request(app).patch(`/api/v1/leads/${lead.id}`).send({ readinessOverride: bad });
      expect(res.status, `expected 400 for ${String(bad)}`).toBe(400);
    }
  });

  it('still accepts a plain status change (backwards compatible)', async () => {
    const { lead } = await seed();
    const res = await request(app).patch(`/api/v1/leads/${lead.id}`).send({ status: 'archived' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('archived');
  });

  it('rejects an empty body rather than silently no-opping', async () => {
    const { lead } = await seed();
    expect((await request(app).patch(`/api/v1/leads/${lead.id}`).send({})).status).toBe(400);
  });
});
