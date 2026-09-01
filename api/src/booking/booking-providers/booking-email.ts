/**
 * Booking invite emails. Builds an ICS and emails it to the customer (and, in
 * Phase 0, the owner) as a `text/calendar` attachment so it lands on their
 * calendar with native reminders. Email failures are non-fatal — a confirmed
 * booking is never rolled back because the invite didn't send.
 */
import { DateTime } from 'luxon';
import { config } from '../../config/environment';
import { luxonEmailWhenFormat } from '../../contracts/clock-format';
import { EmailService, type EmailAttachment } from '../../automations/email.service';
import { logger } from '../../utils/logger';
import { buildIcs, IcsMethod } from './ics';
import { senderFor, parseAddress } from './organizer-address';

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
  params: { uid?: string },
  options: Parameters<EmailService['send']>[0],
  context: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const result = await getEmailService().send(options);
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
    logger.error(`[Booking] ${what} failed (non-fatal)`, {
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
}

function formatWhen(start: Date, timezone: string): string {
  const dt = DateTime.fromJSDate(start).setZone(timezone);
  return `${dt.toFormat(luxonEmailWhenFormat(timezone))} (${timezone})`;
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
async function notifyOwner(params: BookingEmailParams, customerWasInvited: boolean): Promise<void> {
  const cancelled = params.method === 'CANCEL';
  const who = params.attendeeName?.trim() ? esc(params.attendeeName.trim()) : 'A customer';
  const subject = `${cancelled ? 'Cancelled' : 'New booking'}: ${params.summary}`;
  const detail = params.ownerDetail?.trim()
    ? `<p>${esc(params.ownerDetail.trim()).replace(/\n/g, '<br/>')}</p>`
    : '';
  const body =
    `<p>${who} ${cancelled ? 'cancelled their appointment' : 'booked an appointment'}.</p>` +
    `<p><strong>${esc(params.summary)}</strong><br/>${esc(formatWhen(params.start, params.timezone))}</p>` +
    (params.location ? `<p>Where: ${esc(params.location)}</p>` : '') +
    detail +
    (customerWasInvited
      ? ''
      : `<p>They booked through a messaging channel and gave no email address, so no invite was sent to them.</p>`);
  await sendOrReport('owner notification', params, {
      to: [params.ownerEmail as string],
      from: senderFrom(params),
      subject,
      body,
      // Replying to an owner notification should reach the CUSTOMER, when there is one.
      ...(customerWasInvited && params.attendeeEmail ? { replyTo: params.attendeeEmail } : {}),
      // Distinct audiences keep distinct keys. 'owner-only' is retained for the
      // no-customer-email case so keys already issued for in-flight sends keep their
      // meaning; the accompanied case is a genuinely new message and gets a new key.
      idempotencyKey: inviteIdempotencyKey(params, customerWasInvited ? 'owner' : 'owner-only'),
      // The customer's uploaded files ride on the OWNER's copy only.
      ...(params.ownerAttachments?.length ? { attachments: params.ownerAttachments } : {}),
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
function customerEmailBody(params: BookingEmailParams, cancelled: boolean): string {
  const lead = cancelled
    ? 'Your appointment has been cancelled.'
    : 'Your appointment is confirmed.';
  const duration =
    typeof params.durationMin === 'number' && params.durationMin > 0
      ? ` &middot; ${params.durationMin} min`
      : '';
  const price =
    !cancelled && params.priceDisplay?.trim()
      ? ` &middot; ${esc(params.priceDisplay.trim())}`
      : '';
  return (
    `<p>${lead}</p>` +
    `<p><strong>${esc(params.summary)}</strong><br/>${esc(formatWhen(params.start, params.timezone))}${duration}${price}</p>` +
    (params.location ? `<p>Location: ${esc(params.location)}</p>` : '') +
    (!cancelled && params.preparationInstructions?.trim()
      ? `<p><strong>Before your appointment:</strong><br/>${esc(params.preparationInstructions.trim())}</p>`
      : '') +
    `<p>A calendar invite is attached.</p>` +
    (!cancelled && params.manageUrl
      ? `<p><a href="${esc(params.manageUrl)}">Reschedule or cancel this appointment</a></p>`
      : '')
  );
}

export async function sendBookingEmail(params: BookingEmailParams): Promise<void> {
  // No customer email (WhatsApp/Messenger/Instagram bookings). There is nobody to invite,
  // but the OWNER still needs telling — this used to return here and send nothing at all,
  // so a channel booking that was later cancelled reached them only as an event quietly
  // vanishing from their calendar.
  if (!params.attendeeEmail || !params.attendeeEmail.trim()) {
    if (params.ownerEmail?.trim()) await notifyOwner(params, false);
    return;
  }
  // The organizer source may be a full RFC5322 "Name <email>" string (e.g.
  // EMAIL_FROM_ADDRESS). The ICS ORGANIZER must be a BARE email in the mailto:
  // (the display name goes in CN) — otherwise the mailto is malformed and Gmail
  // shows "Unable to load event" for the invite.
  // Frozen first; the old resolution only for rows that predate the column.
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

  // The customer alone. The owner gets their own message below.
  const to = [params.attendeeEmail];
  const cancelled = params.method === 'CANCEL';
  const subject = `${cancelled ? 'Cancelled' : 'Confirmed'}: ${params.summary}`;
  const body = customerEmailBody(params, cancelled);

  await sendOrReport('invite email', params, {
      to,
      from: senderFrom(params),
      subject,
      body,
      // Replies reach the business rather than the platform's unattended from-address.
      // The ORGANIZER is the platform (it must match the envelope sender or Gmail and
      // Outlook refuse to make the invite actionable), so reply-to is what carries the
      // business's own address.
      ...(params.ownerEmail ? { replyTo: params.ownerEmail } : {}),
      // The reconciler re-claims rows after a crash; without a key a retry re-sends the
      // whole invite to the customer.
      idempotencyKey: inviteIdempotencyKey(params, 'invite'),
      attachments: [
        {
          filename: cancelled ? 'cancel.ics' : 'invite.ics',
          content: Buffer.from(ics, 'utf8').toString('base64'),
          contentType: `text/calendar; method=${params.method}; charset=utf-8`,
        },
      ],
  }, { method: params.method });

  // Owner's own copy, sent whether or not the customer's invite succeeded — a failed
  // customer send is precisely when the owner most needs to know a booking exists.
  if (params.ownerEmail?.trim()) await notifyOwner(params, true);
}

export interface ReminderEmailParams {
  summary: string;
  start: Date;
  timezone: string;
  attendeeName: string;
  attendeeEmail: string;
  /** e.g. "tomorrow" / "in 1 hour" — describes the lead time. */
  leadLabel: string;
  /** Self-service manage link (reschedule/cancel). */
  manageUrl?: string;
}

/** Plain appointment reminder (no ICS — the invite was sent on confirmation). */
export async function sendReminderEmail(params: ReminderEmailParams): Promise<void> {
  // No email on file (channel booking) → nothing to remind by email.
  if (!params.attendeeEmail || !params.attendeeEmail.trim()) {
    return;
  }
  // Escaped, like every sibling template in this file. `summary` is the owner-authored
  // service name (validated only for length), so unescaped it renders as live HTML in a
  // customer's inbox — a link the customer has every reason to trust.
  const body =
    `<p>Reminder: your appointment is ${esc(params.leadLabel)}.</p>` +
    `<p><strong>${esc(params.summary)}</strong><br/>${esc(formatWhen(params.start, params.timezone))}</p>` +
    (params.manageUrl ? `<p><a href="${esc(params.manageUrl)}">Reschedule or cancel</a></p>` : '');
  await sendOrReport('reminder email', {}, {
      to: params.attendeeEmail,
      subject: `Reminder: ${params.summary}`,
      body,
  });
}

export interface RequestNotificationParams {
  ownerEmail: string;
  serviceName: string;
  start: Date;
  timezone: string;
  attendeeName: string;
  /** Optional — absent for channel bookings with no customer email. */
  attendeeEmail?: string;
  notes?: string;
  aiSummary?: string;
}

/**
 * Owner-only notification that a customer captured an appointment **request**
 * (not a confirmed booking). Plain HTML, NO ICS — there is nothing to add to a
 * calendar until the owner reviews it. Non-fatal: the request stands if email fails.
 */
export async function sendRequestNotificationEmail(params: RequestNotificationParams): Promise<void> {
  const body =
    `<p>You have a new appointment <strong>request</strong> to review.</p>` +
    `<p><strong>${esc(params.serviceName)}</strong><br/>Preferred time: ${esc(formatWhen(params.start, params.timezone))}</p>` +
    `<p>From: ${esc(params.attendeeName)}${params.attendeeEmail ? ` (${esc(params.attendeeEmail)})` : ''}</p>` +
    (params.aiSummary ? `<p>Summary: ${esc(params.aiSummary)}</p>` : '') +
    (params.notes ? `<p>Notes: ${esc(params.notes)}</p>` : '') +
    `<p>Follow up with the customer to confirm or decline.</p>`;
  await sendOrReport('request notification email', {}, {
      to: params.ownerEmail,
      subject: `New appointment request: ${params.serviceName}`,
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
  /** Customer-safe short reason, e.g. 'That time overlaps another appointment.' */
  reason: string;
}

/**
 * Owner-only notice that an edit in the connected calendar was undone.
 * No ICS and no customer copy - the booking did not move.
 */
export async function sendCalendarChangeRejectedEmail(
  params: CalendarChangeRejectedParams
): Promise<void> {
  const who = params.attendeeName.trim() ? esc(params.attendeeName.trim()) : 'A customer';
  const body =
    `<p>We did not apply the change you made in your calendar. The event is back at the original time.</p>` +
    `<p><strong>${esc(params.serviceName)}</strong><br/>` +
    `Customer: ${who}<br/>` +
    `Attempted time: ${esc(formatWhen(params.attemptedStart, params.timezone))}<br/>` +
    `Restored time: ${esc(formatWhen(params.restoredStart, params.timezone))}</p>` +
    `<p>${esc(params.reason)}</p>` +
    `<p>Move this booking from the Axentrio bookings page instead.</p>`;
  await sendOrReport('calendar change rejected email', {}, {
    to: params.ownerEmail,
    subject: `Calendar change not applied: ${params.serviceName}`,
    body,
  });
}

/** Test seam — reset the memoized EmailService. */
export function __resetBookingEmailService(): void {
  emailService = null;
}
