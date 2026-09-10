/**
 * The booking lifecycle guarantees the plan asks for, asserted on PERSISTED STATE.
 *
 * Two of these close gaps that are easy to miss because something adjacent was already pinned:
 *
 * * [BK-06] / [CAL-07] — the plan requires the booking row, the calendar event and the
 *   confirmation email to agree on the customer's local time. Nothing in this repository ever
 *   bound those three together. `displayTime` was pinned, the row's status was pinned, and the
 *   calendar's start was never asserted at all — so the exact failure the plan was written to
 *   catch (a +2 hour timezone drift a customer sees on their invite) had no safety net anywhere.
 *   Here all three surfaces are read from the SAME booking and compared in local clock terms.
 *
 * * [BK-01] — "no booking before confirmation, exactly one after" was pinned as a mocked-service
 *   CALL COUNT (`unit/builtin-tools.test.ts:1078`), never as a row delta. A call count cannot see a
 *   duplicate INSERT, a second row written by a retry, or a Request captured alongside the
 *   booking. This file asserts the delta on real rows.
 *
 * What is deliberately NOT claimed here: the *confirmation gate itself* (`CONFIRMATION_REQUIRED`)
 * is driven by Redis-backed pending-confirmation state and is pinned in `unit/builtin-tools.test.ts`.
 * These tests are the row-level half, and they say so rather than implying the gate is proven twice.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../scheduler/calendar-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/calendar-provider')>()),
  ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
}));
vi.mock('../../automations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automations')>()),
  getEmailService: () => ({ send: vi.fn().mockResolvedValue({ success: true, messageId: 'qa' }) }),
  initializeAutomations: vi.fn(),
}));

import { DateTime } from 'luxon';
import { formatWhen } from '../../booking/booking-copy';
import { InternalProvider } from '../../booking/booking-providers/internal.provider';
import { CheckAvailabilityTool } from '../../agent/tools/booking.tool';
import {
  createPlanBusiness,
  createPlanService,
  setPlanAvailability,
  seedPlanCalendarCredential,
  PLAN_CALENDAR,
  PLAN_TZ,
  PLAN_CUSTOMER_EMAIL,
  planSession,
  planBookingContext,
  planToolContext,
  planLocalTime,
  localInstant,
  localSpan,
  bookingCount,
  requestCount,
  bookingsForService,
  emailDeliveriesFor,
  customerEmailFor,
  emailText,
} from '../helpers/booking-plan-harness';

/** The local hour a recorded calendar write started at — the invite's own clock. */
function calendarStartLocal(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(PLAN_TZ).toFormat('HH:mm');
}

