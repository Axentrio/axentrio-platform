/**
 * The Pro proactive-capture offer.
 *
 * "The AI should never feel pushy" is the story's one hard rule, and here it is a
 * property of code rather than of prompt wording: these tests are the enforcement.
 * Each `false` case below is a specific way the feature could become the forced
 * questionnaire the story forbids.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldOfferCallback,
  buildCallbackQuickReplies,
  detectCallbackReply,
  humanizeCallbackReply,
  readOfferState,
  withOfferState,
  CALLBACK_ACCEPT_VALUE,
  CALLBACK_DECLINE_VALUE,
  type OfferInput,
} from '../../leads/callback-offer';

const LABELS = { yes: 'Yes, call me back', no: 'No thanks' };

const base: OfferInput = {
  enabled: true,
  hasContact: false,
  requestCaptured: true,
  customerTurns: 3,
  state: {},
  labels: LABELS,
};

describe('shouldOfferCallback — when the offer is allowed', () => {
  it('offers once the customer has described a need and we have no contact', () => {
    expect(shouldOfferCallback(base)).toBe(true);
  });
});

describe('shouldOfferCallback — every restraint', () => {
  it('never offers when the tenant has not opted in', () => {
    // The toggle is opt-in (absent preference = OFF) because this changes what personal
    // data the bot asks an EU consumer for.
    expect(shouldOfferCallback({ ...base, enabled: false })).toBe(false);
  });

  it('never asks for contact details we already have', () => {
    expect(shouldOfferCallback({ ...base, hasContact: true })).toBe(false);
  });

  it('never offers before the customer has described a need', () => {
    // Attaching "can we call you back?" to "what time do you close?" is precisely the
    // forced-form feel Story 3 rules out.
    expect(shouldOfferCallback({ ...base, requestCaptured: false })).toBe(false);
  });

  it('never offers on the opening turn', () => {
    expect(shouldOfferCallback({ ...base, customerTurns: 1 })).toBe(false);
  });

  it('never offers twice — one offer per conversation, ever', () => {
    expect(shouldOfferCallback({ ...base, state: { offeredAt: '2026-08-01T10:00:00Z' } })).toBe(false);
  });

  it('never re-offers after an explicit decline', () => {
    // The whole reason a chip beats a prompt rule: this is enforceable.
    expect(shouldOfferCallback({ ...base, state: { declinedAt: '2026-08-01T10:00:00Z' } })).toBe(false);
  });

  it('never re-offers after acceptance', () => {
    expect(shouldOfferCallback({ ...base, state: { acceptedAt: '2026-08-01T10:00:00Z' } })).toBe(false);
  });
});

describe('chips', () => {
  it('carries reserved sentinel values, not the visible labels', () => {
    const chips = buildCallbackQuickReplies(LABELS);
    expect(chips).toHaveLength(2);
    expect(chips[0]).toEqual({ title: 'Yes, call me back', value: CALLBACK_ACCEPT_VALUE });
    expect(chips[1]).toEqual({ title: 'No thanks', value: CALLBACK_DECLINE_VALUE });
  });
});

describe('detectCallbackReply — only a real tap counts as an answer', () => {
  it('recognises the sentinels', () => {
    expect(detectCallbackReply(CALLBACK_ACCEPT_VALUE)).toBe('accepted');
    expect(detectCallbackReply(CALLBACK_DECLINE_VALUE)).toBe('declined');
    expect(detectCallbackReply(`  ${CALLBACK_DECLINE_VALUE}  `)).toBe('declined');
  });

  it('does NOT treat conversational "no thanks" as answering the offer', () => {
    // Otherwise an unrelated polite refusal would silently consume the one offer the
    // customer was entitled to, or record a decline they never gave.
    for (const text of ['no thanks', 'No thanks!', 'no thanks, I already called', 'yes please']) {
      expect(detectCallbackReply(text)).toBeNull();
    }
  });

  it('does not match a sentinel embedded in a longer message', () => {
    expect(detectCallbackReply(`please ${CALLBACK_ACCEPT_VALUE} now`)).toBeNull();
  });
});

describe('humanizeCallbackReply — the sentinel is never shown or stored as speech', () => {
  it('maps a tap back to the visible label', () => {
    expect(humanizeCallbackReply('accepted', LABELS)).toBe('Yes, call me back');
    expect(humanizeCallbackReply('declined', LABELS)).toBe('No thanks');
  });

  it('never returns the raw sentinel', () => {
    // The raw value must not reach the model, the transcript, or the extractor as if
    // the customer had typed it.
    for (const reply of ['accepted', 'declined'] as const) {
      const out = humanizeCallbackReply(reply, LABELS);
      expect(out).not.toContain('__lead_callback');
    }
  });
});

describe('offer state persistence', () => {
  it('reads an absent/malformed blob as empty rather than throwing', () => {
    expect(readOfferState({ metadata: null } as never)).toEqual({});
    expect(readOfferState({ metadata: { leadCallback: 'nope' } } as never)).toEqual({});
    expect(readOfferState({ metadata: {} } as never)).toEqual({});
  });

  it('merges without disturbing unrelated session metadata', () => {
    const merged = withOfferState({ customData: { keep: 'me' } }, { offeredAt: 'T1' });
    expect((merged.customData as Record<string, unknown>).keep).toBe('me');
    expect(merged.leadCallback).toEqual({ offeredAt: 'T1' });
  });

  it('accumulates state rather than replacing it, so an offer timestamp survives a decline', () => {
    const offered = withOfferState({}, { offeredAt: 'T1' });
    const declined = withOfferState(offered, { declinedAt: 'T2' });
    expect(declined.leadCallback).toEqual({ offeredAt: 'T1', declinedAt: 'T2' });
  });
});
