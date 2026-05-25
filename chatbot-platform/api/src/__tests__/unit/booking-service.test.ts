import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockSessionFindOne = vi.fn();
const mockTenantFindOne = vi.fn();
const mockBookingLogFindOne = vi.fn();
const mockBookingLogCreate = vi.fn((data: any) => data);
const mockBookingLogSave = vi.fn();
const mockBookingLogCreateQueryBuilder = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn((entity: any) => {
      const name = entity?.name || entity;
      if (name === 'ChatSession') {
        return { findOne: mockSessionFindOne };
      }
      if (name === 'Tenant') {
        return { findOne: mockTenantFindOne };
      }
      if (name === 'BookingLog') {
        return {
          findOne: mockBookingLogFindOne,
          create: mockBookingLogCreate,
          save: mockBookingLogSave,
          createQueryBuilder: mockBookingLogCreateQueryBuilder,
        };
      }
      return {};
    }),
  },
}));

const mockDecrypt = vi.fn((val: string) => `decrypted:${val}`);
vi.mock('../../utils/encryption', () => ({
  decrypt: (val: string) => mockDecrypt(val),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Multi-bot Phase 4 (#16d): booking.service now reads integrations +
// businessHours from Bot.settings via getBotConfigForSession. Re-route to
// the existing tenant mock so each test's seeded `settings.integrations`
// transparently flows to the new resolver.
const mockGetBotConfigForSession = vi.fn();
vi.mock('../../services/bot-config.service', () => ({
  getBotConfigForSession: (...args: unknown[]) => mockGetBotConfigForSession(...args),
}));

const mockAxiosGet = vi.fn();
const mockAxiosPost = vi.fn();
const mockAxiosDelete = vi.fn();

vi.mock('axios', () => {
  const AxiosError = class AxiosError extends Error {
    response: any;
    constructor(message: string, _config?: any, _code?: any, _request?: any, response?: any) {
      super(message);
      this.name = 'AxiosError';
      this.response = response;
    }
  };
  return {
    default: {
      get: (...args: unknown[]) => mockAxiosGet(...args),
      post: (...args: unknown[]) => mockAxiosPost(...args),
      delete: (...args: unknown[]) => mockAxiosDelete(...args),
    },
    AxiosError,
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  BookingError,
  listBookings,
  checkAvailability,
  createBooking,
  rescheduleBooking,
  cancelBooking,
} from '../../n8n/booking.service';
import { AxiosError } from 'axios';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const TENANT_ID = 'aaaa0000-bbbb-cccc-dddd-eeeeeeee0001';

function setupValidSession() {
  mockSessionFindOne.mockResolvedValue({ id: VALID_UUID, tenantId: TENANT_ID });
  mockTenantFindOne.mockResolvedValue({
    id: TENANT_ID,
    name: 'Test Tenant',
    settings: {},
  });
  mockGetBotConfigForSession.mockResolvedValue({
    bot: { id: 'bot-anchor', tenantId: TENANT_ID, isDefault: true },
    settings: {
      integrations: {
        calcom: {
          apiKey: 'enc-key',
          eventTypeId: 42,
        },
      },
      businessHours: { timezone: 'Europe/Amsterdam' },
    },
  });
}

describe('Booking Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── resolveSessionTenant ──────────────────────────────────────────────

  describe('resolveSessionTenant (via public functions)', () => {
    it('should throw SESSION_NOT_FOUND when session does not exist', async () => {
      mockSessionFindOne.mockResolvedValue(null);

      await expect(listBookings(VALID_UUID, 'a@b.com'))
        .rejects.toThrow(BookingError);

      try {
        await listBookings(VALID_UUID, 'a@b.com');
      } catch (err) {
        expect(err).toBeInstanceOf(BookingError);
        expect((err as BookingError).code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('should throw BOOKING_NOT_CONFIGURED when no Cal.com config', async () => {
      mockSessionFindOne.mockResolvedValue({ id: VALID_UUID, tenantId: TENANT_ID });
      mockTenantFindOne.mockResolvedValue({
        id: TENANT_ID,
        name: 'Test Tenant',
        settings: {},
      });
      mockGetBotConfigForSession.mockResolvedValue({
        bot: { id: 'bot-anchor', tenantId: TENANT_ID, isDefault: true },
        settings: {},
      });

      await expect(listBookings(VALID_UUID, 'a@b.com'))
        .rejects.toThrow(BookingError);

      try {
        await listBookings(VALID_UUID, 'a@b.com');
      } catch (err) {
        expect(err).toBeInstanceOf(BookingError);
        expect((err as BookingError).code).toBe('BOOKING_NOT_CONFIGURED');
      }
    });
  });

  // ── createBooking ─────────────────────────────────────────────────────

  describe('createBooking', () => {
    it('should return idempotent response when duplicate idempotency key found', async () => {
      setupValidSession();
      mockBookingLogFindOne.mockResolvedValue({
        calBookingId: '999',
        startTime: new Date('2026-04-01T10:00:00Z'),
        endTime: new Date('2026-04-01T10:30:00Z'),
        attendeeName: 'Alice',
        attendeeEmail: 'alice@test.com',
      });

      const result = await createBooking(
        VALID_UUID, 'dup-key', '2026-04-01T10:00:00Z',
        { name: 'Alice', email: 'alice@test.com' }
      );

      expect(result.idempotent).toBe(true);
      expect(result.success).toBe(true);
      expect(result.booking.id).toBe('999');
      // Should NOT call Cal.com API
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('should throw SLOT_UNAVAILABLE (409) when Cal.com returns 409', async () => {
      setupValidSession();
      mockBookingLogFindOne.mockResolvedValue(null);

      const axiosErr = new AxiosError('Conflict');
      axiosErr.response = { status: 409, data: {}, statusText: 'Conflict', headers: {}, config: {} as any };
      mockAxiosPost.mockRejectedValue(axiosErr);

      try {
        await createBooking(
          VALID_UUID, 'key-1', '2026-04-01T10:00:00Z',
          { name: 'Bob', email: 'bob@test.com' }
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BookingError);
        expect((err as BookingError).code).toBe('SLOT_UNAVAILABLE');
        expect((err as BookingError).statusCode).toBe(409);
      }
    });
  });

  // ── checkAvailability ─────────────────────────────────────────────────

  describe('checkAvailability', () => {
    it('should throw BOOKING_UNAVAILABLE (503) when Cal.com returns 5xx', async () => {
      setupValidSession();

      const axiosErr = new AxiosError('Server Error');
      axiosErr.response = { status: 500, data: {}, statusText: 'Internal Server Error', headers: {}, config: {} as any };
      mockAxiosGet.mockRejectedValue(axiosErr);

      try {
        await checkAvailability(VALID_UUID, '2026-04-01', '2026-04-02');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BookingError);
        expect((err as BookingError).code).toBe('BOOKING_UNAVAILABLE');
        expect((err as BookingError).statusCode).toBe(503);
      }
    });
  });

  // ── rescheduleBooking ─────────────────────────────────────────────────

  describe('rescheduleBooking', () => {
    it('should throw BOOKING_NOT_FOUND when booking does not belong to tenant', async () => {
      setupValidSession();
      mockBookingLogFindOne.mockResolvedValue(null);

      try {
        await rescheduleBooking(VALID_UUID, 'nonexistent-booking', '2026-04-02T10:00:00Z');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BookingError);
        expect((err as BookingError).code).toBe('BOOKING_NOT_FOUND');
        expect((err as BookingError).statusCode).toBe(404);
      }
    });
  });

  // ── cancelBooking ─────────────────────────────────────────────────────

  describe('cancelBooking', () => {
    it('should throw BOOKING_NOT_FOUND when booking does not belong to tenant', async () => {
      setupValidSession();
      mockBookingLogFindOne.mockResolvedValue(null);

      try {
        await cancelBooking(VALID_UUID, 'nonexistent-booking', 'No reason');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BookingError);
        expect((err as BookingError).code).toBe('BOOKING_NOT_FOUND');
        expect((err as BookingError).statusCode).toBe(404);
      }
    });
  });
});
