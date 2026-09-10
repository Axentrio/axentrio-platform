/**
 * [AVL-01] The opening-hours gate on the REQUEST path.
 *
 * `docs/booking-rules.md:26-28` lists what is "not a Request on an Auto-book Service" and puts
 * the out-of-hours hour FIRST. The write path implemented every neighbour on that list -
 * `past`, `too_soon`, `too_far`, a date closed all day, this Service's daily cap - and not that
 * one. `internal.provider.ts` asked only whether the named DATE had any hours at all, so 03:00
 * on a Tuesday that opens 09:00-17:00 satisfied it and became a `request_created` row. The owner
 * woke to a request for an hour they never sold.
 *
 * The offer side was never wrong: `windowsForDay` cannot yield a start outside a window, so
 * `check_availability` simply returns the day's real times. That is why this file asserts the
 * refusal AND then drives the real offer path to show what comes back instead - the second half
 * of the rule ("offer the times that come back") is a claim about times that exist, not about a
 * string. `isWithinBusinessHours` is the reused check; it shares `windowsForDay` with the engine,
 * so the hour this path refuses and the hour the offer path declines to produce cannot diverge.
 *
 * THE THREE CASES ARE KEPT APART BECAUSE THE DOCUMENT KEEPS THEM APART, and the difference is
 * customer-visible:
 *
 *  1. out-of-hours on a date that HAS hours -> refuse the hour, offer that SAME date's times;
 *  2. a date closed all day -> offer ANOTHER DATE, never another hour that day;
 *  3. minimum notice -> refuse and offer what is actually reachable.
 *
 * So each case asserts the retry range it was given, and that it was NOT given the other case's
 * range. A gate that refused all three with one message would pass on case 1 and fail here.
 *
 * TWO CONTROLS, because a gate that refuses everything also produces three green refusals:
 *
 *  * the same Service, same date, same everything, at 10:00 -> still captured, exactly as before;
 *  * the same Service at the same 03:00, on a date whose OVERRIDE opens 00:00-24:00 -> captured.
 *    That one is the sharper control: only the Availability Rule row moved, so the refusal is
 *    proven to be decided by the business's hours rather than by the clock looking unusual.
 *
 * `REQUEST_BEFORE_CHECK` is the trap in this file. It refuses any unchecked date and would make
 * every refusal below pass with the hours gate deleted, so each case records a REAL check for
 * its date through `rememberAvailabilityChecked` first. The control tests prove that worked: they
 * capture, which is only reachable past that gate.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DateTime } from 'luxon';

// The calendar port double. Auto-confirm needs a healthy connection or the write path downgrades
// EVERY auto-book Service to a Request for `CALENDAR_NOT_CONNECTED` - which is the documented
// capture reason, so without this the gate under test never runs and the refusals would vanish.
//
// `await import` rather than a static import: a `vi.mock` factory is hoisted above every import
// in this file, so the harness does not exist yet at the point this body runs.
vi.mock('../../scheduler/calendar-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/calendar-provider')>()),
  ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
}));
vi.mock('../../automations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automations')>()),
  getEmailService: () => ({ send: vi.fn().mockResolvedValue({ success: true, messageId: 'qa' }) }),
  initializeAutomations: vi.fn(),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
  routeTypingIndicator: vi.fn().mockResolvedValue(undefined),
  sendChannelTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

// The checked-dates store is Redis-backed. An in-memory map keeps the STORE code real - the date
// is written and read back through `rememberAvailabilityChecked` / `availabilityCheckedFor` - so
// no test here has to stub the predicate the gate order depends on.
const redisData = new Map<string, string>();
vi.mock('../../config/redis', () => ({
  getRedisClient: () => ({
    get: async (key: string) => redisData.get(key) ?? null,
    set: async (key: string, value: string) => {
      redisData.set(key, value);
      return 'OK';
    },
    del: async (...keys: string[]) => {
      let n = 0;
      for (const key of keys.flat()) if (redisData.delete(key)) n += 1;
      return n;
    },
  }),
  initializeRedis: async () => undefined,
  isRedisAvailable: () => true,
}));

import { InternalProvider } from '../../booking/booking-providers/internal.provider';
import { rememberAvailabilityChecked } from '../../booking/booking-providers/availability-checked';
import {
  createPlanBusiness,
  createPlanService,
  setPlanAvailability,
  seedConfirmedBooking,
  PLAN_CALENDAR,
  PLAN_TZ,
  PLAN_CUSTOMER_EMAIL,
  planSession,
  planBookingContext,
  planDate,
  localInstant,
  localHHMM,
  localSpan,
  bookingCount,
  requestCount,
  bookingsForService,
} from '../helpers/booking-plan-harness';

const CUSTOMER = { name: 'QA Hours', email: PLAN_CUSTOMER_EMAIL };

/** `yyyy-MM-dd` a whole number of days after a business-local date. */
const dayAfter = (date: string, days: number): string =>
  DateTime.fromISO(date, { zone: PLAN_TZ }).plus({ days }).toFormat('yyyy-MM-dd');

