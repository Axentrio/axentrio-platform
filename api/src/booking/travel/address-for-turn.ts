/**
 * Which address a booking tool should actually use, given what the model passed it.
 *
 * The model is not the customer. Its `customerAddress` argument is a reconstruction from the
 * conversation, and it can reformat, abbreviate, hallucinate, or silently omit. When a customer
 * has PICKED an address, that choice is a better source than any of that - so this decides
 * between them, in one place, for all three booking tools.
 *
 * The rule, in order:
 *
 *   no binding                  use whatever the model passed. This is every conversation today.
 *   binding, no argument        use the binding. Omission is not a customer changing their mind.
 *   binding, same place         use the binding. A reformat is not a change.
 *   binding, different place    use the binding, and RECORD A PROPOSAL. Something suggested a
 *                               different address; only the customer can settle that.
 *
 * The last line is the one worth defending. Treating a differing argument as a change would let a
 * hallucinated-but-plausible address silently replace a real choice, and the customer would find
 * out when somebody knocked on the wrong door. Treating it as a proposal costs one confirmation
 * and cannot be wrong.
 */
import { createHash } from 'node:crypto';
import { getBoundAddress, proposeCorrection } from './address-binding';
import { logger } from '../../utils/logger';

export interface TurnAddress {
  /** What the tool should book or check against. */
  address: string | undefined;
  /** Google's identity for it, when the customer chose it. */
  placeId?: string;
  /**
   * True when the model's argument named a DIFFERENT place and is waiting on the customer.
   *
   * A statement about the STATE - this turn's address is contested - and not an instruction to
   * ask. Whether asking is allowed is a separate question with a separate owner
   * (`claimPresentation`), because three tools reach this code and only one of them can ask.
   */
  correctionPending: boolean;
  /**
   * Which proposal is outstanding, when one is.
   *
   * Needed by whoever asks: a question the customer can answer has to carry the id of the
   * question, or a late answer settles one they have already left behind.
   */
  proposalId?: string;
  /**
   * The address being proposed, when one is.
   *
   * Carried because a question is a CHOICE between two, and whoever renders it needs both. Handed
   * only the bound address, a client has to reconstruct the other option from the conversation -
   * which is the model defining the options again, and the entire binding design exists to refuse
   * exactly that.
   */
  proposedAddress?: string;
}

/** Case, punctuation and spacing carry no meaning in an address comparison. */
const normalise = (value: string) =>
  value.trim().toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

/** Exactly equal once normalised. */
const sameText = (a: string, b: string) => normalise(a) === normalise(b);

/**
 * The parts a model rewrites without meaning anything by it: a trailing country, a postcode, the
 * order of town and code. Stripping them leaves street and town, which is what actually decides
 * whether two strings are the same doorway.
 */
const CO_INCIDENTAL = /\b(belgium|belgie|belgië|be)\b|\b\d{4}\b/g;

/**
 * The door number, which is the one token forgiveness may never touch.
 *
 * Taken as the FIRST number in the string, which covers both the Belgian order ("Kerkstraat 12")
 * and the anglophone one ("12 Church Street"). Read off the normalised text rather than the
 * stripped `core`, because `CO_INCIDENTAL` deletes any four-digit token to forgive a dropped
 * postcode - and a four-digit HOUSE number is indistinguishable from one. Reading it first is
 * what stops "Straatweg 1234" and "Straatweg 5678" from both collapsing to "straatweg".
 */
const doorNumber = (value: string): string | null =>
  normalise(value).match(/\b\d{1,4}[a-z]?\b/)?.[0] ?? null;

const looksLikeSameAddress = (a: string, b: string) => {
  if (sameText(a, b)) return true;

  // TWO DIFFERENT DOORS ARE NEVER THE SAME ADDRESS, whatever the rest of the string does.
  //
  // This guard runs before any forgiveness because containment is blind to it: "kerkstraat 12"
  // contains "kerkstraat 1", so a neighbour's door passed as a harmless reformat and the whole
  // proposal mechanism never fired. That is the exact wrong-door failure this file exists to
  // prevent, produced by the code meant to prevent it.
  //
  // Only when BOTH sides state a number. A model that drops it entirely has said less, not
  // something different, and that case is what the containment below is for.
  const [da, db] = [doorNumber(a), doorNumber(b)];
  if (da && db && da !== db) return false;

  // When only ONE side names a door, drop it from both before comparing. "Grote Markt, Antwerpen"
  // against "Grote Markt 1, Antwerpen" is the model being vaguer, not the customer moving - and
  // forgiving it keeps the BOUND address, which is the precise one. Proposing instead would ask a
  // customer to confirm an address they never touched, and answer it with the vaguer of the two.
  const dropDoor = !da || !db;
  const core = (v: string) => {
    let out = normalise(v).replace(CO_INCIDENTAL, ' ');
    if (dropDoor) out = out.replace(/\b\d{1,4}[a-z]?\b/, ' ');
    return out.replace(/\s+/g, ' ').trim();
  };
  const [x, y] = [core(a), core(b)];
  if (!x || !y) return false;
  // Containment rather than equality: "Grote Markt 1 Antwerpen" against "Grote Markt 1" is the
  // model dropping the town, not the customer moving.
  return x === y || x.includes(y) || y.includes(x);
};

