import { describe, it, expect, vi, beforeEach } from 'vitest';

const chat = vi.fn();

vi.mock('../../llm/provider-factory', () => ({
  getProvider: vi.fn(() => ({ chat })),
}));

vi.mock('../../config/redis', () => ({
  getRedisClient: vi.fn(() => null),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  BOOKING_COPY_EN,
  fill,
  formatWhen,
  getBookingCopy,
  __resetBookingCopyCache,
} from '../../booking/booking-copy';

describe('fill', () => {
  it('substitutes known placeholders and leaves unknown tokens intact', () => {
    expect(fill('Hello {name}, ref {ref}', { name: 'Ada' })).toBe('Hello Ada, ref {ref}');
    expect(fill('{n} min', { n: 45 })).toBe('45 min');
  });

  it('handles empty templates and repeated placeholders', () => {
    expect(fill('', { n: 1 })).toBe('');
    expect(fill('{x} and {x}', { x: 'yes' })).toBe('yes and yes');
  });
});

describe('formatWhen', () => {
  const start = new Date('2026-08-12T08:00:00Z');

  it('includes the timezone label in the output', () => {
    const out = formatWhen(start, 'Europe/Brussels', 'en');
    expect(out).toContain('Europe/Brussels');
    expect(out.length).toBeGreaterThan(10);
  });

  it('does not throw for unknown locales (Luxon silent fallback)', () => {
    expect(() => formatWhen(start, 'UTC', 'xx-invalid')).not.toThrow();
    expect(formatWhen(start, 'UTC', 'xx-invalid')).toContain('UTC');
  });

  it('does not throw for invalid timezone strings', () => {
    expect(() => formatWhen(start, 'Not/A/Timezone', 'en')).not.toThrow();
  });
});

describe('getBookingCopy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBookingCopyCache();
  });

  it('returns English without calling the LLM', async () => {
    const copy = await getBookingCopy('en');
    expect(copy).toEqual(BOOKING_COPY_EN);
    expect(chat).not.toHaveBeenCalled();
  });

  it('translates once and serves the second call from cache', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.subject_confirmed': 'Bevestigd: {summary}',
      }),
    });

    const first = await getBookingCopy('nl', 'ten-1');
    const second = await getBookingCopy('nl', 'ten-1');

    expect(chat).toHaveBeenCalledOnce();
    expect(first['customer.subject_confirmed']).toBe('Bevestigd: {summary}');
    expect(second).toEqual(first);
  });

  it('falls back to English when translation throws', async () => {
    chat.mockRejectedValueOnce(new Error('provider down'));
    const copy = await getBookingCopy('de');
    expect(copy).toEqual(BOOKING_COPY_EN);
  });

  it('keeps English for a key missing placeholders', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.subject_confirmed': 'Zonder placeholder',
      }),
    });
    const copy = await getBookingCopy('nl');
    expect(copy['customer.subject_confirmed']).toBe(BOOKING_COPY_EN['customer.subject_confirmed']);
  });

  it('treats EN and empty language as English without LLM', async () => {
    await expect(getBookingCopy('EN')).resolves.toEqual(BOOKING_COPY_EN);
    await expect(getBookingCopy('')).resolves.toEqual(BOOKING_COPY_EN);
    await expect(getBookingCopy('english')).resolves.toEqual(BOOKING_COPY_EN);
    expect(chat).not.toHaveBeenCalled();
  });

  it('rejects translations that add URLs', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.lead_confirmed': 'Bevestigd. Zie https://evil.example',
      }),
    });
    const copy = await getBookingCopy('nl');
    expect(copy['customer.lead_confirmed']).toBe(BOOKING_COPY_EN['customer.lead_confirmed']);
  });

  it('rejects translations that drop required placeholders', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.subject_confirmed': 'Bevestigd zonder samenvatting',
      }),
    });
    const copy = await getBookingCopy('nl');
    expect(copy['customer.subject_confirmed']).toBe(BOOKING_COPY_EN['customer.subject_confirmed']);
  });

  it('rejects translations that add extra placeholders', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.subject_confirmed': 'Bevestigd: {summary} ({extra})',
      }),
    });
    const copy = await getBookingCopy('nl');
    expect(copy['customer.subject_confirmed']).toBe(BOOKING_COPY_EN['customer.subject_confirmed']);
  });

  it('rejects empty translated strings', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.lead_confirmed': '   ',
      }),
    });
    const copy = await getBookingCopy('nl');
    expect(copy['customer.lead_confirmed']).toBe(BOOKING_COPY_EN['customer.lead_confirmed']);
  });

  it('falls back entirely to English when most keys fail validation', async () => {
    chat.mockResolvedValueOnce({ content: '{}' });
    const copy = await getBookingCopy('nl');
    expect(copy).toEqual(BOOKING_COPY_EN);
  });

  it('accepts partial translation when most keys pass', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.lead_confirmed': 'Uw afspraak is bevestigd.',
        'customer.subject_confirmed': 'bad',
      }),
    });
    const copy = await getBookingCopy('nl');
    expect(copy['customer.lead_confirmed']).toBe('Uw afspraak is bevestigd.');
    expect(copy['customer.subject_confirmed']).toBe(BOOKING_COPY_EN['customer.subject_confirmed']);
  });

  it('falls back to English on malformed JSON', async () => {
    chat.mockResolvedValueOnce({ content: 'not json at all' });
    const copy = await getBookingCopy('de');
    expect(copy).toEqual(BOOKING_COPY_EN);
  });

  it('preserves HTML tags in manage-page strings', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'manage.cancel_requested_body':
          'Nous avons envoyé une demande. Votre rendez-vous <strong>n\'est pas encore annulé</strong>.',
      }),
    });
    const copy = await getBookingCopy('fr');
    expect(copy['manage.cancel_requested_body']).toContain('<strong>');
    expect(copy['manage.cancel_requested_body']).toContain('</strong>');
  });
});
