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
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const redis = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  expire: vi.fn(async () => 1),
};

vi.mock('../../config/redis', () => ({ getRedisClient: () => redis }));
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

beforeEach(() => {
  store.clear();
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
    const raw = store.get('addrbind:s1')!;
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
    redis.get.mockRejectedValueOnce(new Error('down'));
    expect(await getBoundAddress('s1')).toBeNull();
  });
});
