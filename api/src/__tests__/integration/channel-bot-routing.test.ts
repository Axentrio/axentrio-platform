/**
 * Integration tests for per-channel bot routing — PATCH /channels/:id/bot.
 * Assign/clear the bot a channel connection routes inbound messages to.
 *
 * The `/channels` routes are only mounted inside startServer() (skipped under
 * NODE_ENV=test), so we mount the router on a minimal app here — the same
 * pattern as phase6-channels-n8n-wire.test.ts. Auth middleware is mocked via
 * the shared auth helper.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';
import { errorHandler } from '../../middleware/error-handler';
import channelManagementRoutes from '../../channels/channel-management.routes';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { Bot } from '../../database/entities/Bot';
import { createTestTenant, createTestAnchorBot, createTestUser } from '../helpers/factories';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/channels', channelManagementRoutes);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

async function createConnection(tenantId: string): Promise<ChannelConnection> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  return repo.save(
    repo.create({ tenantId, channel: 'telegram', status: 'active', platformAccountId: `acct_${Date.now()}` }),
  );
}

async function createBot(tenantId: string, status: 'active' | 'paused' = 'active'): Promise<Bot> {
  const repo = AppDataSource.getRepository(Bot);
  return repo.save(
    repo.create({
      tenantId,
      name: 'Channel Bot',
      publicKey: `bk_${crypto.randomBytes(12).toString('hex')}`,
      status,
      isDefault: false,
      settings: {} as Bot['settings'],
    }),
  );
}

describe('PATCH /channels/:id/bot — per-channel bot routing', () => {
  let tenantId: string;
  let connectionId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;
    await createTestAnchorBot(tenant);
    connectionId = (await createConnection(tenantId)).id;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'admin' });
  });

  it('assigns an active owned bot to the connection', async () => {
    const bot = await createBot(tenantId, 'active');
    const res = await request(app).patch(`/channels/${connectionId}/bot`).send({ botId: bot.id });
    expect(res.status).toBe(200);
    expect(res.body.data.botId).toBe(bot.id);

    const row = await AppDataSource.getRepository(ChannelConnection).findOneOrFail({ where: { id: connectionId } });
    expect(row.botId).toBe(bot.id);
  });

  it('clears the assignment (reverts to anchor) when botId is null', async () => {
    const bot = await createBot(tenantId, 'active');
    await request(app).patch(`/channels/${connectionId}/bot`).send({ botId: bot.id });

    const res = await request(app).patch(`/channels/${connectionId}/bot`).send({ botId: null });
    expect(res.status).toBe(200);
    expect(res.body.data.botId).toBeNull();
  });

  it('404s for a bot owned by another tenant', async () => {
    const other = await createTestTenant();
    const otherBot = await createBot(other.id, 'active');
    const res = await request(app).patch(`/channels/${connectionId}/bot`).send({ botId: otherBot.id });
    expect(res.status).toBe(404);
  });

  it('400s when assigning a paused bot', async () => {
    const paused = await createBot(tenantId, 'paused');
    const res = await request(app).patch(`/channels/${connectionId}/bot`).send({ botId: paused.id });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown connection', async () => {
    const bot = await createBot(tenantId, 'active');
    const res = await request(app)
      .patch('/channels/00000000-0000-4000-8000-000000000000/bot')
      .send({ botId: bot.id });
    expect(res.status).toBe(404);
  });
});
