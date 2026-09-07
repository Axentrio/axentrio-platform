import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
  emitToRoom: vi.fn(),
}));

const redisStore = vi.hoisted(() => new Map<string, string>());
vi.mock('../../config/redis', () => ({
  getRedisClient: () => ({
    get: async (key: string) => redisStore.get(key) ?? null,
    set: async (key: string, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    },
    incr: async (key: string) => {
      const next = Number(redisStore.get(key) ?? '0') + 1;
      redisStore.set(key, String(next));
      return next;
    },
    expire: async () => 1,
    ttl: async () => 60,
    pipeline: () => {
      const ops: Array<() => void> = [];
      const chain = {
        incr: (key: string) => {
          ops.push(() => {
            const next = Number(redisStore.get(key) ?? '0') + 1;
            redisStore.set(key, String(next));
          });
          return chain;
        },
        expire: () => chain,
        exec: async () => {
          for (const op of ops) op();
          return [];
        },
      };
      return chain;
    },
  }),
  isRedisAvailable: () => true,
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { Notification } from '../../database/entities/Notification';
import { createTestTenant, createTestAnchorBot, createTestUser } from '../helpers/factories';
import { recordOriginDenial } from '../../services/widget-abuse.service';

const DENIED = 'This chatbot is not allowed on this website.';

describe('widget origin allow-list', () => {
  it('allows a matching wildcard origin and denies others', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant, {
      settings: { widget: { allowedOrigins: ['*.shop.example'] } },
    });

    const ok = await request(app)
      .post('/api/v1/widget/init')
      .set('Origin', 'https://www.shop.example')
      .send({ apiKey: bot.publicKey, visitorId: `ok-${crypto.randomBytes(4).toString('hex')}` });
    expect(ok.status).toBe(200);

    const evil = await request(app)
      .post('/api/v1/widget/init')
      .set('Origin', 'https://evil.example')
      .send({ apiKey: bot.publicKey, visitorId: `evil-${crypto.randomBytes(4).toString('hex')}` });
    expect(evil.status).toBe(403);
    expect(evil.body.error.message).toBe(DENIED);

    const missing = await request(app)
      .post('/api/v1/widget/init')
      .send({ apiKey: bot.publicKey, visitorId: `miss-${crypto.randomBytes(4).toString('hex')}` });
    expect(missing.status).toBe(403);

    const cfgOk = await request(app)
      .get('/api/v1/widget/config')
      .query({ apiKey: bot.publicKey })
      .set('Origin', 'https://www.shop.example');
    expect(cfgOk.status).toBe(200);

    const cfgEvil = await request(app)
      .get('/api/v1/widget/config')
      .query({ apiKey: bot.publicKey })
      .set('Origin', 'https://evil.example');
    expect(cfgEvil.status).toBe(403);
    expect(cfgEvil.body.error.message).toBe(DENIED);
  });

  it('allows every origin when the list is empty', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const res = await request(app)
      .post('/api/v1/widget/init')
      .send({ apiKey: bot.publicKey, visitorId: `open-${crypto.randomBytes(4).toString('hex')}` });
    expect(res.status).toBe(200);
  });

  it('writes allowedOrigins per bot via PATCH and gates that bot independently', async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    await createTestAnchorBot(tenant);
    configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });

    const repo = AppDataSource.getRepository(Bot);
    const shop = await repo.save({
      tenantId: tenant.id,
      name: 'Shop bot',
      publicKey: `bk_${crypto.randomBytes(12).toString('hex')}`,
      isDefault: false,
      settings: {},
    });

    const patch = await request(app)
      .patch(`/api/v1/bots/${shop.id}`)
      .send({ allowedOrigins: ['*.shop.example'] });
    expect(patch.status).toBe(200);
    expect(patch.body.data.allowedOrigins).toEqual(['*.shop.example']);

    const evil = await request(app)
      .post('/api/v1/widget/init')
      .set('Origin', 'https://evil.example')
      .send({ apiKey: shop.publicKey, visitorId: `evil-${crypto.randomBytes(4).toString('hex')}` });
    expect(evil.status).toBe(403);

    const ok = await request(app)
      .post('/api/v1/widget/init')
      .set('Origin', 'https://www.shop.example')
      .send({ apiKey: shop.publicKey, visitorId: `ok-${crypto.randomBytes(4).toString('hex')}` });
    expect(ok.status).toBe(200);
  });

  it('does not apply the per-key init cap to GET /widget/config', async () => {
    redisStore.clear();
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const hashed = crypto.createHash('sha256').update(bot.publicKey).digest('hex').slice(0, 16);
    redisStore.set(`rl:widget-key-init:${hashed}`, '1000');

    const cfg = await request(app)
      .get('/api/v1/widget/config')
      .query({ apiKey: bot.publicKey })
      .set('X-Forwarded-For', '198.51.100.20');
    expect(cfg.status).toBe(200);

    const init = await request(app)
      .post('/api/v1/widget/init')
      .set('X-Forwarded-For', '198.51.100.21')
      .send({ apiKey: bot.publicKey, visitorId: `cap-${crypto.randomBytes(4).toString('hex')}` });
    expect(init.status).toBe(429);
    expect(init.headers['retry-after']).toBe('60');
  });

});

describe('widget key abuse alert', () => {
  it('notifies each active user once after 20 denials in an hour', async () => {
    redisStore.clear();
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant, {
      settings: { widget: { allowedOrigins: ['good.example'] } },
    });
    const a = await createTestUser(tenant.id, { role: 'admin' });
    const b = await createTestUser(tenant.id, { role: 'admin' });

    const res = await request(app)
      .post('/api/v1/widget/init')
      .set('Origin', 'https://evil.example')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ apiKey: bot.publicKey, visitorId: `deny-${crypto.randomBytes(3).toString('hex')}` });
    expect(res.status).toBe(403);
    await vi.waitFor(() => {
      expect(redisStore.get(`rl:origin-denied:${bot.id}`)).toBe('1');
    });

    for (let i = 0; i < 19; i++) {
      await recordOriginDenial(bot, tenant.id, 'https://evil.example');
    }

    const repo = AppDataSource.getRepository(Notification);
    await vi.waitFor(async () =>
      expect(
        (await repo.find({ where: { tenantId: tenant.id, type: 'widget_key_abuse' } }))
          .map((r) => r.recipientUserId)
          .sort(),
      ).toEqual([a.id, b.id].sort()),
    );

    for (let i = 0; i < 20; i++) {
      await recordOriginDenial(bot, tenant.id, 'https://evil.example');
    }
    expect(
      await repo.count({
        where: { tenantId: tenant.id, type: 'widget_key_abuse' },
      }),
    ).toBe(2);
  });
});
