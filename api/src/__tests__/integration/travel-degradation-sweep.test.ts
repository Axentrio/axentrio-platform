/**
 * #68 AC-5 - the failure has to travel the whole way to somebody who can act.
 *
 * Calling the recorder and asserting a counter moved proves the detector and nothing else. The
 * defects live in the wiring: which Agents the sweep selects, whether the itinerary key resolves,
 * whether a notification row actually lands, and whether a repeat run says it twice. So this
 * drives the REAL sweep against the REAL database and the REAL notification service, and asserts
 * on the row a tenant would see.
 *
 * SCOPE: the sweep and the notification only. The cross-instance coordination this feature also
 * depends on - the incident latch, the probe lease, the ordering of a success against a failure -
 * is asserted against REAL REDIS in `travel-degradation-redis.test.ts`, because a double cannot
 * establish it: the double is the part being trusted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';

vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
// The socket emit is a side effect of a successful write, not the thing under test, and its real
// module drags the whole websocket graph into this file.
vi.mock('../../websocket/socket.handler', () => ({ emitToTenantAgents: vi.fn() }));

import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import { Notification } from '../../database/entities/Notification';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import { reconcileSharedItineraries } from '../../booking/travel/travel-health';
import { notifyTenantCapExhausted } from '../../booking/travel/degradation-notify';
import type { Tenant } from '../../database/entities/Tenant';

let tenant: Tenant;
let anchorId: string;

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
  return bot.id;
}

/**
 * A connected calendar. `calendarId` is the identity the key derives from, so passing the same
 * one to two Agents is what "two Agents, one diary" means in the database.
 */
async function seedCredential(t: Tenant, botId: string, calendarId: string) {
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
      calendarId,
      tokenExpiry: new Date(Date.now() + 3_600_000),
    })
  );
}

async function enableTravel(t: Tenant, botId: string) {
  const repo = AppDataSource.getRepository(BookingSettings);
  return repo.save(repo.create({ tenantId: t.id, botId, travelTimeEnabled: true }));
}

const notificationsOfType = (type: string) =>
  AppDataSource.getRepository(Notification).find({ where: { tenantId: tenant.id, type } });

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  const anchor = await createTestAnchorBot(tenant);
  anchorId = anchor.id;
  // `createForTenant` resolves recipients from ACTIVE USERS and returns early when there are
  // none, so without this every assertion below would pass against zero notifications.
  await createTestUser(tenant.id, { role: 'admin' });
});

describe('the sweep finds Agents that were ALREADY sharing a diary', () => {
  it('tells the tenant, naming the Agent', async () => {
    // The half a rekey-triggered warning can never reach: this state predates the monitor, and
    // for those tenants travel has been inert for as long as it has been true.
    const second = await seedAgent(tenant, 'Second driver');
    await seedCredential(tenant, anchorId, 'shared-diary@example.com');
    await seedCredential(tenant, second, 'shared-diary@example.com');
    await enableTravel(tenant, second);

    expect(await reconcileSharedItineraries()).toBe(1);

    const notes = await notificationsOfType('travel_shared_itinerary');
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/Second driver/);
    // The fix is a calendar, not a payment - the alert has to say which.
    expect(notes[0].message).toMatch(/own calendar/i);
  });

  it('says it once, not once per daily sweep', async () => {
    const second = await seedAgent(tenant, 'Second driver');
    await seedCredential(tenant, anchorId, 'shared-diary@example.com');
    await seedCredential(tenant, second, 'shared-diary@example.com');
    await enableTravel(tenant, second);

    await reconcileSharedItineraries();
    await reconcileSharedItineraries();
    await reconcileSharedItineraries();

    expect(await notificationsOfType('travel_shared_itinerary')).toHaveLength(1);
  });

  it('stays quiet when each Agent has its own diary', async () => {
    const second = await seedAgent(tenant, 'Second driver');
    await seedCredential(tenant, anchorId, 'anchor@example.com');
    await seedCredential(tenant, second, 'second@example.com');
    await enableTravel(tenant, second);

    expect(await reconcileSharedItineraries()).toBe(0);
    expect(await notificationsOfType('travel_shared_itinerary')).toHaveLength(0);
  });

  it('ignores an Agent that shares a diary with travel switched OFF', async () => {
    // Nothing is degraded - the feature was never running for them. An alert here would be the
    // noise that teaches an owner to ignore the real one.
    const second = await seedAgent(tenant, 'Second driver');
    await seedCredential(tenant, anchorId, 'shared-diary@example.com');
    await seedCredential(tenant, second, 'shared-diary@example.com');
    // A settings row that exists and is OFF, not an absent one. With no row the sweep finds
    // nothing whatever its filter says, and this would pass against a sweep that had dropped the
    // `travelTimeEnabled` predicate entirely.
    const repo = AppDataSource.getRepository(BookingSettings);
    await repo.save(repo.create({ tenantId: tenant.id, botId: second, travelTimeEnabled: false }));

    expect(await reconcileSharedItineraries()).toBe(0);
    expect(await notificationsOfType('travel_shared_itinerary')).toHaveLength(0);
  });
});

describe('a spent element cap belongs to the tenant', () => {
  it('notifies on the FIRST occurrence - a cap is a fact, not a symptom', async () => {
    // Deliberately not a burst threshold. The tenant is at their cap the moment they hit it, and
    // the platform threshold that governs outages would only delay telling them.
    await notifyTenantCapExhausted(tenant.id);

    const notes = await notificationsOfType('travel_cap_exhausted');
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/still taken/i);
    expect(notes[0].message).toMatch(/next month/i);
  });

  it('says it once a month, not once a booking', async () => {
    for (let i = 0; i < 5; i += 1) await notifyTenantCapExhausted(tenant.id);
    expect(await notificationsOfType('travel_cap_exhausted')).toHaveLength(1);
  });

  it('never notifies a tenant about another tenant', async () => {
    const other = await createTestTenant({ tier: 'pro' });
    await createTestUser(other.id, { role: 'admin' });
    await notifyTenantCapExhausted(other.id);

    expect(await notificationsOfType('travel_cap_exhausted')).toHaveLength(0);
  });
});
