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

/** The single booking result, asserting exactly one capability is surfaced. */
function bookingOf(body: any) {
  expect(body.data.capabilities).toHaveLength(1);
  const cap = body.data.capabilities[0];
  expect(cap.capability).toBe('booking');
  return cap;
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
    expect(res.body.data.capabilities).toEqual([]);
    expect(res.body.data.overall).toMatchObject({
      applicableCount: 0,
      liveCount: 0,
      allLive: false,
      nothingApplicable: true,
    });
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
