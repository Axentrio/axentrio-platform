/**
 * Real-DB regression coverage for GET /api/v1/bots/readiness (booking-only MVP).
 *
 * The unit suites (`unit/booking-readiness.test.ts`, `unit/bots-readiness-route.test.ts`)
 * drive the predicates and route wiring with mocks. THIS suite seeds the REAL
 * rows the booking contributor reads — ServiceType (booking_mode/online_bookable/
 * is_active), AvailabilityRule (availability_mode/weekly_hours), CalendarCredential
 * (status/reauth_required), Tenant.tier, Bot.status, Bot.settings.ai.enabled — and
 * asserts the endpoint output end-to-end, so a regression in the wiring between the
 * DB and the response surfaces here even if every unit passes.
 *
 * It encodes the live edge sweep verified against prod for booking readiness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { BotTemplate } from '../../database/entities/BotTemplate';
import { BotTemplateVersion } from '../../database/entities/BotTemplateVersion';
import { ServiceType } from '../../database/entities/ServiceType';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import { invalidateEntitlements } from '../../billing/entitlements';
import {
  createTestTenant,
  createTestUser,
  createTestAnchorBot,
} from '../helpers/factories';
import type { Tenant, TenantTier } from '../../database/entities/Tenant';
import type { BotStatus } from '../../database/entities/Bot';
import type { BookingMode } from '../../database/entities/ServiceType';
import type {
  AvailabilityMode,
  WeeklyHours,
} from '../../database/entities/AvailabilityRule';

const READINESS_URL = '/api/v1/bots/readiness';
const WEEKLY_OPEN: WeeklyHours = { mon: [{ start: '09:00', end: '17:00' }] };

// ── Seeders (write the REAL rows the booking contributor reads) ──────────────

async function seedService(
  tenantId: string,
  botId: string,
  overrides: Partial<ServiceType> = {},
): Promise<ServiceType> {
  const repo = AppDataSource.getRepository(ServiceType);
  return repo.save(
    repo.create({
      tenantId,
      botId,
      name: 'Consultation',
      slug: `svc-${Math.random().toString(36).slice(2, 8)}`,
      bookingMode: 'auto' as BookingMode,
      onlineBookable: true,
      isActive: true,
      ...overrides,
    }),
  );
}

async function seedRule(
  tenantId: string,
  botId: string,
  overrides: Partial<AvailabilityRule> = {},
): Promise<AvailabilityRule> {
  const repo = AppDataSource.getRepository(AvailabilityRule);
  return repo.save(
    repo.create({
      tenantId,
      botId,
      timezone: 'UTC',
      availabilityMode: 'business_hours' as AvailabilityMode,
      weeklyHours: WEEKLY_OPEN,
      dateOverrides: [],
      ...overrides,
    }),
  );
}

async function seedCalendar(
  tenantId: string,
  botId: string,
  overrides: Partial<CalendarCredential> = {},
): Promise<CalendarCredential> {
  const repo = AppDataSource.getRepository(CalendarCredential);
  return repo.save(
    repo.create({
      tenantId,
      botId,
      provider: 'google',
      status: 'active',
      reauthRequired: false,
      // NOT NULL; readiness never decrypts it — a placeholder string is enough.
      accessTokenEnc: 'enc:placeholder',
      calendarId: 'primary',
      ...overrides,
    }),
  );
}

/**
 * Provision a tenant + admin + anchor bot at a given tier/status/ai-enabled, set
 * the mock auth to that tenant, and return the ids. Entitlements are cached per
 * tenant for 60s; each test uses a fresh tenant so no cache bleed, but we
 * invalidate defensively so a re-seed within a test never reads a stale tier.
 */
async function provision(opts: {
  tier?: TenantTier;
  botStatus?: BotStatus;
  aiEnabled?: boolean;
  featureOverrides?: Tenant['featureOverrides'];
} = {}): Promise<{ tenantId: string; botId: string }> {
  const tenant = await createTestTenant({
    tier: opts.tier ?? 'pro',
    ...(opts.featureOverrides ? { featureOverrides: opts.featureOverrides } : {}),
  });
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  const bot = await createTestAnchorBot(tenant, {
    status: opts.botStatus ?? 'active',
    settings: { ai: { enabled: opts.aiEnabled ?? true } } as Bot['settings'],
  });
  await invalidateEntitlements(tenant.id);
  configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });
  return { tenantId: tenant.id, botId: bot.id };
}

