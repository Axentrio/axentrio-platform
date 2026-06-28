import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────────────

const { state, BotNotFoundConfigError } = vi.hoisted(() => ({
  BotNotFoundConfigError: class BotNotFoundConfigError extends Error {
    constructor(botId: string) {
      super(`Bot ${botId} not found`);
      this.name = 'BotNotFoundConfigError';
    }
  },
  state: {
    tenantId: 'tenant-1' as string | undefined,
    role: 'admin' as string,
    // bot-config resolution
    ownedBots: {} as Record<string, any>, // botId → bot row (or undefined ⇒ NotFound)
    anchorBot: null as any,
    anchorThrows: false,
    // entitlements
    entitlementsThrows: false,
    entitlements: { features: { bookings: true } } as any,
    // capabilities (the readiness registry) — overridden per test
    capabilities: [] as any[],
  },
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.user = state.tenantId ? { tenantId: state.tenantId, role: state.role } : {};
    req.userId = 'user-1';
    req.tenantId = state.tenantId;
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/super-admin.middleware', () => ({
  resolveTenantContext: (req: any, _res: any, next: any) => {
    req.tenantId = state.tenantId;
    next();
  },
}));

vi.mock('../../middleware/auth.middleware', () => ({
  requireRole:
    (...roles: string[]) =>
    (req: any, res: any, next: any) => {
      if (req.user?.role === 'super_admin' || roles.includes(req.user?.role)) return next();
      res.status(403).json({ error: 'forbidden' });
    },
}));

vi.mock('../../services/bot-config.service', () => ({
  BotNotFoundConfigError,
  getOwnedBot: async (botId: string, _tenantId: string) => {
    const bot = state.ownedBots[botId];
    if (!bot) throw new BotNotFoundConfigError(botId);
    return bot;
  },
  getAnchorBotConfig: async (_tenantId: string) => {
    if (state.anchorThrows) throw new Error('anchor resolution failed');
    return { bot: state.anchorBot };
  },
}));

vi.mock('../../billing/entitlements', () => ({
  getEntitlements: async (_tenantId: string) => {
    if (state.entitlementsThrows) throw new Error('entitlement resolution failed');
    return state.entitlements;
  },
}));

// Control the registered capabilities directly so we exercise appliesTo/check
// behavior (clean-false omission, thrown appliesTo/check ⇒ 5xx, flat-map).
vi.mock('../../readiness', () => ({
  getCapabilities: () => state.capabilities,
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// bots.routes imports many handlers at module load. Stub the heavy collaborators
// the readiness route doesn't use so the router mounts cleanly.
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ find: async () => [], findOne: async () => null }) },
}));
vi.mock('../../knowledge/bot-ai-settings.controller', () => ({
  getBotAiSettings: vi.fn(), updateBotAiSettings: vi.fn(), botTestChat: vi.fn(),
}));
vi.mock('../../knowledge/bot-template.controller', () => ({
  getBotTemplateOptions: vi.fn(), updateBotTemplateBinding: vi.fn(),
}));
vi.mock('../../knowledge/knowledge.service', () => ({ KnowledgeService: class {} }));
vi.mock('../../knowledge/bot-knowledge.service', () => ({
  getBotKnowledgeState: vi.fn(), enableDedicatedKb: vi.fn(), disableDedicatedKb: vi.fn(),
}));
vi.mock('../../knowledge/attach-shared-kb', () => ({ ensureSharedKbAttached: vi.fn() }));
vi.mock('../../billing/enforce', () => ({ enforceCountLimit: vi.fn() }));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import botsRoutes from '../../routes/bots.routes';
import { errorHandler } from '../../middleware/error-handler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/bots', botsRoutes);
  app.use(errorHandler);
  return app;
}

const ANCHOR = { id: 'anchor-bot', status: 'active', settings: { ai: { enabled: true } } };

/** A capability stub with controllable appliesTo/check. */
function cap(key: string, opts: { applies?: boolean | (() => any); check?: () => any } = {}): any {
  return {
    key,
    appliesTo: typeof opts.applies === 'function' ? opts.applies : () => opts.applies ?? true,
    check: opts.check ?? (async () => [{ capability: key, state: 'live', missingSteps: [] }]),
  };
}

beforeEach(() => {
  state.tenantId = 'tenant-1';
  state.role = 'admin';
  state.ownedBots = {};
  state.anchorBot = ANCHOR;
  state.anchorThrows = false;
  state.entitlementsThrows = false;
  state.entitlements = { features: { bookings: true } };
  state.capabilities = [];
});

