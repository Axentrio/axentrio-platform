/**
 * Booking reminders — delayed jobs that email the attendee before the meeting.
 *
 * Two reminders per booking (24h and 1h before start). A reminder whose delay is
 * already past (booking is sooner than the lead time) is skipped, not sent
 * immediately. The worker re-reads the booking at execution time and no-ops if
 * the booking was cancelled or rescheduled (`sequence` mismatch) — so stale jobs
 * can never fire, even if cleanup missed them. Job ids are stored on the booking
 * so reschedule/cancel can remove them.
 */
import type { Job } from 'bull';
import { addJob, removeJob } from '../../queue/message-queue';
import { AppDataSource } from '../../database/data-source';
import { Booking } from '../../database/entities/Booking';
import { EventType } from '../../database/entities/EventType';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { logger } from '../../utils/logger';
import { sendReminderEmail } from './booking-email';
import { buildManageUrl } from '../../scheduler/booking-token';

export const REMINDER_QUEUE = 'booking-reminders';

interface ReminderJobData {
  bookingId: string;
  kind: '24h' | '1h';
  sequence: number;
}

const LEAD_MS: Record<ReminderJobData['kind'], number> = {
  '24h': 24 * 3600_000,
  '1h': 1 * 3600_000,
};
const LEAD_LABEL: Record<ReminderJobData['kind'], string> = {
  '24h': 'tomorrow',
  '1h': 'in 1 hour',
};

/**
 * Schedule the 24h/1h reminders for a confirmed booking. Returns the ids of the
 * jobs actually scheduled (past-due reminders are skipped). `now` is injectable
 * for tests.
 */
export async function scheduleReminders(
  bookingId: string,
  startUtc: Date,
  sequence: number,
  now: Date = new Date()
): Promise<string[]> {
  const ids: string[] = [];
  for (const kind of ['24h', '1h'] as const) {
    const fireAt = startUtc.getTime() - LEAD_MS[kind];
    const delay = fireAt - now.getTime();
    if (delay <= 0) continue; // booking is already within this lead window → skip
    const jobId = `rem:${bookingId}:${kind}:${sequence}`;
    await addJob(REMINDER_QUEUE, { bookingId, kind, sequence } as ReminderJobData, {
      jobId,
      delay,
      attempts: 2,
    });
    ids.push(jobId);
  }
  return ids;
}

/** Remove scheduled reminder jobs (best-effort). */
export async function cancelReminders(jobIds: string[] | null | undefined): Promise<void> {
  for (const id of jobIds || []) {
    await removeJob(REMINDER_QUEUE, id);
  }
}

/** Processor: re-reads the booking and emails the reminder only if still valid. */
export function createBookingReminderProcessor(): (job: Job) => Promise<void> {
  return async (job: Job) => {
    const { bookingId, kind, sequence } = job.data as ReminderJobData;
    const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id: bookingId } });

    if (!booking || booking.status !== 'confirmed' || booking.sequence !== sequence) {
      logger.info('[Booking] Skipping stale/cancelled reminder', {
        bookingId,
        kind,
        reason: !booking ? 'missing' : booking.status !== 'confirmed' ? booking.status : 'sequence-mismatch',
      });
      return;
    }

    const eventType = await AppDataSource.getRepository(EventType).findOne({
      where: { botId: booking.botId, isActive: true },
    });
    const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: booking.botId } });

    await sendReminderEmail({
      summary: eventType?.name ?? 'Your appointment',
      start: booking.startUtc,
      timezone: rule?.timezone ?? 'UTC',
      attendeeName: booking.attendeeName ?? '',
      attendeeEmail: booking.attendeeEmail ?? '',
      leadLabel: LEAD_LABEL[kind],
      manageUrl: buildManageUrl(bookingId),
    });
  };
}
