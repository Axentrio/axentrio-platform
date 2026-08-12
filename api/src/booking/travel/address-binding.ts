/**
 * Which address this conversation is about, and who is allowed to change that answer.
 *
 * A customer who picks an address from suggestions has told us something precise. Everything
 * after that - which slots are reachable, which one gets confirmed - has to be about THAT place,
 * and about no other. Holding the choice is the easy half.
 *
 * ## Why the model may not change it
 *
 * The obvious design threads a `place_id` through the booking tools and lets the model pass it
 * along. It cannot work. Tool arguments are written by the LLM, so a place id in a tool schema is
 * a value it can hallucinate, copy from an earlier customer, or quietly drop - and none of those
 * are distinguishable from the customer changing their mind. The same objection defeats the
 * subtler versions: comparing the argument's TEXT to the bound address breaks when the model
 * harmlessly reformats it, and comparing resolved PLACE IDS is better but still asks a
 * model-written value what the customer intended.
 *
 * So the binding is a small state machine, and only events the SERVER observed move it:
 *
 *   selected            a customer chose an address. Authoritative.
 *   correction proposed something suggested a different place. Changes nothing on its own.
 *   replaced            the customer confirmed, or picked again. The only way out of `selected`.
 *
 * A tool call carrying a different address PROPOSES; it never replaces. A tool call carrying no
 * address leaves the binding standing, which is correct - no customer said otherwise.
 *
 * ## Why it holds an identity and not a place
 *
 * `{ placeId, formattedAddress }`, never coordinates. ADR-0014 permits latitude and longitude for
 * 30 consecutive days and `coordinate-retention.service` sweeps the columns that hold them; a
 * Redis value carrying a point would be a fourth place they live, with no timestamp and no sweep.
 * A `place_id` may be kept indefinitely, and the point is re-derived from it through the geocode
 * cache whenever it is needed. Identity survives; position is borrowed.
 */
import { getRedisClient } from '../../config/redis';
import { logger } from '../../utils/logger';

/**
 * Thirty-five minutes.
 *
 * Anchored to a real number rather than chosen: `server.ts` auto-closes a session after 30
 * minutes of inactivity, swept every 5. Anything shorter would drop the address out from under a
 * conversation the platform still considers live. It is refreshed on every customer message, so
 * this measures SILENCE, not the age of the choice - a customer forty minutes into a booking has
 * not lost their address.
 */
const TTL_SECONDS = 35 * 60;

export interface BoundAddress {
  placeId: string;
  formattedAddress: string;
}

export interface PendingCorrection extends BoundAddress {
  /**
   * Which proposal an answer is answering.
   *
   * Without it, a confirmation is just "yes" - and "yes" arriving late, after the customer has
   * proposed something else, would promote the address they abandoned. The same applies to a
   * rejection: a stale "no" would discard a newer proposal.
   */
  proposalId: string;
  /**
   * Has the customer actually been ASKED about this proposal?
   *
   * The one-shot cap is a promise about questions, not about proposals, and conflating them is
   * what made the question unaskable. Every booking tool calls `addressForTurn` and therefore
   * proposes, but only one of them can ask - so counting proposals spent the single question on a
   * tool that says nothing, and the customer was never asked at all.
   *
   * Set by `claimPresentation`, which is the only thing entitled to spend it.
   */
  presented?: boolean;
}

interface Record_ {
  active: BoundAddress | null;
  pending: PendingCorrection | null;
}

const key = (sessionId: string) => `addrbind:${sessionId}`;

async function read(sessionId: string): Promise<Record_> {
  const redis = getRedisClient();
  if (!redis) return { active: null, pending: null };
  try {
    const raw = await redis.get(key(sessionId));
    if (!raw) return { active: null, pending: null };
    const parsed = JSON.parse(raw) as Partial<Record_>;
    return { active: parsed.active ?? null, pending: parsed.pending ?? null };
  } catch (error) {
    // A binding we cannot read is a binding we do not have. The booking falls back to the
    // free-text path that has always existed, which is the whole fail-open contract.
    logger.warn('[Travel] address binding read failed', { sessionId, error });
    return { active: null, pending: null };
  }
}

async function write(sessionId: string, value: Record_): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    // ONE write for both fields. Promoting a pending correction has to be a single operation, or
    // a crash between two writes leaves a session with the new address active AND still pending.
    await redis.set(key(sessionId), JSON.stringify(value), 'EX', TTL_SECONDS);
  } catch (error) {
    logger.warn('[Travel] address binding write failed', { sessionId, error });
  }
}

/** The address this conversation is currently about, if the customer has chosen one. */
export async function getBoundAddress(sessionId: string): Promise<BoundAddress | null> {
  return (await read(sessionId)).active;
}

/** What is waiting on a yes or no, if anything. */
export async function getPendingCorrection(sessionId: string): Promise<PendingCorrection | null> {
  return (await read(sessionId)).pending;
}

/**
 * The customer picked an address. This is the only way in, and it wins outright.
 *
 * Any outstanding proposal is dropped: choosing again ANSWERS the question, so leaving a
 * proposal behind would let a later confirmation resurrect an address the customer moved past.
 */
