import { describe, it, expect, vi, beforeEach } from 'vitest';

const chat = vi.fn();
const redisGet = vi.fn();
const redisSet = vi.fn();

vi.mock('../../llm/provider-factory', () => ({
  getProvider: vi.fn(() => ({ chat })),
}));

vi.mock('../../config/redis', () => ({
  getRedisClient: vi.fn(() => ({
    get: redisGet,
    set: redisSet,
  })),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { BOOKING_COPY_EN, getBookingCopy, __resetBookingCopyCache } from '../../booking/booking-copy';

describe('getBookingCopy · Redis cache edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBookingCopyCache();
    redisSet.mockResolvedValue('OK');
  });

  it('serves a Redis hit without calling the LLM', async () => {
    const cached = { ...BOOKING_COPY_EN, 'customer.lead_confirmed': 'DE: bestätigt.' };
    redisGet.mockResolvedValueOnce(JSON.stringify(cached));

    const copy = await getBookingCopy('de', 'tenant-1');
    expect(copy['customer.lead_confirmed']).toBe('DE: bestätigt.');
    expect(chat).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('falls through to LLM when Redis JSON is corrupt', async () => {
    redisGet.mockResolvedValueOnce('{not-json');
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.lead_confirmed': 'DE: bestätigt.',
      }),
    });

    const copy = await getBookingCopy('de');
    expect(chat).toHaveBeenCalledOnce();
    expect(copy['customer.lead_confirmed']).toBe('DE: bestätigt.');
  });

  it('writes successful translations to Redis with TTL', async () => {
    redisGet.mockResolvedValueOnce(null);
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.lead_confirmed': 'DE: bestätigt.',
      }),
    });

    await getBookingCopy('de');
    expect(redisSet).toHaveBeenCalledOnce();
    const [, payload, mode, ttl] = redisSet.mock.calls[0];
    expect(String(mode)).toBe('EX');
    expect(ttl).toBe(90 * 24 * 3600);
    expect(JSON.parse(String(payload))['customer.lead_confirmed']).toBe('DE: bestätigt.');
  });

  it('still returns copy when Redis set fails', async () => {
    redisGet.mockResolvedValueOnce(null);
    redisSet.mockRejectedValueOnce(new Error('redis write failed'));
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        ...BOOKING_COPY_EN,
        'customer.lead_confirmed': 'DE: bestätigt.',
      }),
    });

    const copy = await getBookingCopy('de');
    expect(copy['customer.lead_confirmed']).toBe('DE: bestätigt.');
  });

  it('does not consult Redis for a shipped locale', async () => {
    const copy = await getBookingCopy('nl');
    expect(copy['event.customer']).toBe('Klant: {name}');
    expect(redisGet).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });
});
