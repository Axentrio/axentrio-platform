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
import { luxonTimeFormat } from '../contracts/clock-format';
import { resolveCustomerChange } from '../booking/customer-change-policy';
import type { CustomerChangeMode } from '../database/entities/ServiceType';
import type { Booking } from '../database/entities/Booking';
import { BOOKING_COPY_EN, getBookingCopy, formatWhen, fill, type BookingCopy } from '../booking/booking-copy';
import { customerLanguageFor } from '../booking/booking-language';
import { getBotConfigForBotId } from '../services/bot-config.service';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Minimal branded HTML shell. */
function page(title: string, bodyHtml: string, lang = 'en', copy: BookingCopy = BOOKING_COPY_EN): string {
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} · ${esc(copy['manage.title_suffix'])}</title>
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

function errorPage(res: Response, message: string, copy: BookingCopy = BOOKING_COPY_EN, lang = 'en'): void {
  res.status(200).send(
    page(copy['manage.error_title'], `<h1>${esc(copy['manage.error_heading'])}</h1><p>${esc(message)}</p>`, lang, copy),
  );
}

/** Back-compat map for tests — English manage-page error strings keyed by BookingError code. */
export const CUSTOMER_MESSAGE: Record<string, string> = {
  BOOKINGS_PAUSED: BOOKING_COPY_EN['manage.err_BOOKINGS_PAUSED'],
  CALENDAR_NOT_CONNECTED: BOOKING_COPY_EN['manage.err_CALENDAR_NOT_CONNECTED'],
  CALENDAR_SYNC_DISABLED: BOOKING_COPY_EN['manage.err_CALENDAR_SYNC_DISABLED'],
  REQUEST_ONLY_SERVICE: BOOKING_COPY_EN['manage.err_REQUEST_ONLY_SERVICE'],
  BOOKING_TEMPORARILY_UNAVAILABLE: BOOKING_COPY_EN['manage.err_BOOKING_TEMPORARILY_UNAVAILABLE'],
  SERVICE_REQUIRED: BOOKING_COPY_EN['manage.err_SERVICE_REQUIRED'],
  SLOT_UNAVAILABLE: BOOKING_COPY_EN['manage.err_SLOT_UNAVAILABLE'],
  BOOKING_NOT_FOUND: BOOKING_COPY_EN['manage.err_BOOKING_NOT_FOUND'],
  CHANGE_NOT_ALLOWED: BOOKING_COPY_EN['manage.err_CHANGE_NOT_ALLOWED'],
  CHANGE_REQUEST_OPEN: BOOKING_COPY_EN['manage.err_CHANGE_REQUEST_OPEN'],
};

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
export function customerMessage(err: BookingError, copy: BookingCopy = BOOKING_COPY_EN): string {
  const keyed = `manage.err_${err.code}` as keyof BookingCopy;
  return err.customerMessage ?? (keyed in copy ? copy[keyed] : undefined) ?? copy['manage.err_invalid_link'];
}

async function loadManageI18n(booking: Booking): Promise<{ lang: string; copy: BookingCopy }> {
  const bot = await getBotConfigForBotId(booking.botId);
  const lang = customerLanguageFor(booking, bot.settings);
  const copy = await getBookingCopy(lang, booking.tenantId);
  return { lang, copy };
}

function whenLabel(startIso: string, tz: string, lang: string): string {
  return formatWhen(DateTime.fromISO(startIso).toJSDate(), tz, lang);
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

type SlotIso = { start: string };

function groupSlotsByDay(slots: SlotIso[], timezone: string, lang: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const s of slots) {
    const dt = DateTime.fromISO(s.start).setZone(timezone).setLocale(lang);
    const day = dt.toFormat('cccc d LLLL');
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(s.start);
  }
  return groups;
}

function rescheduleSlotsHtml(groups: Map<string, string[]>, token: string, timezone: string, lang: string): string {
  if (groups.size === 0) return '';
  return Array.from(groups.entries())
    .map(
      ([day, isos]) =>
        `<div class="day">${esc(day)}</div><div class="slots">` +
        isos
          .map(
            (iso) =>
              `<form method="post" action="/api/v1/bookings/manage/reschedule">
                       <input type="hidden" name="token" value="${esc(token)}"/>
                       <input type="hidden" name="newStartTime" value="${esc(iso)}"/>
                       <button class="slot" type="submit">${esc(DateTime.fromISO(iso).setZone(timezone).setLocale(lang).toFormat(luxonTimeFormat(timezone)))}</button>
                     </form>`
          )
          .join('') +
        `</div>`
    )
    .join('');
}

function requestableTimesHtml(
  state: ReturnType<typeof rescheduleOptionsState>,
  requestable: Array<{ start: string }>,
  timezone: string,
  copy: BookingCopy,
  lang: string,
): string {
  if (state !== 'both' && state !== 'request-only') return '';
  const lead =
    state === 'both' ? copy['manage.requestable_intro_also'] : copy['manage.requestable_intro_still'];
  return `<p>${esc(lead)}${esc(copy['manage.requestable_tail'])}</p>
           <p class="when">${requestable.map((s) => esc(whenLabel(s.start, timezone, lang))).join('<br/>')}</p>`;
}

