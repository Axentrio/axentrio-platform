/**
 * The wizard's calendar requirement.
 *
 * This step demanded GOOGLE: `connected` came from the Google status alone and the Continue
 * button gated on it, with no second option to click. A business running on Microsoft 365
 * therefore could not finish setup at all — a blocked signup, not a missing convenience —
 * even though Outlook is a first-class provider everywhere else in the product and works
 * end to end once connected.
 *
 * The rule is tested rather than the render: the step pulls in the Belgium geo dataset and
 * the whole scheduler query layer, and the decision that actually mattered is a boolean.
 */
import { describe, it, expect } from 'vitest';
import { calendarRequirementMet } from './BookingsStep';

const ON = { connected: true };
const OFF = { connected: false };

describe('BookingsStep — calendar requirement', () => {
  it('is met by OUTLOOK alone — the case that was impossible', () => {
    expect(calendarRequirementMet(OFF, ON)).toBe(true);
  });

  it('is still met by GOOGLE alone, exactly as before', () => {
    expect(calendarRequirementMet(ON, OFF)).toBe(true);
  });

  it('is met by both', () => {
    expect(calendarRequirementMet(ON, ON)).toBe(true);
  });

  it('is NOT met when neither is connected', () => {
    // Connecting something is the one thing this step genuinely requires: a booking with
    // nowhere to land is worse than no booking.
    expect(calendarRequirementMet(OFF, OFF)).toBe(false);
  });

  it('treats a still-loading or absent status as not connected', () => {
    // Fail closed while the status is unknown — briefly enabling Continue and then
    // disabling it under the owner's cursor is worse than a moment's wait.
    expect(calendarRequirementMet(undefined, undefined)).toBe(false);
    expect(calendarRequirementMet(null, null)).toBe(false);
  });

  it('requires a real boolean true, not merely something truthy', () => {
    expect(calendarRequirementMet({ connected: 'yes' as never }, OFF)).toBe(false);
  });
});
