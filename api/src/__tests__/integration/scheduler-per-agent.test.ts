/**
 * #86 — the scheduler endpoints act on a NAMED Agent, and refuse one that is not yours.
 *
 * THROUGH THE REAL ROUTER AND THE REAL ERROR HANDLER, not the controller in isolation. That is
 * the whole point of this file: `getOwnedBot` throws `BotNotFoundConfigError`, which the global
 * handler does not recognise and would report as a **500**. A controller-level mock asserting
 * "it threw" passes either way, so an authorisation check that answers 500 instead of 404 would
 * look perfectly tested. Only a request through the stack can tell them apart.
 *
 * The other half is quieter and matters just as much: a tenant with ONE Agent sends no id, and
 * every one of these endpoints has to behave exactly as it did before this existed.
 */
import { randomBytes } from 'crypto';
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
import { BookingSettings } from '../../database/entities/BookingSettings';
import { ServiceType } from '../../database/entities/ServiceType';
import { invalidateEntitlements } from '../../billing/entitlements';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const CONFIG_URL = '/api/v1/scheduler/config';
const SERVICES_URL = '/api/v1/scheduler/services';

let tenant: Tenant;
let anchorId: string;
let secondId: string;

/** A non-anchor Agent in the same tenant — the population this ticket exists for. */
async function seedSecondAgent(t: Tenant): Promise<string> {
  const repo = AppDataSource.getRepository(Bot);
  const bot = await repo.save(
    repo.create({
      tenantId: t.id,
      name: 'Second driver',
      publicKey: `pk-${randomBytes(4).toString('hex')}`,
      status: 'active',
      isDefault: false,
      settings: {} as Bot['settings'],
    })
  );
  return bot.id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  const anchor = await createTestAnchorBot(tenant);
  anchorId = anchor.id;
  secondId = await seedSecondAgent(tenant);
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });
  invalidateEntitlements(tenant.id);
});