describe('GET /bots/readiness — route ordering', () => {
  it('resolves to the readiness handler, NOT captured by /:id', async () => {
    state.capabilities = [cap('booking')];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.status).toBe(200);
    // The anchor was used (no botId) — proves it hit the readiness handler, not /:id.
    expect(res.body.data.botId).toBe('anchor-bot');
  });
});

describe('GET /bots/readiness — bot resolution', () => {
  it('?botId resolves that bot via getOwnedBot', async () => {
    state.ownedBots = { 'bot-x': { id: 'bot-x', status: 'active', settings: { ai: { enabled: true } } } };
    state.capabilities = [cap('booking')];
    const res = await request(createApp()).get('/bots/readiness?botId=bot-x');
    expect(res.status).toBe(200);
    expect(res.body.data.botId).toBe('bot-x');
  });

  it('omitted botId defaults to the anchor', async () => {
    state.capabilities = [cap('booking')];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.body.data.botId).toBe('anchor-bot');
  });

  it('unknown botId ⇒ 404 (not 5xx)', async () => {
    state.capabilities = [cap('booking')];
    const res = await request(createApp()).get('/bots/readiness?botId=nope');
    expect(res.status).toBe(404);
  });
});

describe('GET /bots/readiness — serving-state gates (no 4xx)', () => {
  it('paused bot ⇒ capabilities still computed, overall.botPaused true', async () => {
    state.anchorBot = { id: 'anchor-bot', status: 'paused', settings: { ai: { enabled: true } } };
    state.capabilities = [cap('booking')];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.status).toBe(200);
    expect(res.body.data.overall.botPaused).toBe(true);
    expect(res.body.data.capabilities).toHaveLength(1);
  });

  it('AI-disabled bot ⇒ capabilities still computed, overall.aiEnabled false', async () => {
    state.anchorBot = { id: 'anchor-bot', status: 'active', settings: { ai: { enabled: false } } };
    state.capabilities = [cap('booking')];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.status).toBe(200);
    expect(res.body.data.overall.aiEnabled).toBe(false);
  });
});

describe('GET /bots/readiness — appliesTo semantics', () => {
  it('clean false ⇒ capability ABSENT (omitted), not not_ready', async () => {
    state.capabilities = [cap('booking', { applies: false }), cap('answering', { applies: true })];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.status).toBe(200);
    const keys = res.body.data.capabilities.map((c: any) => c.capability);
    expect(keys).toEqual(['answering']);
  });
});

describe('GET /bots/readiness — flat-map', () => {
  it("the channel-style contributor's array flat-maps to one entry per element", async () => {
    state.capabilities = [
      cap('channel', {
        check: async () => [
          { capability: 'channel', instanceId: 'c1', state: 'live', missingSteps: [] },
          { capability: 'channel', instanceId: 'c2', state: 'not_ready', missingSteps: [] },
        ],
      }),
    ];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.body.data.capabilities).toHaveLength(2);
    expect(res.body.data.overall.applicableCount).toBe(2);
    expect(res.body.data.overall.liveCount).toBe(1);
    expect(res.body.data.overall.allLive).toBe(false);
  });
});

describe('GET /bots/readiness — overall on empty capabilities', () => {
  it('nothing applies ⇒ allLive false, nothingApplicable true', async () => {
    state.capabilities = [cap('booking', { applies: false })];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.body.data.capabilities).toEqual([]);
    expect(res.body.data.overall).toMatchObject({
      applicableCount: 0,
      liveCount: 0,
      allLive: false,
      nothingApplicable: true,
    });
  });
});

describe('GET /bots/readiness — fail-closed (whole-endpoint 5xx, never partial)', () => {
  it('a check that throws ⇒ 5xx, no partial capabilities', async () => {
    state.capabilities = [
      cap('booking'), // would be live
      cap('answering', { check: async () => { throw new Error('DB down'); } }),
    ];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.data).toBeUndefined();
  });

  it('a thrown (async-rejecting) appliesTo ⇒ 5xx, NOT silently dropped', async () => {
    state.capabilities = [
      cap('booking', { applies: async () => { throw new Error('appliesTo boom'); } }),
    ];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('entitlement resolution failure ⇒ 5xx (not not_ready)', async () => {
    state.entitlementsThrows = true;
    state.capabilities = [cap('booking')];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('anchor resolution failure (non-NotFound) ⇒ 5xx', async () => {
    state.anchorThrows = true;
    state.capabilities = [cap('booking')];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe('GET /bots/readiness — allLive', () => {
  it('all applicable live ⇒ allLive true', async () => {
    state.capabilities = [cap('booking'), cap('answering')];
    const res = await request(createApp()).get('/bots/readiness');
    expect(res.body.data.overall.allLive).toBe(true);
  });
});
