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
import { invalidateEntitlements } from '../../billing/entitlements';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const CONFIG_URL = '/api/v1/scheduler/config';

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
      publicKey: `pk-${Math.random().toString(36).slice(2, 10)}`,
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