/** The booking result. Scoped by capability rather than "the only one": answering
 *  and channel now contribute too, and these assertions are about booking. */
function bookingOf(body: any) {
  const booking = body.data.capabilities.filter((c: any) => c.capability === 'booking');
  expect(booking).toHaveLength(1);
  return booking[0];
}

beforeEach(() => {
  // Default auth; each test re-provisions a fresh tenant via provision().
  configureMockAuth(auth, { role: 'admin' });
});

describe('GET /bots/readiness (real DB) — applies-to / tier gate', () => {
  it('free tenant ⇒ booking ABSENT (applicableCount 0, nothingApplicable true)', async () => {
    await provision({ tier: 'free' });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    // Booking is entitlement-gated and must be absent on free. Answering is not
    // gated — every bot answers — so it is present here and `nothingApplicable`
    // is no longer reachable. Nothing renders that field; it stays derived.
    const caps = res.body.data.capabilities;
    expect(caps.filter((c: any) => c.capability === 'booking')).toEqual([]);
    expect(caps.some((c: any) => c.capability === 'answering')).toBe(true);
    expect(res.body.data.overall).toMatchObject({ allLive: false });
  });
});

describe('GET /bots/readiness (real DB) — not_ready path-to-live', () => {
  it('pro + NO service ⇒ not_ready, missingSteps includes add_service', async () => {
    await provision({ tier: 'pro' });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    const cap = bookingOf(res.body);
    expect(cap.state).toBe('not_ready');
    expect(cap.missingSteps.map((s: any) => s.id)).toContain('add_service');
    expect(cap.detail.willAutoConfirm).toBe(false);
  });

  it('pro + AUTO service + NO availability rule ⇒ not_ready (set_hours)', async () => {
    const { tenantId, botId } = await provision({ tier: 'pro' });
    await seedService(tenantId, botId, { bookingMode: 'auto' });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    const cap = bookingOf(res.body);
    expect(cap.state).toBe('not_ready');
    expect(cap.missingSteps.map((s: any) => s.id)).toContain('set_hours');
  });
});

describe('GET /bots/readiness (real DB) — live + auto-confirm enrichment', () => {
  it('pro + auto + hours + NO calendar ⇒ live, willAutoConfirm false, [calendar_not_connected]', async () => {
    const { tenantId, botId } = await provision({ tier: 'pro' });
    await seedService(tenantId, botId, { bookingMode: 'auto' });
    await seedRule(tenantId, botId);
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    const cap = bookingOf(res.body);
    expect(cap.state).toBe('live');
    expect(cap.detail.willAutoConfirm).toBe(false);
    expect((cap.attention ?? []).map((a: any) => a.code)).toEqual(['calendar_not_connected']);
  });

  it('pro + REQUEST-only (no calendar) ⇒ live, willAutoConfirm false, NO attention (no calendar nag)', async () => {
    const { tenantId, botId } = await provision({ tier: 'pro' });
    await seedService(tenantId, botId, { bookingMode: 'request' });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    const cap = bookingOf(res.body);
    expect(cap.state).toBe('live');
    expect(cap.detail.willAutoConfirm).toBe(false);
    // Request-only has no auto-confirm enrichment — no calendar/hours noise.
    expect(cap.attention ?? []).toEqual([]);
    expect(cap.detail.calendar).toBeUndefined();
  });

  it('pro + auto + hours + HEALTHY calendar ⇒ live, willAutoConfirm true, NO attention', async () => {
    const { tenantId, botId } = await provision({ tier: 'pro' });
    await seedService(tenantId, botId, { bookingMode: 'auto' });
    await seedRule(tenantId, botId);
    await seedCalendar(tenantId, botId, { status: 'active', reauthRequired: false });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    const cap = bookingOf(res.body);
    expect(cap.state).toBe('live');
    expect(cap.detail.willAutoConfirm).toBe(true);
    expect(cap.attention).toBeUndefined();
    expect(cap.detail.calendar).toMatchObject({ state: 'healthy', provider: 'google' });
  });

  it('pro + auto + hours + HEALTHY calendar but calendarSync DISABLED ⇒ live, willAutoConfirm false, [calendar_sync_disabled]', async () => {
    // The reviewer's gap: a healthy calendar with sync turned off by plan/override.
    // Readiness already requires sync for willAutoConfirm; the runtime now matches
    // (canAutoConfirm). So the bot is live (request-capture) with willAutoConfirm
    // false and a calendar_sync_disabled attention, NOT a confirmed auto booking.
    const { tenantId, botId } = await provision({
      tier: 'pro',
      featureOverrides: {
        calendarSync: { value: false, reason: 'test', setBy: 'test', setAt: new Date().toISOString() },
      },
    });
    await seedService(tenantId, botId, { bookingMode: 'auto' });
    await seedRule(tenantId, botId);
    await seedCalendar(tenantId, botId, { status: 'active', reauthRequired: false });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    const cap = bookingOf(res.body);
    expect(cap.state).toBe('live');
    expect(cap.detail.willAutoConfirm).toBe(false);
    expect((cap.attention ?? []).map((a: any) => a.code)).toContain('calendar_sync_disabled');
    expect(cap.detail.calendar).toMatchObject({ state: 'healthy', provider: 'google' });
  });

  it('calendar reauth_required ⇒ live, willAutoConfirm false, [calendar_reauth_required]', async () => {
    const { tenantId, botId } = await provision({ tier: 'pro' });
    await seedService(tenantId, botId, { bookingMode: 'auto' });
    await seedRule(tenantId, botId);
    await seedCalendar(tenantId, botId, { status: 'active', reauthRequired: true });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    const cap = bookingOf(res.body);
    expect(cap.state).toBe('live');
    expect(cap.detail.willAutoConfirm).toBe(false);
    expect((cap.attention ?? []).map((a: any) => a.code)).toContain('calendar_reauth_required');
    expect((cap.detail.calendar as any).state).toBe('reauth_required');
  });

  it('empty weeklyHours business_hours ⇒ live, willAutoConfirm false, attention includes availability_hours_missing', async () => {
    const { tenantId, botId } = await provision({ tier: 'pro' });
    await seedService(tenantId, botId, { bookingMode: 'auto' });
    // hasRule=true (live mirrors rule existence) but no effective hours.
    await seedRule(tenantId, botId, { availabilityMode: 'business_hours', weeklyHours: {} });
    await seedCalendar(tenantId, botId, { status: 'active', reauthRequired: false });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    const cap = bookingOf(res.body);
    expect(cap.state).toBe('live');
    expect(cap.detail.willAutoConfirm).toBe(false);
    expect((cap.attention ?? []).map((a: any) => a.code)).toContain('availability_hours_missing');
  });
});

