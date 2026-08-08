/**
 * #87 - a second Agent's appointments were invisible to the owner.
 *
 * `adminListBookings` resolved the tenant's DEFAULT Agent and filtered to it, so in a tenant
 * with more than one Agent the second one's appointments did not appear on the Bookings page at
 * all. They existed, held time, sent confirmations and wrote calendar invites, and the owner
 * could not see, cancel, reschedule, accept or decline any of them.
 *
 * THE FILE ALSO CHECKS WHAT WAS ONLY ASSUMED. #86's first plan claimed these endpoints already
 * resolved the Agent from the booking; a review found they did not, which is why #87 exists. The
 * mutations were then BELIEVED to be per-Agent through `buildAdminContext` - believed, not
 * shown - so that is asserted here rather than repeated as a claim.
 *
 * Through the real router and the real error handler, for the reason `scheduler-per-agent`
 * gives: `getOwnedBot` throws `BotNotFoundConfigError`, which the global handler would report as
 * a 500, and a controller-level mock cannot tell a 404 from one.
 */
import { randomBytes, randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { ServiceType } from '../../database/entities/ServiceType';
import { invalidateEntitlements } from '../../billing/entitlements';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const LIST = '/api/v1/scheduler/bookings';

let tenant: Tenant;
let anchorId: string;
let secondId: string;

async function seedAgent(t: Tenant, name: string): Promise<string> {
  const repo = AppDataSource.getRepository(Bot);
  const bot = await repo.save(
    repo.create({
      tenantId: t.id,
      name,
      publicKey: `pk-${randomBytes(4).toString('hex')}`,
      status: 'active',
      isDefault: false,
      settings: {} as Bot['settings'],
    })
  );
  // Cancel and decline go through the provider, which loads the Agent's availability rule and
  // refuses with BOOKING_NOT_CONFIGURED without one. An Agent taking real bookings always has
  // it; seeding it here is fixture completeness, not a workaround.
  // Cancel and decline go through the provider, which loads the Agent's availability rule and
  // resolves the booking's service. Neither is optional for an Agent that takes real bookings,
  // so seeding both is fixture completeness rather than a workaround for the assertion.
  const rules = AppDataSource.getRepository(AvailabilityRule);
  await rules.save(rules.create({ tenantId: t.id, botId: bot.id, timezone: 'Europe/Brussels' }));
  const services = AppDataSource.getRepository(ServiceType);
  const service = await services.save(
    services.create({
      tenantId: t.id,
      botId: bot.id,
      name: `${name} visit`,
      slug: `svc-${randomBytes(4).toString('hex')}`,
      durationMin: 60,
      isActive: true,
      onlineBookable: true,
    })
  );
  serviceByAgent.set(bot.id, service.id);
  return bot.id;
}

/** The service each seeded Agent offers, so a booking can name one. */
const serviceByAgent = new Map<string, string>();

/** A confirmed appointment in the future, written the way the engine writes them. */
async function seedBooking(input: {
  botId: string;
  tenantId?: string;
  hoursFromNow?: number;
  status?: 'confirmed' | 'request_created';
  attendeeName?: string;
}): Promise<string> {
  const id = randomUUID();
  const start = new Date(Date.now() + (input.hoursFromNow ?? 24) * 3_600_000);
  const end = new Date(start.getTime() + 3_600_000);
  await AppDataSource.query(
    `INSERT INTO chatbot_bookings
       (id, tenant_id, bot_id, provider, status, start_utc, end_utc, calendar_key,
        blocked_range, ics_uid, attendee_name, event_type_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'internal', $4, $5, $6, $7, tstzrange($5, $6, '[)'), $8, $9, $10, now(), now())`,
    [
      id,
      input.tenantId ?? tenant.id,
      input.botId,
      input.status ?? 'confirmed',
      start,
      end,
      `bot:${input.botId}`,
      `uid-${id}`,
      input.attendeeName ?? 'Someone',
      serviceByAgent.get(input.botId) ?? null,
    ]
  );
  return id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  anchorId = (await createTestAnchorBot(tenant)).id;
  secondId = await seedAgent(tenant, 'Second driver');
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });
  invalidateEntitlements(tenant.id);
});

