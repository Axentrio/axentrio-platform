/**
 * Integration tests for per-bot dedicated knowledge bases ("dedicated replaces
 * shared"): GET state, enable/disable dedicated, per-bot document add/list/delete.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
// Ingestion queue is best-effort; stub it so doc creation doesn't touch Redis.
vi.mock('../../queue/message-queue', () => ({ addJob: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { KnowledgeBase } from '../../database/entities/KnowledgeBase';
import { BotKnowledgeBase } from '../../database/entities/BotKnowledgeBase';
import { app } from '../../server';
import { createTestTenant, createTestAnchorBot, createTestUser } from '../helpers/factories';

describe('Per-bot dedicated knowledge', () => {
  let tenantId: string;
  let botId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'enterprise' });
    tenantId = tenant.id;
    const bot = await createTestAnchorBot(tenant);
    botId = bot.id;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'admin' });
  });

  it('enables a dedicated KB (detaching shared) and reports dedicated mode', async () => {
    const res = await request(app).post(`/api/v1/bots/${botId}/knowledge/dedicated`).send();
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('dedicated');
    expect(res.body.data.kbId).toBeTruthy();

    // The bot is attached to its own KB (botId = bot.id), not the primary.
    const dedicated = await AppDataSource.getRepository(KnowledgeBase).findOne({ where: { tenantId, botId } });
    expect(dedicated).not.toBeNull();
    const joins = await AppDataSource.getRepository(BotKnowledgeBase).find({ where: { botId } });
    expect(joins).toHaveLength(1);
    expect(joins[0].knowledgeBaseId).toBe(dedicated!.id);
  });

  it('adds a document to the dedicated KB and lists it; 400s in shared mode', async () => {
    // Shared mode (no dedicated yet) → cannot add docs.
    const shared = await request(app)
      .post(`/api/v1/bots/${botId}/documents`)
      .send({ type: 'text', title: 'X', sourceContent: 'hello' });
    expect(shared.status).toBe(400);

    await request(app).post(`/api/v1/bots/${botId}/knowledge/dedicated`).send();

    const create = await request(app)
      .post(`/api/v1/bots/${botId}/documents`)
      .send({ type: 'text', title: 'Bot Doc', sourceContent: 'private knowledge' });
    expect(create.status).toBe(201);

    const get = await request(app).get(`/api/v1/bots/${botId}/knowledge`);
    expect(get.status).toBe(200);
    expect(get.body.data.mode).toBe('dedicated');
    expect(get.body.data.documents).toHaveLength(1);
    expect(get.body.data.documents[0].title).toBe('Bot Doc');
  });

  it('switches back to shared (non-destructive) and re-enable keeps the docs', async () => {
    await request(app).post(`/api/v1/bots/${botId}/knowledge/dedicated`).send();
    await request(app)
      .post(`/api/v1/bots/${botId}/documents`)
      .send({ type: 'text', title: 'Kept Doc', sourceContent: 'x' });

    const toShared = await request(app).delete(`/api/v1/bots/${botId}/knowledge/dedicated`).send();
    expect(toShared.status).toBe(200);
    expect(toShared.body.data.mode).toBe('shared');

    // Shared GET hides per-bot docs.
    const sharedGet = await request(app).get(`/api/v1/bots/${botId}/knowledge`);
    expect(sharedGet.body.data.mode).toBe('shared');
    expect(sharedGet.body.data.documents).toHaveLength(0);

    // Re-enable → the dedicated KB and its doc are still there.
    const reEnable = await request(app).post(`/api/v1/bots/${botId}/knowledge/dedicated`).send();
    expect(reEnable.body.data.mode).toBe('dedicated');
    const get = await request(app).get(`/api/v1/bots/${botId}/knowledge`);
    expect(get.body.data.documents).toHaveLength(1);
    expect(get.body.data.documents[0].title).toBe('Kept Doc');
  });

  it('shared mode attaches the primary KB', async () => {
    await request(app).post(`/api/v1/bots/${botId}/knowledge/dedicated`).send();
    await request(app).delete(`/api/v1/bots/${botId}/knowledge/dedicated`).send();

    const primary = await AppDataSource.getRepository(KnowledgeBase).findOne({
      where: { tenantId, botId: IsNull() },
    });
    const joins = await AppDataSource.getRepository(BotKnowledgeBase).find({ where: { botId } });
    expect(joins).toHaveLength(1);
    expect(joins[0].knowledgeBaseId).toBe(primary!.id);
  });
});
