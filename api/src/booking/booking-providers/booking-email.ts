/**
 * Booking invite emails. Builds an ICS and emails it to the customer (and, in
 * Phase 0, the owner) as a `text/calendar` attachment so it lands on their
 * calendar with native reminders. Email failures are non-fatal — a confirmed
 * booking is never rolled back because the invite didn't send.
 */
import { config } from '../../config/environment';
import { EmailService, type EmailAttachment } from '../../automations/email.service';
import { logger } from '../../utils/logger';
import { buildIcs, IcsMethod } from './ics';
import { senderFor, parseAddress } from './organizer-address';
import { emailDeliveryService } from '../../services/email-delivery.service';
import {
  fill,
  formatWhen,
  getBookingCopy,
  type BookingCopy,
  type RejectReasonKey,
} from '../booking-copy';

let emailService: EmailService | null = null;
function getEmailService(): EmailService {
  if (!emailService) {
    emailService = new EmailService(config.email.resendApiKey, config.email.fromAddress);
  }
  return emailService;
}

/**
 * Send one booking email, and report a failure HOWEVER it arrives.
 *
 * `EmailService.send` does not throw when delivery fails. An unconfigured Resend key comes back
 * as `{ success: false, error: 'not configured' }` and a provider error the same way - the two
 * likeliest failures. Each site below wrapped its send in a `try`/`catch` and nothing else, so
 * for those two the `catch` never ran and the log line never fired. Booking emails could stop
 * going out entirely and the logs would be clean: the bookings are created, the calendar events
 * exist, and the only signal that customers are receiving nothing was the line that could not
 * run (#90).
 *
 * Written once rather than checked at four call sites, because four is how one gets missed.
 *
 * Still NON-FATAL, which is the design and stays the design: a booking must not fail because
 * mail is down. This reports and returns; it never throws.
 */
