/**
 * The dedup gate that decides whether two calls are one booking, against a real database.
 *
 * This exists because production could not answer the question. `agent_traces` records that a tool
 * was CALLED and not what it returned, so a single row after a re-confirm is equally consistent
 * with "the gate deduped correctly" and "the call exited somewhere earlier". Reviewing the fix,
 * codex refused the live evidence twice on exactly that ground, and it was right to: the row shape
 * alone cannot distinguish them. A test can, because it can read the return value.
 *
 * ## Why the second call uses a different TIME STRING
 *
 * There are two gates. The idempotency key is the first, and it now carries the address. The second
 * is `(session, service, startUtc)`, and it exists because the model can express one instant two
 * ways (#35) - so a re-confirm can produce a different key for the same booking and slip past gate
 * one. Sending the same instant as `Z` and then as `+01:00` is what forces gate TWO to be the one
 * that decides, which is the gate this fix changed.
 *
 * ## Why the row is geocoded between the calls
 *
 * That is what production does. `createRequest` stores a `place_id` derived from the typed text
 * whenever it can, so a row created from words comes back carrying an identity the customer never
 * supplied. The first version of this fix read that as identity, compared it against the customer's
 * later raw text, found them different and inserted a SECOND live request - turning a genuine
 * re-confirm into two appointments for the owner to untangle. Enriching the row here reproduces
 * that state deliberately.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks } from '../helpers/auth';

const { auth: _auth } = createAuthMocks();
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { AppDataSource } from '../../database/data-source';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { ServiceType } from '../../database/entities/ServiceType';
import { requestBooking } from '../../booking/booking.service';
import { invalidateEntitlements } from '../../billing/entitlements';
import { createTestTenant, createTestAnchorBot, createTestSession } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

let tenant: Tenant;
let botId: string;
let serviceId: string;
let sessionId: string;

/** The same instant, spelled the two ways a model actually spells it. */
const AS_UTC = '2026-12-11T14:00:00Z';
const AS_OFFSET = '2026-12-11T15:00:00+01:00';
const ADDRESS = 'Bist 1, 2610 Wilrijk';

const key = (time: string, token: string) => `request_appointment:${sessionId}:${serviceId}:${time}:${token}`;

const rowsForSession = () =>
  AppDataSource.query(
    `SELECT id, customer_address, location_source FROM chatbot_bookings WHERE session_id = $1 ORDER BY created_at`,
    [sessionId]
  );

/** What production does to a row created from typed words: derive a place id and record it. */
async function geocodeTheRow(id: string): Promise<void> {
  await AppDataSource.query(
    `UPDATE chatbot_bookings SET customer_place_id = $2, location_source = 'geocoded' WHERE id = $1`,
    [id, 'ChIJ_derived_by_us']
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  botId = (await createTestAnchorBot(tenant)).id;
  const rules = AppDataSource.getRepository(AvailabilityRule);
  await rules.save(
    rules.create({ tenantId: tenant.id, botId, timezone: 'Europe/Brussels', availabilityMode: 'always_open' })
  );
  const services = AppDataSource.getRepository(ServiceType);
  const svc = await services.save(
    services.create({
      tenantId: tenant.id,
      botId,
      name: 'On-site consultation',
      slug: `onsite-${randomUUID().slice(0, 8)}`,
      durationMin: 60,
      bookingMode: 'request',
      customerAddressRequired: true,
      locationType: 'in_person',
      isActive: true,
    })
  );
  serviceId = svc.id;
  sessionId = (await createTestSession(tenant.id, { botId })).id;
  invalidateEntitlements(tenant.id);
});

const capture = (time: string, address: string | undefined, token: string) =>
  requestBooking(
    'agent',
    sessionId,
    key(time, token),
    time,
    { name: 'Codex Case', email: 'codex@example.com' },
    undefined,
    serviceId,
    undefined,
    undefined,
    { customerAddress: address, customerPhone: '+32470000000' }
  );

describe('a genuine re-confirm, against a row we geocoded ourselves', () => {
  it('returns the SAME request rather than inserting a second one', async () => {
    const first = await capture(AS_UTC, ADDRESS, 'tok_same');
    const created = await rowsForSession();
    expect(created).toHaveLength(1);

    // The state that broke the first version of this fix.
    await geocodeTheRow(created[0].id);

    // Same instant, different spelling, so the KEY differs and gate two must decide.
    const second = await capture(AS_OFFSET, ADDRESS, 'tok_same');

    // Row count FIRST: it distinguishes "deduped, flag missing" from "inserted a second row",
    // which mean opposite things about the fix.
    expect(await rowsForSession()).toHaveLength(1);
    // The evidence production could not give: the gate ran and said "already have this".
    expect(second.idempotent).toBe(true);
    expect(second.booking.id).toBe(first.booking.id);
    expect(await rowsForSession()).toHaveLength(1);
  });
});

describe('a corrected address at the same time', () => {
  it('is a DIFFERENT request, because the customer changed where the van goes', async () => {
    const first = await capture(AS_UTC, 'Meir 78, 2000 Antwerpen', 'tok_a');
    await geocodeTheRow((await rowsForSession())[0].id);

    const second = await capture(AS_OFFSET, 'Turnhoutsebaan 100, 2140 Antwerpen', 'tok_b');

    expect(second.idempotent).toBeFalsy();
    expect(second.booking.id).not.toBe(first.booking.id);
    const rows = await rowsForSession();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { customer_address: string }) => r.customer_address)).toEqual([
      'Meir 78, 2000 Antwerpen',
      'Turnhoutsebaan 100, 2140 Antwerpen',
    ]);
  });
});
