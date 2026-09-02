/**
 * #90 - a booking email that fails to send used to log nothing at all.
 *
 * `EmailService.send` does not throw when delivery fails. An unconfigured Resend key comes back
 * as `{ success: false, error: 'not configured' }` and a provider error the same way. Every send
 * in `booking-email.ts` was wrapped in a `try`/`catch` and nothing else, so for the two likeliest
 * failures the `catch` never ran and the log line never fired.
 *
 * The consequence is not a missing log line, it is a missing SIGNAL. Booking emails could stop
 * going out entirely while the bookings were created, the calendar events existed, and the logs
 * stayed clean - so "no customer has received an invite since Tuesday" was invisible.
 *
 * Third instance of the same trap: `llm/provider-health.ts` had it (#89) and the travel-time
 * monitor inherited it by copying that file's shape (#68). Tested here as the PROPERTY - a
 * returned failure is reported exactly like a thrown one - rather than per call site, so a fifth
 * send added later is covered by the helper rather than by somebody remembering.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `vi.mock` factories are hoisted above every top-level binding, so the doubles they close over
// have to be hoisted with them or they are read before initialisation.
const { send, sendDurable, logger } = vi.hoisted(() => ({
  send: vi.fn(),
  sendDurable: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../automations/email.service', () => ({
  EmailService: class {
    send = send;
  },
}));
vi.mock('../../services/email-delivery.service', () => ({
  emailDeliveryService: { sendDurable: (...a: unknown[]) => sendDurable(...a) },
}));
vi.mock('../../utils/logger', () => ({ logger }));

import {
  sendBookingEmail,
  sendReminderEmail,
  sendRequestNotificationEmail,
} from '../../booking/booking-providers/booking-email';

const bookingParams = {
  method: 'REQUEST' as const,
  uid: 'uid-1@axentrio',
  sequence: 0,
  start: new Date('2026-09-01T09:00:00Z'),
  end: new Date('2026-09-01T10:00:00Z'),
  summary: 'Boiler repair',
  timezone: 'Europe/Brussels',
  attendeeName: 'Jan',
  attendeeEmail: 'jan@example.com',
  organizerEmail: 'bookings@axentrio.com',
  tenantId: '00000000-0000-0000-0000-000000000001',
  botId: 'bot-test',
  bookingId: '00000000-0000-0000-0000-000000000002',
  customerLanguage: 'en',
  ownerLanguage: 'en',
};

/** Every failure line this file can emit, whatever the shape of the failure. */
const failures = () =>
  [...logger.error.mock.calls, ...logger.warn.mock.calls].filter((c) => String(c[0]).includes('failed (non-fatal)'));

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ success: true });
  sendDurable.mockResolvedValue({ status: 'sent' });
});

describe('a delivery failure is reported however it arrives', () => {
  it('reports a RETURNED failure, which is the one that was silent', async () => {
    // The likeliest failure and the one that reads as success. Before this, nothing was logged:
    // `send` resolved normally, so the catch did not run.
    sendDurable.mockResolvedValue({ status: 'failed', error: 'not configured' });

    await sendBookingEmail(bookingParams);

    const reported = failures();
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0][1]).toMatchObject({ error: 'not configured', uid: 'uid-1@axentrio' });
  });

  it('still reports a THROWN failure, which already worked', async () => {
    sendDurable.mockRejectedValue(new Error('SMTP refused'));

    await sendBookingEmail(bookingParams);

    expect(failures()[0][1]).toMatchObject({ error: 'SMTP refused' });
  });

  it('says nothing when the mail actually went', async () => {
    await sendBookingEmail(bookingParams);
    expect(failures()).toEqual([]);
  });

  it('never throws, because a booking must not fail when mail is down', async () => {
    // Non-fatal is the design and stays the design. The fix is that the failure is now VISIBLE,
    // not that it became fatal - rolling back a confirmed booking because an invite bounced
    // would be a far worse trade.
    sendDurable.mockResolvedValue({ status: 'failed', error: 'not configured' });
    await expect(sendBookingEmail(bookingParams)).resolves.toBeUndefined();

    sendDurable.mockRejectedValue(new Error('SMTP refused'));
    await expect(sendBookingEmail(bookingParams)).resolves.toBeUndefined();
  });
});

describe('the other two senders report it too', () => {
  it('the reminder', async () => {
    send.mockResolvedValue({ success: false, error: 'not configured' });
    await sendReminderEmail({
      attendeeEmail: 'jan@example.com',
      summary: 'Boiler repair',
      start: new Date('2026-09-01T09:00:00Z'),
      timezone: 'Europe/Brussels',
      lead: '24h',
      attendeeName: 'Jan',
      manageUrl: 'https://example.com/manage',
      customerLanguage: 'en',
    } as Parameters<typeof sendReminderEmail>[0]);
    expect(failures()[0][1]).toMatchObject({ error: 'not configured' });
  });

  it('the request notification', async () => {
    send.mockResolvedValue({ success: false, error: 'not configured' });
    await sendRequestNotificationEmail({
      ownerEmail: 'owner@acme.com',
      serviceName: 'Boiler repair',
      attendeeName: 'Jan',
    } as Parameters<typeof sendRequestNotificationEmail>[0]);
    expect(failures()[0][1]).toMatchObject({ error: 'not configured' });
  });
});
