import { describe, it, expect, beforeEach, vi } from 'vitest';

const addJob = vi.fn();
const removeJob = vi.fn();
vi.mock('../../queue/message-queue', () => ({
  addJob: (...a: any[]) => addJob(...a),
  removeJob: (...a: any[]) => removeJob(...a),
}));

const bookingFindOne = vi.fn();
const eventTypeFindOne = vi.fn();
const ruleFindOne = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => {
      const name = entity?.name || entity;
      if (name === 'Booking') return { findOne: bookingFindOne };
      if (name === 'ServiceType') return { findOne: eventTypeFindOne };
      if (name === 'AvailabilityRule') return { findOne: ruleFindOne };
      return {};
    },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendReminderEmail = vi.fn();
vi.mock('../../n8n/booking-providers/booking-email', () => ({
  sendReminderEmail: (...a: any[]) => sendReminderEmail(...a),
}));

import { scheduleReminders, createBookingReminderProcessor } from '../../n8n/booking-providers/reminders';

const NOW = new Date('2026-06-05T00:00:00Z');

describe('reminders · scheduleReminders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('schedules both 24h and 1h reminders for a far-future booking', async () => {
    const ids = await scheduleReminders('bk-1', new Date('2026-06-10T07:00:00Z'), 0, NOW);
    expect(ids).toEqual(['rem:bk-1:24h:0', 'rem:bk-1:1h:0']);
    expect(addJob).toHaveBeenCalledTimes(2);
    // 24h reminder fires 24h before start
    const firstOpts = addJob.mock.calls[0][2];
    expect(firstOpts.jobId).toBe('rem:bk-1:24h:0');
    expect(firstOpts.delay).toBe(
      new Date('2026-06-09T07:00:00Z').getTime() - NOW.getTime()
    );
  });

  it('skips reminders whose lead window has already passed', async () => {
    // Booking is 30 minutes away — both 24h and 1h reminders are in the past.
    const ids = await scheduleReminders('bk-2', new Date('2026-06-05T00:30:00Z'), 0, NOW);
    expect(ids).toEqual([]);
    expect(addJob).not.toHaveBeenCalled();
  });

  it('schedules only the 1h reminder when the booking is <24h away', async () => {
    const ids = await scheduleReminders('bk-3', new Date('2026-06-05T02:00:00Z'), 0, NOW);
    expect(ids).toEqual(['rem:bk-3:1h:0']);
    expect(addJob).toHaveBeenCalledOnce();
  });
});

describe('reminders · processor', () => {
  const proc = createBookingReminderProcessor();
  const job = (data: any) => ({ data } as any);

  beforeEach(() => {
    vi.clearAllMocks();
    eventTypeFindOne.mockResolvedValue({ name: 'Intro call' });
    ruleFindOne.mockResolvedValue({ timezone: 'Europe/Brussels' });
  });

  it('sends the reminder when the booking is still confirmed and current', async () => {
    bookingFindOne.mockResolvedValue({
      id: 'bk-1',
      status: 'confirmed',
      sequence: 0,
      botId: 'bot-1',
      startUtc: new Date('2026-06-10T07:00:00Z'),
      attendeeName: 'Ada',
      attendeeEmail: 'ada@example.com',
    });
    await proc(job({ bookingId: 'bk-1', kind: '24h', sequence: 0 }));
    expect(sendReminderEmail).toHaveBeenCalledOnce();
    expect(sendReminderEmail.mock.calls[0][0]).toMatchObject({ summary: 'Intro call', leadLabel: 'tomorrow' });
  });

  it('skips a cancelled booking', async () => {
    bookingFindOne.mockResolvedValue({ id: 'bk-1', status: 'cancelled', sequence: 0, botId: 'b' });
    await proc(job({ bookingId: 'bk-1', kind: '1h', sequence: 0 }));
    expect(sendReminderEmail).not.toHaveBeenCalled();
  });

  it('skips when the sequence no longer matches (rescheduled)', async () => {
    bookingFindOne.mockResolvedValue({ id: 'bk-1', status: 'confirmed', sequence: 3, botId: 'b' });
    await proc(job({ bookingId: 'bk-1', kind: '1h', sequence: 0 }));
    expect(sendReminderEmail).not.toHaveBeenCalled();
  });

  it('skips when the booking no longer exists', async () => {
    bookingFindOne.mockResolvedValue(null);
    await proc(job({ bookingId: 'gone', kind: '1h', sequence: 0 }));
    expect(sendReminderEmail).not.toHaveBeenCalled();
  });
});
