import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBooking: vi.fn(),
  sendInformationalBotMessage: vi.fn(),
}));

vi.mock('../../booking/booking.service', () => ({
  BookingError: class BookingError extends Error {},
  checkAvailability: vi.fn(),
  createBooking: mocks.createBooking,
  requestBooking: vi.fn(),
  listBookings: vi.fn(),
  rescheduleBooking: vi.fn(),
  cancelBooking: vi.fn(),
  updateBooking: vi.fn(),
}));

vi.mock('../../services/message-forwarding.service', () => ({
  sendInformationalBotMessage: mocks.sendInformationalBotMessage,
}));

vi.mock('../../booking/travel/address-for-turn', () => ({
  addressForTurn: vi.fn().mockResolvedValue({ correctionPending: false }),
  addressToken: vi.fn().mockReturnValue('no-address'),
}));

vi.mock('../../booking/travel/address-binding', () => ({
  getPendingCorrection: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../agent/offered-slots-store', () => ({
  rememberOfferedSlots: vi.fn(),
  resolveBookingTime: vi.fn(async (_sessionId: string, startTime: string) => startTime),
}));

vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: vi.fn().mockReturnValue({}),
}));

import { CreateBookingTool } from '../../agent/tools/booking.tool';

const result = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  serviceName: 'Boiler repair',
  preparationInstructions: '  Please clear access to the boiler.  ',
  booking: {
    id: undefined,
    startTime: undefined,
    endTime: undefined,
    attendee: { name: 'Ada' },
  },
  ...overrides,
});

const ctx = {
  sessionId: 'session-1',
  tenantId: 'tenant-1',
  channel: 'widget',
  conversationHistory: [],
} as any;

const args = {
  startTime: '2026-09-01T10:00:00Z',
  attendeeName: 'Ada',
};

describe('booking preparation instructions chat notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends trimmed preparation instructions once for a newly confirmed booking', async () => {
    mocks.createBooking.mockResolvedValue(result());

    const response = await new CreateBookingTool().execute(args, ctx);

    expect(mocks.sendInformationalBotMessage).toHaveBeenCalledOnce();
    expect(mocks.sendInformationalBotMessage).toHaveBeenCalledWith(
      'session-1',
      'Before your appointment:\nPlease clear access to the boiler.',
    );
    expect(response.success).toBe(true);
    expect((response.data as Record<string, unknown>).preparationInstructions).toBeUndefined();
  });

  it.each([
    ['null instructions', { preparationInstructions: null }],
    ['blank instructions', { preparationInstructions: '   ' }],
    ['a request', { requested: true }],
    ['an idempotent return', { idempotent: true }],
  ])('does not notify for %s', async (_label, overrides) => {
    mocks.createBooking.mockResolvedValue(result(overrides));

    const response = await new CreateBookingTool().execute(args, ctx);

    expect(response.success).toBe(true);
    expect(mocks.sendInformationalBotMessage).not.toHaveBeenCalled();
  });

  it('keeps the confirmed booking successful when chat delivery fails', async () => {
    mocks.createBooking.mockResolvedValue(result());
    mocks.sendInformationalBotMessage.mockRejectedValue(new Error('socket unavailable'));

    const response = await new CreateBookingTool().execute(args, ctx);

    expect(response.success).toBe(true);
  });
});
