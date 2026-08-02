/**
 * Recommended follow-up action — DERIVED from the lead's own facts, never generated.
 *
 * Story 3 asks Enterprise for an "AI recommended follow-up action". This is that
 * feature, and it contains no model call, for the same reasons readiness.ts is not an
 * LLM score:
 *
 *  1. **It cannot fabricate.** Every recommendation is a branch over facts already on
 *     the row and ships the reasons that fired it, so the operator can check the
 *     working. A model asked for "the next step" will happily invent a commitment
 *     nobody made — "call them back about the quote you promised" — and there is no
 *     validation that catches an invented obligation.
 *  2. **A visitor cannot steer it.** See the exclusion below.
 *  3. **It cannot go stale.** Recomputed on every read from the row being projected,
 *     exactly like readiness: the moment a booking is confirmed or a phone number
 *     arrives, the recommendation changes. A stored one would keep telling the operator
 *     to chase a customer who has already booked.
 *
 * Deliberately NOT inputs: `urgency`, `intent` and `tags`. Those are extracted from
 * what the visitor typed, and extractor.service.ts states the rule they live under — an
 * extracted value may COLOUR a row and must never trigger an action. A recommendation
 * IS an action prompt: if `urgency: 'emergency'` could push a lead to "call now", a
 * visitor would reorder the operator's day by typing the word. Priority here comes from
 * the booking state and the platform's own clock, neither of which a visitor can write.
 * Free text (`notes`, `serviceRequested`) is read for PRESENCE only, never for content,
 * so the worst a visitor can do is tell us they have a request — which they do.
 *
 * ADVISORY ONLY, and that is a deliberate limit of this slice: there is no worklist and
 * no `followup_state`, so a recommendation cannot be actioned, dismissed, snoozed or
 * marked done, and nothing here is persisted, queued or notified. It is a read-time
 * suggestion in the lead drawer and nothing else. When the worklist ships, THAT is what
 * gives these an outcome — until then, do not add persistence to this file.
 */

/** Bump when the rules change, so a screenshot of an old recommendation stays readable. */
export const FOLLOWUP_VERSION = 1;

/**
 * A lead still sitting in the inbox after this long is late regardless of what it is
 * about. Drives priority off the platform's clock rather than off anything a visitor
 * can influence.
 */
const WAITING_DAYS = 3;

/**
 * How long after an appointment a check-in is still a follow-up. Past this it is a cold
 * call, and leaving the rule uncapped would pin "check in after the visit" on every
 * historical lead forever — which would make the whole panel noise.
 */
const CHECK_IN_WINDOW_DAYS = 14;

/**
 * Beyond this, a booking is history rather than something to act on. Applies to the two
 * rules that force `priority: 'now'`, which without it fired on every dead booking a
 * tenant had ever taken — an eight-month-old unconfirmed slot rendered as "Today".
 */
const STALE_BOOKING_DAYS = 60;

const DAY_MS = 86_400_000;

export type FollowUpAction =
  /** A booking exists that nobody has confirmed — the customer is waiting on us. */
  | 'confirm_request'
  /** Every booking they had is dead. Lost revenue that can still be won back. */
  | 'win_back_cancelled'
  /** Their appointment time has passed recently. */
  | 'check_in_after_visit'
  /** No booking, but we know what they want. */
  | 'offer_a_time'
  /** No booking and nothing recorded about what they want. */
  | 'ask_what_they_need';

/**
 * The route to use, in the order an SMB actually reaches for: a phone number gets a
 * call; failing that the thread they wrote from is where they will see a reply; email
 * last, because it is the one most likely to go unread.
 */
export type FollowUpVia = 'phone' | 'channel' | 'email';

export type FollowUpPriority = 'now' | 'soon';

export interface FollowUpReason {
  key: string;
  /** English text; the portal uses it as the i18n `defaultValue` for `key`. */
  label: string;
  /** Set only on quantified reasons (`waiting`), so the UI can interpolate it. */
  days?: number;
}

export interface FollowUpRecommendation {
  action: FollowUpAction;
  via: FollowUpVia;
  priority: FollowUpPriority;
  /** Never empty — the rule that fired is always the first reason. */
  reasons: FollowUpReason[];
  version: number;
}

/** Inputs — all facts already on the projected lead row. Nothing inferred. */
export interface FollowUpInput {
  /** Worklist status of the LEAD ('new' | 'archived' | 'erased'), not the booking. */
  status?: string | null;
  phone?: string | null;
  email?: string | null;
  channel?: string | null;
  /** The captured request. Read for presence only. */
  notes?: string | null;
  /** Read for presence only. */
  serviceRequested?: string | null;
  address?: string | null;
  bookingId?: string | null;
  bookingStatus?: string | null;
  /** The booking's start, if it has one. */
  bookingStartAt?: Date | string | null;
  /** When the appointment ENDS. Checking in mid-visit is worse than not checking in. */
  bookingEndAt?: Date | string | null;
  /** Last time anyone actually touched this lead — NOT when the record was created. */
  lastContactAt?: Date | string | null;
  /**
   * Does any row belonging to this PERSON hold a confirmed appointment still ahead of
   * them? Suppresses every chase-them recommendation: the identity is person-scoped
   * (that is the point of repeat detection), so a row-scoped rule would tell an
   * operator to chase a customer who booked through a different channel.
   */
  personHasUpcomingBooking?: boolean;
  /** The server's one definition of "returning" — see leads.routes.ts. */
  isRepeatCustomer?: boolean;
  createdAt?: Date | string | null;
  /** Injected by tests so the rules are not wall-clock dependent. */
  now?: Date;
}

