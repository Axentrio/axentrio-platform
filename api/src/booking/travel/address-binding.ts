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
   * WHICH agent run asked, which is the only way to know whether the customer has seen it.
   *
   * A run is one customer message. The model may emit several tool calls inside it and they are
   * executed back to back with no customer in between, so "we already asked" is not true yet -
   * the question is sitting in a tool result nobody has read. Without this, a `create_booking`
   * queued behind the one that just asked finds the question already spent and books immediately,
   * which is the original defect wearing the fix's clothes.
   *
   * So the refusal stands for as long as the presentation belongs to THIS run, and lifts on the
   * next one - by which time the customer has genuinely been shown the question and had their
   * turn to answer it.
   */
  presentedByRun?: string;
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
 * May this caller ask the customer about this proposal? Spends the question if so.
 *
 * True while the question is unasked, or was asked by THIS run and therefore has not reached the
 * customer yet. False once a different run has asked - which is the moment the customer has had
 * their turn, and from then on the booking proceeds against the address they chose.
 *
 * That is what keeps the promise that a Pending Correction "never blocks them from booking":
 * asking is one refusal, not a wall. A customer whose address Google cannot suggest - a new build,
 * a renamed street - is asked once, cannot usefully answer, and still gets their appointment.
 *
 * Two things had to be separated to make this work, and they are separated by design rather than
 * by accident:
 *
 *   proposing    every booking tool does it, because every one resolves an address.
 *   asking       exactly one tool can, because the other two must not refuse.
 *
 * Counting proposals instead of questions is what let `check_availability` spend the customer's
 * only question by saying nothing.
 */
export async function claimPresentation(
  sessionId: string,
  proposalId: string,
  runId: string
): Promise<boolean> {
  const current = await read(sessionId);
  if (!current.pending || current.pending.proposalId !== proposalId) return false;
  // Already asked, and the customer has since had a turn. Get on with it.
  if (current.pending.presented && current.pending.presentedByRun !== runId) return false;
  // Either nobody has asked, or this same run did - and a run is one customer message, so they
  // have not seen it yet. Keep refusing until they have.
  await write(sessionId, {
    active: current.active,
    pending: { ...current.pending, presented: true, presentedByRun: runId },
  });
  return true;
}

/**
 * The customer said yes to a specific proposal.
 *
 * Returns false when the id does not match what is outstanding, which is exactly the stale case:
 * the answer arrived after the customer proposed something else, or after the record expired.
 * Promotion REPLACES the active binding in one write and never deletes the record - deleting
 * would throw away the binding this call exists to install.
 */
export async function confirmCorrection(sessionId: string, proposalId: string): Promise<boolean> {
  const current = await read(sessionId);
  if (!current.pending || current.pending.proposalId !== proposalId) return false;
  await write(sessionId, {
    active: { placeId: current.pending.placeId, formattedAddress: current.pending.formattedAddress },
    pending: null,
  });
  return true;
}

/** The customer said no. The address they already chose stands. */
export async function rejectCorrection(sessionId: string, proposalId: string): Promise<boolean> {
  const current = await read(sessionId);
  if (!current.pending || current.pending.proposalId !== proposalId) return false;
  await write(sessionId, { active: current.active, pending: null });
  return true;
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
