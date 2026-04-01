import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

let mockRagSecret: string | undefined = 'test-secret';

vi.mock('../../config/environment', () => ({
  config: {
    n8n: {
      get ragInternalSecret() {
        return mockRagSecret;
      },
    },
  },
}));

const mockListBookings = vi.fn();
const mockCheckAvailability = vi.fn();
const mockCreateBooking = vi.fn();
const mockRescheduleBooking = vi.fn();
const mockCancelBooking = vi.fn();

vi.mock('../../n8n/booking.service', () => {
  class BookingError extends Error {
    constructor(
      message: string,
      public code: string,
      public statusCode: number
    ) {
      super(message);
      this.name = 'BookingError';
    }
  }
  return {
    listBookings: (...args: unknown[]) => mockListBookings(...args),
    checkAvailability: (...args: unknown[]) => mockCheckAvailability(...args),
    createBooking: (...args: unknown[]) => mockCreateBooking(...args),
    rescheduleBooking: (...args: unknown[]) => mockRescheduleBooking(...args),
    cancelBooking: (...args: unknown[]) => mockCancelBooking(...args),
    BookingError,
  };
});

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: vi.fn(),
    getRepository: vi.fn(),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import bookingRoutes from '../../n8n/booking.routes';
import { BookingError } from '../../n8n/booking.service';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/internal/booking', bookingRoutes);
  return app;
}

