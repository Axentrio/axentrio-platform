/**
 * POST /bots/pause-all — bulk-write `settings.ai.enabled = false` on every
 * live bot of the caller's tenant. Per-bot flag only; no tenant-wide toggle.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { app } from '../../server';
import { createTestTenant, createTestAnchorBot, createTestUser } from '../helpers/factories';

function aiOn(name: string): Bot['settings'] {
  return {
    ai: {
      enabled: true,
      brandVoice: { name, tone: 'friendly' },
      guardrails: {
        topicsToAvoid: [],
        escalationKeywords: [],
        confidenceThreshold: 0.7,
        maxResponseLength: 500,
        greetingMessage: 'hi',
        fallbackMessage: 'bye',
        offHoursMessage: 'off',
      },
    },
  } as Bot['settings'];
}

async function createExtraBot(tenantId: string, name: string, settings: Bot['settings']): Promise<Bot> {
  const repo = AppDataSource.getRepository(Bot);
  return repo.save(
    repo.create({
      tenantId,
      name,
      publicKey: `bk_${crypto.randomBytes(24).toString('hex')}`,
      status: 'active',
      isDefault: false,
      settings,
    }),
  );
}

describe('POST /bots/pause-all', () => {
  let tenantId: string;
  let anchorId: string;
  let extraId: string;
  let otherBotId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'enterprise' });
    tenantId = tenant.id;
    const anchor = await createTestAnchorBot(tenant, { settings: aiOn('Anchor') });
    const extra = await createExtraBot(tenantId, 'Second', aiOn('Second'));
    anchorId = anchor.id;
    extraId = extra.id;

    const other = await createTestTenant();
    const otherBot = await createTestAnchorBot(other, { settings: aiOn('Other') });
    otherBotId = otherBot.id;

    const admin = await createTestUser(tenantId, { role: 'admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'admin' });
  });

  it('sets ai.enabled=false on every live bot of the tenant and returns their ids', async () => {
    const res = await request(app).post('/api/v1/bots/pause-all').send();
    expect(res.status).toBe(200);
    expect(res.body.data.pausedCount).toBe(2);
    expect(res.body.data.pausedBotIds.sort()).toEqual([anchorId, extraId].sort());

    const repo = AppDataSource.getRepository(Bot);
    const [anchor, extra] = await Promise.all([
      repo.findOneOrFail({ where: { id: anchorId } }),
      repo.findOneOrFail({ where: { id: extraId } }),
    ]);
    expect(anchor.settings.ai?.enabled).toBe(false);
    expect(extra.settings.ai?.enabled).toBe(false);
    // Sibling settings survive the bulk write.
    expect(anchor.settings.ai?.brandVoice.name).toBe('Anchor');
    expect(extra.settings.ai?.brandVoice.name).toBe('Second');
  });

  it("does not touch another tenant's bots", async () => {
    const res = await request(app).post('/api/v1/bots/pause-all').send();
    expect(res.status).toBe(200);

    const other = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: otherBotId } });
    expect(other.settings.ai?.enabled).toBe(true);
  });

  it('rejects a non-admin', async () => {
    const supervisor = await createTestUser(tenantId, { role: 'supervisor' });
    configureMockAuth(auth, { userId: supervisor.id, tenantId, role: 'supervisor' });

    const res = await request(app).post('/api/v1/bots/pause-all').send();
    expect(res.status).toBe(403);

    const anchor = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: anchorId } });
    expect(anchor.settings.ai?.enabled).toBe(true);
  });
});
