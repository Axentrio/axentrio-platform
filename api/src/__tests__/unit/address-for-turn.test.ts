/**
 * Whose answer wins when the model and the customer disagree about an address.
 *
 * The customer's, always - but "disagree" is the hard word. The model rewrites addresses
 * constantly without meaning anything by it: dropping the country, adding a postcode, reordering
 * town and code. Treating every rewrite as a change would ask a customer to confirm their own
 * address several times per conversation. Treating none of them as a change would let a genuine
 * correction slip through silently.
 *
 * So the comparison is deliberately lopsided, and these tests pin the lopsidedness:
 * cosmetic differences pass, substantive ones raise a question, and NOTHING the model says ever
 * replaces the binding by itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBound = vi.fn();
const propose = vi.fn();

vi.mock('../../booking/travel/address-binding', () => ({
  getBoundAddress: (...a: unknown[]) => getBound(...(a as [])),
  proposeCorrection: (...a: unknown[]) => propose(...(a as [])),
}));
vi.mock('../../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { addressForTurn, addressToken } from '../../booking/travel/address-for-turn';

const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Grote Markt 1, 2000 Antwerpen, Belgium' };

beforeEach(() => {
  vi.clearAllMocks();
  getBound.mockResolvedValue(null);
  // A first-time proposal, which is when the question may be raised.
  propose.mockResolvedValue({ isNew: true });
});

describe('addressForTurn', () => {
  it('passes the model’s address straight through when nothing is bound', async () => {
    // Every conversation on the platform today. Nothing has been chosen, so there is nothing to
    // protect and nothing to second-guess.
    const out = await addressForTurn('s1', 'Kerkstraat 12, Gent');
    expect(out).toEqual({ address: 'Kerkstraat 12, Gent', correctionPending: false });
    expect(propose).not.toHaveBeenCalled();
  });

  it('uses the binding when the model passes NO address', async () => {
    // The omission case, and the one that would book the wrong address if it were read as "the
    // customer withdrew it". A model that forgets to repeat an argument has said nothing.
    getBound.mockResolvedValue(CHOSEN);
    const out = await addressForTurn('s1', undefined);
    expect(out).toEqual({
      address: CHOSEN.formattedAddress,
      placeId: CHOSEN.placeId,
      correctionPending: false,
    });
    expect(propose).not.toHaveBeenCalled();
  });

  it.each([
    ['identical', 'Grote Markt 1, 2000 Antwerpen, Belgium'],
    ['country dropped', 'Grote Markt 1, 2000 Antwerpen'],
    ['postcode dropped', 'Grote Markt 1, Antwerpen'],
    ['punctuation and case', 'grote markt 1 2000 antwerpen belgium'],
    ['town dropped entirely', 'Grote Markt 1'],
  ])('treats a %s rewrite as the SAME address', async (_label, rewritten) => {
    getBound.mockResolvedValue(CHOSEN);
    const out = await addressForTurn('s1', rewritten);

    expect(out.correctionPending).toBe(false);
    // The canonical spelling is what gets used, not the model's version of it.
    expect(out.address).toBe(CHOSEN.formattedAddress);
    expect(propose).not.toHaveBeenCalled();
  });

  it.each([
    ['a neighbouring door', 'Grote Markt 12, 2000 Antwerpen'],
    ['a four-digit door number', 'Grote Markt 1234, 2000 Antwerpen'],
  ])('treats %s as a DIFFERENT address', async (_label, typed) => {
    // The wrong-door bug, pinned. Containment is blind to house numbers - "kerkstraat 12"
    // contains "kerkstraat 1" - so a neighbour's door passed as a harmless reformat and the
    // proposal never fired. The four-digit case is nastier still: the postcode strip that
    // forgives a dropped "2000" cannot tell a postcode from a four-digit house number, so both
    // sides collapsed to the street name alone.
    getBound.mockResolvedValue(CHOSEN);
    const out = await addressForTurn('s1', typed);
    expect(out.correctionPending).toBe(true);
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it('still forgives a model that drops the house number entirely', async () => {
    // Saying LESS is not saying something different, and the guard only fires when both sides
    // actually state a number.
    getBound.mockResolvedValue(CHOSEN);
    const out = await addressForTurn('s1', 'Grote Markt, Antwerpen');
    expect(out.correctionPending).toBe(false);
  });

  it('PROPOSES, and does not replace, when the model names a different address', async () => {
    getBound.mockResolvedValue(CHOSEN);
    const out = await addressForTurn('s1', 'Korenmarkt 1, 9000 Gent');

    // The binding still wins for this turn. Only the customer can settle it.
    expect(out.address).toBe(CHOSEN.formattedAddress);
    expect(out.placeId).toBe(CHOSEN.placeId);
    expect(out.correctionPending).toBe(true);
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it('proposes WITHOUT a place id, because nothing has been verified yet', async () => {
    getBound.mockResolvedValue(CHOSEN);
    await addressForTurn('s1', 'Korenmarkt 1, 9000 Gent');

    const [, proposal] = propose.mock.calls[0] as [string, { placeId: string; proposalId: string }];
    // A proposal is a question. Verification happens if and when the customer answers it by
    // picking through /places/select, which resolves properly.
    expect(proposal.placeId).toBe('');
    expect(proposal.proposalId).toMatch(/^[a-f0-9]{16}$/);
  });

  it('gives the SAME proposal id for the same suggested address', async () => {
    // So a repeated suggestion is one outstanding question rather than a new one each turn -
    // and so a confirmation cannot promote a proposal the customer has already moved past.
    getBound.mockResolvedValue(CHOSEN);
    await addressForTurn('s1', 'Korenmarkt 1, 9000 Gent');
    await addressForTurn('s1', 'korenmarkt 1,  9000 gent');

    const ids = propose.mock.calls.map((c) => (c[1] as { proposalId: string }).proposalId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('reports the address as contested for as long as it IS contested', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and asserting the opposite was the bug.
    //
    // It read `correctionPending` as "you may ask now" and expected the second call to say no -
    // the one-shot cap, enforced here by passing `isNew` straight out. That works only while every
    // caller of this function can ask. All three booking tools call it, and only `create_booking`
    // can: so `check_availability` took the single `true`, said nothing, and by the time
    // `create_booking` ran the proposal was no longer new and the customer was never asked. The
    // cap was spent on silence in the ordinary flow, and the green assertion below was what made
    // it look correct.
    //
    // So this is now a fact about STATE - the address is contested until it is answered - and the
    // one-shot promise moved to `claimPresentation`, which the tool that actually asks owns.
    // `address-question-once.test.ts` holds that half, including the wedge it exists to prevent:
    // a customer whose address Google cannot suggest is asked once and still books.
    getBound.mockResolvedValue(CHOSEN);

    propose.mockResolvedValue({ isNew: true });
    const first = await addressForTurn('s1', 'Korenmarkt 1, 9000 Gent');
    expect(first.correctionPending).toBe(true);

    // Same address again - a repeat, or a coalescer replay of the very same message. Still
    // contested, because nobody has answered anything.
    propose.mockResolvedValue({ isNew: false });
    const second = await addressForTurn('s1', 'Korenmarkt 1, 9000 Gent');
    expect(second.correctionPending).toBe(true);
    // Both turns carry the id of the question, so whoever asks can be answered.
    expect(second.proposalId).toBe(first.proposalId);
    // And it proceeds against what they actually chose, not the contested one.
    expect(second.address).toBe(CHOSEN.formattedAddress);
  });

  it('never logs either address', async () => {
    // Both sides of this comparison are somebody's home.
    const { logger } = await import('../../utils/logger');
    getBound.mockResolvedValue(CHOSEN);
    await addressForTurn('s1', 'Korenmarkt 1, 9000 Gent');

    const logged = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('Korenmarkt');
    expect(logged).not.toContain('Grote Markt');
  });
});

describe('addressToken — the field the idempotency key was missing', () => {
  // Live on production, a customer gave a Liège address, corrected it to Antwerp for the SAME
  // slot, and was told the Antwerp booking was confirmed. It was not: the key omitted the
  // address, so the correction deduped into the original row and was discarded. These pin the
  // property that closes it — a different door is a different key.
  it('gives two different addresses two different tokens', () => {
    const a = addressToken({ address: 'Place Saint-Lambert 1, 4000 Liege' });
    const b = addressToken({ address: 'Turnhoutsebaan 100, 2140 Antwerpen' });
    expect(a).not.toBe(b);
  });

  it('is unmoved by the rewriting a model does without meaning anything by it', () => {
    // Same doorway, three spellings. If these differed, every re-confirm would insert a
    // duplicate request and #35 would be back.
    const canonical = addressToken({ address: 'Meir 78, 2000 Antwerpen' });
    expect(addressToken({ address: '  meir 78,  2000   antwerpen ' })).toBe(canonical);
    expect(addressToken({ address: 'Meir 78. 2000 Antwerpen' })).toBe(canonical);
  });

  it('separates two doors on one street, which is the wrong-door case', () => {
    expect(addressToken({ address: 'Kerkstraat 1, 2060 Antwerpen' })).not.toBe(
      addressToken({ address: 'Kerkstraat 12, 2060 Antwerpen' })
    );
  });

  it('prefers the identity the customer PICKED over the words around it', () => {
    // A place id survives reformatting, so two spellings of one chosen place stay one key.
    const one = addressToken({ address: 'Grote Markt 1, Antwerpen', placeId: 'ChIJ_chosen' });
    const two = addressToken({ address: 'Grote Markt 1, 2000 Antwerpen, Belgium', placeId: 'ChIJ_chosen' });
    expect(one).toBe(two);
    // ...and a different pick is a different key even when the text is identical.
    expect(addressToken({ address: 'Grote Markt 1, Antwerpen', placeId: 'ChIJ_other' })).not.toBe(one);
  });

  it('is a constant when there is no address, so nothing changes for services that need none', () => {
    expect(addressToken({ address: undefined })).toBe('noaddr');
    expect(addressToken({ address: '   ' })).toBe(addressToken({ address: undefined }));
  });

  it('stays short enough that a long address cannot overflow idempotency_key', () => {
    // The column is varchar(255) and the key already spends ~113 on prefix, session, service and
    // time, so a 16-char token lands around 129. Widened from 12 when the token gained domain
    // separation: the extra bits are collision headroom, and the budget was never close.
    const long = addressToken({ address: 'A'.repeat(400) });
    expect(long.length).toBeLessThanOrEqual(16);
  });
});
