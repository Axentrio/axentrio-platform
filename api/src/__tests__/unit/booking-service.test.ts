import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockSessionFindOne = vi.fn();
const mockTenantFindOne = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn((entity: any) => {
      const name = entity?.name || entity;
      if (name === 'ChatSession') return { findOne: mockSessionFindOne };
      if (name === 'Tenant') return { findOne: mockTenantFindOne };
      return {};
    }),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetBotConfigForSession = vi.fn();
vi.mock('../../services/bot-config.service', () => ({
  getBotConfigForSession: (...args: unknown[]) => mockGetBotConfigForSession(...args),
}));

// Cal.com is shelved — the service dispatches every operation to the internal
// provider. Mock it so these tests verify routing (resolve context → dispatch),
// not the slot-engine internals (covered by the internal-provider unit tests).
// `vi.hoisted` so the stub is initialized before the hoisted vi.mock factory
// (and before booking.service's top-level `new InternalProvider()`) runs.
const internalMethods = vi.hoisted(() => ({
  listBookings: vi.fn(),
  checkAvailability: vi.fn(),
  createBooking: vi.fn(),
  rescheduleBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));
vi.mock('../../n8n/booking-providers/internal.provider', () => ({
  // Regular function (not an arrow) so `new InternalProvider()` returns the stub.
  InternalProvider: vi.fn(function () {
    return internalMethods;
  }),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  BookingError,
  listBookings,
  checkAvailability,
  createBooking,
  rescheduleBooking,
  cancelBooking,
} from '../../n8n/booking.service';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const TENANT_ID = 'aaaa0000-bbbb-cccc-dddd-eeeeeeee0001';

function setupValidContext() {
  mockSessionFindOne.mockResolvedValue({ id: VALID_UUID, tenantId: TENANT_ID });
  mockTenantFindOne.mockResolvedValue({ id: TENANT_ID, name: 'Test Tenant', settings: {} });
  mockGetBotConfigForSession.mockResolvedValue({
    bot: { id: 'bot-anchor', tenantId: TENANT_ID, isDefault: true },
    settings: { businessHours: { timezone: 'Europe/Amsterdam' } },
  });
}

describe('Booking Service (internal dispatcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── resolveContext (provider-agnostic) ────────────────────────────────

  describe('resolveContext (via public functions)', () => {
    it('throws SESSION_NOT_FOUND when the session does not exist', async () => {
      mockSessionFindOne.mockResolvedValue(null);
      await expect(listBookings(VALID_UUID, 'a@b.com')).rejects.toBeInstanceOf(BookingError);
      await expect(listBookings(VALID_UUID, 'a@b.com')).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    });

    it('throws TENANT_NOT_FOUND when the tenant does not exist', async () => {
      mockSessionFindOne.mockResolvedValue({ id: VALID_UUID, tenantId: TENANT_ID });
      mockTenantFindOne.mockResolvedValue(null);
      await expect(listBookings(VALID_UUID, 'a@b.com')).rejects.toMatchObject({
        code: 'TENANT_NOT_FOUND',
      });
    });
  });

  // ── dispatch to the internal provider ─────────────────────────────────

  describe('dispatches every operation to the internal provider', () => {
    it('routes listBookings with the resolved context', async () => {
      setupValidContext();
      internalMethods.listBookings.mockResolvedValue(['ok']);

      const res = await listBookings(VALID_UUID, 'a@b.com');

      expect(res).toEqual(['ok']);
      expect(internalMethods.listBookings).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: expect.objectContaining({ id: TENANT_ID }) }),
        'a@b.com',
      );
    });

    it('routes to internal even for a legacy bot still set to provider: calcom', async () => {
      // Cal.com is shelved: a stored `provider: 'calcom'` (+ inert creds) must
      // not resurrect the Cal.com path — everything dispatches to internal.
      mockSessionFindOne.mockResolvedValue({ id: VALID_UUID, tenantId: TENANT_ID });
      mockTenantFindOne.mockResolvedValue({ id: TENANT_ID, name: 'Test Tenant', settings: {} });
      mockGetBotConfigForSession.mockResolvedValue({
        bot: { id: 'bot-anchor', tenantId: TENANT_ID, isDefault: true },
        settings: { integrations: { provider: 'calcom', calcom: { apiKey: 'enc', eventTypeId: 42 } } },
      });
      internalMethods.checkAvailability.mockResolvedValue({ slots: [] });

      await checkAvailability(VALID_UUID, '2026-04-01', '2026-04-02');

      expect(internalMethods.checkAvailability).toHaveBeenCalledWith(
        expect.any(Object),
        '2026-04-01',
        '2026-04-02',
      );
    });

    it('routes checkAvailability with the date range', async () => {
      setupValidContext();
      internalMethods.checkAvailability.mockResolvedValue({ slots: [] });

      const res = await checkAvailability(VALID_UUID, '2026-04-01', '2026-04-02');

      expect(res).toEqual({ slots: [] });
      expect(internalMethods.checkAvailability).toHaveBeenCalledWith(
        expect.any(Object),
        '2026-04-01',
        '2026-04-02',
      );
    });

    it('routes createBooking with the idempotency key + attendee', async () => {
      setupValidContext();
      internalMethods.createBooking.mockResolvedValue({ success: true });
      const attendee = { name: 'Alice', email: 'alice@test.com' };

      const res = await createBooking(VALID_UUID, 'key-1', '2026-04-01T10:00:00Z', attendee, 'notes');

      expect(res).toEqual({ success: true });
      expect(internalMethods.createBooking).toHaveBeenCalledWith(
        expect.any(Object),
        'key-1',
        '2026-04-01T10:00:00Z',
        attendee,
        'notes',
      );
    });

    it('routes rescheduleBooking', async () => {
      setupValidContext();
      internalMethods.rescheduleBooking.mockResolvedValue({ success: true });

      await rescheduleBooking(VALID_UUID, 'b-1', '2026-04-02T10:00:00Z');

      expect(internalMethods.rescheduleBooking).toHaveBeenCalledWith(
        expect.any(Object),
        'b-1',
        '2026-04-02T10:00:00Z',
      );
    });

    it('routes cancelBooking', async () => {
      setupValidContext();
      internalMethods.cancelBooking.mockResolvedValue({ success: true });

      await cancelBooking(VALID_UUID, 'b-1', 'No reason');

      expect(internalMethods.cancelBooking).toHaveBeenCalledWith(
        expect.any(Object),
        'b-1',
        'No reason',
      );
    });
  });
});
