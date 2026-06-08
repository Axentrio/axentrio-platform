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
  attendeeEmail: string;
  /** Additional recipient (Phase 0: owner gets the invite too). */
  ownerEmail?: string;
  /** Self-service manage link (reschedule/cancel). Omitted on cancellation. */
  manageUrl?: string;
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

export async function sendBookingEmail(params: BookingEmailParams): Promise<void> {
  const organizerEmail = params.ownerEmail ?? config.email.fromAddress;
  const ics = buildIcs({
    uid: params.uid,
    sequence: params.sequence,
    method: params.method,
    start: params.start,
    end: params.end,
    summary: params.summary,
    description: params.description,
    location: params.location,
    organizerEmail,
    attendeeEmail: params.attendeeEmail,
    attendeeName: params.attendeeName,
  });

  const to = [params.attendeeEmail, ...(params.ownerEmail ? [params.ownerEmail] : [])];
  const cancelled = params.method === 'CANCEL';
  const subject = `${cancelled ? 'Cancelled' : 'Confirmed'}: ${params.summary}`;
  const lead = cancelled
    ? 'Your appointment has been cancelled.'
    : 'Your appointment is confirmed.';
  const body =
    `<p>${lead}</p>` +
    `<p><strong>${params.summary}</strong><br/>${formatWhen(params.start, params.timezone)}</p>` +
    (params.location ? `<p>Location: ${params.location}</p>` : '') +
    `<p>A calendar invite is attached.</p>` +
    (!cancelled && params.manageUrl
      ? `<p><a href="${params.manageUrl}">Reschedule or cancel this appointment</a></p>`
      : '');

  try {
    await getEmailService().send({
      to,
      subject,
      body,
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
  attendeeEmail: string;
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
    `<p>From: ${esc(params.attendeeName)} (${esc(params.attendeeEmail)})</p>` +
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
