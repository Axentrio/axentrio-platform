/**
 * Public (unauthenticated) self-service booking pages reached from email links.
 * The signed token in the URL is the authorization. Server-rendered HTML so we
 * don't have to expose a route through the fully-Clerk-gated portal SPA.
 */
import { Request, Response } from 'express';
import { DateTime } from 'luxon';
import { verifyBookingToken, signBookingToken } from './booking-token';
import { getManageBooking, adminCancelBooking, adminRescheduleBooking, adminAvailability } from '../n8n/booking.service';
import { BookingError } from '../n8n/booking-providers/types';
import { logger } from '../utils/logger';

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

function whenLabel(startIso: string, tz: string): string {
  return `${DateTime.fromISO(startIso).setZone(tz).toFormat('cccc d LLLL yyyy, HH:mm')} (${tz})`;
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

    res.status(200).send(
      page(
        'Manage appointment',
        `<h1>${esc(eventName)}</h1>
         <p>Manage your upcoming appointment.</p>
         <div class="when">${esc(whenLabel(booking.startUtc.toISOString(), timezone))}</div>
         <div class="row">
           <a class="btn btn-primary" href="/api/v1/bookings/manage/reschedule?token=${encodeURIComponent(token)}">Reschedule</a>
           <form method="post" action="/api/v1/bookings/manage/cancel">
             <input type="hidden" name="token" value="${esc(token)}"/>
             <button class="btn btn-danger" type="submit">Cancel appointment</button>
           </form>
         </div>`
      )
    );
  } catch (err) {
    logger.warn('[BookingPublic] manage page error', { error: err instanceof Error ? err.message : String(err) });
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
    await adminCancelBooking({ kind: 'public-manage', verifiedBookingId: bookingId }, view.booking.tenantId, bookingId);
    res.status(200).send(
      page(
        'Appointment cancelled',
        `<h1>${esc(view.eventName)}</h1><p>Your appointment has been cancelled. A confirmation has been emailed to you.</p>`
      )
    );
  } catch (err) {
    if (err instanceof BookingError) return errorPage(res, err.message);
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
    const token = signBookingToken(bookingId);

    const start = new Date();
    const end = new Date(start.getTime() + 30 * 24 * 3600_000);
    // D8: slot lookup inside the token-verified reschedule flow.
    const { slots } = await adminAvailability(
      { kind: 'public-manage', verifiedBookingId: bookingId },
      booking.tenantId,
      start.toISOString(),
      end.toISOString()
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
                       <button class="slot" type="submit">${esc(DateTime.fromISO(iso).setZone(timezone).toFormat('HH:mm'))}</button>
                     </form>`
                )
                .join('') +
              `</div>`
          )
          .join('')
      : `<p>No available times in the next 30 days. Please contact us directly.</p>`;

    res.status(200).send(
      page(
        'Reschedule appointment',
        `<h1>Reschedule</h1>
         <p>${esc(eventName)} — currently ${esc(whenLabel(booking.startUtc.toISOString(), timezone))}. Pick a new time:</p>
         ${slotsHtml}
         <p class="muted">Times shown in ${esc(timezone)}.</p>`
      )
    );
  } catch (err) {
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
    await adminRescheduleBooking({ kind: 'public-manage', verifiedBookingId: bookingId }, view.booking.tenantId, bookingId, newStartTime);
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
    if (err instanceof BookingError) return errorPage(res, err.message);
    logger.warn('[BookingPublic] reschedule error', { error: err instanceof Error ? err.message : String(err) });
    errorPage(res, 'This link is invalid or has expired.');
  }
}
