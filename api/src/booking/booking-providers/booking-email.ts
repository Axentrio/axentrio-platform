/**
 * Booking invite emails. Builds an ICS and emails it to the customer (and, in
 * Phase 0, the owner) as a `text/calendar` attachment so it lands on their
 * calendar with native reminders. Email failures are non-fatal — a confirmed
 * booking is never rolled back because the invite didn't send.
 */
import { DateTime } from 'luxon';
import { config } from '../../config/environment';
import { EmailService } from '../../automations/email.service';
import { logger } from '../../utils/logger';
import { buildIcs, IcsMethod } from './ics';

let emailService: EmailService | null = null;
function getEmailService(): EmailService {
  if (!emailService) {
    emailService = new EmailService(config.email.resendApiKey, config.email.fromAddress);
  }
  return emailService;
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
  /** Additional recipient (Phase 0: owner gets the invite too). */
  ownerEmail?: string;
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
}

function formatWhen(start: Date, timezone: string): string {
  const dt = DateTime.fromJSDate(start).setZone(timezone);
  return `${dt.toFormat('cccc d LLLL yyyy, HH:mm')} (${timezone})`;
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

/** Split a possibly-"Name <email>" address into a bare email + optional name.
 *  Exported for the ICS-organizer regression test. */
export function parseAddress(addr: string): { email: string; name?: string } {
  const m = addr.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].replace(/^"|"$/g, '').trim();
    return { email: m[2].trim(), name: name || undefined };
  }
  return { email: addr.trim() };
}

/** Stable across retries of the SAME invite; a reconciler re-claim must not double-send. */
const inviteIdempotencyKey = (p: BookingEmailParams, audience: string): string =>
  `booking:${p.uid}:${p.sequence}:${p.method}:${audience}`;

/**
 * Tell the owner about a booking that has no customer to invite. Plain email, no ICS —
 * an invite with no ATTENDEE is not a meaningful invite, and the owner already has the
 * appointment on their calendar via the mirror.
 */
async function notifyOwnerWithoutInvite(params: BookingEmailParams): Promise<void> {
  const cancelled = params.method === 'CANCEL';
  const who = params.attendeeName?.trim() ? esc(params.attendeeName.trim()) : 'A customer';
  const subject = `${cancelled ? 'Cancelled' : 'New booking'}: ${params.summary}`;
  const body =
    `<p>${who} ${cancelled ? 'cancelled their appointment' : 'booked an appointment'}.</p>` +
    `<p><strong>${esc(params.summary)}</strong><br/>${esc(formatWhen(params.start, params.timezone))}</p>` +
    `<p>They booked through a messaging channel and gave no email address, so no invite was sent to them.</p>`;
  try {
    await getEmailService().send({
      to: [params.ownerEmail as string],
      subject,
      body,
      idempotencyKey: inviteIdempotencyKey(params, 'owner-only'),
    });
  } catch (err) {
    logger.warn('[Booking] owner notification failed (non-fatal)', {
      uid: params.uid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function sendBookingEmail(params: BookingEmailParams): Promise<void> {
  // No customer email (WhatsApp/Messenger/Instagram bookings). There is nobody to invite,
  // but the OWNER still needs telling — this used to return here and send nothing at all,
  // so a channel booking that was later cancelled reached them only as an event quietly
  // vanishing from their calendar.
  if (!params.attendeeEmail || !params.attendeeEmail.trim()) {
    if (params.ownerEmail?.trim()) await notifyOwnerWithoutInvite(params);
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

  const to = [params.attendeeEmail, ...(params.ownerEmail ? [params.ownerEmail] : [])];
  const cancelled = params.method === 'CANCEL';
  const subject = `${cancelled ? 'Cancelled' : 'Confirmed'}: ${params.summary}`;
  const lead = cancelled
    ? 'Your appointment has been cancelled.'
    : 'Your appointment is confirmed.';
  // Everything interpolated here is escaped. It previously was not — `summary` is
  // owner-authored and `location`/`description` become customer-influenced as soon as an
  // address or intake answer reaches them, so the unescaped version was one service rename
  // away from injecting markup into a real customer's inbox.
  const duration =
    typeof params.durationMin === 'number' && params.durationMin > 0
      ? ` &middot; ${params.durationMin} min`
      : '';
  const body =
    `<p>${lead}</p>` +
    `<p><strong>${esc(params.summary)}</strong><br/>${esc(formatWhen(params.start, params.timezone))}${duration}</p>` +
    (params.location ? `<p>Location: ${esc(params.location)}</p>` : '') +
    (!cancelled && params.preparationInstructions?.trim()
      ? `<p><strong>Before your appointment:</strong><br/>${esc(params.preparationInstructions.trim())}</p>`
      : '') +
    `<p>A calendar invite is attached.</p>` +
    (!cancelled && params.manageUrl
      ? `<p><a href="${esc(params.manageUrl)}">Reschedule or cancel this appointment</a></p>`
      : '');

  try {
    await getEmailService().send({
      to,
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
    });
  } catch (err) {
    logger.error('[Booking] invite email failed (non-fatal)', {
      uid: params.uid,
      method: params.method,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  const body =
    `<p>Reminder: your appointment is ${params.leadLabel}.</p>` +
    `<p><strong>${params.summary}</strong><br/>${formatWhen(params.start, params.timezone)}</p>` +
    (params.manageUrl ? `<p><a href="${params.manageUrl}">Reschedule or cancel</a></p>` : '');
  try {
    await getEmailService().send({
      to: params.attendeeEmail,
      subject: `Reminder: ${params.summary}`,
      body,
    });
  } catch (err) {
    logger.error('[Booking] reminder email failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
    `<p><strong>${esc(params.serviceName)}</strong><br/>Preferred time: ${formatWhen(params.start, params.timezone)}</p>` +
    `<p>From: ${esc(params.attendeeName)}${params.attendeeEmail ? ` (${esc(params.attendeeEmail)})` : ''}</p>` +
    (params.aiSummary ? `<p>Summary: ${esc(params.aiSummary)}</p>` : '') +
    (params.notes ? `<p>Notes: ${esc(params.notes)}</p>` : '') +
    `<p>Follow up with the customer to confirm or decline.</p>`;
  try {
    await getEmailService().send({
      to: params.ownerEmail,
      subject: `New appointment request: ${params.serviceName}`,
      body,
    });
  } catch (err) {
    logger.error('[Booking] request notification email failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test seam — reset the memoized EmailService. */
export function __resetBookingEmailService(): void {
  emailService = null;
}