describe('Booking Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRagSecret = 'test-secret';
    app = createApp();
  });

  // ── Auth tests ──────────────────────────────────────────────────────────

  describe('verifyInternalAuth middleware', () => {
    it('should return 503 when RAG_INTERNAL_SECRET is not configured', async () => {
      mockRagSecret = undefined;

      const res = await request(app)
        .post('/internal/booking/list')
        .send({ sessionId: VALID_UUID, attendeeEmail: 'a@b.com' });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/);
    });

    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .post('/internal/booking/list')
        .send({ sessionId: VALID_UUID, attendeeEmail: 'a@b.com' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should return 401 when token is wrong', async () => {
      const res = await request(app)
        .post('/internal/booking/list')
        .set('Authorization', 'Bearer wrong-token')
        .send({ sessionId: VALID_UUID, attendeeEmail: 'a@b.com' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should return 200 with valid Bearer token', async () => {
      mockListBookings.mockResolvedValue({ bookings: [] });

      const res = await request(app)
        .post('/internal/booking/list')
        .set('Authorization', 'Bearer test-secret')
        .send({ sessionId: VALID_UUID, attendeeEmail: 'a@b.com' });

      expect(res.status).toBe(200);
    });
  });

  // ── Validation tests ───────────────────────────────────────────────────

  describe('request validation', () => {
    it('should return 400 when sessionId is missing on /list', async () => {
      const res = await request(app)
        .post('/internal/booking/list')
        .set('Authorization', 'Bearer test-secret')
        .send({ attendeeEmail: 'a@b.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('should return 400 for invalid email on /list', async () => {
      const res = await request(app)
        .post('/internal/booking/list')
        .set('Authorization', 'Bearer test-secret')
        .send({ sessionId: VALID_UUID, attendeeEmail: 'not-email' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('should return 400 for invalid startDate on /availability', async () => {
      const res = await request(app)
        .post('/internal/booking/availability')
        .set('Authorization', 'Bearer test-secret')
        .send({ sessionId: VALID_UUID, startDate: 'bad-date', endDate: '2026-04-01T00:00:00Z' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('should return 400 for invalid endDate on /availability', async () => {
      const res = await request(app)
        .post('/internal/booking/availability')
        .set('Authorization', 'Bearer test-secret')
        .send({ sessionId: VALID_UUID, startDate: '2026-04-01T00:00:00Z', endDate: 'bad-date' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  // ── Error mapping tests ────────────────────────────────────────────────

  describe('error mapping', () => {
    it('should return 409 when BookingError has statusCode 409', async () => {
      mockCreateBooking.mockRejectedValue(
        new BookingError('Slot taken', 'SLOT_UNAVAILABLE', 409)
      );

      const res = await request(app)
        .post('/internal/booking/create')
        .set('Authorization', 'Bearer test-secret')
        .send({
          sessionId: VALID_UUID,
          idempotencyKey: 'key-123',
          startTime: '2026-04-01T10:00:00Z',
          attendee: { name: 'Test', email: 'test@test.com' },
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SLOT_UNAVAILABLE');
    });

    it('should return 503 when BookingError has statusCode 503', async () => {
      mockCheckAvailability.mockRejectedValue(
        new BookingError('Cal.com unavailable', 'BOOKING_UNAVAILABLE', 503)
      );

      const res = await request(app)
        .post('/internal/booking/availability')
        .set('Authorization', 'Bearer test-secret')
        .send({
          sessionId: VALID_UUID,
          startDate: '2026-04-01T00:00:00Z',
          endDate: '2026-04-02T00:00:00Z',
        });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('BOOKING_UNAVAILABLE');
    });

    it('should return 500 for unexpected errors', async () => {
      mockListBookings.mockRejectedValue(new Error('DB down'));

      const res = await request(app)
        .post('/internal/booking/list')
        .set('Authorization', 'Bearer test-secret')
        .send({ sessionId: VALID_UUID, attendeeEmail: 'a@b.com' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal error');
    });
  });

  // ── Successful calls ──────────────────────────────────────────────────

  describe('successful calls', () => {
    it('should return service result from /list', async () => {
      const result = { bookings: [{ id: '123', status: 'accepted' }] };
      mockListBookings.mockResolvedValue(result);

      const res = await request(app)
        .post('/internal/booking/list')
        .set('Authorization', 'Bearer test-secret')
        .send({ sessionId: VALID_UUID, attendeeEmail: 'a@b.com' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(result);
      expect(mockListBookings).toHaveBeenCalledWith(VALID_UUID, 'a@b.com');
    });

    it('should return service result from /availability', async () => {
      const result = { slots: [{ start: '10:00', end: '10:30' }], timezone: 'UTC' };
      mockCheckAvailability.mockResolvedValue(result);

      const res = await request(app)
        .post('/internal/booking/availability')
        .set('Authorization', 'Bearer test-secret')
        .send({
          sessionId: VALID_UUID,
          startDate: '2026-04-01T00:00:00Z',
          endDate: '2026-04-02T00:00:00Z',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(result);
      expect(mockCheckAvailability).toHaveBeenCalledWith(
        VALID_UUID, '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z'
      );
    });

    it('should return service result from /create', async () => {
      const result = { success: true, booking: { id: '42' } };
      mockCreateBooking.mockResolvedValue(result);

      const res = await request(app)
        .post('/internal/booking/create')
        .set('Authorization', 'Bearer test-secret')
        .send({
          sessionId: VALID_UUID,
          idempotencyKey: 'key-abc',
          startTime: '2026-04-01T10:00:00Z',
          attendee: { name: 'Alice', email: 'alice@test.com' },
          notes: 'Hello',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(result);
      expect(mockCreateBooking).toHaveBeenCalledWith(
        VALID_UUID, 'key-abc', '2026-04-01T10:00:00Z',
        { name: 'Alice', email: 'alice@test.com' }, 'Hello'
      );
    });

    it('should return service result from /reschedule', async () => {
      const result = { success: true, booking: { id: '42' } };
      mockRescheduleBooking.mockResolvedValue(result);

      const res = await request(app)
        .post('/internal/booking/reschedule')
        .set('Authorization', 'Bearer test-secret')
        .send({
          sessionId: VALID_UUID,
          bookingId: '42',
          newStartTime: '2026-04-02T10:00:00Z',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(result);
      expect(mockRescheduleBooking).toHaveBeenCalledWith(VALID_UUID, '42', '2026-04-02T10:00:00Z');
    });

    it('should return service result from /cancel', async () => {
      const result = { success: true, cancelled: true };
      mockCancelBooking.mockResolvedValue(result);

      const res = await request(app)
        .post('/internal/booking/cancel')
        .set('Authorization', 'Bearer test-secret')
        .send({
          sessionId: VALID_UUID,
          bookingId: '42',
          reason: 'Changed plans',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(result);
      expect(mockCancelBooking).toHaveBeenCalledWith(VALID_UUID, '42', 'Changed plans');
    });
  });
});
