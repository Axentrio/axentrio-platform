/**
 * Super-admin bot-template authoring API (.scratch/plan-bot-templates.md,
 * Phase 3). Covers the lifecycle + safety contracts: version allocation +
 * immutability + lock_version concurrency (T19), block-or-force with impacted
 * counts on unpublish/archive/un-grant (T12/T21), grants union, and T22
 * validation. blank-base is seeded here because migrations don't run in test.
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
vi.mock('../../llm/provider-factory', async (importActual) => ({
  ...(await importActual<typeof import('../../llm/provider-factory')>()),
  getProvider: () => ({ chat: vi.fn().mockResolvedValue({ content: 'TEST REPLY' }) }),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { BotTemplate } from '../../database/entities/BotTemplate';
import { BotTemplateVersion } from '../../database/entities/BotTemplateVersion';
import { listAvailableTemplates } from '../../templates/template-resolver';
import { createTestTenant, createTestUser } from '../helpers/factories';

const BASE = '/api/v1/admin/bot-templates';
let keyCounter = 0;

async function seedBlankBase(): Promise<string> {
  const t = await AppDataSource.getRepository(BotTemplate).save({
    key: 'blank-base', displayName: 'Blank', availableToAllTenants: true, status: 'active',
  });
  await AppDataSource.getRepository(BotTemplateVersion).save({
    templateId: t.id, version: 1, body: '', status: 'published', publishedAt: new Date(), publishedBy: 'system',
  });
  return t.id;
}

async function makeBot(tenantId: string, templateId: string, templateVersion = 'latest'): Promise<Bot> {
  return AppDataSource.getRepository(Bot).save({
    tenantId, name: 'Bot', publicKey: `bk_${tenantId}_${Math.abs(hashCode(templateId + templateVersion + Date.now()))}`,
    status: 'active', isDefault: false, settings: {}, templateId, templateVersion,
  });
}
function hashCode(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

async function createTemplate(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app).post(BASE).send({ key: `tmpl-${++keyCounter}`, displayName: 'T', ...extra });
  expect(res.status).toBe(201);
  return res.body.data.template.id;
}

beforeEach(async () => {
  const admin = await createTestUser((await createTestTenant()).id, { role: 'super_admin' });
  configureMockAuth(auth, { userId: admin.id, tenantId: admin.tenantId, role: 'super_admin' });
});

describe('templates CRUD', () => {
  it('creates a template and rejects a duplicate key', async () => {
    const res = await request(app).post(BASE).send({ key: 'dup', displayName: 'Dup' });
    expect(res.status).toBe(201);
    const dup = await request(app).post(BASE).send({ key: 'dup', displayName: 'Dup2' });
    expect(dup.status).toBe(409);
  });

  it('lists templates with a version summary', async () => {
    const id = await createTemplate();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1' });
    const list = await request(app).get(BASE);
    expect(list.status).toBe(200);
    const row = list.body.data.templates.find((t: any) => t.id === id);
    expect(row.versionCount).toBe(1);
    expect(row.draftCount).toBe(1);
    expect(row.latestPublishedVersion).toBeNull();
  });
});

describe('version lifecycle (T19)', () => {
  it('allocates sequential version numbers', async () => {
    const id = await createTemplate();
    const v1 = await request(app).post(`${BASE}/${id}/versions`).send({ body: 'a' });
    const v2 = await request(app).post(`${BASE}/${id}/versions`).send({ body: 'b' });
    expect(v1.body.data.version.version).toBe(1);
    expect(v2.body.data.version.version).toBe(2);
  });

  it('blocks publishing a body with unknown placeholders', async () => {
    const id = await createTemplate();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'Hi {botName}, see {bogusVar}.' });
    const pub = await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    expect(pub.status).toBe(422);
    // fixing the placeholder lets it publish
    await request(app).put(`${BASE}/${id}/versions/1`).send({ body: 'Hi {botName}.', lockVersion: 0 });
    const ok = await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    expect(ok.status).toBe(200);
  });

  it('rejects editing a published version (immutable)', async () => {
    const id = await createTemplate();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'a' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    const edit = await request(app).put(`${BASE}/${id}/versions/1`).send({ body: 'changed' });
    expect(edit.status).toBe(409);
  });

  it('enforces lock_version optimistic concurrency on draft edits', async () => {
    const id = await createTemplate();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'a' }); // lockVersion 0
    const ok = await request(app).put(`${BASE}/${id}/versions/1`).send({ body: 'b', lockVersion: 0 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.version.lockVersion).toBe(1);
    const stale = await request(app).put(`${BASE}/${id}/versions/1`).send({ body: 'c', lockVersion: 0 });
    expect(stale.status).toBe(409);
  });

  it('rollback publishes a NEW version copied from an old body', async () => {
    const id = await createTemplate();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'ORIGINAL' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'NEWER' });
    await request(app).post(`${BASE}/${id}/versions/2/publish`).send();

    const rb = await request(app).post(`${BASE}/${id}/rollback`).send({ fromVersion: 1 });
    expect(rb.status).toBe(201);
    expect(rb.body.data.version.version).toBe(3);
    expect(rb.body.data.version.status).toBe('published');
    expect(rb.body.data.version.body).toBe('ORIGINAL');
  });
});

describe('version config — template-owned tone + guardrails (#24/#25)', () => {
  const sampleConfig = {
    tone: 'professional',
    guardrails: {
      topicsToAvoid: ['politics'],
      greetingMessage: 'Hi from {botName}!',
      fallbackMessage: 'Let me get a human.',
      offHoursMessage: "We're closed.",
      confidenceThreshold: 0.8,
      maxResponseLength: 600,
    },
  };

  it('persists config on create and returns it on the detail GET', async () => {
    const id = await createTemplate();
    const created = await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1', config: sampleConfig });
    expect(created.status).toBe(201);
    expect(created.body.data.version.config).toEqual(sampleConfig);

    const detail = await request(app).get(`${BASE}/${id}`);
    expect(detail.body.data.versions[0].config).toEqual(sampleConfig);
  });

  it('defaults to {} when no config is sent', async () => {
    const id = await createTemplate();
    const created = await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1' });
    expect(created.body.data.version.config).toEqual({});
  });

  it('edits config on a draft and copies it through rollback', async () => {
    const id = await createTemplate();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1' });
    const edit = await request(app).put(`${BASE}/${id}/versions/1`).send({ config: sampleConfig, lockVersion: 0 });
    expect(edit.status).toBe(200);
    expect(edit.body.data.version.config).toEqual(sampleConfig);

    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v2' });
    await request(app).post(`${BASE}/${id}/versions/2/publish`).send();
    const rb = await request(app).post(`${BASE}/${id}/rollback`).send({ fromVersion: 1 });
    expect(rb.body.data.version.config).toEqual(sampleConfig);
  });

  it('rejects an out-of-range confidenceThreshold', async () => {
    const id = await createTemplate();
    const res = await request(app)
      .post(`${BASE}/${id}/versions`)
      .send({ body: 'v1', config: { guardrails: { confidenceThreshold: 2 } } });
    expect(res.status).toBe(422);
  });
});

describe('template test-chat (preview before publish)', () => {
  it('returns a reply for an unsaved prompt + config', async () => {
    const res = await request(app).post(`${BASE}/test-chat`).send({
      body: 'You are {botName} for {businessName}.',
      config: { tone: 'professional', guardrails: { fallbackMessage: 'Sorry.' } },
      message: 'hi',
      history: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.response).toBe('TEST REPLY');
  });

  it('422 without a message', async () => {
    const res = await request(app).post(`${BASE}/test-chat`).send({ body: 'x' });
    expect(res.status).toBe(422);
  });
});

describe('multi-binding safety (unpublish blocks + reassigns a SECONDARY binding)', () => {
  it('blocks unpublishing a version a bot pins as a secondary binding, then forces (drops it)', async () => {
    await seedBlankBase();
    const tenant = await createTestTenant({ tier: 'enterprise' });
    const primary = await createTemplate({ availableToAllTenants: true });
    const secondary = await createTemplate({ availableToAllTenants: true });
    await request(app).post(`${BASE}/${primary}/versions`).send({ body: 'p1' });
    await request(app).post(`${BASE}/${primary}/versions/1/publish`).send();
    await request(app).post(`${BASE}/${secondary}/versions`).send({ body: 's1' });
    await request(app).post(`${BASE}/${secondary}/versions/1/publish`).send();
    // bot binds primary (latest) + secondary (pinned v1)
    const bot = await AppDataSource.getRepository(Bot).save({
      tenantId: tenant.id, name: 'Multi', publicKey: `bk_multi_${Date.now()}`, status: 'active', isDefault: false,
      settings: {}, templateId: primary, templateVersion: 'latest',
      templateBindings: [{ templateId: primary, version: 'latest' }, { templateId: secondary, version: '1' }],
      templateMode: 'or',
    } as Partial<Bot>);

    const blocked = await request(app).post(`${BASE}/${secondary}/versions/1/unpublish`).send();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.details?.impactedBots).toBe(1);

    const forced = await request(app).post(`${BASE}/${secondary}/versions/1/unpublish`).send({ force: true });
    expect(forced.status).toBe(200);
    const reloaded = await AppDataSource.getRepository(Bot).findOneByOrFail({ id: bot.id });
    // secondary binding dropped; primary preserved as the sole (and primary) binding
    expect(reloaded.templateBindings.map((b) => b.templateId)).toEqual([primary]);
    expect(reloaded.templateId).toBe(primary);
  });
});

describe('delete version (drafts + unpublished)', () => {
  it('deletes a draft version', async () => {
    const id = await createTemplate();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'd' });
    const del = await request(app).delete(`${BASE}/${id}/versions/1`);
    expect(del.status).toBe(200);
    const detail = await request(app).get(`${BASE}/${id}`);
    expect(detail.body.data.versions.length).toBe(0);
  });

  it('refuses to delete a published version (must unpublish first)', async () => {
    const id = await createTemplate();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'a' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    const del = await request(app).delete(`${BASE}/${id}/versions/1`);
    expect(del.status).toBe(409);
  });

  it('deletes an unpublished version with no pins', async () => {
    await seedBlankBase();
    const id = await createTemplate({ availableToAllTenants: true });
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'a' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    await request(app).post(`${BASE}/${id}/versions/1/unpublish`).send();
    const del = await request(app).delete(`${BASE}/${id}/versions/1`);
    expect(del.status).toBe(200);
  });

  it('blocks deleting a pinned unpublished version, then forces (unpins to latest)', async () => {
    await seedBlankBase();
    const tenant = await createTestTenant({ tier: 'enterprise' });
    const id = await createTemplate({ availableToAllTenants: true });
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    const bot = await makeBot(tenant.id, id, '1'); // pins fixed v1
    // Contrive the (normally-reassigned) state: v1 unpublished but pin intact.
    await AppDataSource.getRepository(BotTemplateVersion).update({ templateId: id, version: 1 }, { status: 'unpublished' });

    const blocked = await request(app).delete(`${BASE}/${id}/versions/1`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.details?.impactedBots).toBe(1);

    const forced = await request(app).delete(`${BASE}/${id}/versions/1`).send({ force: true });
    expect(forced.status).toBe(200);
    const reloaded = await AppDataSource.getRepository(Bot).findOneByOrFail({ id: bot.id });
    expect(reloaded.templateVersion).toBe('latest');
    expect(reloaded.templateId).toBe(id);
  });
});

describe('unpublish — block-or-force (T12/T21)', () => {
  it('blocks unpublishing a version pinned by a bot, then forces with reassignment', async () => {
    await seedBlankBase();
    const tenant = await createTestTenant({ tier: 'enterprise' });
    const id = await createTemplate({ availableToAllTenants: true });
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    const bot = await makeBot(tenant.id, id, '1'); // pins fixed v1

    const blocked = await request(app).post(`${BASE}/${id}/versions/1/unpublish`).send();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.details?.impactedBots).toBe(1);

    const forced = await request(app).post(`${BASE}/${id}/versions/1/unpublish`).send({ force: true });
    expect(forced.status).toBe(200);
    const reloaded = await AppDataSource.getRepository(Bot).findOneByOrFail({ id: bot.id });
    expect(reloaded.templateVersion).toBe('latest'); // reassigned to blank-base@latest (no other published version)
  });

  it('does not block bots on latest (only fixed pins block)', async () => {
    const tenant = await createTestTenant({ tier: 'enterprise' });
    const id = await createTemplate({ availableToAllTenants: true });
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    await makeBot(tenant.id, id, 'latest');
    const res = await request(app).post(`${BASE}/${id}/versions/1/unpublish`).send();
    expect(res.status).toBe(200);
  });
});

describe('archive — block-or-force (T21)', () => {
  it('blocks while bots are bound, then forces reassignment to blank-base', async () => {
    const blankId = await seedBlankBase();
    const tenant = await createTestTenant({ tier: 'enterprise' });
    const id = await createTemplate({ availableToAllTenants: true });
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    const bot = await makeBot(tenant.id, id, 'latest');

    const blocked = await request(app).post(`${BASE}/${id}/archive`).send();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.details?.impactedBots).toBe(1);

    const forced = await request(app).post(`${BASE}/${id}/archive`).send({ force: true });
    expect(forced.status).toBe(200);
    const reloaded = await AppDataSource.getRepository(Bot).findOneByOrFail({ id: bot.id });
    expect(reloaded.templateId).toBe(blankId);
  });
});

describe('grants (T7) — availability + block-or-force', () => {
  it('grants make a non-global template available to that tenant only', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const other = await createTestTenant({ tier: 'pro' });
    const id = await createTemplate(); // not global
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();

    const put = await request(app).put(`${BASE}/${id}/grants`).send({ tenantIds: [tenant.id] });
    expect(put.status).toBe(200);
    expect((await listAvailableTemplates(tenant.id)).some((t) => t.id === id)).toBe(true);
    expect((await listAvailableTemplates(other.id)).some((t) => t.id === id)).toBe(false);
  });

  it('blocks removing a grant from a tenant with bound bots unless forced', async () => {
    await seedBlankBase();
    const tenant = await createTestTenant({ tier: 'pro' });
    const id = await createTemplate();
    await request(app).post(`${BASE}/${id}/versions`).send({ body: 'v1' });
    await request(app).post(`${BASE}/${id}/versions/1/publish`).send();
    await request(app).put(`${BASE}/${id}/grants`).send({ tenantIds: [tenant.id] });
    await makeBot(tenant.id, id, 'latest');

    const blocked = await request(app).put(`${BASE}/${id}/grants`).send({ tenantIds: [] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.details?.impactedTenants?.[0]?.bots).toBe(1);

    const forced = await request(app).put(`${BASE}/${id}/grants`).send({ tenantIds: [], force: true });
    expect(forced.status).toBe(200);
    expect((await listAvailableTemplates(tenant.id)).some((t) => t.id === id)).toBe(false);
  });
});

describe('authoring validation (T22)', () => {
  it('rejects an over-cap body (20k)', async () => {
    const id = await createTemplate();
    const res = await request(app).post(`${BASE}/${id}/versions`).send({ body: 'x'.repeat(20_001) });
    expect(res.status).toBe(422); // ValidationError → 422 in this codebase
  });

  it('rejects unknown expectedModules ids', async () => {
    const id = await createTemplate();
    const res = await request(app).post(`${BASE}/${id}/versions`).send({ body: 'ok', expectedModules: ['not-a-module'] });
    expect(res.status).toBe(422);
  });

  it('accepts a known module id and warns on unknown placeholders', async () => {
    const id = await createTemplate();
    const res = await request(app).post(`${BASE}/${id}/versions`).send({ body: 'Hi {botName} and {bogus}', expectedModules: ['booking'] });
    expect(res.status).toBe(201);
    expect(res.body.data.warnings.join(' ')).toContain('{bogus}');
  });
});
