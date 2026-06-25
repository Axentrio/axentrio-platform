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

// The service-boundary gate (D7) resolves entitlements; stub it here so these
// dispatcher tests stay DB-free. The gate's own deny behavior is covered by
// the entitlement contract tests.
const mockRequireFeature = vi.fn().mockResolvedValue(undefined);
vi.mock('../../billing/enforce', () => ({
  requireFeature: (...args: unknown[]) => mockRequireFeature(...args),
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
vi.mock('../../booking/booking-providers/internal.provider', () => ({
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
  adminCancelBooking,
  adminAcceptRequest,
} from '../../booking/booking.service';

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
      await expect(listBookings('agent', VALID_UUID, 'a@b.com')).rejects.toBeInstanceOf(BookingError);
      await expect(listBookings('agent', VALID_UUID, 'a@b.com')).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    });

    it('throws TENANT_NOT_FOUND when the tenant does not exist', async () => {
      mockSessionFindOne.mockResolvedValue({ id: VALID_UUID, tenantId: TENANT_ID });
      mockTenantFindOne.mockResolvedValue(null);
      await expect(listBookings('agent', VALID_UUID, 'a@b.com')).rejects.toMatchObject({
        code: 'TENANT_NOT_FOUND',
      });
    });
  });

  // ── dispatch to the internal provider ─────────────────────────────────

  describe('dispatches every operation to the internal provider', () => {
    it('routes listBookings with the resolved context', async () => {
      setupValidContext();
      internalMethods.listBookings.mockResolvedValue(['ok']);

      const res = await listBookings('agent', VALID_UUID, 'a@b.com');

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

      await checkAvailability('agent', VALID_UUID, '2026-04-01', '2026-04-02');

      expect(internalMethods.checkAvailability).toHaveBeenCalledWith(
        expect.any(Object),
        '2026-04-01',
        '2026-04-02',
        undefined,
        undefined,
      );
    });

    it('routes checkAvailability with the date range', async () => {
      setupValidContext();
      internalMethods.checkAvailability.mockResolvedValue({ slots: [] });

      const res = await checkAvailability('agent', VALID_UUID, '2026-04-01', '2026-04-02');

      expect(res).toEqual({ slots: [] });
      expect(internalMethods.checkAvailability).toHaveBeenCalledWith(
        expect.any(Object),
        '2026-04-01',
        '2026-04-02',
        undefined,
        undefined,
      );
    });

    it('routes createBooking with the idempotency key + attendee', async () => {
      setupValidContext();
      internalMethods.createBooking.mockResolvedValue({ success: true });
      const attendee = { name: 'Alice', email: 'alice@test.com' };

      const res = await createBooking('agent', VALID_UUID, 'key-1', '2026-04-01T10:00:00Z', attendee, 'notes');

      expect(res).toEqual({ success: true });
      expect(internalMethods.createBooking).toHaveBeenCalledWith(
        expect.any(Object),
        'key-1',
        '2026-04-01T10:00:00Z',
        attendee,
        'notes',
        undefined,
        undefined,
        undefined,
      );
    });

    it('routes rescheduleBooking', async () => {
      setupValidContext();
      internalMethods.rescheduleBooking.mockResolvedValue({ success: true });

      await rescheduleBooking('agent', VALID_UUID, 'b-1', '2026-04-02T10:00:00Z');

      expect(internalMethods.rescheduleBooking).toHaveBeenCalledWith(
        expect.any(Object),
        'b-1',
        '2026-04-02T10:00:00Z',
      );
    });

    it('routes cancelBooking', async () => {
      setupValidContext();
      internalMethods.cancelBooking.mockResolvedValue({ success: true });

      await cancelBooking('agent', VALID_UUID, 'b-1', 'No reason');

      expect(internalMethods.cancelBooking).toHaveBeenCalledWith(
        expect.any(Object),
        'b-1',
        'No reason',
      );
    });
  });

  // ── boundary gate (plan D7/D8) ─────────────────────────────────────────

  describe('bookings feature gate at the service boundary', () => {
    it('enforces the gate for agent / internal-n8n callers', async () => {
      setupValidContext();
      internalMethods.checkAvailability.mockResolvedValue({ slots: [] });

      await checkAvailability('agent', VALID_UUID, '2026-04-01', '2026-04-02');
      expect(mockRequireFeature).toHaveBeenCalledWith(TENANT_ID, 'bookings', 'plan_limit_bookings');

      mockRequireFeature.mockClear();
      internalMethods.listBookings.mockResolvedValue([]);
      await listBookings('internal-n8n', VALID_UUID, 'a@b.com');
      expect(mockRequireFeature).toHaveBeenCalledWith(TENANT_ID, 'bookings', 'plan_limit_bookings');
    });

    it('a denied gate propagates and the provider is never reached', async () => {
      setupValidContext();
      mockRequireFeature.mockRejectedValueOnce(Object.assign(new Error('plan'), { statusCode: 402 }));

      await expect(createBooking('internal-n8n', VALID_UUID, 'k', 't', { name: 'A' })).rejects.toMatchObject({
        statusCode: 402,
      });
      expect(internalMethods.createBooking).not.toHaveBeenCalled();
    });

    it('public-manage with a MATCHING verified booking id is exempt (D8)', async () => {
      setupValidContext();
      internalMethods.cancelBooking.mockResolvedValue({ success: true });

      await cancelBooking(
        { kind: 'public-manage', verifiedBookingId: 'b-1' },
        VALID_UUID,
        'b-1',
        'Customer cancelled',
      );

      expect(mockRequireFeature).not.toHaveBeenCalled();
      expect(internalMethods.cancelBooking).toHaveBeenCalled();
    });

    it('public-manage with a MISMATCHED id gets the full gate', async () => {
      setupValidContext();
      internalMethods.cancelBooking.mockResolvedValue({ success: true });

      await cancelBooking(
        { kind: 'public-manage', verifiedBookingId: 'b-OTHER' },
        VALID_UUID,
        'b-1',
      );

      expect(mockRequireFeature).toHaveBeenCalledWith(TENANT_ID, 'bookings', 'plan_limit_bookings');
    });

    it('public-manage is never exempt for creation', async () => {
      setupValidContext();
      internalMethods.createBooking.mockResolvedValue({ success: true });

      await createBooking(
        { kind: 'public-manage', verifiedBookingId: 'b-1' },
        VALID_UUID,
        'k',
        '2026-04-01T10:00:00Z',
        { name: 'A' },
      );

      // createBooking passes no bookingId to the gate, so the claim cannot match.
      expect(mockRequireFeature).toHaveBeenCalledWith(TENANT_ID, 'bookings', 'plan_limit_bookings');
    });

    it('owner actions (accept) are never public-manage-exempt', async () => {
      // adminAcceptRequest hits the gate BEFORE loading the booking, so a
      // denied/checked gate is observable without scripting the admin repos.
      mockRequireFeature.mockRejectedValueOnce(Object.assign(new Error('plan'), { statusCode: 402 }));
      await expect(
        adminAcceptRequest({ kind: 'public-manage', verifiedBookingId: 'b-1' }, TENANT_ID, 'b-1'),
      ).rejects.toMatchObject({ statusCode: 402 });
    });

    it('admin cancel via public-manage exemption skips the gate with a matching id', async () => {
      // Gate is checked first; with the exemption it resolves without touching
      // requireFeature (booking loading then fails on the unscripted repo,
      // which is fine — we only assert the gate behavior).
      await adminCancelBooking(
        { kind: 'public-manage', verifiedBookingId: 'b-1' },
        TENANT_ID,
        'b-1',
      ).catch(() => undefined);
      expect(mockRequireFeature).not.toHaveBeenCalled();
    });
  });
});