function reschedulePageHtml(input: {
  eventName: string;
  currentWhen: string;
  requestMode: boolean;
  slotsLength: number;
  slotsHtml: string;
  requestableHtml: string;
  nothingOffered: string;
  timezone: string;
  copy: BookingCopy;
}): string {
  const pickLine = input.slotsLength
    ? input.requestMode
      ? input.copy['manage.pick_request']
      : input.copy['manage.pick']
    : '';
  return `<h1>${esc(input.copy['manage.reschedule_heading'])}</h1>
         <p>${esc(input.eventName)}${esc(fill(input.copy['manage.currently'], { when: input.currentWhen }))}${esc(pickLine)}</p>
         ${input.slotsHtml}${input.requestableHtml}${input.nothingOffered}
         <p class="muted">${esc(fill(input.copy['manage.times_shown_in'], { timezone: input.timezone }))}</p>`;
}

/** GET /manage?token= — booking summary + cancel/reschedule actions. */
export async function getManagePage(req: Request, res: Response): Promise<void> {
  try {
    const { bookingId } = verifyBookingToken(String(req.query.token ?? ''));
    const view = await getManageBooking(bookingId);
    if (!view) return errorPage(res, BOOKING_COPY_EN['manage.not_found']);
    const { booking, timezone, eventName } = view;
    const { lang, copy } = await loadManageI18n(booking);
    const token = signBookingToken(bookingId);

    if (booking.status === 'cancelled') {
      return void res.status(200).send(
        page(copy['manage.cancelled_title'], `<h1>${esc(eventName)}</h1><p>${esc(copy['manage.cancelled_body'])}</p>`, lang, copy)
      );
    }

    const reschedule = effectiveChange(view.rescheduleMode, booking.startUtc, view.rescheduleUntilMin);
    const cancel = effectiveChange(view.cancelMode, booking.startUtc, view.cancelUntilMin);
    const rescheduleBtn =
      reschedule === 'not_allowed'
        ? ''
        : `<a class="btn btn-primary" href="/api/v1/bookings/manage/reschedule?token=${encodeURIComponent(token)}">${
            reschedule === 'request' ? esc(copy['manage.btn_request_reschedule']) : esc(copy['manage.btn_reschedule'])
          }</a>`;
    const cancelBtn =
      cancel === 'not_allowed'
        ? ''
        : `<form method="post" action="/api/v1/bookings/manage/cancel">
             <input type="hidden" name="token" value="${esc(token)}"/>
             <button class="btn btn-danger" type="submit">${
               cancel === 'request' ? esc(copy['manage.btn_request_cancel']) : esc(copy['manage.btn_cancel'])
             }</button>
           </form>`;
    const noActions =
      !rescheduleBtn && !cancelBtn
        ? `<p>${esc(copy['manage.not_changeable'])}</p>`
        : '';

    res.status(200).send(
      page(
        copy['manage.manage_title'],
        `<h1>${esc(eventName)}</h1>
         <p>${esc(copy['manage.manage_intro'])}</p>
         <div class="when">${esc(whenLabel(booking.startUtc.toISOString(), timezone, lang))}</div>
         <div class="row">${rescheduleBtn}${cancelBtn}</div>
         ${noActions}`,
        lang,
        copy,
      )
    );
  } catch (err) {
    logger.warn('[BookingPublic] manage page error', { error: err instanceof Error ? err.message : String(err) });
    if (err instanceof BookingError) return errorPage(res, customerMessage(err));
    errorPage(res, BOOKING_COPY_EN['manage.err_invalid_link']);
  }
}

/** POST /manage/cancel — token in body. */
export async function postCancel(req: Request, res: Response): Promise<void> {
  let lang = 'en';
  let copy: BookingCopy = BOOKING_COPY_EN;
  try {
    const { bookingId } = verifyBookingToken(String(req.body?.token ?? ''));
    const view = await getManageBooking(bookingId);
    if (!view) return errorPage(res, BOOKING_COPY_EN['manage.not_found']);
    ({ lang, copy } = await loadManageI18n(view.booking));
    const result = await adminCancelBooking({ kind: 'public-manage', verifiedBookingId: bookingId }, view.booking.tenantId, bookingId);
    if (result.requested) {
      return void res.status(200).send(
        page(
          copy['manage.cancel_requested_title'],
          `<h1>${esc(view.eventName)}</h1><p>${copy['manage.cancel_requested_body']}</p>`,
          lang,
          copy,
        )
      );
    }
    res.status(200).send(
      page(
        copy['manage.cancelled_title'],
        `<h1>${esc(view.eventName)}</h1><p>${esc(copy['manage.cancelled_confirmed_body'])}</p>`,
        lang,
        copy,
      )
    );
  } catch (err) {
    if (err instanceof BookingError) return errorPage(res, customerMessage(err, copy), copy, lang);
    logger.warn('[BookingPublic] cancel error', { error: err instanceof Error ? err.message : String(err) });
    errorPage(res, BOOKING_COPY_EN['manage.err_invalid_link']);
  }
}

