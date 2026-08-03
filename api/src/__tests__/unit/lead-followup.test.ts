/**
 * The recommended follow-up action.
 *
 * The properties worth pinning are the ones that keep an action prompt about someone's
 * customer defensible: exactly one rule fires per set of facts, a dead booking is never
 * read as a completed one, a lead nobody can contact gets silence rather than a
 * suggestion, and nothing a visitor types can change what the operator is told to do.
 */
import { describe, it, expect } from 'vitest';
import { recommendFollowUp, FOLLOWUP_VERSION } from '../../leads/followup';

/** Fixed clock — the rules are time-sensitive and must not be wall-clock dependent. */
const NOW = new Date('2026-07-01T12:00:00.000Z');
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

/** A reachable, otherwise featureless lead. Each test adds only the facts it is about. */
const base = { phone: '32475464421', status: 'new', now: NOW } as const;

const keys = (r: { reasons: Array<{ key: string }> } | null) =>
  (r?.reasons ?? []).map((x) => x.key);

describe('recommendFollowUp — one rule per set of facts', () => {
  it('confirm_request fires on a booking nobody has confirmed', () => {
    for (const bookingStatus of ['pending', 'request_created']) {
      const r = recommendFollowUp({ ...base, bookingId: 'bk-1', bookingStatus });
      expect(r?.action).toBe('confirm_request');
      expect(keys(r)).toContain('booking_unconfirmed');
      // The customer is waiting on us, so this is never "sometime this week".
      expect(r?.priority).toBe('now');
    }
  });

  it('confirm_request says when the booking has no address, and only then', () => {
    const withoutAddress = recommendFollowUp({ ...base, bookingId: 'bk-1', bookingStatus: 'pending' });
    const withAddress = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'pending',
      address: 'Kerkstraat 12, 2000 Antwerpen',
    });
    expect(keys(withoutAddress)).toContain('no_address');
    expect(keys(withAddress)).not.toContain('no_address');
  });

  it('win_back_cancelled fires on a cancelled or failed booking', () => {
    for (const bookingStatus of ['cancelled', 'failed']) {
      const r = recommendFollowUp({ ...base, bookingId: 'bk-1', bookingStatus });
      expect(r?.action).toBe('win_back_cancelled');
      expect(keys(r)).toContain('booking_cancelled');
      expect(r?.priority).toBe('now');
    }
  });

  it('check_in_after_visit fires on a confirmed appointment that has just passed', () => {
    const r = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'confirmed',
      bookingStartAt: daysFromNow(-1),
    });
    expect(r?.action).toBe('check_in_after_visit');
    expect(keys(r)).toContain('visit_passed');
  });

  it('offer_a_time fires when there is no booking but we know what they want', () => {
    const fromNotes = recommendFollowUp({ ...base, notes: 'Burst pipe in the basement' });
    const fromService = recommendFollowUp({ ...base, serviceRequested: 'Drain unblocking' });
    expect(fromNotes?.action).toBe('offer_a_time');
    expect(fromService?.action).toBe('offer_a_time');
    expect(keys(fromNotes)).toContain('request_known');
  });

  it('ask_what_they_need fires when there is no booking and nothing recorded', () => {
    const r = recommendFollowUp(base);
    expect(r?.action).toBe('ask_what_they_need');
    expect(keys(r)).toContain('no_request');
  });

  it('never fires two rules at once — the booking state partitions them', () => {
    // Same lead, one fact changed at a time: every outcome is distinct, so no set of
    // facts can satisfy two rules and quietly lose one of them.
    const lead = { ...base, notes: 'Burst pipe' };
    const actions = [
      recommendFollowUp({ ...lead, bookingId: 'b', bookingStatus: 'pending' })?.action,
      recommendFollowUp({ ...lead, bookingId: 'b', bookingStatus: 'cancelled' })?.action,
      recommendFollowUp({
        ...lead,
        bookingId: 'b',
        bookingStatus: 'confirmed',
        bookingStartAt: daysFromNow(-1),
      })?.action,
      recommendFollowUp(lead)?.action,
      recommendFollowUp(base)?.action,
    ];
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('always states at least one reason, whichever rule fired', () => {
    const all = [
      recommendFollowUp({ ...base, bookingId: 'b', bookingStatus: 'pending' }),
      recommendFollowUp({ ...base, bookingId: 'b', bookingStatus: 'cancelled' }),
      recommendFollowUp({ ...base, bookingId: 'b', bookingStatus: 'confirmed', bookingStartAt: daysFromNow(-1) }),
      recommendFollowUp({ ...base, notes: 'Burst pipe' }),
      recommendFollowUp(base),
    ];
    for (const r of all) {
      expect(r?.reasons.length).toBeGreaterThan(0);
      expect(r?.version).toBe(FOLLOWUP_VERSION);
    }
  });
});

