/**
 * Explicit confirmation is a whole-message yes, not any later utterance.
 * Digits mean they named a time. A details dump is never a yes.
 */
import { describe, it, expect } from 'vitest';
import {
  isAffirmativeReply,
  isConfirmingChip,
  summaryWasAsked,
} from '../../agent/pending-booking-confirmation';

describe('isAffirmativeReply', () => {
  it.each([
    'ja',
    'Ja, dat klopt',
    'Ja hoor',
    'Klopt helemaal',
    "Yes, that's correct.",
    'oké',
    'boek het',
    'oui',
    "d'accord",
  ])('accepts %s', (text) => {
    expect(isAffirmativeReply(text)).toBe(true);
  });

  it('rejects a first-message details dump', () => {
    expect(
      isAffirmativeReply(
        'Ik wil maandag 26 oktober 2026 om 10:00 de Korting booking test boeken. Tom Test, 0470 00 00 12, achraftamranim@gmail.com.',
      ),
    ).toBe(false);
  });

  it('rejects a later change of time', () => {
    expect(isAffirmativeReply('Change it to 11:00')).toBe(false);
  });

  it('rejects a later question', () => {
    expect(isAffirmativeReply('What is the address?')).toBe(false);
  });

  it('rejects a yes that also names a time', () => {
    expect(isAffirmativeReply('ja 11:00')).toBe(false);
  });

  it('rejects a no after ja', () => {
    expect(isAffirmativeReply('ja liever niet')).toBe(false);
  });
});

describe('isConfirmingChip', () => {
  const start = '2026-10-26T10:00:00';

  it('accepts a short chip for the pending hour', () => {
    expect(isConfirmingChip('Mon 10:00 AM', start)).toBe(true);
  });

  it('rejects a chip for a different hour', () => {
    expect(isConfirmingChip('Mon 11:00 AM', start)).toBe(false);
  });

  it('rejects a time question even when it is under 80 characters', () => {
    expect(isConfirmingChip('Kan ik maandag 5 oktober 2026 om 10:00 langskomen?', start)).toBe(false);
    expect(isConfirmingChip('Kan ik om 10:00 langskomen?', start)).toBe(false);
  });

  it('rejects the details dump even though it names 10:00', () => {
    expect(
      isConfirmingChip(
        'Ik wil maandag 26 oktober 2026 om 10:00 de Korting booking test boeken. Tom Test, 0470 00 00 12, achraftamranim@gmail.com.',
        start,
      ),
    ).toBe(false);
  });
});

describe('summaryWasAsked', () => {
  const start = '2026-10-26T10:00:00';

  it('accepts a prior booking question that names the hour', () => {
    expect(
      summaryWasAsked(
        [
          { role: 'user', content: 'dump' },
          { role: 'assistant', content: 'Zal ik boeken om 10:00?' },
          { role: 'user', content: 'Ja, dat klopt' },
        ],
        start,
      ),
    ).toBe(true);
  });

  it('rejects an availability question that does not name the hour', () => {
    expect(
      summaryWasAsked(
        [{ role: 'assistant', content: 'Zal ik de beschikbaarheid checken?' }],
        start,
      ),
    ).toBe(false);
  });

  it('rejects a booking question for a different hour', () => {
    expect(
      summaryWasAsked(
        [{ role: 'assistant', content: 'Zal ik boeken om 11:00?' }],
        start,
      ),
    ).toBe(false);
  });

  it('ignores a same-turn booking question after the yes', () => {
    expect(
      summaryWasAsked(
        [
          { role: 'user', content: 'dump' },
          { role: 'assistant', content: 'Zal ik de beschikbaarheid checken?' },
          { role: 'user', content: 'Ja, dat klopt' },
          { role: 'assistant', content: 'Zal ik boeken om 10:00?' },
        ],
        start,
      ),
    ).toBe(false);
  });
});
