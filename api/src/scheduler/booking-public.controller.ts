/**
 * Public (unauthenticated) self-service booking pages reached from email links.
 * The signed token in the URL is the authorization. Server-rendered HTML so we
 * don't have to expose a route through the fully-Clerk-gated portal SPA.
 */
import { Request, Response } from 'express';
import { DateTime } from 'luxon';
import { verifyBookingToken, signBookingToken } from './booking-token';
import { getManageBooking, adminCancelBooking, adminRescheduleBooking, adminAvailability } from '../booking/booking.service';
import { BookingError } from '../booking/booking-providers/types';
import { logger } from '../utils/logger';
import { luxonEmailWhenFormat, luxonTimeFormat } from '../contracts/clock-format';
import { resolveCustomerChange } from '../booking/customer-change-policy';
import type { CustomerChangeMode } from '../database/entities/ServiceType';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Minimal branded HTML shell. */
function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} · Axentrio</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
         background:#0b0f17; color:#e6e8ee; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { width:100%; max-width:440px; margin:24px; background:#151b26; border:1px solid #232b3a; border-radius:16px; padding:28px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p { color:#9aa3b2; font-size:14px; line-height:1.5; }
  .when { color:#e6e8ee; font-weight:600; font-size:16px; margin:14px 0; }
  .btn { display:inline-block; border:none; border-radius:10px; padding:10px 16px; font-size:14px; font-weight:600;
         cursor:pointer; text-decoration:none; }
  .btn-primary { background:#4f7cff; color:#fff; }
  .btn-danger { background:#e5484d; color:#fff; }
  .btn-ghost { background:transparent; color:#9aa3b2; border:1px solid #232b3a; }
  .row { display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; }
  .day { margin-top:16px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#9aa3b2; }
  .slots { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
  .slot { background:#1c2433; border:1px solid #2a3447; color:#e6e8ee; border-radius:10px; padding:8px 12px; font-size:14px; cursor:pointer; }
  .slot:hover { border-color:#4f7cff; }
  form { display:inline; }
  .muted { font-size:12px; color:#6b7280; margin-top:18px; }
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

function errorPage(res: Response, message: string): void {
  res.status(200).send(page('Link unavailable', `<h1>This link can’t be used</h1><p>${esc(message)}</p>`));
}

/**
 * What to SAY to the customer about a BookingError.
 *
 * `BookingError.message` is written for the model — it is fed to the LLM verbatim by
 * `booking.tool.ts` and reads as instructions ("Do not offer specific times… capture it with
 * request_appointment"). This is the one place those errors reach a human being's browser, so
 * they cannot be rendered raw: the customer would be reading the bot's stage directions.
 *
 * An unknown code falls back to the generic line. That is deliberate — a message reaches this
 * page only by being listed here, so a new error added elsewhere can never leak by default.
 */
export const CUSTOMER_MESSAGE: Record<string, string> = {
  BOOKINGS_PAUSED: 'This business has paused online booking changes for now. Please contact them directly to move your appointment.',
  CALENDAR_NOT_CONNECTED: 'This business can’t confirm changes online at the moment. Please contact them directly to move your appointment.',
  CALENDAR_SYNC_DISABLED: 'This business can’t confirm changes online at the moment. Please contact them directly to move your appointment.',
  REQUEST_ONLY_SERVICE: 'This appointment can’t be moved online. Please contact the business directly.',
  BOOKING_TEMPORARILY_UNAVAILABLE: 'We couldn’t load the available times just now. Please try again in a few minutes.',
  SERVICE_REQUIRED: 'We couldn’t load the available times for this appointment. Please contact the business directly.',
  SLOT_UNAVAILABLE: 'That time has just been taken. Please pick another.',
  BOOKING_NOT_FOUND: 'This appointment could no longer be found.',
  CHANGE_NOT_ALLOWED: 'This appointment cannot be changed online. Please contact the business directly.',
  CHANGE_REQUEST_OPEN: 'You already have a pending change request for this appointment. The business will get back to you.',
};

/**
 * The one rule every public handler uses. Three sources, in order of who knows best:
 *
 * 1. **The throw site**, when it declared customer copy. Whoever raised the error knows what
 *    happened; a controller reconciling codes by hand does not, and drifts.
 * 2. **The allow-list below**, for the errors raised before this existed. Default-DENY: an
 *    unlisted code cannot leak by simply not being thought about.
 * 3. **A generic line**, which is honest and uninformative - the state this design is trying to
 *    make rare rather than the one it settles for.
 */
export function customerMessage(err: BookingError): string {
  return err.customerMessage ?? CUSTOMER_MESSAGE[err.code] ?? 'This link is invalid or has expired.';
}

function whenLabel(startIso: string, tz: string): string {
  return `${DateTime.fromISO(startIso).setZone(tz).toFormat(luxonEmailWhenFormat(tz))} (${tz})`;
}

function effectiveChange(
  mode: CustomerChangeMode,
  startUtc: Date,
  untilMin: number | null,
): CustomerChangeMode {
  return resolveCustomerChange(mode, startUtc, untilMin);
}

/**
 * What the reschedule page has to say, given what availability came back with.
 *
 * ONE FUNCTION BECAUSE ONE MISTAKE. This page used to read an empty slot list as an empty
 * diary, and travel time made those two different things: a customer whose address placed only
 * to a town centre has EVERY time judged undecided by design — a coarse position may refuse a
 * drive and may never clear one — so nothing is confirmable while the business could very well
 * fit them in. Telling that customer there is nothing available is false, and turning them away
 * at "no" is the single outcome the whole booking design is written to avoid.
 *
 * `request-only` is not a lesser `pick`. Those times are deliberately not buttons: submitting
 * one goes straight to a confirmed reschedule, and confirming a drive nobody measured is the
 * defect travel time exists to prevent. They are stated, and the customer is pointed at the
 * business, until write-time enforcement gives this page a real request path.
 *
 * Pure and exported so the distinction can be tested without a signed token and an HTTP round
 * trip, which is what let the original mistake ship untested.
 */
export function rescheduleOptionsState(
  confirmable: number,
  requestable: number
): 'pick' | 'both' | 'request-only' | 'none' {
  if (confirmable && requestable) return 'both';
  if (confirmable) return 'pick';
  if (requestable) return 'request-only';
  return 'none';
}

/** GET /manage?token= — booking summary + cancel/reschedule actions. */
export async function getManagePage(req: Request, res: Response): Promise<void> {
  try {
    const { bookingId } = verifyBookingToken(String(req.query.token ?? ''));
    const view = await getManageBooking(bookingId);
    if (!view) return errorPage(res, 'We couldn’t find this appointment.');
    const { booking, timezone, eventName } = view;
    const token = signBookingToken(bookingId);

    if (booking.status === 'cancelled') {
      return void res.status(200).send(
        page('Appointment cancelled', `<h1>${esc(eventName)}</h1><p>This appointment has been cancelled.</p>`)
      );
    }

    const reschedule = effectiveChange(view.rescheduleMode, booking.startUtc, view.rescheduleUntilMin);
    const cancel = effectiveChange(view.cancelMode, booking.startUtc, view.cancelUntilMin);
    const rescheduleBtn =
      reschedule === 'not_allowed'
        ? ''
        : `<a class="btn btn-primary" href="/api/v1/bookings/manage/reschedule?token=${encodeURIComponent(token)}">${
            reschedule === 'request' ? 'Request reschedule' : 'Reschedule'
          }</a>`;
    const cancelBtn =
      cancel === 'not_allowed'
        ? ''
        : `<form method="post" action="/api/v1/bookings/manage/cancel">
             <input type="hidden" name="token" value="${esc(token)}"/>
             <button class="btn btn-danger" type="submit">${
               cancel === 'request' ? 'Request cancellation' : 'Cancel appointment'
             }</button>
           </form>`;
    const noActions =
      !rescheduleBtn && !cancelBtn
        ? '<p>This appointment cannot be changed online. Please contact the business directly.</p>'
        : '';

    res.status(200).send(
      page(
        'Manage appointment',
        `<h1>${esc(eventName)}</h1>
         <p>Manage your upcoming appointment.</p>
         <div class="when">${esc(whenLabel(booking.startUtc.toISOString(), timezone))}</div>
         <div class="row">${rescheduleBtn}${cancelBtn}</div>
         ${noActions}`
      )
    );
  } catch (err) {
    logger.warn('[BookingPublic] manage page error', { error: err instanceof Error ? err.message : String(err) });
    // The same rule as the other three handlers (#73). This one was the odd one out: it went
    // straight to the generic line, so a customer opening their manage link at a business whose
    // calendar had been disconnected was told their LINK was broken - which is a lie about the
    // one thing they can check, and sends them to look for a new email that does not exist.
    if (err instanceof BookingError) return errorPage(res, customerMessage(err));
    errorPage(res, 'This link is invalid or has expired.');
  }
}

/** POST /manage/cancel — token in body. */
export async function postCancel(req: Request, res: Response): Promise<void> {
  try {
    const { bookingId } = verifyBookingToken(String(req.body?.token ?? ''));
    const view = await getManageBooking(bookingId);
    if (!view) return errorPage(res, 'We couldn’t find this appointment.');
    // D8: token-verified self-service management of an existing appointment —
    // exempt from the bookings feature gate (the verified id IS the proof).
    const result = await adminCancelBooking({ kind: 'public-manage', verifiedBookingId: bookingId }, view.booking.tenantId, bookingId);
    if (result.requested) {
      return void res.status(200).send(
        page(
          'Cancellation requested',
          `<h1>${esc(view.eventName)}</h1><p>We've sent a cancellation request to the business. Your appointment is <strong>not cancelled yet</strong> — they will confirm.</p>`
        )
      );
    }
    res.status(200).send(
      page(
        'Appointment cancelled',
        `<h1>${esc(view.eventName)}</h1><p>Your appointment has been cancelled. A confirmation has been emailed to you.</p>`
      )
    );
  } catch (err) {
    if (err instanceof BookingError) return errorPage(res, customerMessage(err));
    logger.warn('[BookingPublic] cancel error', { error: err instanceof Error ? err.message : String(err) });
    errorPage(res, 'This link is invalid or has expired.');
  }
}

/** GET /manage/reschedule?token= — pick a new slot. */
export async function getReschedulePage(req: Request, res: Response): Promise<void> {
  try {
    const { bookingId } = verifyBookingToken(String(req.query.token ?? ''));
    const view = await getManageBooking(bookingId);
    if (!view) return errorPage(res, 'We couldn’t find this appointment.');
    const { booking, timezone, eventName } = view;
    if (booking.status !== 'confirmed') return errorPage(res, 'This appointment can no longer be rescheduled.');
    if (effectiveChange(view.rescheduleMode, booking.startUtc, view.rescheduleUntilMin) === 'not_allowed') {
      return errorPage(res, 'This appointment cannot be rescheduled online. Please contact the business directly.');
    }
    const token = signBookingToken(bookingId);
    const requestMode = effectiveChange(view.rescheduleMode, booking.startUtc, view.rescheduleUntilMin) === 'request';

    const start = new Date();
    const end = new Date(start.getTime() + 30 * 24 * 3600_000);
    // D8: slot lookup inside the token-verified reschedule flow.
    const { slots, travel } = await adminAvailability(
      { kind: 'public-manage', verifiedBookingId: bookingId },
      booking.tenantId,
      start.toISOString(),
      end.toISOString(),
      booking.eventTypeId ?? undefined,
      booking.bookedDurationMin ?? undefined,
      // Don't count this booking against its own reschedule.
      bookingId,
      // THE AGENT THAT OWNS THIS BOOKING, not the tenant's default one. The mutations already
      // resolved it from the booking through `buildAdminContext`; this read did not, so a
      // customer moving a non-default Agent's appointment was offered slots computed against
      // a different Agent's hours, services and travel settings, and the write then applied
      // them to the right one.
      booking.botId
    );

    // Group slots by day in the owner's timezone.
    const groups = new Map<string, string[]>();
    for (const s of slots) {
      const dt = DateTime.fromISO(s.start).setZone(timezone);
      const day = dt.toFormat('cccc d LLLL');
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push(s.start);
    }

    const slotsHtml = slots.length
      ? Array.from(groups.entries())
          .map(
            ([day, isos]) =>
              `<div class="day">${esc(day)}</div><div class="slots">` +
              isos
                .map(
                  (iso) =>
                    `<form method="post" action="/api/v1/bookings/manage/reschedule">
                       <input type="hidden" name="token" value="${esc(token)}"/>
                       <input type="hidden" name="newStartTime" value="${esc(iso)}"/>
                       <button class="slot" type="submit">${esc(DateTime.fromISO(iso).setZone(timezone).toFormat(luxonTimeFormat(timezone)))}</button>
                     </form>`
                )
                .join('') +
              `</div>`
          )
          .join('')
      : '';

    // TRAVEL TIME CAN EMPTY THIS LIST WITHOUT THE DIARY BEING EMPTY, and saying "no available
    // times" then is simply false. A customer whose address placed only to a town centre has
    // EVERY time judged undecided by design — a coarse position may refuse a drive and may
    // never clear one — so the confirmable list is empty while the business could very well
    // fit them in. Refusing them at that point is the one outcome the whole booking prompt is
    // written to avoid, and it would be this page doing it silently.
    //
    // These times are deliberately NOT buttons. Submitting one goes straight to a confirmed
    // reschedule, and confirming a drive nobody has measured is the defect this feature exists
    // to prevent. So they are stated, and the customer is pointed at the business, until the
    // ticket that adds write-time enforcement gives this page a real request path.
    const requestable = travel?.requestableSlots ?? [];
    const state = rescheduleOptionsState(slots.length, requestable.length);
    const requestableHtml =
      state === 'both' || state === 'request-only'
        ? `<p>${
            state === 'both' ? 'These times may also be possible' : 'These times may still be possible'
          }, but the business has to confirm them because of the travel involved. Get in touch and mention the one you would like:</p>
           <p class="when">${requestable.map((s) => esc(whenLabel(s.start, timezone))).join('<br/>')}</p>`
        : '';
    const nothingOffered =
      state === 'none'
        ? `<p>No available times in the next 30 days. Please contact us directly.</p>`
        : '';

    res.status(200).send(
      page(
        'Reschedule appointment',
        `<h1>Reschedule</h1>
         <p>${esc(eventName)} — currently ${esc(whenLabel(booking.startUtc.toISOString(), timezone))}.${
           slots.length ? (requestMode ? ' Pick a new time to request:' : ' Pick a new time:') : ''
         }</p>
         ${slotsHtml}${requestableHtml}${nothingOffered}
         <p class="muted">Times shown in ${esc(timezone)}.</p>`
      )
    );
  } catch (err) {
    // The sibling POST handlers both do this; only the page that OPENS the flow did not, so
    // every domain error here — a paused business, a temporarily unavailable diary, a
    // multi-service tenant needing a service id — was reported to the customer as a broken
    // link. They then have no reason to try again, and the owner never hears about it.
    if (err instanceof BookingError) return errorPage(res, customerMessage(err));
    logger.warn('[BookingPublic] reschedule page error', { error: err instanceof Error ? err.message : String(err) });
    errorPage(res, 'This link is invalid or has expired.');
  }
}

/** POST /manage/reschedule — token + newStartTime in body. */
export async function postReschedule(req: Request, res: Response): Promise<void> {
  try {
    const { bookingId } = verifyBookingToken(String(req.body?.token ?? ''));
    const newStartTime = String(req.body?.newStartTime ?? '');
    const view = await getManageBooking(bookingId);
    if (!view) return errorPage(res, 'We couldn’t find this appointment.');
    // D8: token-verified self-service management of an existing appointment.
    const result = await adminRescheduleBooking({ kind: 'public-manage', verifiedBookingId: bookingId }, view.booking.tenantId, bookingId, newStartTime);
    if (result.requested) {
      const when = whenLabel(result.booking.startTime, view.timezone);
      return void res.status(200).send(
        page(
          'Reschedule requested',
          `<h1>${esc(view.eventName)}</h1><p>We've asked the business to move your appointment to:</p>
           <div class="when">${esc(when)}</div>
           <p>This is <strong>not confirmed yet</strong>. Your original appointment still stands until they accept.</p>`
        )
      );
    }
    const updated = await getManageBooking(bookingId);
    const when = updated ? whenLabel(updated.booking.startUtc.toISOString(), updated.timezone) : '';
    res.status(200).send(
      page(
        'Appointment rescheduled',
        `<h1>${esc(view.eventName)}</h1><p>Your appointment has been moved to:</p>
         <div class="when">${esc(when)}</div>
         <p>An updated invite has been emailed to you.</p>`
      )
    );
  } catch (err) {
    if (err instanceof BookingError) return errorPage(res, customerMessage(err));
    logger.warn('[BookingPublic] reschedule error', { error: err instanceof Error ? err.message : String(err) });
    errorPage(res, 'This link is invalid or has expired.');
  }
}
