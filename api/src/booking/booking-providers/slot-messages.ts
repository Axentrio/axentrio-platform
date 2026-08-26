/**
 * What to tell the model when the time it asked for has gone.
 *
 * THE MESSAGE CARRIES THE NEXT STEP, because a bare statement of fact does not survive contact
 * with the model. Observed in production: two customers raced for one slot, and the loser's tool
 * returned `This time slot is no longer available` - correct, safe to show, and useless. The model
 * answered an English customer with the tenant's Dutch handoff string and gave up, on a race it
 * could have recovered from in one turn by re-checking the day.
 *
 * Every booking error that produces a good reply says what to do next. These did not.
 * The two forbidden moves are named explicitly because both were what it actually did.
 */
export const SLOT_TAKEN_ON_CREATE =
  'That time is no longer available. Tell the customer plainly that it has just gone, apologise ' +
  'briefly, then call check_availability again for the same day and offer what is left. Do NOT ' +
  'hand the conversation to a human and do NOT use the fallback message: a taken slot is an ' +
  'ordinary thing that happens and you can fix it yourself.';

/**
 * The time was never offerable, which is NOT the same as taken.
 *
 * `SLOT_TAKEN_*` says somebody got there first, and for a slot the engine would never have
 * offered - outside opening hours, on a closed day, sooner than the notice the owner needs,
 * further ahead than they take bookings, or past the day's cap - that is simply false. Told "no
 * longer available", a customer reads it as bad luck and asks for a Request; told "too soon",
 * they pick a later time and book themselves. Observed on a min-notice refusal, where the second
 * outcome was available and the first is what happened.
 *
 * The reason is not enumerated here because the engine does not hand one back - it returns a slot
 * list, and a time is either in it or not. Re-offering is the honest recovery: it shows what IS
 * possible rather than guessing why this was not.
 *
 * CAPTURING A REQUEST IS REFUSED IN SO MANY WORDS, because forbidding the handoff was not enough.
 * Two reports arrived against auto-book services - one refused for minimum notice, one for the
 * horizon - where the bot did not hand off and did not use the fallback, and instead offered to
 * send the appointment for somebody to confirm by hand. That is the same surrender wearing a
 * different hat: the owner chose automatic booking, and a time the policy ruled out has bookable
 * neighbours the customer could have had in the same turn.
 */
export const SLOT_NOT_OFFERABLE =
  'That time is not one this business can take. It may be outside their opening hours, on a day ' +
  'they are closed, sooner than the notice they need, further ahead than they book, or the day ' +
  'may already be full. Do NOT say it was just taken and do NOT say it is unavailable without ' +
  'explanation. Call check_availability for that day and the days around it, then offer the ' +
  'customer the times that actually exist. Do not hand the conversation to a human, do not use ' +
  'the fallback message, and do NOT capture it with request_appointment or offer to have anyone ' +
  'confirm it by hand: this service books automatically and another time will book outright.';

/** `SLOT_NOT_OFFERABLE` for a move: same distinction, and the appointment still stands. */
export const SLOT_NOT_OFFERABLE_ON_RESCHEDULE =
  'That time is not one this business can take, and the existing appointment has NOT been ' +
  'changed. It may be outside their opening hours, on a day they are closed, sooner than the ' +
  'notice they need, further ahead than they book, or the day may already be full. Do NOT say it ' +
  'was just taken. Say both of those things, call check_availability for that day, and offer the ' +
  'times that actually exist. Do not hand the conversation to a human, do not use the fallback ' +
  'message, and do NOT capture it with request_appointment: a move is not a new request, and ' +
  'another time will book outright.';

/** The same, for a move. The customer keeps their existing appointment until one succeeds. */
export const SLOT_TAKEN_ON_RESCHEDULE =
  'That time is no longer available, and the existing appointment has NOT been changed. Say both ' +
  'of those things, then call check_availability again for the day the customer wants and offer ' +
  'what is left. Do NOT hand the conversation to a human and do NOT use the fallback message.';