/** The local `HH:mm` each offered slot starts at — what the customer would actually be shown. */
const offeredAt = (slots: Array<{ start: string }>): string[] => slots.map((s) => localHHMM(s.start));

/**
 * The whole fixture, one call: a Brussels business open Mon–Fri 09:00–17:00 on a 30-minute grid,
 * one Auto-book Service, a live session, and `date` already checked in that conversation.
 *
 * Built per test rather than once, because `__tests__/setup.ts` truncates every table in an
 * `afterEach` — a `beforeAll` fixture is gone by the second case.
 */
async function planHoursFixture(input: {
  date: string;
  rule?: Parameters<typeof setPlanAvailability>[1];
  service?: Parameters<typeof createPlanService>[1];
}) {
  const { tenant, bot } = await createPlanBusiness();
  await setPlanAvailability(bot, input.rule ?? {});
  const service = await createPlanService(bot, input.service ?? {});
  const session = await planSession(bot);
  // The date really is checked, through the production store. Without this every refusal below
  // would be `REQUEST_BEFORE_CHECK` and would survive the hours gate being deleted.
  await rememberAvailabilityChecked(session.id, input.date, input.date);
  return { tenant, bot, service, session, ctx: planBookingContext(tenant, bot, session) };
}

describe('booking plan · the opening-hours gate on the request path', () => {
  beforeEach(() => {
    // Both are module state and outlive the `afterEach` TRUNCATE, so one case's recorded calendar
    // writes or checked dates would otherwise decide the next case.
    PLAN_CALENDAR.reset();
    redisData.clear();
  });

  describe('[AVL-01] case 1 — an hour outside opening hours, on a date that has hours', () => {
    it('refuses 03:00 on a 09:00-17:00 weekday, writes nothing, and sends the model back to that same date', async () => {
      const date = planDate(35);
      const { service, session, ctx } = await planHoursFixture({ date });

      const provider = new InternalProvider();
      const capture = provider.requestAppointment(
        ctx,
        `idem-avl01-hours-${randomUUID()}`,
        localInstant(`${date}T03:00`).toISOString(),
        CUSTOMER,
      );

      await expect(capture).rejects.toMatchObject({ code: 'REQUEST_OUTSIDE_WINDOW' });
      // The rule's own words: refuse the HOUR, keep the DATE. So the retry range is that one
      // date at both ends, and the message must not push the customer off it.
      await expect(capture).rejects.toThrow(new RegExp(`startDate ${date} and endDate ${date}`));
      await expect(capture).rejects.toThrow(/do NOT capture it/i);
      await expect(capture).rejects.toThrow(/opening hours/i);
      // The clause that separates case 1 from case 2. `requestClosedDay` would have offered
      // ${date}+1 … ${date}+7 and told the customer the business was shut all day; that is the
      // wrong answer on a date the business sells, and this is where the two would blur.
      await expect(capture).rejects.toThrow(/do NOT move the customer to another date/i);
      await expect(capture).rejects.not.toThrow(new RegExp(dayAfter(date, 1)));

      // No row of ANY status, not merely no confirmed one: the defect wrote a `request_created`.
      expect(await bookingCount(service.id)).toBe(0);
      expect(await requestCount(service.id)).toBe(0);
      expect(PLAN_CALENDAR.creates).toHaveLength(0);

      // "Offer the times that come back" — driven, not asserted from prose. The same date the
      // refusal names really does return that day's own times through the real offer path, so the
      // customer is sent somewhere that has answers.
      const offer = await provider.checkAvailability(ctx, date, date, service.id);
      expect(offeredAt(offer.slots).length).toBeGreaterThan(0);
      expect(offeredAt(offer.slots)[0]).toBe('09:00');
      expect(offeredAt(offer.slots)).not.toContain('03:00');
      // Every offered start sits on the refused DATE, which is the half of the rule a
      // closed-day-style answer would break.
      for (const slot of offer.slots) {
        expect(DateTime.fromISO(slot.start, { zone: PLAN_TZ }).toFormat('yyyy-MM-dd')).toBe(date);
      }
      expect(session.id).toBeTruthy();
    });

    it('still refuses 17:00, the closing instant, because the window end is exclusive', async () => {
      // The boundary the offer path already treats as shut (`slot-engine.test.ts:212`). Stated
      // here so the request path and the offer path agree on the same instant rather than on the
      // same idea: a gate written with `<=` would capture a request for a time no check offers.
      const date = planDate(36);
      const { service, ctx } = await planHoursFixture({ date });

      await expect(
        new InternalProvider().requestAppointment(
          ctx,
          `idem-avl01-close-${randomUUID()}`,
          localInstant(`${date}T17:00`).toISOString(),
          CUSTOMER,
        ),
      ).rejects.toMatchObject({ code: 'REQUEST_OUTSIDE_WINDOW' });
      expect(await bookingCount(service.id)).toBe(0);
    });

    it('sends the customer to another date when the named date has no time left the business can take', async () => {
      // The notice ends at 16:45 on a 09:00-17:00 date, so its last 30-minute start (16:30) is
      // already out of reach, while 20:00 clears the notice and is refused for its hour alone.
      // Keeping the customer on that date would contradict the whole-day check for it.
      const date = planDate(3);
      const noticeEnds = localInstant(`${date}T16:45`);
      const { service, ctx } = await planHoursFixture({
        date,
        service: { minNoticeMin: Math.ceil((noticeEnds.getTime() - Date.now()) / 60_000) },
      });

      const provider = new InternalProvider();
      const capture = provider.requestAppointment(
        ctx,
        `idem-avl01-noneleft-${randomUUID()}`,
        localInstant(`${date}T20:00`).toISOString(),
        CUSTOMER,
      );

      await expect(capture).rejects.toMatchObject({ code: 'REQUEST_OUTSIDE_WINDOW' });
      await expect(capture).rejects.toThrow(/opening hours/i);
      await expect(capture).rejects.toThrow(new RegExp(`startDate ${date} and endDate ${dayAfter(date, 6)}`));
      await expect(capture).rejects.toThrow(/do NOT offer another time on that same date/i);
      await expect(capture).rejects.not.toThrow(/do NOT move the customer to another date/i);
      expect(await bookingCount(service.id)).toBe(0);

      const sameDate = await provider.checkAvailability(ctx, date, date, service.id);
      expect(sameDate.slots).toHaveLength(0);
      expect(sameDate.emptyRange?.reason).toBe('too_soon');
      const elsewhere = await provider.checkAvailability(ctx, date, dayAfter(date, 6), service.id);
      expect(elsewhere.slots.length).toBeGreaterThan(0);
      for (const slot of elsewhere.slots) {
        expect(DateTime.fromISO(slot.start, { zone: PLAN_TZ }).toFormat('yyyy-MM-dd')).not.toBe(date);
      }
    });
  });

  describe('[AVL-01] case 2 — a date closed all day', () => {
    it('refuses it and offers ANOTHER DATE, never another hour on that date', async () => {
      // Closed by a one-off override rather than by landing on a weekend, so the case does not
      // depend on which weekday the suite runs.
      const date = planDate(40);
      const { service, ctx } = await planHoursFixture({
        date,
        rule: { dateOverrides: [{ date, closed: true }] },
      });

      const provider = new InternalProvider();
      const capture = provider.requestAppointment(
        ctx,
        `idem-avl01-closed-${randomUUID()}`,
        // 10:00: an hour the business normally opens. The date is the only thing wrong, so a gate
        // that answered "outside opening hours" here would be caught by the assertions below.
        localInstant(`${date}T10:00`).toISOString(),
        CUSTOMER,
      );

      await expect(capture).rejects.toMatchObject({ code: 'REQUEST_OUTSIDE_WINDOW' });
      await expect(capture).rejects.toThrow(/closed that whole date/i);
      // ANOTHER DATE: the week that starts the day after the refused one.
      await expect(capture).rejects.toThrow(
        new RegExp(`startDate ${dayAfter(date, 1)} and endDate ${dayAfter(date, 7)}`),
      );
      await expect(capture).rejects.toThrow(/Do not retry the same date/i);
      // The refused date is nowhere in the retry instruction. This is the assertion that would
      // fail if case 1's message were reused here — it names that date at both ends.
      await expect(capture).rejects.not.toThrow(new RegExp(date));

      expect(await bookingCount(service.id)).toBe(0);
      expect(await requestCount(service.id)).toBe(0);

      // Both halves through the real offer path: the refused date genuinely has nothing, and the
      // range the customer was sent to genuinely has times.
      const shut = await provider.checkAvailability(ctx, date, date, service.id);
      expect(shut.slots).toHaveLength(0);
      const elsewhere = await provider.checkAvailability(ctx, dayAfter(date, 1), dayAfter(date, 7), service.id);
      expect(elsewhere.slots.length).toBeGreaterThan(0);
      for (const slot of elsewhere.slots) {
        expect(DateTime.fromISO(slot.start, { zone: PLAN_TZ }).toFormat('yyyy-MM-dd')).not.toBe(date);
      }
    });

    it('treats a window that closes before it opens as no hours, and refuses that date as closed', async () => {
      // 18:00-02:00 can be saved but the engine never offers from it, so the date has no usable
      // hours. The hours gate must not claim it is open; the closed-day answer offers another date.
      const date = planDate(41);
      const { service, ctx } = await planHoursFixture({
        date,
        rule: { dateOverrides: [{ date, windows: [{ start: '18:00', end: '02:00' }] }] },
      });

      const provider = new InternalProvider();
      const capture = provider.requestAppointment(
        ctx,
        `idem-avl01-inverted-${randomUUID()}`,
        localInstant(`${date}T20:00`).toISOString(),
        CUSTOMER,
      );

      await expect(capture).rejects.toMatchObject({ code: 'REQUEST_OUTSIDE_WINDOW' });
      await expect(capture).rejects.toThrow(/closed that whole date/i);
      await expect(capture).rejects.toThrow(
        new RegExp(`startDate ${dayAfter(date, 1)} and endDate ${dayAfter(date, 7)}`),
      );
      await expect(capture).rejects.not.toThrow(new RegExp(date));
      expect(await bookingCount(service.id)).toBe(0);

      // The offer path agrees: the same date is closed there too, so its guidance cannot send the
      // model back to capture a Request this gate refuses.
      const shut = await provider.checkAvailability(ctx, date, date, service.id);
      expect(shut.slots).toHaveLength(0);
      expect(shut.emptyRange?.reason).toBe('closed');
    });
  });

  describe('[AVL-01] case 3 — inside the minimum notice', () => {
    it('refuses it and offers a range that is actually reachable', async () => {
      // Twenty days of notice against a date three days out: in hours, on an open weekday, and
      // refused by the notice alone. The hour is deliberately bookable so this case cannot pass
      // for case 1's reason.
      const date = planDate(3);
      const { service, ctx } = await planHoursFixture({
        date,
        service: { minNoticeMin: 20 * 24 * 60 },
      });
      const earliest = DateTime.now().setZone(PLAN_TZ).plus({ days: 20 });
      const noticeDate = earliest.toFormat('yyyy-MM-dd');

      const provider = new InternalProvider();
      const capture = provider.requestAppointment(
        ctx,
        `idem-avl01-notice-${randomUUID()}`,
        localInstant(`${date}T10:00`).toISOString(),
        CUSTOMER,
      );

      await expect(capture).rejects.toMatchObject({ code: 'REQUEST_OUTSIDE_WINDOW' });
      await expect(capture).rejects.toThrow(/sooner than the notice/i);
      await expect(capture).rejects.toThrow(
        new RegExp(`startDate ${noticeDate} and endDate ${dayAfter(noticeDate, 6)}`),
      );
      // Never the refused date, and never the opening clock: the notice bound is a policy instant
      // that knows nothing about hours, which is what `slot-messages.ts` documents at length.
      await expect(capture).rejects.not.toThrow(new RegExp(date));

      expect(await bookingCount(service.id)).toBe(0);
      expect(await requestCount(service.id)).toBe(0);

      // REACHABLE, not merely named. The refused date returns nothing under this notice, and the
      // range the customer was sent to returns times — and every one of them clears the notice.
      const tooSoon = await provider.checkAvailability(ctx, date, date, service.id);
      expect(tooSoon.slots).toHaveLength(0);
      const reachable = await provider.checkAvailability(ctx, noticeDate, dayAfter(noticeDate, 6), service.id);
      expect(reachable.slots.length).toBeGreaterThan(0);
      for (const slot of reachable.slots) {
        expect(new Date(slot.start).getTime()).toBeGreaterThanOrEqual(earliest.toMillis());
      }
    });
  });

  describe('[AVL-01] where the new gate sits — the daily cap still speaks first', () => {
    it('answers a capped date with ANOTHER DATE, even when the named hour is also out of hours', async () => {
      // Both refusals apply, and only one of them is right. `service_day_full` sends the customer
      // to another date; the out-of-hours refusal deliberately keeps them on this one. On a date
      // whose cap is already spent, keeping them on it offers hours that cannot be sold - so the
      // date-wide no has to be reached first, and the hours gate is placed after it on purpose.
      const date = planDate(37);
      const { bot, service, ctx } = await planHoursFixture({ date, service: { maxBookingsPerDay: 1 } });
      await seedConfirmedBooking({ bot, serviceId: service.id, startLocal: `${date}T10:00`, durationMin: 30 });

      const capture = new InternalProvider().requestAppointment(
        ctx,
        `idem-avl01-capped-${randomUUID()}`,
        localInstant(`${date}T03:00`).toISOString(),
        CUSTOMER,
      );

      // `CAPACITY_REACHED`, not `REQUEST_OUTSIDE_WINDOW`: the code itself records which gate
      // answered, so this line alone would fail if the hours check ran first.
      await expect(capture).rejects.toMatchObject({ code: 'CAPACITY_REACHED' });
      await expect(capture).rejects.toThrow(/maximum number of bookings for that date/i);
      await expect(capture).rejects.toThrow(/Do not retry the same date/i);
      // The clause that fails if the hours gate is moved above the cap: it would answer with
      // this same date at both ends and invite an hour the cap has already sold out.
      await expect(capture).rejects.not.toThrow(/opening hours/i);
      await expect(capture).rejects.toThrow(
        new RegExp(`startDate ${dayAfter(date, 1)} and endDate ${dayAfter(date, 7)}`),
      );

      expect(await requestCount(service.id)).toBe(0);
    });
  });

  describe('[AVL-01] the reschedule door — a change Request is held to the same hours', () => {
    it('refuses a move to 03:00 before any change Request is written, and still captures one in hours', async () => {
      const date = planDate(38);
      const { tenant, bot, service, session } = await planHoursFixture({ date, service: { rescheduleMode: 'request' } });
      const original = await seedConfirmedBooking({
        bot,
        serviceId: service.id,
        sessionId: session.id,
        startLocal: `${date}T10:00`,
      });
      const customerCtx = planBookingContext(tenant, bot, session, { subjectToCustomerChangePolicy: true });
      const provider = new InternalProvider();

      const move = provider.rescheduleBooking(customerCtx, original.id, localInstant(`${date}T03:00`).toISOString());

      await expect(move).rejects.toMatchObject({ code: 'REQUEST_OUTSIDE_WINDOW' });
      await expect(move).rejects.toThrow(/opening hours/i);
      await expect(move).rejects.toThrow(/existing appointment has NOT been changed/i);
      await expect(move).rejects.toThrow(new RegExp(`startDate ${date} and endDate ${date}`));
      expect(await requestCount(service.id)).toBe(0);
      const [kept] = await bookingsForService(service.id);
      expect(kept.status).toBe('confirmed');
      expect(localSpan(kept)).toMatchObject({ date, start: '10:00' });

      // The policy decision is untouched: an in-hours move on the same Service still goes to the
      // owner as a change Request.
      const moved = await provider.rescheduleBooking(customerCtx, original.id, localInstant(`${date}T14:00`).toISOString());
      expect(moved.requested).toBe(true);
      const request = (await bookingsForService(service.id)).find((r) => r.status === 'request_created');
      expect(request?.requestKind).toBe('reschedule');
      expect(localSpan(request!)).toMatchObject({ date, start: '14:00' });
    });
  });

  describe('[AVL-01] the controls — what must keep capturing', () => {
    it('captures an in-hours request on the same Auto-book Service, exactly as before', async () => {
      // Without this, a gate that refused every request would satisfy all three cases above.
      // Same business, same Service, same date, same connected calendar; only the hour moves.
      const date = planDate(35);
      const { service, ctx } = await planHoursFixture({ date });

      const result = await new InternalProvider().requestAppointment(
        ctx,
        `idem-avl01-control-${randomUUID()}`,
        localInstant(`${date}T10:00`).toISOString(),
        CUSTOMER,
      );

      expect(result.success).toBe(true);
      expect(result.requested).toBe(true);
      const rows = await bookingsForService(service.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('request_created');
      expect(localSpan(rows[0])).toMatchObject({ date, start: '10:00', end: '10:30' });
    });

    it('captures the very same 03:00 once the Availability Rule opens that date around the clock', async () => {
      // The sharper control: the clock, the Service and the conversation are identical to case 1
      // and only the RULE ROW changes. So the refusal there is proven to be decided by the
      // business's own hours — reading the override, as `windowsForDay` does — and not by 03:00
      // looking like an odd time to ask for.
      const date = planDate(35);
      const { service, ctx } = await planHoursFixture({
        date,
        rule: { dateOverrides: [{ date, windows: [{ start: '00:00', end: '24:00' }] }] },
      });

      const result = await new InternalProvider().requestAppointment(
        ctx,
        `idem-avl01-nighthours-${randomUUID()}`,
        localInstant(`${date}T03:00`).toISOString(),
        CUSTOMER,
      );

      expect(result.requested).toBe(true);
      expect(await requestCount(service.id)).toBe(1);
      const [row] = await bookingsForService(service.id);
      expect(localSpan(row)).toMatchObject({ date, start: '03:00' });
    });

    it('still captures a business that never opens, which is the documented ordinary-empty Request', async () => {
      // The other thing this gate must not swallow. `booking-rules.md:20` keeps "a business that
      // never opens" as a legitimate Request, and the closed-day gate already stands down for it
      // because no date has hours. A gate written as "not in hours" without the has-hours guard
      // would refuse this and delete a documented capture path.
      const date = planDate(35);
      const { service, ctx } = await planHoursFixture({ date, rule: { weeklyHours: {} } });

      const result = await new InternalProvider().requestAppointment(
        ctx,
        `idem-avl01-neveropen-${randomUUID()}`,
        localInstant(`${date}T10:00`).toISOString(),
        CUSTOMER,
      );

      expect(result.requested).toBe(true);
      expect(await requestCount(service.id)).toBe(1);
    });
  });
});
