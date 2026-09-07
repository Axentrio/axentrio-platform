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

import request from 'supertest';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { Tenant } from '../../database/entities/Tenant';
import { app } from '../../server';
import { createTestTenant, createTestAnchorBot, createTestUser } from '../helpers/factories';
import { endKeyGrace, rotateBotKey } from '../../services/bot-key-rotation.service';
import { resolveBotKey } from '../../services/bot-resolution.service';

describe('bot key rotation grace', () => {
  let tenantId: string;
  let botId: string;
  let oldKey: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    tenantId = tenant.id;
    botId = bot.id;
    oldKey = bot.publicKey;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'admin' });
  });

  it('keeps the old key working during grace and points the new key at the anchor', async () => {
    const rotated = await rotateBotKey(tenantId, botId);

    const viaOld = await resolveBotKey(oldKey);
    expect(viaOld).not.toBeNull();
    expect(viaOld!.viaPreviousKey).toBe(true);
    expect(viaOld!.bot.id).toBe(botId);
    expect(viaOld!.bot.previousPublicKeyLastUsedAt).not.toBeNull();

    const viaNew = await resolveBotKey(rotated.publicKey);
    expect(viaNew).not.toBeNull();
    expect(viaNew!.viaPreviousKey).toBe(false);
    expect(viaNew!.isAnchorViaLegacyKey).toBe(true);

    const tenant = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: tenantId });
    expect(tenant.apiKey).toBe(rotated.publicKey);
  });

  it('stops resolving the old key after the grace expires', async () => {
    await rotateBotKey(tenantId, botId);
    await AppDataSource.getRepository(Bot).update(
      { id: botId },
      { previousPublicKeyExpiresAt: new Date(Date.now() - 1000) },
    );
    expect(await resolveBotKey(oldKey)).toBeNull();
  });

  it('endKeyGrace drops the previous key immediately', async () => {
    await rotateBotKey(tenantId, botId);
    await endKeyGrace(tenantId, botId);
    expect(await resolveBotKey(oldKey)).toBeNull();
  });

  it('a second rotate kills the first key immediately', async () => {
    const first = await rotateBotKey(tenantId, botId);
    await rotateBotKey(tenantId, botId);
    expect(await resolveBotKey(oldKey)).toBeNull();
    expect(await resolveBotKey(first.publicKey)).not.toBeNull();
  });

  it('POST /bots/:id/rotate-key returns the new snippet', async () => {
    const res = await request(app).post(`/api/v1/bots/${botId}/rotate-key`).send();
    expect(res.status).toBe(200);
    expect(res.body.data.publicKey).toMatch(/^bk_/);
    expect(res.body.data.publicKey).not.toBe(oldKey);
    expect(res.body.data.snippet).toContain(res.body.data.publicKey);
    expect(res.body.data.previousPublicKeyExpiresAt).toBeDefined();
  });
});
