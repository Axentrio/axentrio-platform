/**
 * Customer booking confirmation/cancellation HTML. Asserts the branded layout
 * through sendBookingEmail — customerEmailBody is not exported.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendDurable = vi.fn();
vi.mock('../../services/email-delivery.service', () => ({
  emailDeliveryService: {
    sendDurable: (...a: unknown[]) => sendDurable(...a),
  },
}));
vi.mock('../../automations/email.service', () => ({
  EmailService: class {
    send() {
      return Promise.resolve({ success: true });
    }
  },
}));
const getBookingCopy = vi.fn(async (lang: string, _tenantId?: string) => {
  if (lang === 'nl') {
    return { ...BOOKING_COPY_EN, 'customer.lead_confirmed': 'NL: Your appointment is confirmed.' };
  }
  return BOOKING_COPY_EN;
});
vi.mock('../../booking/booking-copy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/booking-copy')>();
  return { ...actual, getBookingCopy: (lang: string, tenantId?: string) => getBookingCopy(lang, tenantId) };
});

const loadConfirmationExtras = vi.fn(async (_botId: string) => null as {
  text?: string;
  attachments: Array<{ filename: string; content: string; contentType: string }>;
} | null);
vi.mock('../../booking/booking-providers/confirmation-extras', () => ({
  loadConfirmationExtras: (botId: string) => loadConfirmationExtras(botId),
}));

const loadCustomerEmailBrand = vi.fn(async (_botId: string, _tenantId: string) => ({
  logoUrl: null as string | null,
  venueLine: null as string | null,
}));
vi.mock('../../booking/booking-providers/customer-email-brand', () => ({
  loadCustomerEmailBrand: (botId: string, tenantId: string) => loadCustomerEmailBrand(botId, tenantId),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendBookingEmail } from '../../booking/booking-providers/booking-email';
import { BOOKING_COPY_EN } from '../../booking/booking-copy';

const BASE = {
  method: 'REQUEST' as const,
  uid: 'uid-1',
  sequence: 0,
  start: new Date('2026-08-12T08:00:00Z'),
  end: new Date('2026-08-12T09:00:00Z'),
  summary: 'Boiler repair',
  timezone: 'Europe/Brussels',
  attendeeName: 'Ada Lovelace',
  attendeeEmail: 'ada@example.com',
  ownerEmail: 'owner@valyro.be',
  organizerEmail: 'bookings@notifications.axentrio.com',
  tenantId: '00000000-0000-0000-0000-000000000001',
  botId: 'bot-test',
  bookingId: '00000000-0000-0000-0000-000000000002',
  customerLanguage: 'en',
  ownerLanguage: 'en',
};

const sent = (): Array<Record<string, unknown>> =>
  sendDurable.mock.calls.map((c) => {
    const input = c[0] as Record<string, unknown>;
    return { ...input, to: [input.recipientEmail] };
  });
const toCustomer = () => sent().find((m) => (m.to as string[]).includes('ada@example.com'));
const toOwner = () => sent().find((m) => (m.to as string[]).includes('owner@valyro.be'));
const customerBody = () => String(toCustomer()!.body);
const ownerBody = () => String(toOwner()!.body);

describe('booking email — branded customer template', () => {
  beforeEach(() => {
    sendDurable.mockReset();
    sendDurable.mockResolvedValue({ status: 'sent' });
    loadConfirmationExtras.mockReset();
    loadConfirmationExtras.mockResolvedValue(null);
    loadCustomerEmailBrand.mockReset();
    loadCustomerEmailBrand.mockResolvedValue({ logoUrl: null, venueLine: null });
  });

  it('renders the full confirmation layout', async () => {
    loadCustomerEmailBrand.mockResolvedValue({
      logoUrl: 'https://img.clerk.example/logo.png',
      venueLine: 'Grote Markt 1, 9300 Aalst',
    });
    loadConfirmationExtras.mockResolvedValue({
      text: 'Arrive 10 minutes early.',
      attachments: [
        { filename: 'parking.pdf', content: Buffer.from('pdf').toString('base64'), contentType: 'application/pdf' },
      ],
    });
    await sendBookingEmail({
      ...BASE,
      durationMin: 30,
      priceDisplay: '€75',
      location: 'Grote Markt 1, 9300 Aalst',
      organizerName: 'Valyro',
      manageUrl: 'https://app.example/m',
    });
    const html = customerBody();
    expect(html).toContain('Hello Ada Lovelace,');
    expect(html).toContain('Your appointment is confirmed.');
    expect(html).toContain('Appointment: Boiler repair');
    expect(html).toContain('Date:');
    expect(html).toContain('Duration: 30 min');
    expect(html).toContain('Price: €75');
    expect(html).toContain('Location: Grote Markt 1, 9300 Aalst');
    expect(html).toContain('Additional information:');
    expect(html).toContain('Arrive 10 minutes early.');
    expect(html).toContain('parking.pdf');
    expect(html).not.toContain('invite.ics');
    expect(html).toContain('Kind regards,');
    expect(html).toContain('Valyro');
    expect(html).toContain('Grote Markt 1, 9300 Aalst');
    expect(html).toContain('mailto:owner@valyro.be');
    expect(html).toContain('<img');
    expect(html).toContain('https://img.clerk.example/logo.png');
    expect(html).toContain('max-width:600px');
    expect(html).toContain('https://app.example/m');
    expect(html.toLowerCase()).not.toContain('invoice');
    expect(html.toLowerCase()).not.toContain('vat');
    const attachments = toCustomer()!.attachments as Array<{ filename: string }>;
    expect(attachments.map((a) => a.filename)).toEqual(['invite.ics', 'parking.pdf']);
  });

  it('omits empty optional sections', async () => {
    await sendBookingEmail({ ...BASE, organizerName: '', ownerEmail: undefined });
    const html = customerBody();
    expect(html).toContain('Appointment');
    expect(html).toContain('Boiler repair');
    expect(html).toContain('Date:');
    expect(html).toContain('Your appointment is confirmed.');
    expect(html).toContain('Kind regards,');
    expect(html).toContain('A calendar invite is attached.');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Additional information:');
    expect(html).not.toContain('Attachments');
    expect(html).not.toContain('Location:');
    expect(html).not.toContain('Duration:');
    expect(html).not.toContain('Price:');
    expect(html).not.toContain('mailto:');
    expect(html).not.toContain('Grote Markt');
  });

  it('omits the greeting when the attendee name is missing or whitespace', async () => {
    await sendBookingEmail({ ...BASE, attendeeName: '' });
    expect(customerBody()).not.toContain('Hello');
    sendDurable.mockClear();
    await sendBookingEmail({ ...BASE, attendeeName: '   ' });
    expect(customerBody()).not.toContain('Hello');
  });

  it('renders no logo img when the brand loader already stripped a non-https URL', async () => {
    loadCustomerEmailBrand.mockResolvedValue({ logoUrl: null, venueLine: null });
    await sendBookingEmail({ ...BASE });
    expect(customerBody()).not.toContain('<img');
  });

  it('keeps brand on cancel and drops extras, attachments card, and manage link', async () => {
    loadConfirmationExtras.mockResolvedValue({
      text: 'Arrive 10 minutes early.',
      attachments: [
        { filename: 'parking.pdf', content: Buffer.from('pdf').toString('base64'), contentType: 'application/pdf' },
      ],
    });
    loadCustomerEmailBrand.mockResolvedValue({
      logoUrl: 'https://img.clerk.example/logo.png',
      venueLine: 'Grote Markt 1, 9300 Aalst',
    });
    await sendBookingEmail({
      ...BASE,
      method: 'CANCEL',
      organizerName: 'Valyro',
      manageUrl: 'https://app.example/m',
    });
    expect(loadConfirmationExtras).not.toHaveBeenCalled();
    expect(loadCustomerEmailBrand).toHaveBeenCalledWith(BASE.botId, BASE.tenantId);
    const html = customerBody();
    expect(html).toContain('Hello Ada Lovelace,');
    expect(html).toContain('Your appointment has been cancelled.');
    expect(html).toContain('Appointment: Boiler repair');
    expect(html).toContain('Kind regards,');
    expect(html).toContain('https://img.clerk.example/logo.png');
    expect(html).toContain('Grote Markt 1, 9300 Aalst');
    expect(html).not.toContain('Additional information:');
    expect(html).not.toContain('Attachments');
    expect(html).not.toContain('parking.pdf');
    expect(html).not.toContain('https://app.example/m');
    const attachments = toCustomer()!.attachments as Array<{ filename: string }>;
    expect(attachments.map((a) => a.filename)).toEqual(['cancel.ics']);
  });

  it('escapes owner and customer text in the HTML', async () => {
    loadCustomerEmailBrand.mockResolvedValue({
      logoUrl: 'https://img.example/a.png?x=1&y=2',
      venueLine: 'Grote Markt 1 <b>xss</b>',
    });
    loadConfirmationExtras.mockResolvedValue({
      text: '<img src=x onerror=alert(1)>',
      attachments: [],
    });
    await sendBookingEmail({
      ...BASE,
      attendeeName: 'Ada <script>',
      organizerName: 'Valyro <img>',
    });
    const html = customerBody();
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('Ada &lt;script&gt;');
    expect(html).toContain('Valyro &lt;img&gt;');
    expect(html).toContain('Grote Markt 1 &lt;b&gt;xss&lt;/b&gt;');
    expect(html).toContain('https://img.example/a.png?x=1&amp;y=2');
  });

  it('keeps extras and customer cards off the owner copy', async () => {
    loadConfirmationExtras.mockResolvedValue({
      text: 'Arrive 10 minutes early.',
      attachments: [
        { filename: 'parking.pdf', content: Buffer.from('pdf').toString('base64'), contentType: 'application/pdf' },
      ],
    });
    loadCustomerEmailBrand.mockResolvedValue({
      logoUrl: 'https://img.clerk.example/logo.png',
      venueLine: 'Grote Markt 1, 9300 Aalst',
    });
    await sendBookingEmail({ ...BASE, organizerName: 'Valyro', durationMin: 30, priceDisplay: '€75' });
    expect(ownerBody()).not.toContain('Arrive 10 minutes early.');
    expect(ownerBody()).not.toContain('Hello Ada Lovelace,');
    expect(ownerBody()).not.toContain('Appointment:');
    expect(ownerBody()).not.toContain('Kind regards,');
    expect(ownerBody()).not.toContain('max-width:600px');
    expect(toOwner()!.attachments).toBeUndefined();
  });
});