describe('scheduler config — which Agent', () => {
  it('answers for the ANCHOR when no Agent is named', async () => {
    // A single-Agent tenant's portal sends nothing. This is the "byte-identical" guarantee.
    const res = await request(app).get(CONFIG_URL);
    expect(res.status).toBe(200);
    expect(res.body.data.agent.id).toBe(anchorId);
  });

  it('answers for the Agent that was named', async () => {
    const res = await request(app).get(`${CONFIG_URL}?botId=${secondId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.agent.id).toBe(secondId);
  });

  it('writes the named Agent’s row, creating it on first write', async () => {
    // The second Agent has no `chatbot_booking_settings` row at all until now — the upsert is
    // ON CONFLICT (bot_id), so this is the first INSERT rather than an UPDATE of nothing.
    const before = await AppDataSource.getRepository(BookingSettings).findOne({ where: { botId: secondId } });
    expect(before).toBeNull();

    const res = await request(app).put(`${CONFIG_URL}?botId=${secondId}`).send({ bookingsPaused: true });
    expect(res.status).toBe(200);

    const after = await AppDataSource.getRepository(BookingSettings).findOne({ where: { botId: secondId } });
    expect(after?.bookingsPaused).toBe(true);
    // And the ANCHOR is untouched — the failure this ticket is about runs in that direction.
    const anchorRow = await AppDataSource.getRepository(BookingSettings).findOne({ where: { botId: anchorId } });
    expect(anchorRow?.bookingsPaused ?? false).toBe(false);
  });

  it('returns the configuration of the Agent it WROTE, not the anchor’s', async () => {
    // `readConfig` used to re-resolve the anchor, so a successful write to Agent B answered
    // with Agent A's configuration and the portal cached it under B's key.
    const res = await request(app).put(`${CONFIG_URL}?botId=${secondId}`).send({ bookingsPaused: true });
    expect(res.body.data.agent.id).toBe(secondId);
  });
});

describe('scheduler config — an Agent that is not yours', () => {
  it('404s on another tenant’s Agent, and does not leak that it exists', async () => {
    const other = await createTestTenant({ tier: 'pro' });
    const otherAnchor = await createTestAnchorBot(other);

    const res = await request(app).get(`${CONFIG_URL}?botId=${otherAnchor.id}`);
    // 404 and NOT 500. `getOwnedBot` throws a config error the global handler does not know;
    // without the translation in `resolveTargetBot` this is an internal server error, which
    // both fails the AC and tells a prober that something went wrong rather than nothing exists.
    expect(res.status).toBe(404);
  });

  it('404s on a well-formed id that names nothing', async () => {
    const res = await request(app).get(`${CONFIG_URL}?botId=00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(404);
  });

  it('400s on a malformed id rather than 404ing about an Agent that could not exist', async () => {
    const res = await request(app).get(`${CONFIG_URL}?botId=not-a-uuid`);
    expect(res.status).toBe(400);
  });

  it('refuses to WRITE another tenant’s Agent', async () => {
    const other = await createTestTenant({ tier: 'pro' });
    const otherAnchor = await createTestAnchorBot(other);

    const res = await request(app).put(`${CONFIG_URL}?botId=${otherAnchor.id}`).send({ bookingsPaused: true });
    expect(res.status).toBe(404);

    const row = await AppDataSource.getRepository(BookingSettings).findOne({ where: { botId: otherAnchor.id } });
    expect(row).toBeNull();
  });
});

/**
 * EVERY endpoint, not one representative.
 *
 * All eight resolve the Agent through the same `resolveTargetBot`, and the config route above
 * already proves that helper answers 404 rather than 500 through the real stack. What these
 * cover is different and is the reason the plan asked for them by name: that each of the other
 * seven actually CALLS it. A call site that forgot would not be a coverage gap — it would be a
 * cross-tenant read or write, on a route whose own tests were green.
 */
describe('every scheduler endpoint refuses an Agent outside the tenant', () => {
  let foreignBotId: string;

  beforeEach(async () => {
    const other = await createTestTenant({ tier: 'pro' });
    foreignBotId = (await createTestAnchorBot(other)).id;
  });

  const routes: Array<[string, () => Promise<{ status: number; body?: any }>]> = [
    ['GET /config', () => request(app).get(`${CONFIG_URL}?botId=${foreignBotId}`)],
    ['PUT /config', () => request(app).put(`${CONFIG_URL}?botId=${foreignBotId}`).send({ bookingsPaused: true })],
    ['GET /services', () => request(app).get(`${SERVICES_URL}?botId=${foreignBotId}`)],
    ['POST /services', () =>
      request(app).post(`${SERVICES_URL}?botId=${foreignBotId}`).send({ name: 'Intrusion', durationMin: 30 })],
    ['PUT /services/reorder', () =>
      request(app).put(`${SERVICES_URL}/reorder?botId=${foreignBotId}`).send({ serviceIds: [] })],
    ['PUT /services/:id', () =>
      request(app)
        .put(`${SERVICES_URL}/00000000-0000-4000-8000-000000000001?botId=${foreignBotId}`)
        .send({ name: 'Intrusion' })],
    ['DELETE /services/:id', () =>
      request(app).delete(`${SERVICES_URL}/00000000-0000-4000-8000-000000000001?botId=${foreignBotId}`)],
    // A REAL preset key. `applyPreset` resolves the preset before the Agent, so an invented key
    // 404s as PRESET_NOT_FOUND and the test passes without ever reaching the check it exists to
    // make — which is exactly what it did until the error-code assertion below caught it.
    ['POST /presets/:key/apply', () =>
      request(app).post(`/api/v1/scheduler/presets/barber/apply?botId=${foreignBotId}`).send({})],
  ];

  it.each(routes)('%s refuses another tenant’s Agent', async (_label, call) => {
    const res = await call();
    expect(res.status).toBe(404);
    // THE CODE, not just the status. Two of these address a service id that does not exist, so
    // a 404 alone would also be satisfied by `SERVICE_NOT_FOUND` — which is what they would
    // answer if the Agent check were removed entirely, or moved after the service lookup. Only
    // `NOT_FOUND` proves the refusal came from `resolveTargetBot`.
    expect(res.body?.error?.code ?? res.body?.code).toBe('NOT_FOUND');
  });

  it('writes nothing to the foreign Agent while being refused', async () => {
    await request(app).post(`${SERVICES_URL}?botId=${foreignBotId}`).send({ name: 'Intrusion', durationMin: 30 });
    const leaked = await AppDataSource.getRepository(ServiceType).findOne({ where: { botId: foreignBotId } });
    expect(leaked).toBeNull();
  });
});

/**
 * Two Agents, two catalogues.
 *
 * The end-to-end statement of what #86 is for, and the one the issue says the whole change is
 * pointless without: a service added while Agent B is selected belongs to B and is absent from
 * A. The portal missed passing the Agent here for a whole commit, so this is the assertion that
 * would have caught it.
 */
describe('service catalogues are separate per Agent', () => {
  it('keeps a service created for one Agent out of the other’s catalogue', async () => {
    const created = await request(app)
      .post(`${SERVICES_URL}?botId=${secondId}`)
      .send({ name: 'Emergency call-out', durationMin: 60 });
    expect(created.status).toBeGreaterThanOrEqual(200);
    expect(created.status).toBeLessThan(300);

    const second = await request(app).get(`${SERVICES_URL}?botId=${secondId}`);
    const anchor = await request(app).get(SERVICES_URL);

    const namesOf = (res: { body: { data?: { services?: Array<{ name: string }> } } }) =>
      (res.body.data?.services ?? []).map((svc) => svc.name);
    expect(namesOf(second)).toContain('Emergency call-out');
    expect(namesOf(anchor)).not.toContain('Emergency call-out');
  });
});
