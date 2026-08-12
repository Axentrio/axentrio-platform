/**
 * Two people changing one answer at the same time.
 *
 * `confirmCorrection` and `rejectCorrection` read the record, check the proposal id, and write the
 * result back - three steps against one Redis key. Between the read and the write, a booking tool
 * can call `proposeCorrection` or `/places/select` can call `bindAddress`, and that write is then
 * overwritten by a transition that decided before it existed. The confirmation promotes a proposal
 * the customer has already moved past, which is the exact failure `proposalId` was introduced to
 * prevent, reintroduced one layer down.
 *
 * ## Why this asserts on the RECORD and not on the return value
 *
 * The obvious test races two promises and expects `applied: false`. It cannot work, because the
 * buggy and the fixed implementation legitimately disagree about the return value:
 *
 *   read-then-write   the GET already captured the stale record, so the SET overwrites the
 *                     supersede. Final state: the confirmed address is active and `pending` is
 *                     GONE. The customer's newer question vanished.
 *   atomic            the whole transition committed before the supersede ran. Final state: the
 *                     confirmed address is active and `pending` holds the NEW proposal.
 *
 * Both return `applied: true`. Only one of them is a state that any ordering of the two operations
 * could have produced - and that is the property worth asserting. Confirm-then-propose leaves the
 * new proposal outstanding; propose-then-confirm leaves the bound address alone and the new
 * proposal outstanding. **No ordering loses the second proposal.** A record with `pending` empty is
 * a lost write, whatever the return value said.
 *
 * ## Why the barrier holds a RESOLUTION rather than a dispatch
 *
 * Delaying the command would order the supersede FIRST, where today's code already behaves
 * correctly and the test would pass against the bug. The command has to reach the server, capture
 * the stale state, and only then be held - which is the window the defect lives in.
 *
 * It also cannot key on `GET`: the fix issues `EVAL` and no `GET` at all, so a barrier waiting for
 * a GET would hang the moment the bug was fixed. It keys on whichever command the transition
 * issues first.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Redis from 'ioredis';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

let real: Redis;
/** Holds the resolution of the transition's first command until the test releases it. */
let barrier: { engaged: Promise<void> } | null = null;
let armed = false;

/**
 * A client that behaves exactly like the real one, except that the first command issued after
 * `arm()` has its PROMISE held until released. One-shot, so nothing the fixture does is caught.
 */
function barrierClient(client: Redis): Redis {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || !armed) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      // Only intercept commands, never the bookkeeping ioredis does on itself.
      if (prop !== 'get' && prop !== 'eval' && prop !== 'evalsha' && prop !== 'set') return value.bind(target);
      return (...args: unknown[]) => {
        armed = false; // one-shot: consumed by the first command of the transition
        const ran = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        // The command has ALREADY executed and captured the state it saw. Holding only its
        // return is what opens the window a read-then-write transition is vulnerable in.
        return ran.then(async (out) => {
          await barrier!.engaged;
          return out;
        });
      };
    },
  }) as Redis;
}

vi.mock('../../config/redis', () => ({
  getRedisClient: () => barrierClient(real),
  isRedisAvailable: () => true,
}));

import {
  bindAddress,
  proposeCorrection,
  markQuestionDelivered,
  confirmCorrection,
  rejectCorrection,
  getBoundAddress,
  getPendingCorrection,
} from '../../booking/travel/address-binding';

const SESSION = 'sess-atomicity';
const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Turnhoutsebaan 100, 2140 Antwerpen' };
const P1 = { proposalId: 'p-one', placeId: '', formattedAddress: 'Kerkstraat 12, 2060 Antwerpen' };
const P2 = { proposalId: 'p-two', placeId: '', formattedAddress: 'Meir 78, 2000 Antwerpen' };