describe('the appointment list', () => {
  it('shows EVERY Agent\'s appointments, which is the bug', async () => {
    const mine = await seedBooking({ botId: anchorId });
    const theirs = await seedBooking({ botId: secondId, hoursFromNow: 26 });

    const res = await request(app).get(`${LIST}?scope=upcoming`);
    expect(res.status).toBe(200);
    const ids = res.body.data.bookings.map((b: { id: string }) => b.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(theirs);
    expect(res.body.data.total).toBe(2);
  });

  it('names the Agent on each row, so a mixed page can be read', async () => {
    await seedBooking({ botId: secondId });
    const res = await request(app).get(`${LIST}?scope=upcoming`);
    const row = res.body.data.bookings.find((b: { agentId: string }) => b.agentId === secondId);
    expect(row.agentName).toBe('Second driver');
  });

  it('narrows to ONE Agent when asked', async () => {
    const mine = await seedBooking({ botId: anchorId });
    await seedBooking({ botId: secondId, hoursFromNow: 26 });

    const res = await request(app).get(`${LIST}?scope=upcoming&botId=${anchorId}`);
    expect(res.body.data.bookings.map((b: { id: string }) => b.id)).toEqual([mine]);
    expect(res.body.data.total).toBe(1);
  });

  it('refuses another tenant\'s Agent with a 404, not an empty list', async () => {
    // An empty list reads as "no appointments" and would hide the refusal. The status is the
    // assertion, because `getOwnedBot` throws an error the global handler reports as 500 unless
    // it is mapped - and a 500 would satisfy any "it did not return data" check.
    const other = await createTestTenant({ tier: 'pro' });
    const foreign = await seedAgent(other, 'Not yours');

    const res = await request(app).get(`${LIST}?scope=upcoming&botId=${foreign}`);
    expect(res.status).toBe(404);
  });

  it('still keeps tenants apart when no Agent is named', async () => {
    // Widening from "the anchor" to "every Agent" must widen within the TENANT only. This is
    // the assertion that would fail if the botId filter had simply been deleted.
    const other = await createTestTenant({ tier: 'pro' });
    const otherAnchor = (await createTestAnchorBot(other)).id;
    await seedBooking({ botId: otherAnchor, tenantId: other.id });
    const mine = await seedBooking({ botId: anchorId });

    const res = await request(app).get(`${LIST}?scope=upcoming`);
    expect(res.body.data.bookings.map((b: { id: string }) => b.id)).toEqual([mine]);
  });

  it('covers requests from every Agent too', async () => {
    // The Requests tab is where an owner ACCEPTS work. A captured request nobody can see is a
    // customer who asked for an appointment and was never answered.
    const theirs = await seedBooking({ botId: secondId, status: 'request_created' });
    const res = await request(app).get(`${LIST}?scope=requests`);
    expect(res.body.data.bookings.map((b: { id: string }) => b.id)).toContain(theirs);
  });
});

describe('acting on a non-default Agent\'s appointment', () => {
  /**
   * #86's plan asserted this and was wrong about the reads. The mutations resolve the Agent
   * through `buildAdminContext`, which calls `getOwnedBot(booking.botId, tenantId)` - so they
   * were already right. Asserted rather than restated, because that is exactly the kind of
   * claim that proved false last time.
   */
  it('cancels one', async () => {
    const theirs = await seedBooking({ botId: secondId });
    const res = await request(app).post(`/api/v1/scheduler/bookings/${theirs}/cancel`).send({ reason: 'test' });
    expect([200, 204]).toContain(res.status);

    const rows = await AppDataSource.query(`SELECT status FROM chatbot_bookings WHERE id = $1`, [theirs]);
    expect(rows[0].status).toBe('cancelled');
  });

  it('declines one of their requests', async () => {
    const theirs = await seedBooking({ botId: secondId, status: 'request_created' });
    const res = await request(app).post(`/api/v1/scheduler/bookings/${theirs}/decline`).send({ reason: 'test' });
    expect([200, 204]).toContain(res.status);

    const rows = await AppDataSource.query(`SELECT status FROM chatbot_bookings WHERE id = $1`, [theirs]);
    expect(rows[0].status).toBe('cancelled');
  });
});