async function sendOrReport(
  what: string,
  /** Optional because the reminder and request-notification params carry no `uid`, and their
   *  log lines never did either. Omitted rather than faked. */
  params: { uid?: string; tenantId?: string; bookingId?: string },
  options: Parameters<EmailService['send']>[0] & { retainPayload?: boolean },
  context: Record<string, unknown> = {},
): Promise<boolean> {
  const { retainPayload, ...sendOptions } = options;
  try {
    if (params.tenantId && sendOptions.idempotencyKey) {
      if (!params.bookingId) {
        logger.warn(`[Booking] ${what} failed (non-fatal)`, {
          ...(params.uid ? { uid: params.uid } : {}),
          ...context,
          error: 'bookingId is required for a durable booking email',
        });
        return false;
      }
      const to = sendOptions.to;
      const recipientEmail = Array.isArray(to) ? to[0] : to;
      const result = await emailDeliveryService.sendDurable({
        recipientEmail,
        subject: sendOptions.subject,
        body: sendOptions.body,
        from: sendOptions.from,
        replyTo: sendOptions.replyTo,
        attachments: sendOptions.attachments,
        idempotencyKey: sendOptions.idempotencyKey,
        kind: 'booking_email',
        tenantId: params.tenantId,
        relatedId: params.bookingId,
        retainPayload: retainPayload === true,
      });
      if (result.status === 'failed') {
        logger.warn(`[Booking] ${what} failed (non-fatal)`, {
          ...(params.uid ? { uid: params.uid } : {}),
          ...context,
          error: result.error ?? 'delivery reported failure',
        });
        return false;
      }
      return true;
    }
    const result = await getEmailService().send(sendOptions);
    if (result?.success === false) {
      logger.error(`[Booking] ${what} failed (non-fatal)`, {
        ...(params.uid ? { uid: params.uid } : {}),
        ...context,
        error: result.error ?? 'delivery reported failure',
      });
      return false;
    }
    return true;
  } catch (err) {
    const log = params.tenantId && sendOptions.idempotencyKey ? logger.warn : logger.error;
    log(`[Booking] ${what} failed (non-fatal)`, {
      ...(params.uid ? { uid: params.uid } : {}),
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface BookingEmailParams {
  method: IcsMethod;
  uid: string;
  sequence: number;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  timezone: string;
  attendeeName: string;
  /** Optional — absent for channel bookings (WhatsApp/Messenger) where the
   *  customer gives no email. The invite email is then skipped (they're
   *  confirmed in-channel and the owner sees it on their calendar). */
  attendeeEmail?: string;
  tenantId: string;
  bookingId: string;
  /** The business's own address. Gets its OWN message now, not a seat on the customer's. */
  ownerEmail?: string;
  /**
   * The operational detail for the owner's copy — customer name, phone, address, intake
   * answers, reference. Already assembled by `buildBookingEventContent` for the calendar
   * body; passed through so the owner's email says the same thing their calendar entry
   * does. Plain text in, escaped here.
   */
  ownerDetail?: string | null;
  /**
   * The FROZEN ICS organizer for this booking (Booking.organizer_email). Null on rows
   * predating that column, which fall back to the old ownerEmail-then-platform resolution
   * so their already-sent invite keeps matching.
   */
  organizerEmail?: string | null;
  /** Display name for the organizer — the business, not the platform. */
  organizerName?: string | null;
  /** Self-service manage link (reschedule/cancel). Omitted on cancellation. */
  manageUrl?: string;
  /** Effective length, so the customer knows how long to set aside. */
  durationMin?: number | null;
  /**
   * Owner-authored prep notes for this service ("please arrive with clean hair").
   * Customer-facing by nature — it is the one piece of owner content that belongs in
   * this email, which both the customer AND the owner receive.
   */
  preparationInstructions?: string | null;
  /**
   * Already-formatted price from `formatServicePrice`. Empty or absent means
   * no price — omitted from the customer body. The owner's copy gets the same
   * string via `ownerDetail` (the calendar body).
   */
  priceDisplay?: string | null;
  /**
   * The customer's uploaded files, already read + base64-encoded, attached to the OWNER's
   * copy so they see them inline instead of a "N files attached — open in Axentrio" pointer.
   * Owner-only: the customer uploaded these, so their invite never carries them. Absent or
   * empty leaves that pointer as the fallback (e.g. a file too big to attach).
   */
  ownerAttachments?: EmailAttachment[];
  /**
   * A video booking whose calendar account produced no meeting link (e.g. a personal
   * Microsoft account, which cannot host Teams). Adds a heads-up to the OWNER's copy so they
   * can reconnect a work account. Owner-only; the customer copy never shows it.
   */
  videoLinkMissing?: boolean;
  customerLanguage: string;
  ownerLanguage: string;
}

/** Escape user-supplied text before interpolating it into an HTML email body. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Re-exported for the ICS-organizer regression test; the implementation is shared with
 *  the sender resolution so the two can never disagree about what an address is. */
export { parseAddress };

/**
 * `From:` for this booking, aligned with its FROZEN ICS ORGANIZER whenever that address is
 * one we may legally send from. Recomputing it instead would drift away from the organizer
 * the invite was issued under, and rows backfilled by migration 1788900000000 carry the
 * tenant's OWN domain, which Resend would reject outright.
 */
const senderFrom = (p: BookingEmailParams): string =>
  senderFor(p.organizerEmail, p.organizerName ?? undefined);

/** Stable across retries of the SAME invite; a reconciler re-claim must not double-send. */
const inviteIdempotencyKey = (p: BookingEmailParams, audience: string): string =>
  `booking:${p.uid}:${p.sequence}:${p.method}:${audience}`;

/**
 * Tell the OWNER about a booking, in their own message.
 *
 * The owner used to be a second `To:` on the customer's invite. That was wrong three ways:
 * they received a `METHOD:REQUEST` in which they hold no role at all (RFC 5546 frames a
 * REQUEST as addressed to its Attendees, and the only ATTENDEE is the customer), the
 * customer could see the owner's address in the header, and one body had to serve two
 * audiences who need opposite things — the customer needs "your appointment is confirmed",
 * the owner needs the phone number and the address.
 *
 * No ICS here on purpose. The owner's calendar entry comes from the mirror, which carries
 * the same content; a second copy of the same event arriving as an invite is how you end up
 * with duplicates in a calendar.
 */
async function notifyOwner(
  params: BookingEmailParams,
  customerWasInvited: boolean,
  copy: BookingCopy,
): Promise<void> {
  const cancelled = params.method === 'CANCEL';
  const subject = fill(
    cancelled ? copy['owner.subject_cancelled'] : copy['owner.subject_new'],
    { summary: params.summary },
  );
  const detail = params.ownerDetail?.trim()
    ? `<p>${esc(params.ownerDetail.trim()).replace(/\n/g, '<br/>')}</p>`
    : '';
  const action = esc(
    fill(cancelled ? copy['owner.cancelled'] : copy['owner.booked'], {
      who: params.attendeeName?.trim() || copy['owner.a_customer'],
    }),
  );
  const body =
    `<p>${action}</p>` +
    `<p><strong>${esc(params.summary)}</strong><br/>${esc(formatWhen(params.start, params.timezone, params.ownerLanguage))}</p>` +
    (params.location ? `<p>${esc(fill(copy['owner.where'], { location: params.location }))}</p>` : '') +
    (params.videoLinkMissing && !cancelled
      ? `<p><strong>${esc(copy['owner.video_link_missing'])}</strong></p>`
      : '') +
    detail +
    (customerWasInvited ? '' : `<p>${esc(copy['owner.no_customer_email'])}</p>`);
  await sendOrReport('owner notification', params, {
    to: [params.ownerEmail as string],
    from: senderFrom(params),
    subject,
    body,
    ...(customerWasInvited && params.attendeeEmail ? { replyTo: params.attendeeEmail } : {}),
    idempotencyKey: inviteIdempotencyKey(params, customerWasInvited ? 'owner' : 'owner-only'),
    ...(params.ownerAttachments?.length ? { attachments: params.ownerAttachments } : {}),
    retainPayload: false,
  });
}

/**
 * The customer-facing invite/cancellation body.
 *
 * Everything interpolated here is escaped. It previously was not — `summary` is
 * owner-authored and `location`/`description` become customer-influenced as soon as an
 * address or intake answer reaches them, so the unescaped version was one service rename
 * away from injecting markup into a real customer's inbox.
 */
function customerEmailBody(params: BookingEmailParams, cancelled: boolean, copy: BookingCopy): string {
  const lead = cancelled ? copy['customer.lead_cancelled'] : copy['customer.lead_confirmed'];
  const duration =
    typeof params.durationMin === 'number' && params.durationMin > 0
      ? ` &middot; ${esc(fill(copy['customer.minutes'], { n: params.durationMin }))}`
      : '';
  const price =
    !cancelled && params.priceDisplay?.trim()
      ? ` &middot; ${esc(params.priceDisplay.trim())}`
      : '';
  return (
    `<p>${lead}</p>` +
    `<p><strong>${esc(params.summary)}</strong><br/>${esc(formatWhen(params.start, params.timezone, params.customerLanguage))}${duration}${price}</p>` +
    (params.location ? `<p>${esc(fill(copy['customer.location'], { location: params.location }))}</p>` : '') +
    (!cancelled && params.preparationInstructions?.trim()
      ? `<p><strong>${esc(copy['customer.before_heading'])}</strong><br/>${esc(params.preparationInstructions.trim())}</p>`
      : '') +
    `<p>${esc(copy['customer.invite_attached'])}</p>` +
    (!cancelled && params.manageUrl
      ? `<p><a href="${esc(params.manageUrl)}">${esc(copy['customer.manage_link'])}</a></p>`
      : '')
  );
}

export async function sendBookingEmail(params: BookingEmailParams): Promise<void> {
  const [customerCopy, ownerCopy] = await Promise.all([
    getBookingCopy(params.customerLanguage, params.tenantId),
    getBookingCopy(params.ownerLanguage, params.tenantId),
  ]);

  if (!params.attendeeEmail || !params.attendeeEmail.trim()) {
    if (params.ownerEmail?.trim()) await notifyOwner(params, false, ownerCopy);
    return;
  }

  const organizer = parseAddress(params.organizerEmail || params.ownerEmail || config.email.fromAddress);
  const ics = buildIcs({
    uid: params.uid,
    sequence: params.sequence,
    method: params.method,
    start: params.start,
    end: params.end,
    summary: params.summary,
    description: params.description,
    location: params.location,
    organizerEmail: organizer.email,
    organizerName: params.organizerName || organizer.name,
    attendeeEmail: params.attendeeEmail,
    attendeeName: params.attendeeName,
  });

  const to = [params.attendeeEmail];
  const cancelled = params.method === 'CANCEL';
  const subject = fill(
    cancelled ? customerCopy['customer.subject_cancelled'] : customerCopy['customer.subject_confirmed'],
    { summary: params.summary },
  );
  const body = customerEmailBody(params, cancelled, customerCopy);

  await sendOrReport(
    'invite email',
    params,
    {
      to,
      from: senderFrom(params),
      subject,
      body,
      ...(params.ownerEmail ? { replyTo: params.ownerEmail } : {}),
      idempotencyKey: inviteIdempotencyKey(params, 'invite'),
      attachments: [
        {
          filename: cancelled ? 'cancel.ics' : 'invite.ics',
          content: Buffer.from(ics, 'utf8').toString('base64'),
          contentType: `text/calendar; method=${params.method}; charset=utf-8`,
        },
      ],
      retainPayload: true,
    },
    { method: params.method },
  );

  if (params.ownerEmail?.trim()) await notifyOwner(params, true, ownerCopy);
}

export interface ReminderEmailParams {
  summary: string;
  start: Date;
  timezone: string;
  attendeeName: string;
  attendeeEmail: string;
  lead: '24h' | '1h';
  customerLanguage: string;
  manageUrl?: string;
}

/** Plain appointment reminder (no ICS — the invite was sent on confirmation). */
export async function sendReminderEmail(params: ReminderEmailParams): Promise<void> {
  if (!params.attendeeEmail || !params.attendeeEmail.trim()) return;
  const copy = await getBookingCopy(params.customerLanguage);
  const when =
    params.lead === '24h' ? copy['customer.reminder_tomorrow'] : copy['customer.reminder_in_1_hour'];
  const body =
    `<p>${esc(fill(copy['customer.reminder_lead'], { when }))}</p>` +
    `<p><strong>${esc(params.summary)}</strong><br/>${esc(formatWhen(params.start, params.timezone, params.customerLanguage))}</p>` +
    (params.manageUrl
      ? `<p><a href="${esc(params.manageUrl)}">${esc(copy['customer.reminder_manage_link'])}</a></p>`
      : '');
  await sendOrReport('reminder email', {}, {
    to: params.attendeeEmail,
    subject: fill(copy['customer.reminder_subject'], { summary: params.summary }),
    body,
  });
}

export interface RequestNotificationParams {
  ownerEmail: string;
  serviceName: string;
  start: Date;
  timezone: string;
  attendeeName: string;
  attendeeEmail?: string;
  notes?: string;
  aiSummary?: string;
  ownerLanguage: string;
}

/**
 * Owner-only notification that a customer captured an appointment **request**
 * (not a confirmed booking). Plain HTML, NO ICS — there is nothing to add to a
 * calendar until the owner reviews it. Non-fatal: the request stands if email fails.
 */
export async function sendRequestNotificationEmail(params: RequestNotificationParams): Promise<void> {
  const copy = await getBookingCopy(params.ownerLanguage);
  const fromLine = params.attendeeEmail
    ? `${esc(params.attendeeName)} (${esc(params.attendeeEmail)})`
    : esc(fill(copy['owner.request_from'], { who: params.attendeeName }));
  const body =
    `<p>${esc(copy['owner.request_intro'])}</p>` +
    `<p><strong>${esc(params.serviceName)}</strong><br/>${esc(
      fill(copy['owner.request_preferred_time'], {
        when: formatWhen(params.start, params.timezone, params.ownerLanguage),
      }),
    )}</p>` +
    `<p>${fromLine}</p>` +
    (params.aiSummary ? `<p>${esc(fill(copy['owner.request_summary'], { text: params.aiSummary }))}</p>` : '') +
    (params.notes ? `<p>${esc(fill(copy['owner.request_notes'], { text: params.notes }))}</p>` : '') +
    `<p>${esc(copy['owner.request_follow_up'])}</p>`;
  await sendOrReport('request notification email', {}, {
    to: params.ownerEmail,
    subject: fill(copy['owner.request_subject'], { service: params.serviceName }),
    body,
  });
}

export interface CalendarChangeRejectedParams {
  ownerEmail: string;
  serviceName: string;
  attemptedStart: Date;
  restoredStart: Date;
  timezone: string;
  attendeeName: string;
  reasonKey: RejectReasonKey;
  ownerLanguage: string;
}

/**
 * Owner-only notice that an edit in the connected calendar was undone.
 * No ICS and no customer copy - the booking did not move.
 */
export async function sendCalendarChangeRejectedEmail(
  params: CalendarChangeRejectedParams,
): Promise<void> {
  const copy = await getBookingCopy(params.ownerLanguage);
  const serviceName = params.serviceName.trim() || copy['owner.service_fallback'];
  const body =
    `<p>${esc(copy['owner.rejected_intro'])}</p>` +
    `<p><strong>${esc(serviceName)}</strong><br/>` +
    `${esc(fill(copy['owner.rejected_customer'], { who: params.attendeeName.trim() || copy['owner.a_customer'] }))}<br/>` +
    `${esc(fill(copy['owner.rejected_attempted'], { when: formatWhen(params.attemptedStart, params.timezone, params.ownerLanguage) }))}<br/>` +
    `${esc(fill(copy['owner.rejected_restored'], { when: formatWhen(params.restoredStart, params.timezone, params.ownerLanguage) }))}</p>` +
    `<p>${esc(copy[params.reasonKey])}</p>` +
    `<p>${esc(copy['owner.rejected_footer'])}</p>`;
  await sendOrReport('calendar change rejected email', {}, {
    to: params.ownerEmail,
    subject: fill(copy['owner.rejected_subject'], { service: serviceName }),
    body,
  });
}

/** Test seam — reset the memoized EmailService. */
export function __resetBookingEmailService(): void {
  emailService = null;
}

export type { RejectReasonKey };
