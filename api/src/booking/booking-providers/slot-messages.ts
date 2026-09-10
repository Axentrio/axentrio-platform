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

/**
 * A request captured for a time the business could never have taken anyway.
 *
 * `request_appointment` skips slot validation on purpose - a request is a preference, not a
 * booking, and the owner decides. That is right for a full day, an out-of-area job, or a drive
 * nobody measured. It is wrong for a time outside the owner's own notice or horizon, because
 * there is nothing for the owner to decide: they already said they do not take those.
 *
 * OBSERVED ON PRODUCTION. An auto-book service with a 60-day horizon was asked for a day 63
 * days out. The model never called check_availability at all - it asked for a name and captured
 * a request - and a `request_created` row was written for a date the business does not accept.
 * The customer was told the team would confirm it. Nobody could have.
 *
 * The tool description invites exactly this ("...or you are not confident you can safely confirm
 * a time"), so the refusal has to live on the write path. Prose could not have stopped it.
 * The description no longer invites it, and `REQUEST_BEFORE_CHECK` below refuses the skip outright.
 *
 * THE DESTINATION TRAVELS WITH THE REFUSAL, BUT NEVER THE BOUND ITSELF. The first version was a
 * bare string and the model filled the gap: told only "too soon", it answered "choose a date
 * after Wednesday 2 September" when the earliest was the 25th, so every date the customer could
 * pick for three weeks was refused again.
 *
 * Putting the bound in the message is the WORSE fix, and the same live run shows why. The bound
 * is `now + notice`, a policy instant that knows nothing about opening hours: on that
 * Wednesday-only 09:00-17:00 diary it fell on a Friday at 20:26, while the first bookable slot
 * was the Wednesday after. Coming from the server it outranks the model's own guess, and the
 * invented-time guard is blind here because a refused turn offers no clock times to judge
 * against. So these name a RANGE to search and nothing else.
 */
export const requestInPast = (startDate: string, endDate: string): string =>
  `That time has already passed, so it cannot be booked OR requested - there is nothing for the business to confirm. Do NOT capture it and do NOT tell the customer the team will come back on it. Tell the customer plainly that those hours have already gone by. Call check_availability with startDate ${startDate} and endDate ${endDate}, offer the customer the times it returns, and book one outright: this service books automatically. Offer ONLY times that call gives you - do not work out the next date yourself and do not name one to the customer.`;

export const requestTooSoon = (startDate: string, endDate: string): string =>
  `That time is sooner than the notice this business needs, so it cannot be booked OR requested ` +
  `- they have already said they do not take appointments at that notice, so there is nothing ` +
  `for them to confirm. Do NOT capture it and do NOT tell the customer the team will come back ` +
  `on it. Call check_availability with startDate ${startDate} and endDate ${endDate}, offer the ` +
  `customer the times it returns, and book one outright: this service books automatically. ` +
  `Offer ONLY times that call gives you - the notice says nothing about opening hours, so do ` +
  `not work out the earliest date yourself and do not name one to the customer.`;

/** The horizon twin. Same refusal, same range-only rule, opposite end of the window. */
export const requestTooFar = (startDate: string, endDate: string): string =>
  `That time is further ahead than this business takes bookings, so it cannot be booked OR ` +
  `requested - they have already said they do not accept dates that far out, so there is ` +
  `nothing for them to confirm. Do NOT capture it and do NOT tell the customer the team will ` +
  `come back on it. Call check_availability with startDate ${startDate} and endDate ${endDate}, ` +
  `offer the customer the times it returns, and book one outright: this service books ` +
  `automatically. Offer ONLY times that call gives you - the horizon says nothing about opening ` +
  `hours, so do not work out the last date yourself and do not name one to the customer.`;

/**
 * An auto-book service at its daily cap is not a request.
 *
 * Requests skip slot validation on purpose, and they are uncapped: a request-only service
 * may collect extra demand for the owner to triage. That must not become the fallback when
 * an AUTO-BOOK service hits maxBookingsPerDay. The owner already set the limit. Observed
 * on production: two held jobs, cap 2, asked for 14:00 the same day - the create path
 * refused, then request_appointment wrote a row and the customer was told the team would
 * confirm it because of location, availability and type of work.
 */
export const requestServiceDayFull = (startDate: string, endDate: string): string =>
  `This service already has its maximum number of bookings for that date, so it cannot be booked OR requested ` +
  `- the owner has already set that limit, so there is nothing for them to confirm. Do NOT capture it and do NOT tell the customer the team will come back ` +
  `on it. SAY THE REASON: tell the customer plainly that this service is fully booked for that whole date because the business limits how many of these ` +
  `appointments it takes per day. Do NOT say only the time they asked for is unavailable, and do NOT offer another time on that same date. ` +
  `Call check_availability with startDate ${startDate} and endDate ${endDate}, offer the ` +
  `customer the times it returns, and book one outright: this service books automatically. ` +
  `Offer ONLY times that call gives you. Do not retry the same date.`;

