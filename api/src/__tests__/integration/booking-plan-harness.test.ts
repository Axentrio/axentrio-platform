/**
 * The harness itself, before any plan case trusts it.
 *
 * A fixture layer that is subtly wrong is worse than none: `seedConfirmedBooking` is the busy
 * time every capacity and Minimum Gap case reasons about, and `localInstant` is the single
 * conversion BK-06's timezone-drift regression depends on. If either lies, the plan's cases go
 * green against a diary that does not resemble production.
 *
 * The assertions that matter most here are the two the plan cannot survive getting wrong:
 *   - 10:00 written as a Brussels wall clock reads back as 10:00 (not 08:00 or 12:00), and
 *   - two Bookings cannot occupy the same time, enforced by the DB rather than by our helpers.
 *     That exclusion constraint is the whole of CON-01's guarantee, so it is checked at the level
 *     it actually lives.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ServiceType } from '../../database/entities/ServiceType';
import {
  PLAN_TZ,
  BUSINESS_ADDRESS,
  createPlanBusiness,
  createPlanService,
  setPlanAvailability,
  setPlanBookingSettings,
  seedConfirmedBooking,
  bookingCount,
  requestCount,
  soleConfirmedBooking,
  localSpan,
  localInstant,
  localHHMM,
  localDateOnly,
  localWeekday,
  planDate,
  planLocalTime,
} from '../helpers/booking-plan-harness';

describe('booking plan harness', () => {
  describe('local wall clock conversions (§3 Europe/Brussels)', () => {
    it('a local 10:00 is the same local 10:00 after a UTC round trip', () => {
      // September is CEST (+02:00). The bug BK-06 pins was a +2 hour drift, so the summer case is
      // the one that catches it.
      expect(localHHMM(localInstant('2026-09-14T10:00'))).toBe('10:00');
      expect(localDateOnly(localInstant('2026-09-14T10:00'))).toBe('2026-09-14');
    });

    it('holds across the DST boundary, where a naive offset would shift by an hour', () => {
      // Brussels moves to CET (+01:00) on 2026-10-25. A fixed-offset helper passes the summer case
      // and fails here, which is why both are asserted.
      expect(localHHMM(localInstant('2026-10-14T10:00'))).toBe('10:00');
      expect(localHHMM(localInstant('2026-11-14T10:00'))).toBe('10:00');
      // And the UTC instants genuinely differ, so the helper is converting rather than echoing.
      expect(localInstant('2026-09-14T10:00').toISOString()).toBe('2026-09-14T08:00:00.000Z');
      expect(localInstant('2026-11-14T10:00').toISOString()).toBe('2026-11-14T09:00:00.000Z');
    });

    it('names the business-local weekday, not the UTC one', () => {
      // 2026-09-14 is a Monday. 00:30 local on a Monday is still Sunday in UTC.
      expect(localWeekday(localInstant('2026-09-14T10:00'))).toBe('mon');
      expect(localWeekday(localInstant('2026-09-14T00:30'))).toBe('mon');
    });

    it('refuses something that is not a wall clock rather than inventing one', () => {
      expect(() => localInstant('not-a-date')).toThrow(/not a local wall clock/);
    });
  });

  describe('relative dates for notice / horizon cases', () => {
    it('lands on a weekday so an hours case is never decided by a closed weekend', () => {
      for (const days of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const weekday = localWeekday(`${planDate(days)}T12:00`);
        expect(['mon', 'tue', 'wed', 'thu', 'fri']).toContain(weekday);
      }
    });

    it('builds a local wall clock at a requested hour', () => {
      expect(planLocalTime(3, '10:00')).toMatch(/^\d{4}-\d{2}-\d{2}T10:00$/);
    });
  });

  describe('a bookable business (§3 default fixtures)', () => {
    it('sets Brussels as the business timezone, which is authoritative over the rule copy', async () => {
      const business = await createPlanBusiness();
      await setPlanAvailability(business.bot);
      expect(business.bot.businessTimezone).toBe(PLAN_TZ);
    });

    it('creates the plan default Service: Auto-book, fixed 30 min, no price, bookable', async () => {
      const business = await createPlanBusiness();
      await setPlanAvailability(business.bot);
      const service = await createPlanService(business.bot);

      const svc = await AppDataSource.getRepository(ServiceType).findOneOrFail({
        where: { id: service.id },
      });
      expect(svc).toMatchObject({
        bookingMode: 'auto',
        durationMode: 'fixed',
        durationMin: 30,
        priceDisplayType: 'none',
        isActive: true,
        onlineBookable: true,
      });
    });

    it('starts with an empty diary, so a delta of 0 means what the plan says it means', async () => {
      const business = await createPlanBusiness();
      await setPlanAvailability(business.bot);
      const service = await createPlanService(business.bot);

      expect(await bookingCount(service.id)).toBe(0);
      expect(await requestCount(service.id)).toBe(0);
    });

    it('seeds busy time that reads back at the local hour it was written for', async () => {
      const business = await createPlanBusiness();
      await setPlanAvailability(business.bot);
      const service = await createPlanService(business.bot);

      const when = planLocalTime(10, '10:00');
      const seeded = await seedConfirmedBooking({ bot: business.bot, serviceId: service.id, startLocal: when });

      const span = localSpan(seeded);
      expect(span.start).toBe('10:00');
      expect(span.end).toBe('10:30');
      expect(span.minutes).toBe(30);
      expect(span.date).toBe(when.slice(0, 10));

      expect(await bookingCount(service.id, 'confirmed')).toBe(1);
      expect(await requestCount(service.id)).toBe(0);

      const sole = await soleConfirmedBooking(service.id);
      expect(sole.id).toBe(seeded.id);
    });
  });

  describe('the exclusion constraint, which is the whole of CON-01', () => {
    it('refuses a second Booking overlapping the first, at the database level', async () => {
      const business = await createPlanBusiness();
      await setPlanAvailability(business.bot);
      const service = await createPlanService(business.bot);

      const day = planDate(20);
      await seedConfirmedBooking({ bot: business.bot, serviceId: service.id, startLocal: `${day}T13:00` });

      // Same slot, a different customer and a different Service — the constraint is on
      // (calendar_key, blocked_range), so neither difference may rescue it.
      const other = await createPlanService(business.bot, { name: 'Other service' });
      await expect(
        seedConfirmedBooking({ bot: business.bot, serviceId: other.id, startLocal: `${day}T13:00` }),
      ).rejects.toThrow(/conflict|exclusion|blocked_range/i);

      // A partial overlap must fail too: 13:15–13:45 crosses the held 13:00–13:30.
      await expect(
        seedConfirmedBooking({ bot: business.bot, serviceId: service.id, startLocal: `${day}T13:15` }),
      ).rejects.toThrow(/conflict|exclusion|blocked_range/i);

      // Abutting is NOT an overlap — 13:30 starts exactly when the held range ends, and treating
      // that as busy would break CAL-04's "boundary immediately after is allowed".
      await seedConfirmedBooking({ bot: business.bot, serviceId: service.id, startLocal: `${day}T13:30` });
      expect(await bookingCount(service.id, 'confirmed')).toBe(2);
    });
  });

  describe('booking settings are an upsert, not a duplicate insert', () => {
    it('tunes ceilings and defaults twice without tripping the one-row-per-bot index', async () => {
      const business = await createPlanBusiness();
      const first = await setPlanBookingSettings(business.bot, {
        ...BUSINESS_ADDRESS,
        maxBookingsPerDay: 2,
      });
      const second = await setPlanBookingSettings(business.bot, { maxBookedMinutesPerDay: 120 });

      expect(second.id).toBe(first.id);
      // The second call must not erase what the first set.
      expect(second.maxBookingsPerDay).toBe(2);
      expect(second.maxBookedMinutesPerDay).toBe(120);
      expect(second.venueCity).toBe('Antwerpen');
    });
  });
});
