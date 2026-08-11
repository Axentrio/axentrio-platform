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
 */
export async function proposeCorrection(
  sessionId: string,
  proposal: PendingCorrection
): Promise<void> {
  const current = await read(sessionId);
  await write(sessionId, { active: current.active, pending: proposal });
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
 * silently inherit the first one's address, and when the session closes.
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
