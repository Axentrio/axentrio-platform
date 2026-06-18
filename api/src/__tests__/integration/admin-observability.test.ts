import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { SpamScamLog } from '../../database/entities/SpamScamLog';
import { GuardrailOutputLog } from '../../database/entities/GuardrailOutputLog';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { MessageDelivery } from '../../database/entities/MessageDelivery';
import {
  createTestTenant,
  createTestUser,
  createTestSession,
  createTestParticipant,
  createTestMessage,
  createTestHandoffRequest,
} from '../helpers/factories';

const BASE = '/api/v1/admin/observability/overview';

describe('admin observability (Rollout Health snapshot)', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ name: 'Acme Co', tier: 'pro' });
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  async function seedActivity() {
    const session = await createTestSession(tenantId);
    const participant = await createTestParticipant(session.id, { type: 'user' });
    await createTestMessage(session.id, tenantId, participant.id);
    await createTestHandoffRequest(session.id, tenantId, { status: 'requested' });
    const spam = AppDataSource.getRepository(SpamScamLog);
    await spam.save(
      spam.create({
        tenantId,
        conversationId: crypto.randomUUID(),
        sourceChannel: 'widget',
        detectedCategory: 'phishing',
        reasons: ['fake alert'],
        enforced: false, // shadow
      }),
    );
    const out = AppDataSource.getRepository(GuardrailOutputLog);
    await out.save(
      out.create({
        tenantId,
        conversationId: crypto.randomUUID(),
        sourceChannel: 'widget',
        generationPath: 'coalescer',
        families: ['plan_leakage'],
        reasons: ['plan_leakage'],
        enforced: true, // enforced
      }),
    );
  }

  it('aggregates platform totals + per-tenant rows from seeded activity', async () => {
    await seedActivity();
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.status).toBe(200);
    const { windowDays, totals, byTenant, channelsDown } = res.body.data;

    expect(windowDays).toBe(7);
    expect(totals.sessions).toBe(1);
    expect(totals.messages).toBe(1);
    expect(totals.guardrailInbound).toEqual({ enforced: 0, shadow: 1 });
    expect(totals.guardrailOutput).toEqual({ enforced: 1, shadow: 0 });
    expect(totals.handoffs).toBe(1);
    expect(totals.openHandoffs).toBe(1);
    expect(totals.channelsDown).toBe(0);
    expect(totals.enforceOnTenants).toBe(0);
    expect(channelsDown).toEqual([]);

    // Per-tenant merge (separate aggregates merged in app code → no join multiplication).
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0]).toMatchObject({
      tenantId,
      name: 'Acme Co',
      tier: 'pro',
      sessions: 1,
      messages: 1,
      guardrailBlocks: 2, // inbound shadow + output enforced
      handoffs: 1,
    });
  });

  it('counts channel-error connections + failed deliveries (camelCase tables)', async () => {
    const ch = AppDataSource.getRepository(ChannelConnection);
    await ch.save(ch.create({ tenantId, channel: 'telegram', status: 'error', label: 'Bot A', lastError: 'token expired' }));
    await ch.save(ch.create({ tenantId, channel: 'messenger', status: 'error', label: 'Page B', lastError: '401' }));
    await ch.save(ch.create({ tenantId, channel: 'whatsapp', status: 'active' })); // healthy → not counted
    const md = AppDataSource.getRepository(MessageDelivery);
    await md.save(md.create({ internalMessageId: crypto.randomUUID(), channelConnectionId: crypto.randomUUID(), channel: 'telegram', status: 'failed' }));
    await md.save(md.create({ internalMessageId: crypto.randomUUID(), channelConnectionId: crypto.randomUUID(), channel: 'telegram', status: 'sent' })); // not counted

    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.channelsDown).toBe(2);
    expect(res.body.data.totals.deliveryFailures).toBe(1);
    expect(res.body.data.channelsDown).toHaveLength(2);
    expect(res.body.data.channelsDown.map((c: { channel: string }) => c.channel).sort()).toEqual(['messenger', 'telegram']);
  });

  it('counts a tenant with guardrails.enforce=true in enforceOnTenants', async () => {
    await request(app).put(`/api/v1/admin/tenants/${tenantId}/guardrails`).send({ enforce: true });
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.body.data.totals.enforceOnTenants).toBe(1);
  });

  it('excludes events older than the window', async () => {
    const spam = AppDataSource.getRepository(SpamScamLog);
    await spam.save(
      spam.create({
        tenantId,
        conversationId: crypto.randomUUID(),
        sourceChannel: 'widget',
        detectedCategory: 'spam',
        reasons: ['old'],
        enforced: false,
      }),
    );
    await AppDataSource.query(
      `UPDATE guardrail_spam_logs SET created_at = now() - interval '30 days' WHERE tenant_id = $1`,
      [tenantId],
    );
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.body.data.totals.guardrailInbound.shadow).toBe(0);
  });

  it('clamps days (default 7, max 90, non-numeric → 7)', async () => {
    const big = await request(app).get(`${BASE}?days=999`);
    expect(big.body.data.windowDays).toBe(90);
    const zero = await request(app).get(`${BASE}?days=0`);
    expect(zero.body.data.windowDays).toBe(1);
    const bad = await request(app).get(`${BASE}?days=abc`);
    expect(bad.body.data.windowDays).toBe(7);
  });

  it('rejects non-super-admin', async () => {
    configureMockAuth(auth, { userId: crypto.randomUUID(), tenantId, role: 'admin' });
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.status).toBe(403);
  });
});
