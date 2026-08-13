/**
 * The one place a bot reply's client-facing payload is assembled.
 *
 * It was three places - the same `quickReplies?.length ? { quickReplies } : undefined` written out
 * at each persistence site and again on the outbound one. The comment at `routeBotMessageOutbound`
 * records what that cost: #80's offer measurement "sat in exactly the right function and never
 * fired once in production", because every caller built its own literal and a field added to one
 * was silently missing from the others. Nothing failed. The reply just arrived without it.
 *
 * These tests exist because a second field is now going through here, and the argument for
 * believing it arrives is entirely "there is only one builder". That claim is worth pinning.
 */
import { describe, it, expect } from 'vitest';
import { replyMetadata } from '../../services/message-forwarding.service';

const CHIPS = [{ title: 'Mon 9:00 am', value: 'Book Monday at 9' }];
const PICKER = { kind: 'address_picker' as const, reason: 'unverified' as const };

describe('replyMetadata', () => {
  it('is undefined when there is nothing to say', () => {
    // NOT `{}`. An empty object is still written to the metadata column and reads downstream as
    // "this reply carried metadata", which is a different claim from "it carried none".
    expect(replyMetadata({})).toBeUndefined();
    expect(replyMetadata({ quickReplies: [] })).toBeUndefined();
  });

  it('carries each field on its own', () => {
    expect(replyMetadata({ quickReplies: CHIPS })).toEqual({ quickReplies: CHIPS });
    expect(replyMetadata({ affordance: PICKER })).toEqual({ affordance: PICKER });
  });

  it('carries BOTH at once, which is the case the three literals could not', () => {
    // A reply offering times AND asking the customer to verify their address is not exotic - it
    // is what `check_availability` produces for a service that travels. Under the old shape this
    // was the combination that silently lost one of the two.
    expect(replyMetadata({ quickReplies: CHIPS, affordance: PICKER })).toEqual({
      quickReplies: CHIPS,
      affordance: PICKER,
    });
  });

  it('omits empty chips rather than sending an empty list', () => {
    // The widget renders a chip row when the array is present. An empty one is an empty row.
    expect(replyMetadata({ quickReplies: [], affordance: PICKER })).toEqual({ affordance: PICKER });
  });

  it('drops the delivery-only suggestion text from a picker, keeping the {id, placeId} evidence', () => {
    // ADR-0014 (#98): options[].text is Google Content, shown in the provider body but never
    // persisted. What lands in messages.metadata + the socket frame is only the evidence
    // `offeredPlaceId` reads. The in-memory affordance is left intact for the Meta render.
    const inMemory = {
      kind: 'address_picker' as const,
      reason: 'unverified' as const,
      query: 'Turnhoutsebaan',
      options: [
        { id: 'a1b2', placeId: 'ChIJ_one', text: 'Turnhoutsebaan 100, 2140 Antwerpen' },
        { id: 'c3d4', placeId: 'ChIJ_two', text: 'Turnhoutsebaan 101, 2140 Antwerpen' },
      ],
    };

    const meta = replyMetadata({ affordance: inMemory });

    expect(meta).toEqual({
      affordance: {
        kind: 'address_picker',
        reason: 'unverified',
        query: 'Turnhoutsebaan',
        options: [
          { id: 'a1b2', placeId: 'ChIJ_one' },
          { id: 'c3d4', placeId: 'ChIJ_two' },
        ],
      },
    });
    // No unselected Google address string survives in the persisted/wire metadata.
    expect(JSON.stringify(meta)).not.toContain('Turnhoutsebaan 100');
    // The input affordance is not mutated — the provider render still needs its text.
    expect(inMemory.options[0].text).toBe('Turnhoutsebaan 100, 2140 Antwerpen');
  });
});
