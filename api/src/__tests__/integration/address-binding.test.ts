/**
 * Who is allowed to change the address a conversation is about.
 *
 * The answer is "the customer, and nobody else" - and the whole reason this file exists is that
 * the obvious implementations all get it wrong in ways that look fine. A `place_id` in a tool
 * schema is a value the model can invent. Comparing the model's argument TEXT to the bound
 * address breaks on a harmless reformat. Comparing resolved PLACE IDS is closer but still asks a
 * model-written value what the customer meant.
 *
 * So: a differing argument PROPOSES, and only a server-observed event replaces. These tests are
 * the difference between that sentence being true and it being a comment.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

import Redis from 'ioredis';

/**
 * REAL Redis, because the binding's guarantees are now the store's.
 *
 * `proposeCorrection` and the transitions are Lua scripts, so a Map standing in for Redis would
 * have to reimplement them and the tests would assert only that the reimplementation agrees with
 * itself. The one case that still needs a fake - a store that cannot be read - fakes exactly that
 * and nothing else.
 */
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
let client: Redis;
let broken = false;
vi.mock('../../config/redis', () => ({
  getRedisClient: () =>
    broken
      ? ({ get: async () => { throw new Error('down'); } } as unknown as Redis)
      : client,
  isRedisAvailable: () => true,
}));

beforeAll(async () => {
  client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await client.connect();
    await client.ping();
  } catch (err) {
    throw new Error(
      `Needs the real Redis the address binding lives in. Start it with ` +
        `\`docker compose -f api/docker-compose.test.yml up -d test-redis\`. Tried ${REDIS_URL}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
});
afterAll(async () => { await client?.quit(); });
vi.mock('../../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import {
  bindAddress,
  getBoundAddress,
  getPendingCorrection,
  proposeCorrection,
  clearAddressBinding,
} from '../../booking/travel/address-binding';

const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Grote Markt 1, 2000 Antwerpen' };
const OTHER = { placeId: 'ChIJ_other', formattedAddress: 'Korenmarkt 1, 9000 Gent' };

beforeEach(async () => {
  broken = false;
  await client.del('addrbind:s1');
  await client.del('addrbind:s2');
  vi.clearAllMocks();
});

describe('the address a conversation is about', () => {
  it('is whatever the customer picked', async () => {
    await bindAddress('s1', CHOSEN);
    expect(await getBoundAddress('s1')).toEqual(CHOSEN);
  });

  it('is not changed by a proposal', async () => {
    await bindAddress('s1', CHOSEN);
    await proposeCorrection('s1', { ...OTHER, proposalId: OTHER.placeId });

    // The whole point. Something suggested Gent; the customer chose Antwerpen; Antwerpen stands.
    expect(await getBoundAddress('s1')).toEqual(CHOSEN);
    expect(await getPendingCorrection('s1')).toMatchObject({ placeId: OTHER.placeId });
  });




  /**
   * The confirm/reject transitions used to be tested here and now live in
   * `integration/address-binding-atomicity.test.ts`.
   *
   * They became a Lua script, so the STORE executes them. A test against the Map below would have
   * to reimplement that script and would then assert only that the reimplementation agrees with
   * itself - which is the definition of a test that cannot fail for the right reason. The same
   * argument the #95 endpoint suite already makes for refusing to run without a real Redis.
   *
   * What stays here is everything the transitions do not decide: what `bindAddress` and
   * `proposeCorrection` write, what the record may never contain, and how a proposal is counted.
   */

  it('reports a proposal as NEW once, then as a repeat', async () => {
    // What caps the question at one. Keyed on the proposal rather than counted, because the turn
    // coalescer re-runs the same customer message after a processor error - a counter would spend
    // the single question on a retry nobody saw.
    await bindAddress('s1', CHOSEN);

    const first = await proposeCorrection('s1', { ...OTHER, proposalId: OTHER.placeId });
    expect(first.isNew).toBe(true);

    const replay = await proposeCorrection('s1', { ...OTHER, proposalId: OTHER.placeId });
    expect(replay.isNew).toBe(false);

    // A genuinely different address is a new question and may be asked.
    const third = await proposeCorrection('s1', {
      placeId: 'ChIJ_third', formattedAddress: 'Meir 1', proposalId: 'ChIJ_third',
    });
    expect(third.isNew).toBe(true);
  });




  it('NEVER stores coordinates — only an identity and its spelling', async () => {
    // ADR-0014 caps lat/lng at 30 days and `coordinate-retention.service` sweeps the columns
    // that hold them. A Redis value carrying a point would be a fourth home for them, with no
    // timestamp and no sweep.
    await bindAddress('s1', CHOSEN);
    const raw = (await client.get('addrbind:s1'))!;
    expect(raw).not.toMatch(/lat|lng/i);
    expect(Object.keys(JSON.parse(raw).active).sort()).toEqual(['formattedAddress', 'placeId']);
  });

  it('is forgotten on demand, so a second booking cannot inherit the first address', async () => {
    await bindAddress('s1', CHOSEN);
    await clearAddressBinding('s1');
    expect(await getBoundAddress('s1')).toBeNull();
  });

  it('does not leak between sessions', async () => {
    await bindAddress('s1', CHOSEN);
    expect(await getBoundAddress('s2')).toBeNull();
  });

  it('degrades to no binding when Redis cannot be read', async () => {
    // Fail-open: a booking without a binding is the free-text path that has always existed.
    broken = true;
    expect(await getBoundAddress('s1')).toBeNull();
    broken = false;
  });
});
