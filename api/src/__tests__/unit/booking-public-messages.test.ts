/**
 * What a CUSTOMER is allowed to read.
 *
 * `BookingError.message` is written for the model — `booking.tool.ts` feeds it to the LLM
 * verbatim, so it reads as stage directions ("Do not offer specific times… capture it with
 * request_appointment"). The signed manage/reschedule pages are the one place those errors
 * reach a human being's browser, and `errorPage` prints what it is given. Rendering
 * `err.message` there put the bot's instructions in front of the customer.
 *
 * The mapping is allow-list shaped on purpose: an error reaches this page only by being
 * listed, so an error added anywhere else in the booking engine cannot leak by default.
 */
import { describe, it, expect } from 'vitest';
import { CUSTOMER_MESSAGE, customerMessage } from '../../scheduler/booking-public.controller';
import { BookingError } from '../../booking/booking-providers/types';

/** Vocabulary that only ever makes sense to the model. */
const BOT_DIRECTIVE = /request_appointment|reschedule_booking|check_availability|do not offer|do not say|capture it with|the bot\b/i;

describe('customer-facing copy for a BookingError', () => {
  it('never renders the model-facing message, however the error is phrased', () => {
    const err = new BookingError(
      'This business has paused NEW online bookings. Do not offer specific times and do not say they are fully booked or closed — capture it with request_appointment. EXCEPTION: call reschedule_booking.',
      'BOOKINGS_PAUSED',
      409,
    );
    const shown = customerMessage(err);
    expect(shown).not.toBe(err.message);
    expect(shown).not.toMatch(BOT_DIRECTIVE);
    expect(shown).toMatch(/paused/i);
  });

  it('holds for every code the pages can surface', () => {
    // These are the errors checkAvailability / reschedule can raise behind the signed link.
    for (const code of [
      'BOOKINGS_PAUSED',
      'CALENDAR_NOT_CONNECTED',
      'CALENDAR_SYNC_DISABLED',
      'REQUEST_ONLY_SERVICE',
      'BOOKING_TEMPORARILY_UNAVAILABLE',
      'SERVICE_REQUIRED',
      'SLOT_UNAVAILABLE',
    ]) {
      const shown = customerMessage(new BookingError('Do not offer specific times — capture it with request_appointment.', code, 409));
      expect(shown, code).not.toMatch(BOT_DIRECTIVE);
      expect(shown.length, code).toBeGreaterThan(10);
    }
  });

  it('no entry in the table leaks directive vocabulary', () => {
    for (const [code, copy] of Object.entries(CUSTOMER_MESSAGE)) {
      expect(copy, code).not.toMatch(BOT_DIRECTIVE);
    }
  });

  it('falls back to the generic line for an unlisted code, rather than passing it through', () => {
    // Default-deny: a new BookingError added elsewhere must not reach the customer verbatim
    // just because nobody remembered this file.
    const err = new BookingError('Internal: itinerary key resolution failed for bot xyz', 'SOME_NEW_CODE', 500);
    expect(customerMessage(err)).toBe('This link is invalid or has expired.');
  });
});