/** GET /manage/reschedule?token= — pick a new slot. */
export async function getReschedulePage(req: Request, res: Response): Promise<void> {
  let lang = 'en';
  let copy: BookingCopy = BOOKING_COPY_EN;
  try {
    const { bookingId } = verifyBookingToken(String(req.query.token ?? ''));
    const view = await getManageBooking(bookingId);
    if (!view) return errorPage(res, BOOKING_COPY_EN['manage.not_found']);
    const { booking, timezone, eventName } = view;
    ({ lang, copy } = await loadManageI18n(booking));
    if (booking.status !== 'confirmed') return errorPage(res, copy['manage.no_longer_reschedulable'], copy, lang);
    if (effectiveChange(view.rescheduleMode, booking.startUtc, view.rescheduleUntilMin) === 'not_allowed') {
      return errorPage(res, copy['manage.not_reschedulable_online'], copy, lang);
    }
    const token = signBookingToken(bookingId);
    const requestMode = effectiveChange(view.rescheduleMode, booking.startUtc, view.rescheduleUntilMin) === 'request';

    const start = new Date();
    const end = new Date(start.getTime() + 30 * 24 * 3600_000);
    const { slots, travel } = await adminAvailability(
      { kind: 'public-manage', verifiedBookingId: bookingId },
      booking.tenantId,
      start.toISOString(),
      end.toISOString(),
      booking.eventTypeId ?? undefined,
      booking.bookedDurationMin ?? undefined,
      bookingId,
      booking.botId
    );

    const requestable = travel?.requestableSlots ?? [];
    const state = rescheduleOptionsState(slots.length, requestable.length);
    const nothingOffered =
      state === 'none' ? `<p>${esc(copy['manage.no_times'])}</p>` : '';
    res.status(200).send(
      page(
        copy['manage.reschedule_title'],
        reschedulePageHtml({
          eventName,
          currentWhen: whenLabel(booking.startUtc.toISOString(), timezone, lang),
          requestMode,
          slotsLength: slots.length,
          slotsHtml: slots.length
            ? rescheduleSlotsHtml(groupSlotsByDay(slots, timezone, lang), token, timezone, lang)
            : '',
          requestableHtml: requestableTimesHtml(state, requestable, timezone, copy, lang),
          nothingOffered,
          timezone,
          copy,
        }),
        lang,
        copy,
      ),
    );
  } catch (err) {
    if (err instanceof BookingError) return errorPage(res, customerMessage(err, copy), copy, lang);
    logger.warn('[BookingPublic] reschedule page error', { error: err instanceof Error ? err.message : String(err) });
    errorPage(res, BOOKING_COPY_EN['manage.err_invalid_link']);
  }
}

/** POST /manage/reschedule — token + newStartTime in body. */
export async function postReschedule(req: Request, res: Response): Promise<void> {
  let lang = 'en';
  let copy: BookingCopy = BOOKING_COPY_EN;
  try {
    const { bookingId } = verifyBookingToken(String(req.body?.token ?? ''));
    const newStartTime = String(req.body?.newStartTime ?? '');
    const view = await getManageBooking(bookingId);
    if (!view) return errorPage(res, BOOKING_COPY_EN['manage.not_found']);
    ({ lang, copy } = await loadManageI18n(view.booking));
    const result = await adminRescheduleBooking({ kind: 'public-manage', verifiedBookingId: bookingId }, view.booking.tenantId, bookingId, newStartTime);
    if (result.requested) {
      const when = whenLabel(result.booking.startTime, view.timezone, lang);
      return void res.status(200).send(
        page(
          copy['manage.reschedule_requested_title'],
          `<h1>${esc(view.eventName)}</h1><p>${esc(copy['manage.reschedule_requested_body'])}</p>
           <div class="when">${esc(when)}</div>
           <p>${copy['manage.reschedule_not_confirmed']}</p>`,
          lang,
          copy,
        )
      );
    }
    const updated = await getManageBooking(bookingId);
    const when = updated ? whenLabel(updated.booking.startUtc.toISOString(), updated.timezone, lang) : '';
    res.status(200).send(
      page(
        copy['manage.rescheduled_title'],
        `<h1>${esc(view.eventName)}</h1><p>${esc(copy['manage.rescheduled_body'])}</p>
         <div class="when">${esc(when)}</div>
         <p>${esc(copy['manage.updated_invite'])}</p>`,
        lang,
        copy,
      )
    );
  } catch (err) {
    if (err instanceof BookingError) return errorPage(res, customerMessage(err, copy), copy, lang);
    logger.warn('[BookingPublic] reschedule error', { error: err instanceof Error ? err.message : String(err) });
    errorPage(res, BOOKING_COPY_EN['manage.err_invalid_link']);
  }
}
