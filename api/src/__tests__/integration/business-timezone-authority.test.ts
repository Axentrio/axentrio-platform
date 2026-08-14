/**
 * Server-owned Business Time, PR 1a (A4) — through the real router and controllers.
 *
 * The pilot bug: onboarding wrote the CONFIGURATOR's browser timezone into both the
 * operational businessHours and the booking availability rule, so a Belgian business set up
 * from Kuala Lumpur ran eight hours wrong. These tests pin the tolerant-server cutover:
 *
 * - a legacy client may still SEND a timezone (its schema requires it), but the value is
 *   ignored — the persisted and returned timezone is the bot's derived `businessTimezone`;
 * - a venue write recomputes `businessTimezone` in the same request/transaction;
 * - clearing the venue (`No Location`) derives from the TENANT's operating country, not
 *   UTC and not the browser;
 * - an unsupported venue country is refused outright, and refusal writes nothing;
 * - one bot's timezone can never move another bot's.
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
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const CONFIG_URL = '/api/v1/scheduler/config';
const BRUSSELS = 'Europe/Brussels';

let tenant: Tenant;
let anchor: Bot;

const botRow = (id: string) =>
  AppDataSource.getRepository(Bot).findOneOrFail({ where: { id } });
const ruleRow = (botId: string) =>
  AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId } });
const settingsRow = (botId: string) =>
  AppDataSource.getRepository(BookingSettings).findOne({ where: { botId } });

/** Simulate legacy browser-corrupted state so a recompute is observable. */
async function corruptTimezones(botId: string, tz = 'Asia/Kuala_Lumpur'): Promise<void> {
  await AppDataSource.query(`UPDATE chatbot_bots SET business_timezone = $1 WHERE id = $2`, [tz, botId]);
  await AppDataSource.query(`UPDATE chatbot_availability_rules SET timezone = $1 WHERE bot_id = $2`, [tz, botId]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  anchor = await createTestAnchorBot(tenant);
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });
});

describe('a legacy conflicting timezone payload cannot change business time (A4 #1/#6)', () => {
  it('accepts availability.timezone from an old client, ignores it, persists + returns the derived value', async () => {
    const res = await request(app)
      .put(CONFIG_URL)
      .send({
        availability: {
          // What a browser in Kuala Lumpur would send while configuring a Belgian business.
          timezone: 'Asia/Kuala_Lumpur',
          weeklyHours: { mon: [{ start: '09:00', end: '17:00' }] },
        },
      });
    expect(res.status).toBe(200);
    // Displayed value is the DERIVED one.
    expect(res.body.data.availability.timezone).toBe(BRUSSELS);
    // Persisted value is the DERIVED one.
    expect((await ruleRow(anchor.id))!.timezone).toBe(BRUSSELS);
  });

  it('a NEW tolerant client may omit timezone entirely — the rule still gets the derived value', async () => {
    const res = await request(app)
      .put(CONFIG_URL)
      .send({ availability: { weeklyHours: { tue: [{ start: '08:00', end: '12:00' }] } } });
    expect(res.status).toBe(200);
    expect((await ruleRow(anchor.id))!.timezone).toBe(BRUSSELS);
  });

  it('a conflicting write cannot resurrect a corrupted rule timezone on the next save', async () => {
    // Corrupt state (pre-cutover browser writes), then a legacy client saves again.
    await request(app).put(CONFIG_URL).send({ availability: { weeklyHours: {} } });
    await corruptTimezones(anchor.id);
    const res = await request(app)
      .put(CONFIG_URL)
      .send({ availability: { timezone: 'Asia/Kuala_Lumpur', weeklyHours: {} } });
    expect(res.status).toBe(200);
    expect((await botRow(anchor.id)).businessTimezone).toBe('Asia/Kuala_Lumpur'); // untouched: no venue in this write
    expect((await ruleRow(anchor.id))!.timezone).toBe('Asia/Kuala_Lumpur'); // rule mirrors the bot value…
    // …which is exactly the point: the rule can never disagree with the bot,
    // even while the bot itself still carries pre-repair data. The migration
    // (1791200000000) repairs both to Europe/Brussels in production.
  });
});