describe('GET /bots/readiness (real DB) — serving-state overall flags', () => {
  it('paused bot ⇒ overall.botPaused true (capabilities still computed)', async () => {
    const { tenantId, botId } = await provision({ tier: 'pro', botStatus: 'paused' });
    await seedService(tenantId, botId, { bookingMode: 'request' });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    expect(res.body.data.overall.botPaused).toBe(true);
    bookingOf(res.body); // booking still surfaced while paused (owner mid-setup)
  });

  it('ai.enabled false ⇒ overall.aiEnabled false', async () => {
    await provision({ tier: 'pro', aiEnabled: false });
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    expect(res.body.data.overall.aiEnabled).toBe(false);
  });
});

/**
 * The production incident this endpoint now catches: a Pro tenant's bot bound a
 * template whose `selected_skill_ids` was `["booking"]`. The agent's template
 * tool-gate drops the tools of every ACTIVE skill a template did not select, so
 * `capture_lead` was stripped — the tenant paid for Leads, `leadCapture` said
 * true, and their bot never captured one. Nothing surfaced it.
 *
 * Real rows here: BotTemplate + a published BotTemplateVersion with the exact
 * selection, bound to the bot, against the real Pro entitlement map.
 */
describe('GET /bots/readiness (real DB) — entitled but undelivered skills', () => {
  let keyN = 0;

  /** Seed a globally-available template whose published v1 selects `skills`, and bind it. */
  async function bindTemplateSelecting(botId: string, skills: string[]): Promise<void> {
    const tpl = await AppDataSource.getRepository(BotTemplate).save({
      key: `coverage-tmpl-${++keyN}-${Math.random().toString(36).slice(2, 8)}`,
      displayName: 'Coverage',
      availableToAllTenants: true,
      status: 'active',
    });
    await AppDataSource.getRepository(BotTemplateVersion).save({
      templateId: tpl.id,
      version: 1,
      body: 'body',
      status: 'published',
      expectedModules: [],
      selectedSkillIds: skills,
    });
    await AppDataSource.getRepository(Bot).update(
      { id: botId },
      { templateId: tpl.id, templateVersion: 'latest', templateBindings: [{ templateId: tpl.id, version: 'latest' }] },
    );
  }

  beforeEach(() => {
    // The tool-gate this mirrors only runs behind the composable flag.
    process.env.COMPOSABLE_TEMPLATES_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.COMPOSABLE_TEMPLATES_ENABLED;
  });

  it('pro bot bound to a booking-only template ⇒ the paid-for lead_capture skill is reported', async () => {
    const { botId } = await provision({ tier: 'pro' });
    await bindTemplateSelecting(botId, ['booking']);
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    expect(res.body.data.unselectedEntitledSkills).toContainEqual({
      feature: 'leadCapture',
      skillId: 'lead_capture',
      skillName: 'Lead capture',
    });
  });

  it('a template that selects lead_capture ⇒ not reported', async () => {
    const { botId } = await provision({ tier: 'pro' });
    await bindTemplateSelecting(botId, ['booking', 'lead_capture', 'handoff']);
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    expect(res.body.data.unselectedEntitledSkills).toEqual([]);
  });

  it('essential tenant (no bookings entitlement) ⇒ booking is NOT reported', async () => {
    // Omitting a skill the plan never included is not a misconfiguration. Essential
    // has leadCapture + handoff but not bookings.
    const { botId } = await provision({ tier: 'essential' });
    await bindTemplateSelecting(botId, ['lead_capture', 'handoff']);
    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBe(200);
    expect(res.body.data.unselectedEntitledSkills).toEqual([]);
  });
});