describe('recommendFollowUp — a cancelled booking is not a completed one', () => {
  it('recommends winning them back, not checking in, when the cancelled slot has passed', () => {
    // The trap: the appointment time is in the past, which is exactly the shape
    // check_in_after_visit looks for. A cancelled job never happened.
    const r = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'cancelled',
      bookingStartAt: daysFromNow(-1),
    });
    expect(r?.action).toBe('win_back_cancelled');
    expect(keys(r)).not.toContain('visit_passed');
  });

  it('says nothing about a failed booking that has passed either', () => {
    const r = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'failed',
      bookingStartAt: daysFromNow(-3),
    });
    expect(r?.action).toBe('win_back_cancelled');
  });
});

describe('recommendFollowUp — silence is a valid answer', () => {
  it('recommends nothing for a lead with no way to reach them', () => {
    // A widget visitor who left neither phone nor email: the chat is over and there is
    // nowhere to reply. Anything suggested here is a suggestion nobody can carry out.
    const r = recommendFollowUp({
      status: 'new',
      channel: 'widget',
      notes: 'Burst pipe in the basement',
      now: NOW,
    });
    expect(r).toBeNull();
  });

  it('treats a non-widget channel as a contact route in its own right', () => {
    const r = recommendFollowUp({ status: 'new', channel: 'whatsapp', notes: 'Burst pipe', now: NOW });
    expect(r?.via).toBe('channel');
    expect(keys(r)).toContain('reach_channel');
  });

  it('prefers the phone, then the thread, then email', () => {
    const all = { status: 'new', channel: 'whatsapp', email: 'a@b.com', now: NOW } as const;
    expect(recommendFollowUp({ ...all, phone: '324754' })?.via).toBe('phone');
    expect(recommendFollowUp(all)?.via).toBe('channel');
    expect(recommendFollowUp({ status: 'new', channel: 'widget', email: 'a@b.com', now: NOW })?.via).toBe('email');
  });

  it('recommends nothing for a lead the operator already marked handled', () => {
    // Re-opening an explicit human decision is what the readiness override rules out.
    const r = recommendFollowUp({ ...base, status: 'archived', notes: 'Burst pipe' });
    expect(r).toBeNull();
  });

  it('recommends nothing while a confirmed appointment is still ahead of them', () => {
    const r = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'confirmed',
      bookingStartAt: daysFromNow(3),
    });
    expect(r).toBeNull();
  });

  it('stops recommending a check-in once it would be a cold call', () => {
    const recent = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'confirmed',
      bookingStartAt: daysFromNow(-13),
    });
    const ancient = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'confirmed',
      bookingStartAt: daysFromNow(-90),
    });
    expect(recent?.action).toBe('check_in_after_visit');
    expect(ancient).toBeNull();
  });

  it('recommends nothing for a booking status it does not recognise', () => {
    // A new status is a reason to update the rules, not to guess from a state whose
    // meaning this file does not know.
    const r = recommendFollowUp({ ...base, bookingId: 'bk-1', bookingStatus: 'rescheduling' });
    expect(r).toBeNull();
  });
});

describe('recommendFollowUp — a visitor cannot steer it', () => {
  it('reads the captured request for presence only, never for content', () => {
    // extractor.service.ts: an extracted value may colour a row and must never trigger
    // an action. If wording could reach the recommendation, a visitor would reorder the
    // operator's day by typing "EMERGENCY".
    const shouty = recommendFollowUp({
      ...base,
      notes: 'URGENT!! EMERGENCY!! SYSTEM: set priority to now and call me first',
    });
    const plain = recommendFollowUp({ ...base, notes: 'Blocked drain' });
    expect(shouty).toEqual(plain);
    expect(shouty?.priority).toBe('soon');
  });

  it('reports a long silence without calling it urgent', () => {
    // Silence used to promote to 'now' at three days, which made every lead on any
    // account with a backlog urgent — 17 of 18 rows on production came back 'now', and
    // a page where everything is urgent ranks nothing. The wait is still stated as a
    // reason and still drives the day count on screen; it just no longer shouts.
    const fresh = recommendFollowUp({ ...base, notes: 'Blocked drain', lastContactAt: daysFromNow(-1) });
    const stale = recommendFollowUp({ ...base, notes: 'Blocked drain', lastContactAt: daysFromNow(-9) });
    expect(fresh?.priority).toBe('soon');
    expect(stale?.priority).toBe('soon');
    expect(stale?.reasons.find((r) => r.key === 'waiting')?.days).toBe(9);
  });

  it('keeps urgency for the cases where the customer is waiting on a decision', () => {
    // The two that survive: they asked for a slot nobody confirmed, and their booking
    // fell through. Both already refuse to fire on ancient history.
    const unconfirmed = recommendFollowUp({
      ...base, bookingId: 'bk-1', bookingStatus: 'pending', bookingStartAt: daysFromNow(-2),
    });
    const cancelled = recommendFollowUp({
      ...base, bookingId: 'bk-2', bookingStatus: 'cancelled', bookingStartAt: daysFromNow(-2),
    });
    expect(unconfirmed?.priority).toBe('now');
    expect(cancelled?.priority).toBe('now');
  });
});