describe('booking plan · lifecycle', () => {
  beforeEach(() => {
    PLAN_CALENDAR.reset();
  });

  describe('[BK-06] the booking time is the same time on every surface', () => {
    it('agrees across the booking row, the calendar mirror and the confirmation email', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      // September, so Brussels is CEST (UTC+2). The original drift was +2 hours, which is exactly
      // the offset in force here — a fixture in a UTC-offset-0 month could not reproduce it.
      const day = planLocalTime(35, '10:00');
      const provider = new InternalProvider();

      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-tz-${randomUUID()}`,
        localInstant(day).toISOString(),
        { name: 'QA Timezone', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      expect(result.success).toBe(true);

      const [row] = await bookingsForService(service.id);
      expect(row).toBeDefined();

      // Surface 1 — the booking row, read back in the business's local clock.
      const span = localSpan(row);
      expect(span.start).toBe('10:00');
      expect(span.end).toBe('10:30');
      expect(span.minutes).toBe(30);
      expect(span.date).toBe(day.slice(0, 10));

      // Surface 2 — the calendar mirror. This is the surface that had NEVER been asserted, and it
      // is the one the customer actually looks at.
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
      const invite = PLAN_CALENDAR.creates[0].input;
      expect(calendarStartLocal(invite.startISO)).toBe('10:00');
      expect(calendarStartLocal(invite.endISO)).toBe('10:30');
      expect(invite.timezone).toBe(PLAN_TZ);

      // The drift is stated explicitly rather than only implied by the equality above: 10:00 local
      // in September is 08:00Z, so a surface showing the UTC instant as though it were local would
      // read 08:00. A test that compared UTC against UTC would pass while the customer saw the
      // wrong hour, which is precisely how this bug survived.
      expect(invite.startISO).toBe('2026-09-14T08:00:00.000Z'.replace('2026-09-14', day.slice(0, 10)));
      expect(calendarStartLocal(invite.startISO)).not.toBe('08:00');

      // Surface 3 — the confirmation email, read from the durable ledger so this asserts the copy
      // the customer was actually promised rather than a template.
      const deliveries = await emailDeliveriesFor(row.id);
      expect(deliveries.length).toBeGreaterThanOrEqual(1);

      const customer = await customerEmailFor(row.id, PLAN_CUSTOMER_EMAIL);
      expect(customer).toBeDefined();
      const text = emailText(customer!);
      expect(text).toContain('10:00');

      // And the DATE, rendered through the SAME formatter the email itself uses. That is what makes
      // this an agreement assertion rather than a style assertion: the expected string is derived
      // from the booking ROW's own instant, so the email can only contain it if the email rendered
      // that row's time. A wrong-day booking that happened to contain a "10:00" somewhere cannot pass.
      const expectedWhen = formatWhen(new Date(row.startUtc), PLAN_TZ, row.customerLanguage ?? 'en');
      expect(expectedWhen).toContain('10:00');
      expect(text).toContain(expectedWhen);
    });
  });

  describe('[BK-01] the booking row delta', () => {
    it('is zero before any write and exactly one after a confirmed booking', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      // Before: nothing exists. This is the half a mocked CALL COUNT cannot express — it is a
      // statement about the diary, not about whether a function was invoked.
      expect(await bookingCount(service.id)).toBe(0);
      expect(PLAN_CALENDAR.creates).toHaveLength(0);

      const day = planLocalTime(36, '10:00');
      const provider = new InternalProvider();
      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-delta-${randomUUID()}`,
        localInstant(day).toISOString(),
        { name: 'QA Delta', email: 'qa-delta@example.test' },
        undefined,
        service.id,
      );

      expect(result.success).toBe(true);
      expect(result.requested).toBeFalsy();

      // After: exactly one, and no Request captured alongside it. A booking that ALSO leaves a
      // request row is the "duplicate request" the plan warns about, and it is invisible to a call
      // count.
      expect(await bookingCount(service.id, 'confirmed')).toBe(1);
      expect(await requestCount(service.id)).toBe(0);
      expect(await bookingCount(service.id)).toBe(1);

      // Exactly one mirror, not two — a retry that mirrors twice is a second invite in the owner's
      // calendar for one appointment.
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
    });

    it('stays at one when the same idempotency key is submitted twice', async () => {
      // Retries are ordinary: a timeout, a model looping, a customer double-tapping. The idempotency
      // key exists so that a retry does not become a second appointment, and a count of calls
      // cannot see the difference.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      const day = planLocalTime(37, '10:00');
      const idempotencyKey = `idem-retry-${randomUUID()}`;
      const provider = new InternalProvider();
      const args = [
        planBookingContext(tenant, bot, session),
        idempotencyKey,
        localInstant(day).toISOString(),
        { name: 'QA Retry', email: 'qa-retry@example.test' },
        undefined,
        service.id,
      ] as const;

      await provider.createBooking(...args);
      await provider.createBooking(...args);

      expect(await bookingCount(service.id, 'confirmed')).toBe(1);
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
    });
  });

  describe('[BK-02] a price-only question writes nothing', () => {
    it('a price question leaves the diary and the calendar untouched', async () => {
      // Only the deterministic half of BK-02 belongs here, and it is worth being precise about
      // which half that is. Whether the MODEL answers a price question without booking is a
      // judgement call, measured in the live eval suite ("eval:booking-plan"). What CAN be proven
      // deterministically — and is what this test does — is that the information-gathering step a
      // price question legitimately triggers is incapable of writing: `check_availability` is
      // side-effect-free. Together the two layers cover the case; neither alone does.
      const { bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot, {
        priceDisplayType: 'fixed',
        fixedPrice: 75,
        priceNote: 'incl. VAT',
      });
      const session = await planSession(bot);

      const day = planLocalTime(38, '10:00');
      const tool = new CheckAvailabilityTool();
      const result = await tool.execute(
        { startDate: day.slice(0, 10), endDate: day.slice(0, 10), serviceId: service.id },
        planToolContext({ bot, sessionId: session.id, runId: randomUUID() }),
      );

      // The check answered…
      expect(result.success).toBe(true);
      // …and cost the diary nothing.
      expect(await bookingCount(service.id)).toBe(0);
      expect(await requestCount(service.id)).toBe(0);
      expect(await bookingsForService(service.id)).toEqual([]);
      expect(PLAN_CALENDAR.creates).toHaveLength(0);
      expect(PLAN_CALENDAR.updates).toHaveLength(0);
      expect(PLAN_CALENDAR.deletes).toHaveLength(0);
    });
  });
});