describe('GET /bots/readiness (real DB) — fail-closed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a contributor lookup error ⇒ 5xx, no partial capabilities', async () => {
    await provision({ tier: 'pro' });
    // Simulate a DB/lookup failure inside the booking contributor by making the
    // ServiceType repository throw. The endpoint must fail the WHOLE request
    // (5xx) — never a partial `capabilities[]`, never a not_ready painted from a
    // swallowed exception.
    const realGetRepo = AppDataSource.getRepository.bind(AppDataSource);
    vi.spyOn(AppDataSource, 'getRepository').mockImplementation((entity: any) => {
      if (entity === ServiceType) {
        return { find: async () => { throw new Error('simulated lookup failure'); } } as any;
      }
      return realGetRepo(entity);
    });

    const res = await request(app).get(READINESS_URL);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.data).toBeUndefined();
  });
});

/**
 * Answering readiness. Each case is an incident that reached a real customer:
 * a bot with nothing to answer from told a prospect its services were
 * "[not specified]", while the portal showed it configured and its document
 * "Indexed".
 */
describe('GET /bots/readiness — answering', () => {
  const answeringOf = (body: any) =>
    body.data.capabilities.find((c: any) => c.capability === 'answering');

  const attachKb = async (tenantId: string, botId: string) => {
    const kb = await AppDataSource.query(
      `INSERT INTO knowledge_bases ("tenantId", "botId", status) VALUES ($1,$2,'active') RETURNING id`,
      [tenantId, botId],
    );
    await AppDataSource.query(
      `INSERT INTO chatbot_bot_knowledge_bases (bot_id, knowledge_base_id, tenant_id) VALUES ($1,$2,$3)`,
      [botId, kb[0].id, tenantId],
    );
    return kb[0].id as string;
  };

  const addDoc = (tenantId: string, kbId: string, status: string, chunkCount: number) =>
    AppDataSource.query(
      `INSERT INTO knowledge_documents ("tenantId","knowledgeBaseId",title,"sourceContent",type,status,"chunkCount")
       VALUES ($1,$2,'Doc','body','text',$3,$4)`,
      [tenantId, kbId, status, chunkCount],
    );

  it('is not_ready when the bot has nothing to answer from', async () => {
    await provision();
    const res = await request(app).get(READINESS_URL);
    const a = answeringOf(res.body);
    expect(a.state).toBe('not_ready');
    expect(a.missingSteps.map((m: any) => m.id)).toContain('no_knowledge');
  });

  it('is still not_ready when a document exists but has no chunks yet', async () => {
    // "Indexed" is the document's status; chunks are what retrieval reads. This
    // gap is why a doc can look uploaded and be unanswerable.
    const { tenantId, botId } = await provision();
    const kb = await attachKb(tenantId, botId);
    await addDoc(tenantId, kb, 'indexed', 0);

    const a = answeringOf((await request(app).get(READINESS_URL)).body);
    expect(a.state).toBe('not_ready');
    expect(a.detail.retrievableDocuments).toBe(0);
  });

  it('goes live once a document is actually retrievable', async () => {
    const { tenantId, botId } = await provision();
    const kb = await attachKb(tenantId, botId);
    await addDoc(tenantId, kb, 'indexed', 3);

    const a = answeringOf((await request(app).get(READINESS_URL)).body);
    expect(a.state).toBe('live');
    expect(a.missingSteps).toEqual([]);
    expect(a.detail.retrievableDocuments).toBe(1);
  });

  it('flags a document that failed to index, which will never be answered from', async () => {
    const { tenantId, botId } = await provision();
    const kb = await attachKb(tenantId, botId);
    await addDoc(tenantId, kb, 'indexed', 2);
    await addDoc(tenantId, kb, 'failed', 0);

    const a = answeringOf((await request(app).get(READINESS_URL)).body);
    expect(a.state).toBe('live');
    expect(a.attention.map((x: any) => x.code)).toContain('documents_failed');
  });

  it('reports AI being switched off as a missing step', async () => {
    await provision({ aiEnabled: false });
    const a = answeringOf((await request(app).get(READINESS_URL)).body);
    expect(a.missingSteps.map((m: any) => m.id)).toContain('ai_disabled');
  });
});

