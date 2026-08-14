/**
 * A reply that names a time nobody can book.
 *
 * The availability twin of a false confirmation. Seen in production: the chips carried
 * 9:00, 9:30, 12:30, 13:00, 13:30, 14:00, 14:30, 15:00 while the sentence above them read
 * "09:30, 11:30, 12:00, 12:30, 13:00, 13:30, and 14:00" - two times nobody could book, and three
 * real ones missing. The chips are right, so a tap is safe; a customer who reads the words and
 * replies "11:30 then" is asking for a slot that does not exist.
 *
 * These tests are mostly about NOT firing, because the cost of a false positive is throwing away
 * a good reply.
 */
import { describe, it, expect } from 'vitest';
import { unofferedTimesIn } from '../../agent/agent.service';

const OFFERED = ['09:00', '09:30', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00'];

describe('naming a time that was never offered', () => {
  it('catches the production case exactly', () => {
    const reply =
      'Here are some available times on Monday 17 August: 09:30, 11:30, 12:00, 12:30, 13:00, 13:30, and 14:00.';
    expect(unofferedTimesIn(reply, OFFERED)).toEqual(['11:30', '12:00']);
  });

  it('says nothing when every named time was offered', () => {
    const reply = 'I have 09:00, 12:30 and 15:00 free. Which suits?';
    expect(unofferedTimesIn(reply, OFFERED)).toEqual([]);
  });

  it('reads a 12-hour clock, so 1:30 PM matches an offered 13:30', () => {
    const reply = 'I can do 9:00 AM, 1:30 PM or 3:00 PM.';
    expect(unofferedTimesIn(reply, OFFERED)).toEqual([]);
  });

  it('accepts EITHER reading of an unsuffixed 12-hour time', () => {
    // "1:00" alone could be 01:00 or 13:00, and the model writes both. Flagging it because the
    // morning reading was not offered would throw away a correct reply about the afternoon one.
    const reply = 'How about 12:30 or 1:00?';
    expect(unofferedTimesIn(reply, OFFERED)).toEqual([]);
  });
});

/**
 * The whole-hour blind spot, found by driving production on 2026-08-13.
 *
 * The chips carried 09:30, 10:00, 10:30, 11:00, 13:00, 13:30, 14:00 and 14:30. The sentence above
 * them read "the available times are 9 AM, 11 AM, or 11:30 AM" - not one of the three was a real
 * offer in the shape the customer read it, and the guard said nothing.
 *
 * The reason is exact: the pattern required `[:.]` plus two minute digits, so `9 AM` and `11 AM`
 * were never times at all. Only `11:30 AM` matched, which left ONE recognised time, and the
 * two-or-more enumeration guard returned early. The single time it did recognise was the bogus
 * one, and it was discarded for want of a second.
 */
describe('whole-hour times, which the minutes-only pattern could not see', () => {
  const CHIPS = ['09:30', '10:00', '10:30', '11:00', '13:00', '13:30', '14:00', '14:30'];

  it('catches the 2026-08-13 production sentence', () => {
    const reply =
      'The available times for tomorrow at Turnhoutsebaan 100, 2140 Antwerpen are 9 AM, 11 AM, or 11:30 AM.';
    // `11 AM` is a real offer (11:00) and must survive; the other two are inventions.
    expect(unofferedTimesIn(reply, CHIPS)).toEqual(['9 AM', '11:30 AM']);
  });

  it('stays quiet when the whole hours WERE offered', () => {
    expect(unofferedTimesIn('I have 10 AM or 1 PM free.', CHIPS)).toEqual([]);
  });

  it('reads a whole hour and a minute time as one enumeration', () => {
    // Two recognised times only if the whole hour counts. Before this, `10 AM` was invisible and
    // the guard saw a single time and stood down.
    expect(unofferedTimesIn('I can do 10 AM or 16:00.', CHIPS)).toEqual(['16:00']);
  });

  it('handles the 12-hour boundary in both directions', () => {
    // 12 PM is noon, 12 AM is midnight. Neither was offered.
    expect(unofferedTimesIn('How about 12 PM or 12 AM?', CHIPS)).toEqual(['12 PM', '12 AM']);
  });

  it('reads punctuated and unspaced meridiems', () => {
    expect(unofferedTimesIn('We could do 9a.m. or 8 p.m.', CHIPS)).toEqual(['9a.m.', '8 p.m.']);
  });
});

describe('when it must stay quiet', () => {
  const CHIPS = ['09:30', '10:00', '10:30', '11:00'];

  it('does NOT read a bare number as a whole-hour time', () => {
    // The meridiem is what makes a lone digit a clock reading. Without this, "3 slots" and
    // "2 staff" become 03:00 and 02:00, and a perfectly good reply is thrown away.
    const reply = 'We have 3 slots left with 2 engineers, at 09:30 and 10:00.';
    expect(unofferedTimesIn(reply, CHIPS)).toEqual([]);
  });

  it('does NOT read a date or a price as a whole-hour time', () => {
    const reply = 'On 17 August the call-out is 45 EUR; I have 09:30 and 10:00.';
    expect(unofferedTimesIn(reply, CHIPS)).toEqual([]);
  });

  it('ignores a reply that names only ONE time', () => {
    // Not an enumeration. "We open at 08:00" is a fact about the business, not a claim about a
    // slot, and replacing that reply would be worse than leaving it.
    expect(unofferedTimesIn('We open at 08:00 every weekday.', OFFERED)).toEqual([]);
  });

  it('ignores numbers that are not clock times', () => {
    // A price and a phone number both contain digits and a separator. Requiring two-digit minutes
    // and a colon or dot is what keeps this from firing on them.
    const reply = 'That is 45.50 euro, and you can reach us on 03 123 45 67.';
    expect(unofferedTimesIn(reply, OFFERED)).toEqual([]);
  });

  it('ignores an impossible clock reading', () => {
    const reply = 'Reference 99:99 and order 45:61 are both in progress.';
    expect(unofferedTimesIn(reply, OFFERED)).toEqual([]);
  });

  it('treats EVERY time as unoffered when nothing was offered', () => {
    // The suspicious reading on purpose: a reply listing times when no availability was produced
    // is inventing them outright. The caller only runs this where chips exist, so it cannot fire
    // in production today - but a future caller gets the safe answer rather than a permissive one.
    expect(unofferedTimesIn('I can do 09:00 or 10:00.', [])).toEqual(['09:00', '10:00']);
  });
});