function present(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The one recommendation for this lead, or `null` when the honest answer is nothing.
 *
 * Returning `null` is a first-class outcome, not a failure: a suggestion the operator
 * cannot carry out, or that contradicts a decision they already made, is worse than an
 * empty panel.
 */
export function recommendFollowUp(lead: FollowUpInput): FollowUpRecommendation | null {
  // An operator who marked this handled has already answered the question. Readiness
  // makes a human override terminal for the same reason: the platform does not get to
  // re-open a judgement a person made about their own customer.
  if (lead.status === 'archived' || lead.status === 'erased') return null;

  // No route to the customer, no recommendation. Every action below ends in "contact
  // them", so without a way to do that the answer is nothing at all — not a suggestion
  // that cannot be carried out. A widget visitor who left neither phone nor email is
  // exactly this case: the chat is over and there is nowhere to reply.
  const via: FollowUpVia | null = present(lead.phone)
    ? 'phone'
    : present(lead.channel) && lead.channel !== 'widget'
      ? 'channel'
      : present(lead.email)
        ? 'email'
        : null;
  if (!via) return null;

  const reasons: FollowUpReason[] = [];
  const add = (key: string, label: string, days?: number) =>
    reasons.push({ key, label, ...(days === undefined ? {} : { days }) });

  const now = lead.now ?? new Date();
  // Someone with an appointment in the diary is not waiting to be chased, whichever of
  // their rows this is.
  if (lead.personHasUpcomingBooking) return null;
  const hasBooking = present(lead.bookingId);
  const bookingStatus = lead.bookingStatus ?? null;
  const startAt = toDate(lead.bookingStartAt);

  // Booking state partitions the rules: exactly one branch can match a given row, so
  // "the first rule wins" never hides a second, competing recommendation.
  let action: FollowUpAction;
  if (hasBooking && (bookingStatus === 'pending' || bookingStatus === 'request_created')) {
    // Same staleness reasoning the check-in rule already applied, and it belongs here
    // more: "confirm or decline the slot they asked for" about a slot eight months in
    // the past is the recommendation that embarrasses a tenant in front of a customer.
    if (startAt && now.getTime() - startAt.getTime() > STALE_BOOKING_DAYS * DAY_MS) return null;
    action = 'confirm_request';
    add('booking_unconfirmed', 'They asked for a slot that is still unconfirmed');
    // Only here: an unconfirmed on-site job cannot be confirmed without somewhere to go,
    // and the operator is about to be on the phone to them anyway.
    if (!present(lead.address)) add('no_address', 'No address on the booking');
  } else if (hasBooking && (bookingStatus === 'cancelled' || bookingStatus === 'failed')) {
    // The list query surfaces the most recent NON-cancelled booking first, so a dead
    // status reaching here means EVERY booking this lead has is dead — not that one of
    // several fell through. A cancelled appointment is therefore never mistaken for a
    // completed one: it wins back, it does not check in.
    // A cancellation two years old is history, not a lead to win back.
    if (startAt && now.getTime() - startAt.getTime() > STALE_BOOKING_DAYS * DAY_MS) return null;
    action = 'win_back_cancelled';
    add('booking_cancelled', 'Their booking was cancelled');
  } else if (hasBooking && bookingStatus === 'confirmed') {
    // Nothing to chase until the visit is OVER. Gating on the START time told the
    // operator to ask how it went while the technician was still standing in the
    // customer's kitchen — the appointment's own end time is right there on the
    // booking, so use it and fall back to the start only when it is missing.
    const endAt = toDate(lead.bookingEndAt) ?? startAt;
    if (!endAt || endAt > now) return null;
    if (now.getTime() - endAt.getTime() > CHECK_IN_WINDOW_DAYS * DAY_MS) return null;
    action = 'check_in_after_visit';
    add('visit_passed', 'Their appointment time has passed');
  } else if (hasBooking) {
    // Unreachable while BookingStatus is the closed union it is today; kept as the
    // fail-closed landing for a status added later. Saying nothing is the right
    // response to a state whose meaning these rules do not know.
    return null;
  } else if (present(lead.notes) || present(lead.serviceRequested)) {
    action = 'offer_a_time';
    add('request_known', 'They told us what they need');
  } else {
    action = 'ask_what_they_need';
    add('no_request', 'Nothing recorded about what they need');
  }

  add(
    `reach_${via}`,
    via === 'phone'
      ? 'Phone number on file'
      : via === 'channel'
        ? 'Reachable in the thread they wrote from'
        : 'Email address on file',
  );

  if (lead.isRepeatCustomer) add('returning', 'Returning customer');

  // Time since anyone last TOUCHED this lead, falling back to when it arrived. Reading
  // `createdAt` measured record age instead: the list is sorted newest-first and most
  // rows on a mature account are older than the threshold, so nearly every
  // recommendation rendered the red "Today" badge, and a lead answered yesterday but
  // created 400 days ago read "Today · Open for 400 days".
  const since = toDate(lead.lastContactAt) ?? toDate(lead.createdAt);
  const waitingDays = since ? Math.floor((now.getTime() - since.getTime()) / DAY_MS) : 0;
  const waiting = waitingDays >= WAITING_DAYS;
  if (waiting) add('waiting', 'No contact for {{days}} days', waitingDays);

  return {
    action,
    via,
    // An unconfirmed slot and a cancellation are both "the customer is waiting on you
    // right now"; so is a lead nobody has touched in days. Nothing else is urgent, and
    // nothing a visitor types can reach this line.
    priority:
      action === 'confirm_request' || action === 'win_back_cancelled' || waiting ? 'now' : 'soon',
    reasons,
    version: FOLLOWUP_VERSION,
  };
}