/**
 * Channel readiness answers "which bot replies on WhatsApp, and is it the one I
 * have been editing?" — unanswerable in the UI when a tenant had two ACTIVE bots
 * both named "Valyro", and edits went to the wrong one for days.
 */
describe('GET /bots/readiness — channel', () => {
  const channelsOf = (body: any) =>
    body.data.capabilities.filter((c: any) => c.capability === 'channel');

  const addConnection = (tenantId: string, channel: string, botId: string | null, status = 'active') =>
    AppDataSource.query(
      `INSERT INTO channel_connections ("tenantId", channel, status, "botId", label)
       VALUES ($1,$2,$3,$4,'L') RETURNING id`,
      [tenantId, channel, status, botId],
    );

  it('surfaces a channel that follows the default bot, and says so', async () => {
    // botId null is not "unrouted" — it follows whichever bot is default, so
    // changing the default silently repoints a live channel.
    const { tenantId } = await provision();
    await addConnection(tenantId, 'whatsapp', null);

    const chans = channelsOf((await request(app).get(READINESS_URL)).body);
    expect(chans).toHaveLength(1);
    expect(chans[0].detail.routedExplicitly).toBe(false);
    expect(chans[0].attention.map((a: any) => a.code)).toContain('follows_default_bot');
  });

  it('is live for an explicitly routed, active channel on an AI-enabled bot', async () => {
    const { tenantId, botId } = await provision();
    await addConnection(tenantId, 'whatsapp', botId);

    const chans = channelsOf((await request(app).get(READINESS_URL)).body);
    expect(chans[0].state).toBe('live');
    expect(chans[0].detail.routedExplicitly).toBe(true);
  });

  it('is not_ready when the channel routes to a bot whose AI is off', async () => {
    const { tenantId, botId } = await provision({ aiEnabled: false });
    await addConnection(tenantId, 'whatsapp', botId);

    const chans = channelsOf((await request(app).get(READINESS_URL)).body);
    expect(chans[0].state).toBe('not_ready');
    expect(chans[0].missingSteps.map((m: any) => m.id)).toContain('target_bot_ai_off');
  });

  it('is not_ready when the connection itself is inactive', async () => {
    const { tenantId, botId } = await provision();
    await addConnection(tenantId, 'whatsapp', botId, 'pending_setup');

    const chans = channelsOf((await request(app).get(READINESS_URL)).body);
    expect(chans[0].missingSteps.map((m: any) => m.id)).toContain('connection_inactive');
  });

  it('warns when another active bot shares this bot’s name', async () => {
    const { tenantId, botId } = await provision();
    await addConnection(tenantId, 'whatsapp', botId);
    const me = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: botId } });
    await AppDataSource.getRepository(Bot).save(
      AppDataSource.getRepository(Bot).create({
        tenantId, name: me.name, status: 'active', isDefault: false,
        publicKey: 'bk_twin_' + Math.random().toString(36).slice(2, 10),
        settings: { ai: { enabled: true } } as Bot['settings'],
      }),
    );

    const chans = channelsOf((await request(app).get(READINESS_URL)).body);
    expect(chans[0].attention.map((a: any) => a.code)).toContain('ambiguous_bot_name');
  });

  it('emits nothing for a tenant with no channels', async () => {
    await provision();
    expect(channelsOf((await request(app).get(READINESS_URL)).body)).toEqual([]);
  });
});