export async function bindAddress(sessionId: string, address: BoundAddress): Promise<void> {
  await write(sessionId, { active: address, pending: null });
}

/**
 * Something suggested a different address. Note it; change nothing.
 *
 * Supersedes any previous proposal atomically, so exactly one is ever outstanding and a stale
 * `proposalId` stops matching the moment a newer one exists.
 *
 * RETURNS WHETHER THIS PROPOSAL IS NEW, and that return value is what caps the question at one.
 * Asking a customer to confirm an address is reasonable once; asking on every turn until they
 * happen to use a picker they may not even have is a customer who can never book. So the caller
 * raises the question the first time a given address is proposed and proceeds on every repeat.
 *
 * Keyed on the proposal rather than counted, because counting is not retry-safe: the turn
 * coalescer re-runs the SAME customer message after a processor error, and a counter would spend
 * the single question on a retry nobody saw. The same message yields the same `proposalId`, so a
 * replay is indistinguishable from a repeat - which is exactly the behaviour wanted.
 */
export async function proposeCorrection(
  sessionId: string,
  proposal: PendingCorrection
): Promise<{ isNew: boolean }> {
  const current = await read(sessionId);
  const isNew = current.pending?.proposalId !== proposal.proposalId;

  // A QUESTION THE CUSTOMER IS LOOKING AT MAY NOT BE REPLACED BEHIND THEIR BACK.
  //
  // Superseding is right for a proposal nobody has seen - it is how a customer restating their
  // address stops an older suggestion from mattering. It is wrong the moment they have been ASKED,
  // because the buttons are already on their screen: replacing the proposal underneath them turns
  // their next tap into "that question no longer exists", for a question they were asked seconds
  // ago and never got to answer.
  //
  // `check_availability` is why this is not hypothetical. It is read-only and the model may call
  // it speculatively, with an address it reconstructed - so without this guard, a speculative call
  // naming a third address would quietly invalidate a live question.
  //
  // A presented proposal is released by an ANSWER, by the customer picking again (`bindAddress`),
  // or by expiry. Nothing else, and never as a side effect of the model calling a tool.
  // `isNew: false` in both cases, and deliberately: nothing new was recorded, whether the caller
  // named the same address or a different one. A caller reading this as "go ahead and ask" would
  // be asking about a proposal that was not stored.
  if (current.pending?.presented) return { isNew: false };

  await write(sessionId, { active: current.active, pending: proposal });
  return { isNew };
}

/**
 * Mark this proposal as ASKED, so the transition will accept an answer to it.
 *
 * Records only that the server put the question; it does NOT decide whether asking is allowed.
 * That decision needs to know whether the customer ever saw the last attempt, which is a fact
 * about persisted replies rather than about this record - see `question-delivery.ts`, and the list
 * of three guards that each named something adjacent to it.
 *
 * `presented` is what the confirm/reject transition requires. Without it the transition keyed on
 * `proposalId` alone, and that id is a hash of the two addresses - reproducible by anyone who knows
 * them, so it proved nothing about whether a question was ever put.
 */
/**
 * KNOWN, AND TRACKED WITH ITS TWO SIBLINGS: read-then-write, like `proposeCorrection` and
 * `bindAddress`. A write committed in between is lost - a claim that reads {A, P} while the
 * customer's confirmation commits {B, null} puts {A, P} back, discarding the answer and restoring
 * a question they have already settled.
 *
 * Briefly converted to a Lua CAS and reverted. Converting ONE of the three writers does not close
 * the class, and every unit test of the booking tools holds its binding state in a Map standing in
 * for Redis - which has no `eval`, so the conversion silently disabled the question in eight of
 * them. The three want doing together, against real Redis, as one piece of work rather than as a
 * side effect of an unrelated fix.
 *
 * The TRANSITIONS are already atomic, which is the half that decides where a van goes.
 */
export async function claimPresentation(sessionId: string, proposalId: string): Promise<boolean> {
  const current = await read(sessionId);
  if (!current.pending || current.pending.proposalId !== proposalId) return false;
  await write(sessionId, {
    active: current.active,
    pending: { ...current.pending, presented: true },
  });
  return true;
}

/**
 * What a transition did, and enough for the caller to act without reading again.
 *
 * A boolean was not enough for either branch. On success the caller needs the address that was
 * COMMITTED - the widget route used to ingest a value it had read before the transition, so what
 * the model was told could differ from what was stored. On failure the client needs to re-render,
 * and "no longer outstanding" names neither the current question nor either address, so a client
 * handed only that can either show nothing or show the stale choice.
 */
export type TransitionResult =
  | { applied: false; current: { active: BoundAddress | null; pending: PendingCorrection | null } }
  | { applied: true; address: string | null };

