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
vi.mock('../../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import {
  bindAddress,
  getBoundAddress,
  getPendingCorrection,
  proposeCorrection,
  clearAddressBinding,
} from '../../booking/travel/address-binding';
import { AppDataSource } from '../../database/data-source';

/**
 * A proposal names the binding it is a question ABOUT.
 *
 * Without it the write is refused - deliberately: `proposalId` hashes bound+proposed, so a proposal
 * stored beside a DIFFERENT active would label the control with one address and keep another.
 */
const about = (bound: { placeId: string; formattedAddress: string }) => ({
  expectedActivePlaceId: bound.placeId,
  expectedActiveAddress: bound.formattedAddress,
});

const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Grote Markt 1, 2000 Antwerpen' };
const OTHER = { placeId: 'ChIJ_other', formattedAddress: 'Korenmarkt 1, 9000 Gent' };
const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '10000000-0000-4000-8000-000000000002';

beforeEach(async () => {
  vi.clearAllMocks();
});

describe('the address a conversation is about', () => {
  it('is whatever the customer picked', async () => {
    await bindAddress(S1, CHOSEN);
    expect(await getBoundAddress(S1)).toEqual(CHOSEN);
  });

  it('is not changed by a proposal', async () => {
    await bindAddress(S1, CHOSEN);
    await proposeCorrection(S1, { ...OTHER, proposalId: OTHER.placeId, ...about(CHOSEN) });

    // The whole point. Something suggested Gent; the customer chose Antwerpen; Antwerpen stands.
    expect(await getBoundAddress(S1)).toEqual(CHOSEN);
    expect(await getPendingCorrection(S1)).toMatchObject({ formattedAddress: OTHER.formattedAddress, status: 'recorded' });
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
    await bindAddress(S1, CHOSEN);

    const first = await proposeCorrection(S1, { ...OTHER, proposalId: OTHER.placeId, ...about(CHOSEN) });
    expect(first.isNew).toBe(true);

    const replay = await proposeCorrection(S1, { ...OTHER, proposalId: OTHER.placeId, ...about(CHOSEN) });
    expect(replay.isNew).toBe(false);

    // A genuinely different address is a new question and may be asked.
    const third = await proposeCorrection(S1, {
      placeId: 'ChIJ_third', formattedAddress: 'Meir 1', proposalId: 'ChIJ_third', ...about(CHOSEN),
    });
    expect(third.isNew).toBe(true);
  });




  it('NEVER stores coordinates — only an identity and its spelling', async () => {
    await bindAddress(S1, CHOSEN);
    const [row] = await AppDataSource.query(
      `SELECT address, place_id, source, pending, version, updated_at
         FROM chatbot_address_bindings WHERE session_id = $1`,
      [S1]
    );
    expect(Object.keys(row).sort()).not.toEqual(expect.arrayContaining(['lat', 'lng']));
  });

  it('is forgotten on demand, so a second booking cannot inherit the first address', async () => {
    await bindAddress(S1, CHOSEN);
    await clearAddressBinding(S1);
    expect(await getBoundAddress(S1)).toBeNull();
    expect(await getPendingCorrection(S1)).toBeNull();
  });

  it('does not leak between sessions', async () => {
    await bindAddress(S1, CHOSEN);
    expect(await getBoundAddress(S2)).toBeNull();
  });

  it('refuses a proposal whose question is about an address the customer has left', async () => {
    // The caller reads the binding, derives `proposalId` from bound+proposed, and only then writes.
    // If the customer picks something else in between, storing the proposal beside the NEW active
    // would label the control "A or B?" while "keep mine" retained C - a door they were never
    // offered. The write is refused instead, and the next contested turn asks afresh about C.
    await bindAddress(S1, CHOSEN);
    const stale = about(CHOSEN);
    await bindAddress(S1, OTHER); // they picked again

    const { isNew } = await proposeCorrection(S1, {
      placeId: '', formattedAddress: 'Meir 1, 2000 Antwerpen', proposalId: 'p-stale', ...stale,
    });

    expect(isNew).toBe(false);
    expect(await getPendingCorrection(S1)).toBeNull();
    expect(await getBoundAddress(S1)).toEqual(OTHER);
  });

  it('treats an expired row as absent even before a sweep deletes it', async () => {
    await bindAddress(S1, CHOSEN);
    await AppDataSource.query(
      `UPDATE chatbot_address_bindings SET updated_at = now() - interval '36 minutes' WHERE session_id = $1`,
      [S1]
    );
    expect(await getBoundAddress(S1)).toBeNull();
    expect(await getPendingCorrection(S1)).toBeNull();
  });
});