describe('a venue edit recomputes businessTimezone in the same request (A4 #4)', () => {
  it('typed Belgian venue → bot + rule realigned to Europe/Brussels', async () => {
    await request(app).put(CONFIG_URL).send({ availability: { weeklyHours: {} } });
    await corruptTimezones(anchor.id);

    const res = await request(app)
      .put(CONFIG_URL)
      .send({ venueAddress: { street: 'Grote Markt 1', postalCode: '2000', city: 'Antwerpen', country: 'BE' } });
    expect(res.status).toBe(200);

    expect((await botRow(anchor.id)).businessTimezone).toBe(BRUSSELS);
    expect((await ruleRow(anchor.id))!.timezone).toBe(BRUSSELS);
    // And the response already shows the recomputed value.
    expect(res.body.data.availability.timezone).toBe(BRUSSELS);
    expect(res.body.data.venueAddress.city).toBe('Antwerpen');
  });

  it('a venue WITHOUT a country derives from the tenant operating country (BE)', async () => {
    await corruptTimezones(anchor.id);
    const res = await request(app)
      .put(CONFIG_URL)
      .send({ venueAddress: { street: 'Kerkstraat 5', city: 'Gent' } });
    expect(res.status).toBe(200);
    expect((await botRow(anchor.id)).businessTimezone).toBe(BRUSSELS);
  });
});

describe('No Location uses the tenant operating country, never UTC/browser (A4 #5)', () => {
  it('clearing the venue keeps Europe/Brussels via operating_country', async () => {
    await AppDataSource.query(`UPDATE chatbot_bots SET business_timezone = 'UTC' WHERE id = $1`, [anchor.id]);
    const res = await request(app).put(CONFIG_URL).send({ venueAddress: null });
    expect(res.status).toBe(200);
    expect((await botRow(anchor.id)).businessTimezone).toBe(BRUSSELS);
    // The venue itself is cleared.
    const bs = await settingsRow(anchor.id);
    expect(bs?.venueStreet ?? null).toBeNull();
  });

  it('every tenant is backfilled/created with operating_country BE', async () => {
    const [row] = await AppDataSource.query(`SELECT operating_country FROM tenants WHERE id = $1`, [tenant.id]);
    expect(row.operating_country).toBe('BE');
  });
});

describe('an unsupported venue country is refused, and refusal writes NOTHING', () => {
  it('country NL → 400 UNSUPPORTED_BUSINESS_COUNTRY, venue and timezone untouched', async () => {
    const res = await request(app)
      .put(CONFIG_URL)
      .send({ venueAddress: { street: 'Damrak 1', city: 'Amsterdam', country: 'NL' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_BUSINESS_COUNTRY');
    expect(res.body.error.message).toContain('NL');
    // Nothing was written: no settings row sprang into being for this bot.
    expect(await settingsRow(anchor.id)).toBeNull();
    expect((await botRow(anchor.id)).businessTimezone).toBe(BRUSSELS);
  });
});

describe('multi-bot: one bot cannot move another bot\'s business time (A4 #7)', () => {
  it('a venue write on the second Agent leaves the anchor untouched', async () => {
    const repo = AppDataSource.getRepository(Bot);
    const second = await repo.save(
      repo.create({
        tenantId: tenant.id,
        name: 'Second driver',
        publicKey: `pk-${randomBytes(4).toString('hex')}`,
        status: 'active',
        isDefault: false,
        settings: {} as Bot['settings'],
      }),
    );
    // Both bots start in the corrupted legacy state.
    await request(app).put(CONFIG_URL).send({ availability: { weeklyHours: {} } });
    await request(app).put(`${CONFIG_URL}?botId=${second.id}`).send({ availability: { weeklyHours: {} } });
    await corruptTimezones(anchor.id);
    await corruptTimezones(second.id);

    const res = await request(app)
      .put(`${CONFIG_URL}?botId=${second.id}`)
      .send({ venueAddress: { street: 'Meir 12', city: 'Antwerpen', country: 'BE' } });
    expect(res.status).toBe(200);

    // The named Agent is repaired…
    expect((await botRow(second.id)).businessTimezone).toBe(BRUSSELS);
    expect((await ruleRow(second.id))!.timezone).toBe(BRUSSELS);
    // …and the anchor keeps its own (still-corrupt) value: no cross-bot writes.
    expect((await botRow(anchor.id)).businessTimezone).toBe('Asia/Kuala_Lumpur');
    expect((await ruleRow(anchor.id))!.timezone).toBe('Asia/Kuala_Lumpur');
  });
});

describe('operational businessHours writes are equally tolerant (A2/A3)', () => {
  it('PATCH /bots/:id accepts a browser timezone but stores the derived one', async () => {
    const res = await request(app)
      .patch(`/api/v1/bots/${anchor.id}`)
      .send({
        businessHours: {
          enabled: true,
          timezone: 'Asia/Kuala_Lumpur', // what a KL browser would submit
          schedule: [{ day: 'monday', open: '09:00', close: '17:00', closed: false }],
        },
      });
    expect(res.status).toBe(200);
    const stored = (await botRow(anchor.id)).settings?.businessHours;
    expect(stored?.timezone).toBe(BRUSSELS);
    expect(stored?.schedule?.[0]?.open).toBe('09:00');
  });
});