/**
 * Read, compare and write in ONE round trip, because three steps against one key is not a
 * transition - it is a race with a good success rate.
 *
 * The window is real and the loser is always the customer. `confirmCorrection` used to GET the
 * record, check the proposal id, and SET the result. A `proposeCorrection` or a `bindAddress`
 * landing in between was then overwritten by a decision made before it existed: the confirmation
 * promoted a proposal the customer had already moved past, and their newer question vanished with
 * no error anywhere. That is precisely the failure `proposalId` exists to prevent, reintroduced one
 * layer underneath it.
 *
 * `EVAL` is the smallest thing that fixes it. Redis runs the script atomically, so no write can
 * land between the read and the write - there is no between.
 *
 * NOT applied to `proposeCorrection` or `claimPresentation`, deliberately. Their worst case is a
 * duplicate question or a proposal recorded twice, which costs the customer one extra tap; the
 * transitions' worst case is losing the answer they gave. Extending it there is worth doing and is
 * not worth blocking this on.
 *
 * `cjson.null` rather than absent keys throughout: an empty Lua table encodes ambiguously, and
 * indexing a null would error, so both fields are always present and always compared explicitly.
 */
const TRANSITION_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return cjson.encode({ applied = false, current = { active = cjson.null, pending = cjson.null } })
end
local rec = cjson.decode(raw)
local active = rec.active
local pending = rec.pending
if active == nil then active = cjson.null end
if pending == nil then pending = cjson.null end
-- THE ID NAMES THE QUESTION; presented IS THE EVIDENCE IT WAS ASKED.
--
-- Keyed on the id alone, this answered questions nobody had been shown. Verified against
-- production on 2026-08-13: a proposal that check_availability had merely RECORDED was confirmed
-- by a caller who derived its id, and the binding moved. proposalId is a hash of the addresses,
-- so it is reproducible by anyone who knows them - it identifies WHICH question, and identifies
-- nothing about whether it was ever put to the customer.
--
-- Only claimPresentation sets this, and only create_booking calls that. So the flag is the
-- server's own record that it asked, which is the evidence this design requires and the id never
-- was. (No backticks in here: this is a JS template literal.)
if pending == cjson.null or pending.proposalId ~= ARGV[1] or pending.presented ~= true then
  return cjson.encode({ applied = false, current = { active = active, pending = pending } })
end
local newActive = active
if ARGV[2] == '1' then
  newActive = { placeId = pending.placeId, formattedAddress = pending.formattedAddress }
end
redis.call('SET', KEYS[1], cjson.encode({ active = newActive, pending = cjson.null }), 'EX', ARGV[3])
local addr = cjson.null
if newActive ~= cjson.null then addr = newActive.formattedAddress end
return cjson.encode({ applied = true, address = addr })
`;

async function transition(
  sessionId: string,
  proposalId: string,
  confirmed: boolean
): Promise<TransitionResult> {
  const redis = getRedisClient();
  // No store is no binding, which is the same fail-open every read here takes: the booking falls
  // back to the free-text path that has always existed.
  if (!redis) return { applied: false, current: { active: null, pending: null } };
  try {
    const raw = (await redis.eval(
      TRANSITION_LUA,
      1,
      key(sessionId),
      proposalId,
      confirmed ? '1' : '0',
      String(TTL_SECONDS)
    )) as string;
    return JSON.parse(raw) as TransitionResult;
  } catch (error) {
    // Reported as "nothing outstanding" rather than thrown. The customer's tap did nothing, which
    // is what they will be told - and telling them that is honest, where an error page about a
    // question they answered correctly is not.
    logger.warn('[Travel] address transition failed', { sessionId, error });
    return { applied: false, current: { active: null, pending: null } };
  }
}

/**
 * The customer said yes to a specific proposal.
 *
 * Not applied when the id does not match what is outstanding, which is exactly the stale case: the
 * answer arrived after the customer proposed something else, or after the record expired. Promotion
 * REPLACES the active binding and never deletes the record - deleting would throw away the binding
 * this call exists to install.
 */
export function confirmCorrection(sessionId: string, proposalId: string): Promise<TransitionResult> {
  return transition(sessionId, proposalId, true);
}

/** The customer said no. The address they already chose stands. */
export function rejectCorrection(sessionId: string, proposalId: string): Promise<TransitionResult> {
  return transition(sessionId, proposalId, false);
}

/**
 * Forget this conversation's address entirely.
 *
 * Called when a booking or a Request completes, so a second booking in the same session cannot
 * silently inherit the first one's address - a customer booking two jobs at two addresses is
 * ordinary, and the second would otherwise be sent to the first one's door.
 *
 * NOT called on session close, deliberately. The auto-close sweep in `server.ts` is raw SQL that
 * bypasses the entity layer, so a hook there would be a fifth thing to remember rather than a
 * guarantee - and the TTL below already outlives the close by five minutes. Saying so beats
 * wiring a call that looks load-bearing and is not.
 */
export async function clearAddressBinding(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(key(sessionId));
  } catch (error) {
    logger.warn('[Travel] address binding clear failed', { sessionId, error });
  }
}

/** Keep a live conversation's address alive. The window measures silence, not age. */
export async function touchAddressBinding(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.expire(key(sessionId), TTL_SECONDS);
  } catch {
    // Losing a refresh costs at most one early expiry, and expiry is a fallback, not a failure.
  }
}
