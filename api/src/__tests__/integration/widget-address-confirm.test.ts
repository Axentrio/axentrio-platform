/**
 * The customer's answer to "should the address be X instead of Y?" (#95).
 *
 * Before this endpoint the answer went nowhere. The question was recorded, `confirmCorrection` and
 * `rejectCorrection` were implemented and unit-tested, and nothing in production called them - so a
 * customer who said "yes, Kerkstraat 12 is correct" was booked at the address they had just moved
 * away from, and told otherwise. Reproduced on production the day address suggestions were enabled,
 * which is what made the path reachable.
 *
 * Tested at the HTTP seam because that is the whole point of the design: only an event the SERVER
 * observed may move the binding. A unit test on the transitions would pass with no endpoint at all,
 * which is exactly the state that shipped.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import Redis from 'ioredis';
import { createAuthMocks } from '../helpers/auth';

createAuthMocks();
vi.mock('@clerk/express', () => ({ clerkMiddleware: () => (_r: any, _s: any, n: any) => n() }));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
// The ingestion path pulls in the agent; the endpoint's contract is the binding, not the reply.
vi.mock('../../services/widget-ingest', () => ({
  ingestWidgetCustomerMessage: vi.fn().mockResolvedValue(undefined),
}));

// The binding lives in Redis, and `address-binding` fails OPEN without it - a binding it cannot
// write is simply one that does not exist. Correct in production, and it means a suite with no
// Redis proves nothing here: every assertion would go green-to-red for an environmental reason.
// Same seam the #68 health suite uses: hand the real client back through the accessors production
// calls, rather than letting `initializeRedis` read a REDIS_URL that points at nothing.
let client: Redis;
vi.mock('../../config/redis', () => ({
  getRedisClient: () => client,
  isRedisAvailable: () => true,
}));

import request from 'supertest';
import { app } from '../../server';
import { createTestTenant, createTestAnchorBot, createTestSession } from '../helpers/factories';
import {
  bindAddress,
  proposeCorrection,
  claimPresentation,
  getBoundAddress,
  getPendingCorrection,
} from '../../booking/travel/address-binding';
import type { Tenant } from '../../database/entities/Tenant';

let tenant: Tenant;
let sessionId: string;
let token: string;

const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Turnhoutsebaan 100, 2140 Antwerpen' };
const PROPOSED = { proposalId: 'prop-1', placeId: '', formattedAddress: 'Kerkstraat 12, 2060 Antwerpen' };

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

beforeAll(async () => {
  client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await client.connect();
    await client.ping();
  } catch (err) {
    // FAIL rather than skip. A silently skipped suite is how this endpoint shipped unverified.
    throw new Error(
      `#95 needs the real Redis the address binding lives in. Start it with ` +
        `\`docker compose -f api/docker-compose.test.yml up -d test-redis\`. Tried ${REDIS_URL}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
});

afterAll(async () => {
  await client?.quit();
});

const post = (body: Record<string, unknown>) =>
  request(app).post('/api/v1/widget/address/confirm').set('Authorization', `Bearer ${token}`).send(body);

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  const bot = await createTestAnchorBot(tenant);
  const session = await createTestSession(tenant.id, { botId: bot.id });
  sessionId = session.id;
  const init = await request(app)
    .post('/api/v1/widget/init')
    .send({ apiKey: bot.publicKey, visitorId: 'confirm-test' });
  token = init.body.data.token;
  sessionId = init.body.data.session.id;

  await bindAddress(sessionId, CHOSEN);
  await proposeCorrection(sessionId, PROPOSED);
  // ASKED, not merely recorded. The transition now requires it, because a proposal the customer
  // was never shown is not a question they can have answered - and `proposalId` alone was
  // derivable from the address, so it proved nothing. Verified against production 2026-08-13.
  await claimPresentation(sessionId, PROPOSED.proposalId, 'run-fixture');
});

describe('POST /widget/address/confirm', () => {
  it('PRECONDITION: the binding store is actually working in this environment', async () => {
    // If this fails, every test below fails for an environmental reason and none of them say
    // anything about the endpoint.
    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe(CHOSEN.formattedAddress);
    expect((await getPendingCorrection(sessionId))?.proposalId).toBe(PROPOSED.proposalId);
  });

  it('makes YES change the address the conversation is about', async () => {
    const res = await post({ proposalId: PROPOSED.proposalId, confirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(true);
    // The assertion that matters: the binding moved. Before this endpoint it never did.
    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe(PROPOSED.formattedAddress);
    expect(await getPendingCorrection(sessionId)).toBeNull();
  });

  it('makes NO keep the address they originally chose', async () => {
    const res = await post({ proposalId: PROPOSED.proposalId, confirmed: false });

    expect(res.body.data.applied).toBe(true);
    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe(CHOSEN.formattedAddress);
    // The question is answered either way, so a later stale "yes" cannot resurrect it.
    expect(await getPendingCorrection(sessionId)).toBeNull();
  });

  it('refuses an answer to a question the customer has already moved past', async () => {
    // The customer moved on while the button sat on their screen. A PRESENTED proposal cannot be
    // superseded behind their back, so the route production takes is the one taken here: they pick
    // again (which releases the question), and the next contested turn asks afresh.
    await bindAddress(sessionId, CHOSEN);
    await proposeCorrection(sessionId, { ...PROPOSED, proposalId: 'prop-2', formattedAddress: 'Meir 78, 2000 Antwerpen' });
    await claimPresentation(sessionId, 'prop-2', 'run-2');

    const res = await post({ proposalId: 'prop-1', confirmed: true });

    expect(res.body.data.applied).toBe(false);
    expect(res.body.data.reason).toBe('no_longer_outstanding');
    // The stale answer promoted nothing.
    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe(CHOSEN.formattedAddress);
  });

  it('rejects a body that tries to name an address', async () => {
    // The model may not choose a place here and neither may the widget: the server already knows
    // what it asked, and an address in this payload would be a claim nobody verified.
    const res = await post({ proposalId: PROPOSED.proposalId, confirmed: true, address: 'Somewhere else' });
    expect(res.status).toBe(200);
    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe(PROPOSED.formattedAddress);
  });
});