/**
 * An auto-book service on a closed weekday is not a request.
 *
 * Requests skip slot validation on purpose: a request is a preference and the owner
 * decides. That holds for a full day. It does not hold for a weekday the business does
 * not open — they have already said no, and bookable times sit on the next open day.
 * Observed: Thursday closed, asked for Thursday 10:00, the bot offered to register
 * the appointment as a request while Friday was open.
 */
export const requestClosedDay = (startDate: string, endDate: string): string =>
  `That date is closed: the business is not open that day, so it cannot be booked OR requested ` +
  `- they have already said they do not take appointments that day, so there is nothing ` +
  `for them to confirm. Do NOT capture it and do NOT tell the customer the team will come back ` +
  `on it. SAY THE REASON: tell the customer plainly that the business is closed that whole date. ` +
  `Do NOT say only the time they asked for is unavailable, and do NOT offer another time on that same date. ` +
  `Call check_availability with startDate ${startDate} and endDate ${endDate}, offer the ` +
  `customer the times it returns, and book one outright: this service books automatically. ` +
  `Offer ONLY times that call gives you. Do not retry the same date.`;

/**
 * An auto-book service at an hour it does not open is not a request.
 *
 * The last hole in the window gates, and `requestClosedDay` above is why it stayed open so long:
 * that one refuses a date with NO hours, so a date WITH hours looked handled. It was not. 03:00
 * against a 09:00-17:00 Tuesday is the first case `docs/booking-rules.md:26-28` names, and the
 * request path never looked at the day's windows at all. The offer path cannot produce that hour
 * - `windowsForDay` never yields a start outside a window - so `check_availability` simply
 * returns the day's real times, and only `request_appointment` could bank one. The owner then
 * wakes to a request for an hour they never sold.
 *
 * THE DATE STAYS, AND THAT IS THE DIFFERENCE FROM EVERY MESSAGE ABOVE. Closed, capped, too soon
 * and too far all send the customer to ANOTHER DATE. This date is open, so its own hours are the
 * answer, and moving the customer off it would refuse times the business actively sells. Hence
 * one date in, one date out, and the explicit "do not say closed". Only while the date still has
 * a time the business can take: `requestOutsideHoursNoneLeft` is the date whose hours are gone.
 *
 * The opening clock itself is still absent, for the reason `requestTooSoon` documents at length:
 * a bound this server states outranks the model's own reading, and the model is about to hold a
 * real check for that date which carries the true hours.
 */
export const requestOutsideHours = (date: string): string =>
  `That time is outside this business's opening hours for that date, so it cannot be booked OR ` +
  `requested - they have already said they do not work at that hour, so there is nothing for ` +
  `them to confirm. Do NOT capture it and do NOT tell the customer the team will come back on ` +
  `it. SAY THE REASON: tell the customer plainly that the business does not open at the hour ` +
  `they asked for. The business IS open on that date, so do NOT say it is closed for the day ` +
  `and do NOT move the customer to another date. Call check_availability with startDate ` +
  `${date} and endDate ${date} (whole day, no earliestTime or latestTime), offer the customer ` +
  `the times it returns for that same date, and book one outright: this service books ` +
  `automatically. Offer ONLY times that call gives you - do not work out the opening hours ` +
  `yourself and do not name an hour to the customer. If that call returns no times, follow the ` +
  `guidance it returns instead.`;

/**
 * `requestOutsideHours` on a date with no time left the business can take: its hours have gone
 * by, sit inside the notice, or lie past the horizon. Keeping the customer on that date would
 * contradict the check for it, so this one names the range that check itself would retry.
 */
export const requestOutsideHoursNoneLeft = (startDate: string, endDate: string): string =>
  `That time is outside this business's opening hours for that date, so it cannot be booked OR ` +
  `requested - they have already said they do not work at that hour, so there is nothing for ` +
  `them to confirm. Do NOT capture it and do NOT tell the customer the team will come back on ` +
  `it. No time the business can still take is left on that date either. SAY THE REASON: tell ` +
  `the customer plainly that the business does not open at the hour they asked for and that ` +
  `nothing is left on that date. Do NOT say the business is closed that day, and do NOT offer ` +
  `another time on that same date. Call check_availability with startDate ${startDate} and ` +
  `endDate ${endDate}, offer the customer the times it returns, and book one outright: this ` +
  `service books automatically. Offer ONLY times that call gives you - do not work out the ` +
  `opening hours yourself and do not name an hour to the customer.`;

