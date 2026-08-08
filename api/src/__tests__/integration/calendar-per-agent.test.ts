/**
 * #86 — disconnecting one Agent's calendar must not touch another's.
 *
 * THIS IS THE PATH THE WHOLE TICKET WAS WIDENED FOR. The connect and disconnect controls live on
 * the booking settings screen, beside the Agent picker. Before this change those endpoints
 * resolved the tenant's DEFAULT Agent, so an owner could select Agent B, be shown Agent A's
 * connection, press Disconnect, and lose A's calendar while the screen said B — A's bookings
 * stop syncing to a calendar and nothing anywhere says why.
 *
 * WHAT THESE GUARD, EXACTLY: which Agent a disconnect acts on, and who is allowed to name one.
 * The cross-tenant refusal goes through the real router and error handler rather than a
 * controller mock, because a 404 that is really a 500 passes every mock-level assertion.
 *
 * WHAT THEY DO NOT GUARD, AND CANNOT HERE: that `rekeyBotBookings` moves the right Agent's
 * bookings. Disconnecting rewrites `calendar_key` on that Agent's future bookings, and a rekey
 * aimed at the wrong Agent is #86's failure in its most damaging form. It is unassertable in
 * this environment: the rekey selects on `upper(blocked_range) > now()`, the `Booking` entity
 * does not map that column, and the test schema is built by `synchronize()` — so the column
 * does not exist, the SELECT errors, and `disconnect` swallows it in the `.catch()` that makes
 * the rekey non-fatal. **The rekey therefore no-ops in every test in this repository**, which is
 * worth knowing well beyond this file. An attempted assertion here would have passed against a
 * rekey that never ran, which is worse than the gap.
 *
 * WHAT THEY DO NOT GUARD: that the OAuth grant is actually revoked at Google. `disconnect`
 * catches a failed revoke and continues by design, and the fixture below carries an
 * undecryptable token, so a disconnect that never reached Google would still pass here. That is
 * a real gap and it belongs to whoever owns the revoke path — naming it beats implying these
 * tests cover it.
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
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import { invalidateEntitlements } from '../../billing/entitlements';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const DISCONNECT = '/api/v1/integrations/google/disconnect';
const STATUS = '/api/v1/integrations/google/status';

let tenant: Tenant;
let anchorId: string;
let secondId: string;

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

/** An active connection for one Agent. Enough of one for the disconnect path to find it. */
async function seedCredential(t: Tenant, botId: string) {
  const repo = AppDataSource.getRepository(CalendarCredential);
  return repo.save(
    repo.create({
      tenantId: t.id,
      botId,
      provider: 'google',
      status: 'active',
      accountEmail: `owner+${botId.slice(0, 6)}@example.com`,
      accessTokenEnc: 'enc:test',
      refreshTokenEnc: 'enc:test',
      calendarId: 'primary',
      tokenExpiry: new Date(Date.now() + 3_600_000),
    })
  );
}

const activeFor = (botId: string) =>
  AppDataSource.getRepository(CalendarCredential).findOne({ where: { botId, status: 'active' } });

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

describe('calendar disconnect — one Agent at a time', () => {
  it('disconnects the NAMED Agent and leaves the default one connected', async () => {
    await seedCredential(tenant, anchorId);
    await seedCredential(tenant, secondId);

    const res = await request(app).delete(`${DISCONNECT}?botId=${secondId}`);
    expect(res.status).toBe(200);

    expect(await activeFor(secondId)).toBeNull();
    // The whole point. Before #86 this assertion would have failed the other way round: the
    // request said "the second Agent" and the server disconnected the default one.
    expect(await activeFor(anchorId)).not.toBeNull();
  });

  it('disconnects the DEFAULT Agent when none is named', async () => {
    // The unchanged behaviour a single-Agent tenant relies on.
    await seedCredential(tenant, anchorId);
    await seedCredential(tenant, secondId);

    const res = await request(app).delete(DISCONNECT);
    expect(res.status).toBe(200);

    expect(await activeFor(anchorId)).toBeNull();
    expect(await activeFor(secondId)).not.toBeNull();
  });
});

describe('calendar endpoints — an Agent that is not yours', () => {
  it('refuses to disconnect another tenant’s Agent, and leaves it connected', async () => {
    const other = await createTestTenant({ tier: 'pro' });
    const otherAnchor = await createTestAnchorBot(other);
    await seedCredential(other, otherAnchor.id);

    const res = await request(app).delete(`${DISCONNECT}?botId=${otherAnchor.id}`);
    // 404, not 500 — the translation in `resolveTargetBot`. And not 200: a credential belonging
    // to a different tenant must survive the attempt.
    expect(res.status).toBe(404);
    expect(await activeFor(otherAnchor.id)).not.toBeNull();
  });

  it('refuses to READ another tenant’s connection status', async () => {
    const other = await createTestTenant({ tier: 'pro' });
    const otherAnchor = await createTestAnchorBot(other);

    const res = await request(app).get(`${STATUS}?botId=${otherAnchor.id}`);
    expect(res.status).toBe(404);
  });

  it('400s on a malformed Agent id rather than acting on the default one', async () => {
    // The dangerous default: a validation failure that quietly falls back to the anchor would
    // disconnect the wrong calendar on a typo.
    await seedCredential(tenant, anchorId);

    const res = await request(app).delete(`${DISCONNECT}?botId=not-a-uuid`);
    expect(res.status).toBe(400);
    expect(await activeFor(anchorId)).not.toBeNull();
  });
});