beforeAll(async () => {
  real = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await real.connect();
    await real.ping();
  } catch (err) {
    // FAIL rather than skip. A concurrency suite that quietly skips is a concurrency suite that
    // has never run, and this one exists precisely because the guarantee is the store's.
    throw new Error(
      `Needs the real Redis the address binding lives in. Start it with ` +
        `\`docker compose -f api/docker-compose.test.yml up -d test-redis\`. Tried ${REDIS_URL}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
});

afterAll(async () => {
  await real?.quit();
});

beforeEach(async () => {
  armed = false;
  barrier = null;
  await real.del(`addrbind:${SESSION}`);
  await bindAddress(SESSION, CHOSEN);
  await proposeCorrection(SESSION, P1);
  // PRESENTED, because a transition may only answer a question that was actually asked. Every
  // test below that expects `applied: true` depends on this line, which is the point.
  await markQuestionDelivered(SESSION, P1.proposalId);
});

describe('a confirmation racing a new proposal', () => {
  it('never loses the newer proposal, whichever of them went first', async () => {
    // Hand-rolled interleaving rather than Promise.all: racing two promises against real Redis
    // orders nothing, and a test that only sometimes reproduces a lost write is a test that
    // reports green on a bad day.
    let released!: () => void;
    const held = new Promise<void>((r) => { released = r; });
    barrier = { engaged: held };
    armed = true;

    // Starts, reaches Redis, captures state, then waits on `held`.
    const confirming = confirmCorrection(SESSION, P1.proposalId);
    // Give the transition's first command time to land before the supersede runs.
    await new Promise((r) => setTimeout(r, 50));
    // The customer restated their address while the button sat on their screen.
    await proposeCorrection(SESSION, P2);
    released();
    await confirming;

    const pending = await getPendingCorrection(SESSION);
    const active = await getBoundAddress(SESSION);

    // THE ASSERTION. Both legal orderings leave P2 outstanding:
    //   confirm then propose -> active = P1's address, pending = P2
    //   propose then confirm -> active = CHOSEN,       pending = P2
    // A read-then-write transition produces `pending = null`, which no ordering can reach.
    expect(pending?.proposalId).toBe(P2.proposalId);
    expect([P1.formattedAddress, CHOSEN.formattedAddress]).toContain(active?.formattedAddress);
  });

  it('still refuses a proposal that is simply stale', async () => {
    // The ordinary case, uncontended, so the fix cannot pass the race by refusing everything.
    // A PRESENTED proposal cannot be superseded behind the customer's back, so the only way to
    // reach a newer question is the way production reaches it: they pick again, which releases the
    // old one, and the next contested turn asks afresh.
    await bindAddress(SESSION, CHOSEN);
    await proposeCorrection(SESSION, P2);
    await markQuestionDelivered(SESSION, P2.proposalId);

    const applied = await confirmCorrection(SESSION, P1.proposalId);

    expect(applied.applied).toBe(false);
    expect((await getBoundAddress(SESSION))?.formattedAddress).toBe(CHOSEN.formattedAddress);
    expect((await getPendingCorrection(SESSION))?.proposalId).toBe(P2.proposalId);
  });

  it('promotes the proposed address when nothing contends', async () => {
    const applied = await confirmCorrection(SESSION, P1.proposalId);

    expect(applied).toEqual({ applied: true, address: P1.formattedAddress });
    expect((await getBoundAddress(SESSION))?.formattedAddress).toBe(P1.formattedAddress);
    // Promotion must clear the proposal, or a replayed confirmation promotes it twice.
    expect(await getPendingCorrection(SESSION)).toBeNull();
  });
});

/**
 * These moved here from `unit/address-binding.test.ts` when the transitions became a Lua script.
 *
 * They were unit tests over a Map standing in for Redis, and that stopped being able to say
 * anything: the store now EXECUTES the transition, so a fake would have to reimplement it and the
 * test would assert only that the reimplementation agrees with itself. The same reasoning the #95
 * endpoint suite already gives for refusing to run without a real Redis.
 */
describe('the transitions themselves', () => {
  it('REFUSES to answer a question that was never asked', async () => {
    // Verified failing against production on 2026-08-13. `proposalId` is
    // sha256(normalise(proposedText)) - derivable from the address text alone, identical in every
    // session - so possessing one is not evidence of anything. With the transition keyed on the id
    // alone, an authenticated caller could confirm a proposal that had only ever been RECORDED,
    // moving the binding for a question the customer was never shown.
    //
    // That defeats the rule the whole feature rests on: only an event the SERVER observed may move
    // a binding. `presented` is what the server observed; the id is just the subject line.
    await real.del(`addrbind:${SESSION}`);
    await bindAddress(SESSION, CHOSEN);
    await proposeCorrection(SESSION, P1);   // proposed, never presented

    const result = await confirmCorrection(SESSION, P1.proposalId);

    expect(result.applied).toBe(false);
    expect((await getBoundAddress(SESSION))?.formattedAddress).toBe(CHOSEN.formattedAddress);
    expect((await getPendingCorrection(SESSION))?.proposalId).toBe(P1.proposalId);
  });

  it('keeps the original address when the customer rejects', async () => {
    const result = await rejectCorrection(SESSION, P1.proposalId);

    expect(result).toEqual({ applied: true, address: CHOSEN.formattedAddress });
    expect((await getBoundAddress(SESSION))?.formattedAddress).toBe(CHOSEN.formattedAddress);
    // Answered either way, so a later stale "yes" cannot resurrect it.
    expect(await getPendingCorrection(SESSION)).toBeNull();
  });

  it('refuses a stale rejection, so it cannot discard a NEWER proposal', async () => {
    await bindAddress(SESSION, CHOSEN);
    await proposeCorrection(SESSION, P2);
    await markQuestionDelivered(SESSION, P2.proposalId);

    const result = await rejectCorrection(SESSION, P1.proposalId);

    expect(result.applied).toBe(false);
    expect((await getPendingCorrection(SESSION))?.proposalId).toBe(P2.proposalId);
  });

  it('reports BOTH addresses when it refuses, so the client can re-render', async () => {
    // A question is a choice between two. Handed only "no longer outstanding", a client can show
    // nothing or show the stale choice - and the stale choice is the worse of the two.
    await bindAddress(SESSION, CHOSEN);
    await proposeCorrection(SESSION, P2);
    await markQuestionDelivered(SESSION, P2.proposalId);

    const result = await rejectCorrection(SESSION, P1.proposalId);

    expect(result).toEqual({
      applied: false,
      current: {
        active: { placeId: CHOSEN.placeId, formattedAddress: CHOSEN.formattedAddress },
        pending: expect.objectContaining({ proposalId: P2.proposalId }),
      },
    });
  });

  it('lets a fresh selection supersede an outstanding proposal outright', async () => {
    // Picking again ANSWERS the question, so a late confirmation must not resurrect anything.
    await bindAddress(SESSION, { placeId: 'ChIJ_new', formattedAddress: 'Meir 1, 2000 Antwerpen' });

    expect(await getPendingCorrection(SESSION)).toBeNull();
    expect((await confirmCorrection(SESSION, P1.proposalId)).applied).toBe(false);
  });

  it('says applied with a null address when a booking already took the binding', async () => {
    // `clearAddressBinding` runs on every completed booking, so a customer tapping "keep mine"
    // just after one has nothing left to keep. The route must ingest nothing rather than the
    // string "undefined", which is what a boolean return made easy to get wrong.
    // `presented: true` because the customer can only tap a control that was rendered, and only a
    // presentation renders one. A record with an unpresented proposal is not a state this scenario
    // can reach in production.
    await real.set(
      `addrbind:${SESSION}`,
      JSON.stringify({ active: null, pending: { ...P1, presented: true, presentedByRun: 'run-x' } }),
      'EX',
      600
    );

    const result = await rejectCorrection(SESSION, P1.proposalId);

    expect(result).toEqual({ applied: true, address: null });
  });
});
