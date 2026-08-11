/**
 * A verified venue, through the real router and the real controller.
 *
 * There is a unit test beside this one that exercises the same rule against an extracted copy of
 * the branch. That copy is worth having and it is not evidence: it would keep passing if somebody
 * changed the controller, which is the only thing that actually runs. This file drives
 * `PUT /scheduler/config` and reads the row back out of Postgres, so the assertions are about the
 * code that ships.
 *
 * What it is defending: the venue is the travel BASE, so a `venue_place_id` that outlives the
 * address beside it routes every first job of every day from somewhere the owner has already
 * replaced - while the screen shows the new address and nothing looks wrong.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

/**
 * Google, stubbed at the one seam that reaches it. Everything between the HTTP request and this
 * mock is the real thing: the router, the auth stack, the zod schema, the controller branch and
 * the upsert.
 */
const resolve = vi.fn();
vi.mock('../../booking/travel/geocoding.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../booking/travel/geocoding.service')>()),
  resolvePlaceId: (...a: unknown[]) => resolve(...(a as [])),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const CONFIG_URL = '/api/v1/scheduler/config';

let tenant: Tenant;
let anchor: { id: string };

const placed = (components?: Record<string, string>) => ({
  status: 'placed' as const,
  place: {
    placeId: 'ChIJ_venue',
    lat: 51.2213,
    lng: 4.3997,
    precision: 'rooftop' as const,
    formattedAddress: 'Grote Markt 1, 2000 Antwerpen, Belgium',
    components,
  },
});

const settingsFor = (botId: string) =>
  AppDataSource.getRepository(BookingSettings).findOne({ where: { botId } });

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  anchor = await createTestAnchorBot(tenant);
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });
});

async function saveVenue(venueAddress: Record<string, unknown>) {
  return request(app).put(CONFIG_URL).set('Authorization', 'Bearer t').send({ venueAddress });
}

describe('a venue place id, through the real write path', () => {
  it('stores GOOGLE’s components rather than what the browser submitted', async () => {
    resolve.mockResolvedValue(
      placed({ street: 'Grote Markt 1', postalCode: '2000', city: 'Antwerpen', country: 'BE' })
    );

    // The owner picked a suggestion, but the form still carried the half-typed text they had
    // been editing. Trusting the browser here is what lets an id and an address drift apart.
    const res = await saveVenue({
      placeId: 'ChIJ_venue',
      street: 'grote mark',
      postalCode: null,
      city: 'antwerp',
      country: 'BE',
    });
    expect(res.status).toBe(200);

    const row = await settingsFor(anchor.id);
    expect(row?.venuePlaceId).toBe('ChIJ_venue');
    expect(row?.venueStreet).toBe('Grote Markt 1');
    expect(row?.venuePostalCode).toBe('2000');
    expect(row?.venueCity).toBe('Antwerpen');
  });

  it('stores NO id when the owner typed the address instead of picking it', async () => {
    const res = await saveVenue({ street: 'Kerkstraat 12', city: 'Gent', country: 'BE' });
    expect(res.status).toBe(200);

    const row = await settingsFor(anchor.id);
    expect(row?.venuePlaceId).toBeNull();
    expect(row?.venueStreet).toBe('Kerkstraat 12');
    // Nothing was picked, so nothing should have been resolved - and nothing should have been paid for.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('CLEARS a stored id when the owner later edits the address by hand', async () => {
    // The regression this whole design exists to prevent, end to end.
    resolve.mockResolvedValue(placed({ street: 'Grote Markt 1', city: 'Antwerpen', country: 'BE' }));
    await saveVenue({ placeId: 'ChIJ_venue', street: 'Grote Markt 1', city: 'Antwerpen', country: 'BE' });

    expect((await settingsFor(anchor.id))?.venuePlaceId).toBe('ChIJ_venue');

    // They move premises and retype the address. The browser sends no id.
    resolve.mockClear();
    await saveVenue({ street: 'Kerkstraat 12', city: 'Gent', country: 'BE' });

    const after = await settingsFor(anchor.id);
    expect(after?.venuePlaceId).toBeNull();
    expect(after?.venueStreet).toBe('Kerkstraat 12');
    expect(after?.venueCity).toBe('Gent');
  });

  it('FAILS OPEN: an unresolvable id still saves the address, without an id', async () => {
    resolve.mockResolvedValue({ status: 'unavailable', cause: 'api_error' });

    const res = await saveVenue({
      placeId: 'ChIJ_venue',
      street: 'Kerkstraat 12',
      city: 'Gent',
      country: 'BE',
    });
    // Being unable to VERIFY an address is not a reason to refuse to STORE it.
    expect(res.status).toBe(200);

    const row = await settingsFor(anchor.id);
    expect(row?.venuePlaceId).toBeNull();
    expect(row?.venueStreet).toBe('Kerkstraat 12');
  });

  it('returns the stored id on the read path, so the editor can keep it', async () => {
    // `readConfig` cherry-picks its fields: one missing here hydrates the editor blank and the
    // owner's next Save writes that blank back over a real value.
    resolve.mockResolvedValue(placed({ street: 'Grote Markt 1', city: 'Antwerpen', country: 'BE' }));
    await saveVenue({ placeId: 'ChIJ_venue', street: 'Grote Markt 1', city: 'Antwerpen', country: 'BE' });

    const res = await request(app).get(CONFIG_URL).set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.data.venueAddress.placeId).toBe('ChIJ_venue');
  });
});
