/**
 * Edge cases for localized booking emails (reminder, request notification, calendar rejected).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const send = vi.fn();
const getBookingCopy = vi.fn();

vi.mock('../../automations/email.service', () => ({
  EmailService: class {
    send = send;
  },
}));
vi.mock('../../services/email-delivery.service', () => ({
  emailDeliveryService: { sendDurable: vi.fn() },
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../booking/booking-copy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/booking-copy')>();
  return {
    ...actual,
    getBookingCopy: (...a: unknown[]) => getBookingCopy(...a),
    formatWhen: actual.formatWhen,
    fill: actual.fill,
  };
});

import {
  sendReminderEmail,
  sendCalendarChangeRejectedEmail,
  __resetBookingEmailService,
} from '../../booking/booking-providers/booking-email';
import { BOOKING_COPY_EN } from '../../booking/booking-copy';

const START = new Date('2026-08-12T08:00:00Z');

describe('sendReminderEmail · i18n edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBookingEmailService();
    send.mockResolvedValue({ success: true });
    getBookingCopy.mockImplementation(async (lang: string) => ({
      ...BOOKING_COPY_EN,
      'customer.reminder_tomorrow': lang === 'nl' ? 'morgen' : BOOKING_COPY_EN['customer.reminder_tomorrow'],
      'customer.reminder_in_1_hour': lang === 'nl' ? 'over 1 uur' : BOOKING_COPY_EN['customer.reminder_in_1_hour'],
      'customer.reminder_subject': lang === 'nl' ? 'Herinnering: {summary}' : BOOKING_COPY_EN['customer.reminder_subject'],
    }));
  });

  it('skips send when attendee email is blank', async () => {
    await sendReminderEmail({
      summary: 'Intro',
      start: START,
      timezone: 'Europe/Brussels',
      attendeeName: 'Ada',
      attendeeEmail: '   ',
      lead: '24h',
      customerLanguage: 'nl',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('uses tomorrow copy for 24h lead', async () => {
    await sendReminderEmail({
      summary: 'Intro',
      start: START,
      timezone: 'Europe/Brussels',
      attendeeName: 'Ada',
      attendeeEmail: 'ada@example.com',
      lead: '24h',
      customerLanguage: 'nl',
    });
    expect(getBookingCopy).toHaveBeenCalledWith('nl');
    expect(String(send.mock.calls[0][0].body)).toContain('morgen');
    expect(send.mock.calls[0][0].subject).toBe('Herinnering: Intro');
  });

  it('uses in-1-hour copy for 1h lead', async () => {
    await sendReminderEmail({
      summary: 'Intro',
      start: START,
      timezone: 'Europe/Brussels',
      attendeeName: 'Ada',
      attendeeEmail: 'ada@example.com',
      lead: '1h',
      customerLanguage: 'nl',
    });
    expect(String(send.mock.calls[0][0].body)).toContain('over 1 uur');
  });
});

describe('sendCalendarChangeRejectedEmail · reason keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBookingEmailService();
    send.mockResolvedValue({ success: true });
    getBookingCopy.mockResolvedValue({ ...BOOKING_COPY_EN });
  });

  const reasonKeys = [
    'owner.reason_all_day',
    'owner.reason_end_before_start',
    'owner.reason_slot_unavailable',
    'owner.reason_travel_conflict',
    'owner.reason_not_reschedulable',
    'owner.reason_default',
  ] as const;

  for (const reasonKey of reasonKeys) {
    it(`includes copy for ${reasonKey}`, async () => {
      await sendCalendarChangeRejectedEmail({
        ownerEmail: 'owner@example.com',
        serviceName: 'Repair',
        attemptedStart: START,
        restoredStart: new Date('2026-08-12T09:00:00Z'),
        timezone: 'UTC',
        attendeeName: 'Ada',
        reasonKey,
        ownerLanguage: 'en',
      });
      expect(String(send.mock.calls[0][0].body)).toContain(BOOKING_COPY_EN[reasonKey]);
    });
  }
});