/**
 * A short, stable token for the address a booking tool is actually about to use.
 *
 * It exists to go in an idempotency key, and the bug it closes is worth stating because the key
 * looked complete without it. `request_appointment:<session>:<service>:<time>` names everything
 * the model chose EXCEPT where the van goes - so a customer who gave one address, then corrected
 * it for the same slot, produced the same key. The second call found the first row, returned it as
 * a success, and threw the new address away. Live on production this told a customer their
 * appointment in Antwerp was confirmed while the only row said Liège, unconfirmed.
 *
 * A changed address must therefore be a DIFFERENT request, not a duplicate of the old one. That
 * keeps #35's reason for a stable key - a re-confirm of the same facts still dedupes - while
 * denying it the one case where the facts changed.
 *
 * `place_id` first, because it is the identity the customer picked and survives reformatting;
 * otherwise the normalised text, which is the same comparison `looksLikeSameAddress` starts from.
 * Hashed and truncated so a long address cannot push the key past `idempotency_key`'s varchar(255).
 *
 * A service that needs no address yields a constant, so nothing changes for the bookings that
 * never had this problem.
 */
export function addressToken(turn: Pick<TurnAddress, 'address' | 'placeId'>): string {
  const picked = turn.placeId?.trim();
  const typed = turn.address ? normalise(turn.address) : '';
  // DOMAIN-SEPARATED. Without the prefix a place id and an address string share one input space,
  // so a collision between them is a collision between two different KINDS of claim. It costs
  // nothing and removes a whole class of false equality.
  const identity = picked ? `place:${picked}` : typed ? `text:${typed}` : '';
  if (!identity) return 'noaddr';
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

export async function addressForTurn(
  sessionId: string,
  modelArgument: string | undefined
): Promise<TurnAddress> {
  const bound = await getBoundAddress(sessionId);

  // No choice has been made, so there is nothing to protect and nothing to second-guess.
  if (!bound) return { address: modelArgument, correctionPending: false };

  const typed = modelArgument?.trim();
  if (!typed || sameText(typed, bound.formattedAddress)) {
    return { address: bound.formattedAddress, placeId: bound.placeId, correctionPending: false };
  }

  // Different TEXT is not necessarily a different PLACE, and this cannot tell them apart with
  // certainty. Resolving the argument would say for sure - but `geocodeAddress` deliberately
  // demands an `ActiveTravelEligibility`, because that argument being unforgeable is the one
  // thing standing between a runaway caller and a Google bill. Weakening that gate to sharpen a
  // comparison would trade a real protection for a nicety.
  //
  // So the comparison is textual, and it is normalised hard: case, punctuation, the country
  // suffix and the postcode all come off, because those are exactly what a model rewrites when
  // it is NOT changing the address. What survives is street and town.
  //
  // The asymmetry justifies the imprecision. A false proposal costs one confirmation question. A
  // missed one sends a van to the wrong door and nobody finds out until it arrives.
  if (looksLikeSameAddress(typed, bound.formattedAddress)) {
    return { address: bound.formattedAddress, placeId: bound.placeId, correctionPending: false };
  }

  // THE ID NAMES THE QUESTION, AND A QUESTION IS A PAIR.
  //
  // It used to hash the proposed text alone, which made "is it A or B?" and "is it C or B?" the
  // same id. Verified failing against production on 2026-08-13: the customer picked C, the model
  // proposed B again, and a control left on screen from the FIRST question answered the second -
  // moving the binding to an address they had not been asked about since changing their mind. The
  // design promised the opposite: a superseded proposal was supposed to match nothing.
  //
  // Both sides go in, so a different bound address is a different question. The bound identity is
  // preferred over its spelling because that is what the customer actually picked and it survives
  // reformatting.
  //
  // STILL DETERMINISTIC, and that is not incidental. A random id would close this and reopen
  // something worse: the turn coalescer re-runs the same customer message after a processor error,
  // and the design relies on that replay producing the SAME proposal rather than a fresh question
  // nobody saw. Determinism over the pair keeps both properties.
  const proposalId = createHash('sha256')
    .update(`${bound.placeId || normalise(bound.formattedAddress)}|${normalise(typed)}`)
    .digest('hex')
    .slice(0, 16);
  await proposeCorrection(sessionId, {
    proposalId,
    // NO PLACE ID. Nothing has been verified yet; that happens if and when the customer confirms
    // through `/places/select`, which resolves properly. A proposal is a question, not a place.
    placeId: '',
    formattedAddress: typed,
  });
  logger.info('[Travel] a booking tool named a different address than the customer chose', {
    sessionId,
    // The identity only. Both sides of this comparison are somebody's home address.
    chosen: bound.placeId,
  });

  return {
    address: bound.formattedAddress,
    placeId: bound.placeId,
    // CONTESTED, WHICH IS NOT THE SAME AS "ASK NOW".
    //
    // This used to report `isNew` from `proposeCorrection` - whether the PROPOSAL was new - and
    // callers read it as permission to ask. That works only while every proposer also asks, and it
    // stopped being true the moment a second tool called this function. All three booking tools do,
    // so `check_availability` proposed first, took the `true`, said nothing, and `create_booking`
    // then found the proposal already outstanding and booked without asking. The one question the
    // design allows was spent on silence, every single time a model checked times before booking.
    //
    // So this is now a fact about the STATE, true for as long as the question is unanswered, and
    // the cap moved to `claimPresentation` - which is owned by the one tool that can actually ask.
    // "Asked once, then we get on with it" is still the rule; it is just counted where the asking
    // happens rather than where the proposing happens.
    correctionPending: true,
    proposalId,
    proposedAddress: typed,
  };
}