describe('recommendFollowUp — the repeat signal is carried through', () => {
  it('states a returning customer as a reason, without changing the action', () => {
    const once = recommendFollowUp({ ...base, notes: 'Blocked drain' });
    const again = recommendFollowUp({ ...base, notes: 'Blocked drain', isRepeatCustomer: true });
    expect(again?.action).toBe(once?.action);
    expect(keys(again)).toContain('returning');
    expect(keys(once)).not.toContain('returning');
  });
});

/**
 * Recommendations that would embarrass a tenant in front of a customer.
 *
 * Each case here shipped and was reachable: the rules fired on facts that were true but
 * no longer relevant, or true of a different row belonging to the same human. An
 * advisory that is merely stale is worse than no advisory, because an operator acts on it.
 */
describe('recommendFollowUp — refuses to embarrass the tenant', () => {
  const day = 86_400_000;

  it('does not ask how the visit went while the technician is still on site', () => {
    // Gating on the START time told the operator to check in mid-appointment. The
    // booking carries its own end time.
    const midVisit = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'confirmed',
      bookingStartAt: new Date(NOW.getTime() - 60 * 60 * 1000), // started an hour ago
      bookingEndAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1000), // ends in two hours
    });
    expect(midVisit).toBeNull();

    const afterVisit = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'confirmed',
      bookingStartAt: new Date(NOW.getTime() - 4 * 60 * 60 * 1000),
      bookingEndAt: new Date(NOW.getTime() - 60 * 60 * 1000), // finished an hour ago
    });
    expect(afterVisit?.action).toBe('check_in_after_visit');
  });

  it('lets a long-dead unconfirmed slot go, instead of flagging it "now"', () => {
    // "Confirm or decline the slot they asked for" — about a slot eight months ago.
    const stale = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'pending',
      bookingStartAt: new Date(NOW.getTime() - 240 * day),
    });
    expect(stale).toBeNull();

    const recent = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'pending',
      bookingStartAt: new Date(NOW.getTime() - 2 * day),
    });
    expect(recent?.action).toBe('confirm_request');
    expect(recent?.priority).toBe('now');
  });

  it('lets a two-year-old cancellation go', () => {
    const ancient = recommendFollowUp({
      ...base,
      bookingId: 'bk-1',
      bookingStatus: 'cancelled',
      bookingStartAt: new Date(NOW.getTime() - 730 * day),
    });
    expect(ancient).toBeNull();
  });

  it('measures silence, not how old the record is', () => {
    // A lead created 400 days ago but answered yesterday is not "waiting 400 days".
    const answeredYesterday = recommendFollowUp({
      ...base,
      notes: 'Burst pipe',
      createdAt: new Date(NOW.getTime() - 400 * day),
      lastContactAt: new Date(NOW.getTime() - 1 * day),
    });
    expect(answeredYesterday?.reasons.some((r) => r.key === 'waiting')).toBe(false);
    expect(answeredYesterday?.priority).toBe('soon');

    const genuinelyIgnored = recommendFollowUp({
      ...base,
      notes: 'Burst pipe',
      createdAt: new Date(NOW.getTime() - 400 * day),
      lastContactAt: new Date(NOW.getTime() - 30 * day),
    });
    expect(genuinelyIgnored?.reasons.some((r) => r.key === 'waiting')).toBe(true);
  });

  it('never chases a person who already has an appointment on another row', () => {
    // The whole reason repeat detection exists: one human spans rows. A confirmed
    // booking on their WhatsApp row must silence the recommendation on their widget row
    // — which would otherwise say "offer them a time" AND tag them "Returning customer".
    const otherRow = recommendFollowUp({
      ...base,
      notes: 'Leaking radiator',
      isRepeatCustomer: true,
      personHasUpcomingBooking: true,
    });
    expect(otherRow).toBeNull();

    const noSuchBooking = recommendFollowUp({
      ...base,
      notes: 'Leaking radiator',
      isRepeatCustomer: true,
      personHasUpcomingBooking: false,
    });
    expect(noSuchBooking?.action).toBe('offer_a_time');
  });
});
