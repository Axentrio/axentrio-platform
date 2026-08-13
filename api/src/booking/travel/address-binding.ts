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
  /**
   * The binding this question is ABOUT, as the caller saw it.
   *
   * `proposalId` hashes bound+proposed, so a proposal only means anything beside the active address
   * it was derived from. Carried so the write can refuse when the customer picked something else in
   * between - otherwise "A or B?" is stored against an active of C, and "keep mine" keeps a third
   * address the control never named. Both fields, because a binding is identified by its place id
   * when it has one and by its verified spelling when it does not.
   */
  expectedActivePlaceId?: string;
  expectedActiveAddress?: string;
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
const PROPOSE_LUA = `
local raw = redis.call('GET', KEYS[1])
local rec = { active = cjson.null, pending = cjson.null }
if raw then rec = cjson.decode(raw) end
local active = rec.active
local pending = rec.pending
if active == nil then active = cjson.null end
if pending == nil then pending = cjson.null end
if pending ~= cjson.null and pending.presented == true then
  return '0'
end
-- THE PROPOSAL MUST BELONG TO THE ACTIVE ADDRESS IT WAS DERIVED FROM.
--
-- proposalId hashes bound+proposed, and the caller computed it from the binding it read a moment
-- earlier. If the customer picked a different address in between, writing the proposal beside the
-- NEW active stores the question "A or B?" against an active of C - so "keep mine" retains C while
-- the control says A, and the booking goes to a door the customer was never offered.
--
-- Compared on the same terms the caller used: its place id when the binding has one, its verified
-- spelling when it does not. (No backticks in here - this is a JS template literal.)
local okActive = false
if active ~= cjson.null then
  local pid = active.placeId
  if pid ~= nil and pid ~= '' then
    okActive = (pid == ARGV[5])
  else
    okActive = (active.formattedAddress == ARGV[6])
  end
end
if not okActive then
  return '0'
end
local isNew = '1'
if pending ~= cjson.null and pending.proposalId == ARGV[1] then isNew = '0' end
redis.call('SET', KEYS[1], cjson.encode({
  active = active,
  pending = { proposalId = ARGV[1], placeId = ARGV[2], formattedAddress = ARGV[3] }
}), 'EX', ARGV[4])
return isNew
`;

export async function proposeCorrection(
  sessionId: string,
  proposal: PendingCorrection
): Promise<{ isNew: boolean }> {
  const redis = getRedisClient();
  if (!redis) return { isNew: false };
  try {
    // ATOMIC, like the transitions, and for the same reason. Read-then-write here could overwrite
    // an answer committed in between: it reads {A, P}, the customer confirms and the transition
    // commits {B, null}, and the delayed write puts {A, P} back - the answer lost and a settled
    // question restored. The script also keeps the rule that a DELIVERED question is not replaced
    // behind the customer's back, which the JS version enforced separately.
    const out = (await redis.eval(
      PROPOSE_LUA, 1, key(sessionId),
      proposal.proposalId, proposal.placeId, proposal.formattedAddress, String(TTL_SECONDS),
      // The binding this proposal is a question ABOUT. If it moved between the caller reading it
      // and this script running, the question no longer applies and nothing is written.
      proposal.expectedActivePlaceId ?? '',
      proposal.expectedActiveAddress ?? ''
    )) as string;
    return { isNew: out === '1' };
  } catch (error) {
    logger.warn('[Travel] address proposal failed', { sessionId, error });
    return { isNew: false };
  }
}

/**
 * The question actually REACHED the customer.
 *
 * Called when the reply carrying the control is persisted, which is the only moment anything can
 * honestly claim they were asked. This used to be set when the tool DECIDED to ask, and the two are
 * different events: a run that dies in between leaves the flag set with nothing on screen, and the
 * transition - which trusts the flag - would then accept an answer to a question nobody saw.
 *
 * Moving it here also removed the need to ask Postgres the same question, and with it a fail-open
 * SQL path whose two possible guesses were "re-ask every turn and wedge them" or "book in silence".
 * One fact, one store, one failure mode.
 */
const DELIVERED_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '0' end
local rec = cjson.decode(raw)
local pending = rec.pending
if pending == nil or pending == cjson.null or pending.proposalId ~= ARGV[1] then return '0' end
pending.presented = true
local active = rec.active
if active == nil then active = cjson.null end
redis.call('SET', KEYS[1], cjson.encode({ active = active, pending = pending }), 'EX', ARGV[2])
return '1'
`;

export async function markQuestionDelivered(sessionId: string, proposalId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.eval(DELIVERED_LUA, 1, key(sessionId), proposalId, String(TTL_SECONDS));
  } catch (error) {
    // Unmarked reads as "not asked yet", so the next turn asks again. One extra question, never a
    // silent booking - the safe direction of the two.
    logger.warn('[Travel] could not mark the address question delivered', { sessionId, error });
  }
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
