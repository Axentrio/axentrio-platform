/**
 * Travel settings survive a save and come back out again.
 *
 * Every field here has the same failure mode and it is quiet: `readConfig` CHERRY-PICKS what it
 * returns, so a field that is written but not read hydrates the editor blank, and the owner's next
 * Save writes that blank back over the value they set. Nothing errors. The setting simply forgets
 * itself one save later, and the owner concludes the feature does not work.
 *
 * `travel_max_detour_min` is the reason this file exists. Its READER has existed since #81
 * (`travel-eligibility` -> `insertion-scorer`) and nothing could ever write it, so every business
 * on the platform ran with "no threshold" whether that suited them or not - a whole setting that
 * existed in the engine and nowhere else.
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
import { BookingSettings } from '../../database/entities/BookingSettings';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const CONFIG_URL = '/api/v1/scheduler/config';

let tenant: Tenant;
let anchor: { id: string };

const save = (travel: Record<string, unknown>) =>
  request(app).put(CONFIG_URL).set('Authorization', 'Bearer t').send({ travel });

const read = () => request(app).get(CONFIG_URL).set('Authorization', 'Bearer t');

const stored = () =>
  AppDataSource.getRepository(BookingSettings).findOne({ where: { botId: anchor.id } });

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  anchor = await createTestAnchorBot(tenant);
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });
});

describe('maximum travel time', () => {
  it('persists, and comes back on the read the editor hydrates from', async () => {
    const res = await save({ maxDetourMin: 30 });
    expect(res.status).toBe(200);
    expect((await stored())?.travelMaxDetourMin).toBe(30);

    // The half that actually bites: written but not read means the next Save blanks it.
    const back = await read();
    expect(back.body.data.travel.maxDetourMin).toBe(30);
  });

  it('is left ALONE by a save that does not mention it', async () => {
    await save({ maxDetourMin: 30 });
    // An owner toggling something else entirely must not silently clear a threshold they set.
    await save({ startFromBase: true });

    expect((await stored())?.travelMaxDetourMin).toBe(30);
  });

  it('is CLEARED by an explicit null, because that is how an owner turns it off', async () => {
    await save({ maxDetourMin: 30 });
    await save({ maxDetourMin: null });

    expect((await stored())?.travelMaxDetourMin).toBeNull();
  });

  it('refuses a value beyond the ceiling rather than storing it', async () => {
    // Past two hours an owner is describing a different business rather than a detour.
    // 422 rather than 400 - this API's validation status, confirmed against the running route.
    const res = await save({ maxDetourMin: 500 });
    expect(res.status).toBe(422);
    // And the refusal must not be cosmetic: nothing may reach the column.
    expect((await stored())?.travelMaxDetourMin ?? null).toBeNull();
  });

  it('accepts zero, which means no threshold rather than "nothing qualifies"', async () => {
    // A value that silently marked every slot unpreferred would be indistinguishable from the
    // feature being off, and off is overwhelmingly what an owner who typed 0 meant.
    const res = await save({ maxDetourMin: 0 });
    expect(res.status).toBe(200);
    expect((await stored())?.travelMaxDetourMin).toBe(0);
  });
});