/**
 * The same refusal for a move whose Service sends changes to the owner. The hour is refused
 * before any change Request is written, and the range comes from the same decision as above.
 */
export const rescheduleOutsideHours = (startDate: string, endDate: string): string =>
  `That time is outside this business's opening hours, so the appointment cannot be moved there ` +
  `and no change request can be sent for it - they have already said they do not work at that ` +
  `hour, so there is nothing for them to approve. The existing appointment has NOT been changed. ` +
  `Do NOT tell the customer the team will come back on that time. SAY BOTH: tell the customer ` +
  `plainly that the business does not open at the hour they asked for, and that their ` +
  `appointment still stands. Call check_availability with startDate ${startDate} and endDate ` +
  `${endDate} (no earliestTime or latestTime), offer the customer ONLY the times it returns, and ` +
  `call reschedule_booking again with the one they choose. Do not work out the opening hours ` +
  `yourself and do not name an hour to the customer. Do NOT capture it with request_appointment: ` +
  `a move is not a new request.`;

/** `requestClosedDay` for a move: another date, never another hour on the refused one. */
export const rescheduleClosedDay = (startDate: string, endDate: string): string =>
  `That date is closed: the business is not open that day, so the appointment cannot be moved ` +
  `to any time on it and no change request can be sent for it - they have already said they do ` +
  `not take appointments that day, so there is nothing for them to approve. The existing ` +
  `appointment has NOT been changed. Do NOT tell the customer the team will come back on it. ` +
  `SAY BOTH: tell the customer plainly that the business is closed that whole date, and that ` +
  `their appointment still stands. Do NOT offer another time on that same date. Call ` +
  `check_availability with startDate ${startDate} and endDate ${endDate}, offer the customer ` +
  `ONLY the times it returns, and call reschedule_booking again with the one they choose. Do NOT ` +
  `capture it with request_appointment: a move is not a new request. Do not retry the same date.`;

/** `requestInPast` for a move: those hours have gone by, and the appointment still stands. */
export const reschedulePast = (startDate: string, endDate: string): string =>
  `That time has already passed, so the appointment cannot be moved there and no change request ` +
  `can be sent for it - there is nothing for the business to approve. The existing appointment ` +
  `has NOT been changed. Do NOT tell the customer the team will come back on it. SAY BOTH: tell ` +
  `the customer plainly that those hours have already gone by, and that their appointment still ` +
  `stands. Call check_availability with startDate ${startDate} and endDate ${endDate}, offer the ` +
  `customer ONLY the times it returns, and call reschedule_booking again with the one they ` +
  `choose. Do not work out the next date yourself and do not name one to the customer. Do NOT ` +
  `capture it with request_appointment: a move is not a new request.`;

/** `requestTooSoon` for a move: the range only, never the notice bound itself. */
export const rescheduleTooSoon = (startDate: string, endDate: string): string =>
  `That time is sooner than the notice this business needs, so the appointment cannot be moved ` +
  `there and no change request can be sent for it - they have already said they do not take ` +
  `appointments at that notice, so there is nothing for them to approve. The existing ` +
  `appointment has NOT been changed. Do NOT tell the customer the team will come back on it. ` +
  `SAY BOTH: tell the customer plainly that the business needs more notice than that, and that ` +
  `their appointment still stands. Call check_availability with startDate ${startDate} and ` +
  `endDate ${endDate}, offer the customer ONLY the times it returns, and call reschedule_booking ` +
  `again with the one they choose. The notice says nothing about opening hours, so do not work ` +
  `out the earliest date yourself and do not name one to the customer. Do NOT capture it with ` +
  `request_appointment: a move is not a new request.`;

/**
 * An auto-book Request with no availability check behind it.
 * BK 2026-09-08: first reply offered a same-day appointment as a request for the owner to
 * review — zero tool calls, open day, free times. The window gates above cannot see it because
 * the time was inside the window. This is booking-rules.md "Never call request_appointment on
 * Auto-book before a check_availability result exists for that date", enforced.
 */
export const requestBeforeCheck = (date: string): string =>
  `This service books automatically and nothing has checked ${date} yet, so it cannot be captured as a request - a free time would silently become an unconfirmed request. Do NOT capture it and do NOT tell the customer the team will come back on it. Call check_availability with startDate ${date} and endDate ${date} (whole day, no earliestTime or latestTime). If the customer's time is in the result, confirm it with create_booking; otherwise offer ONLY the times that call returns. Capture a request only if that call returns no times, fails, or returns CALENDAR_NOT_CONNECTED.`;

