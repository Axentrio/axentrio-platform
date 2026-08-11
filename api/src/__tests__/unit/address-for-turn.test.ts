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

import { addressForTurn } from '../../booking/travel/address-for-turn';

const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Grote Markt 1, 2000 Antwerpen, Belgium' };

beforeEach(() => {
  vi.clearAllMocks();
  getBound.mockResolvedValue(null);
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
