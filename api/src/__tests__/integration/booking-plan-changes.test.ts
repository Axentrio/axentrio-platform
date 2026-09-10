/**
 * The customer change-policy persistence path (`MOD-01` … `MOD-08`), asserted on PERSISTED STATE.
 *
 * Every pin that existed for this block was one layer short of the guarantee, and the shortfall was
 * always the same shape: the `requested: true` flag stood in for the request ROW, "the writer was
 * not called" stood in for "the original is untouched", and the no-handoff rule was pinned as
 * GUIDANCE COPY only. So this file deliberately never trusts a returned flag:
 *
 *  1. a request path is proven by the `request_created` ROW, its `requestKind` and its
 *     `relatedBookingId`;
 *  2. "the original is untouched" is proven by RE-READING the original row and comparing
 *     `startUtc`, `status` and `sequence` - not by a `not.toHaveBeenCalled()`;
 *  3. the mirror is proven against the calendar PORT (`PLAN_CALENDAR.updates` / `.deletes`), which
 *     is the same port `calendar-sync.ts` writes through;
 *  4. "no human handoff" is proven by COUNTING `handoff_requests` rows for the session and by a spy
 *     on the real `EscalationTool`. `docs/booking-rules.md:190` forbids offering a human on a
 *     policy refusal, and until now no row-level test existed for that clause anywhere;
 *  5. a cutoff refusal is proven by its MACHINE-READABLE details (`reason: 'cutoff'`, `untilMin`)
 *     plus the cutoff duration rendered through the product's own `spokenChangeCutoff`, so the
 *     expected text is derived rather than hand-typed.
 *
 * THE ORIGINAL IS CREATED THROUGH `createBooking`, NOT `seedConfirmedBooking`. The work order
 * suggests the seed helper, but the seed writes no `BookingReference`, and without that ref
 * `syncCalendarMirror` and `syncCalendarCancel` both return early (`calendar-sync.ts:149`, `:240`).
 * A mirror assertion against a seeded row would therefore be unreachable, or worse, would pass
 * vacuously. Booking the original through the real write path gives a real ref, so `MOD-01`'s
 * `updateEvent` and `MOD-06`'s `deleteEvent` are genuine.
 *
 * What is NOT claimed here: what the MODEL says. These cases are about what the platform persists
 * and what it tells the caller in machine-readable terms. The assistant's actual sentence is a
 * model judgement and belongs in the live eval suite.
 *
 * `MOD-05` is deliberately absent: it is already covered
 * (`unit/internal-provider-reschedule-cancel.test.ts:738-749`, `:408-420`).
 *
 * One defect re-observed and NOT fixed here, matching the incidental item in the work order's §6:
 * `customerChangeNotAllowedError` sets the CUSTOMER-facing `customerMessage` to "Please contact the
 * business directly." (`customer-change-policy.ts:151`, `:164-165`) while the MODEL-facing
 * `message` in the same factory forbids sending the customer to the business. The cutoff tests
 * below therefore assert the model-facing clause and the machine-readable `details`, and pin no
 * part of the contradicted customer copy.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('../../scheduler/calendar-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/calendar-provider')>()),
  ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
}));
// `await import` here is required, not preferred: a `vi.mock` factory is HOISTED above this file's
// imports, so a static top-level binding would still be uninitialised when the factory runs. The
// harness documents this at `booking-plan-harness.ts:492-504`.
vi.mock('../../automations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automations')>()),
  getEmailService: () => ({ send: vi.fn().mockResolvedValue({ success: true, messageId: 'qa' }) }),
  initializeAutomations: vi.fn(),
}));

import { AppDataSource } from '../../database/data-source';
import { Booking } from '../../database/entities/Booking';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import { EscalationTool } from '../../agent/tools/escalation.tool';
import { InternalProvider } from '../../booking/booking-providers/internal.provider';
import type { CustomerChangeMode } from '../../database/entities/ServiceType';
import { spokenChangeCutoff } from '../../booking/customer-change-policy';
import type { BookingContext } from '../../booking/booking-providers/types';
import { formatBookingDisplayTime } from '../../booking/booking-providers/booking-dates';
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
  planLocalTime,
  localInstant,
  localHHMM,
  localDateOnly,
  bookingCount,
  requestCount,
  bookingsForService,
} from '../helpers/booking-plan-harness';

/** Handoff rows for this conversation - the clause `MOD-03` / `MOD-08` had no row-level test for. */
function handoffCount(sessionId: string): Promise<number> {
  return AppDataSource.getRepository(HandoffRequest).count({ where: { sessionId } });
}

function reread(bookingId: string): Promise<Booking> {
  return AppDataSource.getRepository(Booking).findOneOrFail({ where: { id: bookingId } });
}

interface ChangeFixture {
  provider: InternalProvider;
  /** The agent/customer caller: the only caller the change policy binds. */
  customerCtx: BookingContext;
  serviceId: string;
  sessionId: string;
  original: Booking;
  /** The mirror event the original was written to, so a delete can be matched by id. */
  mirrorEventId: string;
  startLocal: string;
}

/**
 * A confirmed booking with a live calendar mirror, on a Service carrying the policy under test.
 *
 * Seeded INSIDE each test (via each `it`'s own call), because `src/__tests__/setup.ts` TRUNCATEs in
 * an `afterEach`: a fixture built in `beforeAll` would leave the second test asserting deltas
 * against an empty database.
 */
async function confirmedOnPolicy(
  policy: Partial<{
    rescheduleMode: CustomerChangeMode;
    cancelMode: CustomerChangeMode;
    rescheduleUntilMin: number;
    cancelUntilMin: number;
  }>,
  opts: { daysAhead?: number; startHHMM?: string } = {},
): Promise<ChangeFixture> {
  const { tenant, bot } = await createPlanBusiness();
  await setPlanAvailability(bot);
  await seedPlanCalendarCredential(bot);
  const service = await createPlanService(bot, policy);
  const session = await planSession(bot);
  const provider = new InternalProvider();

  const startLocal = planLocalTime(opts.daysAhead ?? 30, opts.startHHMM ?? '10:00', {
    weekdayOnly: true,
  });

  // The owner path writes the original: `subjectToCustomerChangePolicy` is unset here, so a
  // Service that forbids CUSTOMER changes can still be booked in the first place.
  const created = await provider.createBooking(
    planBookingContext(tenant, bot, session),
    `idem-change-${randomUUID()}`,
    localInstant(startLocal).toISOString(),
    { name: 'QA Change', email: PLAN_CUSTOMER_EMAIL },
    undefined,
    service.id,
  );
  expect(created.success).toBe(true);
  expect(created.requested).toBeFalsy();
  // The mirror the change cases operate on. Without it every mirror assertion below would be
  // vacuous, so it is asserted here once rather than assumed in six places.
  expect(PLAN_CALENDAR.creates).toHaveLength(1);

  const rows = await bookingsForService(service.id);
  expect(rows).toHaveLength(1);

  return {
    provider,
    customerCtx: planBookingContext(tenant, bot, session, { subjectToCustomerChangePolicy: true }),
    serviceId: service.id,
    sessionId: session.id,
    original: rows[0],
    mirrorEventId: PLAN_CALENDAR.creates[0].result.eventId,
    startLocal,
  };
}

describe('booking plan · customer change policy', () => {
  let escalate: MockInstance;

  beforeEach(() => {
    PLAN_CALENDAR.reset();
    // The real tool class the registry serves, so any path that reached a handoff during a policy
    // refusal would trip this. Paired with the row count below: the spy catches an escalation via
    // the tool, the count catches one written straight through the handoff service.
    escalate = vi.spyOn(EscalationTool.prototype, 'execute');
  });

  afterEach(() => {
    escalate.mockRestore();
  });

  describe('[MOD-01] an auto reschedule moves the appointment and its mirror', () => {
    it('lands the new start on the row and on the calendar event, with no second row', async () => {
      const f = await confirmedOnPolicy({ rescheduleMode: 'auto' }, { startHHMM: '10:00' });
      const newLocal = `${f.startLocal.slice(0, 10)}T14:00`;

      const result = await f.provider.rescheduleBooking(
        f.customerCtx,
        f.original.id,
        localInstant(newLocal).toISOString(),
      );
      expect(result.success).toBe(true);
      expect(result.requested).toBeFalsy();

      // The ROW moved. Read back, not taken from the result: the result is assembled from the
      // requested time, so it reads correctly even when the UPDATE never landed.
      const moved = await reread(f.original.id);
      expect(moved.status).toBe('confirmed');
      expect(localHHMM(moved.startUtc)).toBe('14:00');
      expect(localHHMM(moved.endUtc)).toBe('14:30');
      expect(moved.sequence).toBe(f.original.sequence + 1);

      // The MIRROR moved, and to the NEW time. The pre-existing pin used
      // `objectContaining({location})` (`unit/internal-provider-reschedule-cancel.test.ts:606-637`),
      // which passes against an unchanged start. Comparing the local clock is what makes this
      // discriminating: 14:00 local is 12:00Z in September, so a mirror written from the UTC
      // instant as though it were local would read 12:00 here.
      //
      // PROVEN, not asserted: passing `booking.startUtc` / `booking.endUtc` instead of the new
      // `start` / `end` to `syncCalendarMirror` (`internal.provider.ts:4617-4618`) fails this test
      // with "expected '10:00' to be '14:00'". The old `objectContaining({location})` pin passes
      // against that same break, which is why it was one layer short.
      expect(PLAN_CALENDAR.updates).toHaveLength(1);
      const patch = PLAN_CALENDAR.updates[0];
      expect(patch.eventId).toBe(f.mirrorEventId);
      expect(localHHMM(new Date(String(patch.patch.startISO)))).toBe('14:00');
      expect(localHHMM(new Date(String(patch.patch.endISO)))).toBe('14:30');

      // NO DUPLICATE. A move that inserts instead of updating leaves two rows and two invites, and
      // both counts below are needed to see it: the row count catches the second booking, the
      // create count catches the second invite.
      expect(await bookingCount(f.serviceId)).toBe(1);
      expect(await requestCount(f.serviceId)).toBe(0);
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
      expect(PLAN_CALENDAR.deletes).toHaveLength(0);
    });
  });

  describe('[MOD-02] a request-policy reschedule captures a Request and moves nothing', () => {
    it('writes a reschedule Request row and leaves the original row exactly as it was', async () => {
      const f = await confirmedOnPolicy({ rescheduleMode: 'request' }, { startHHMM: '10:00' });
      const newLocal = `${f.startLocal.slice(0, 10)}T15:00`;

      const result = await f.provider.rescheduleBooking(
        f.customerCtx,
        f.original.id,
        localInstant(newLocal).toISOString(),
      );
      expect(result.requested).toBe(true);

      // 1 - THE ROW, not the flag. `requested: true` is already pinned
      // (`unit/internal-provider-reschedule-cancel.test.ts:1472-1479`) and is exactly the gap: the
      // INSERT was mocked there, so no real request row had ever been inspected.
      const request = await AppDataSource.getRepository(Booking).findOne({
        where: { relatedBookingId: f.original.id, status: 'request_created' },
      });
      expect(request).not.toBeNull();
      expect(request!.requestKind).toBe('reschedule');
      expect(request!.relatedBookingId).toBe(f.original.id);
      expect(request!.status).toBe('request_created');
      // The Request carries the time that was ASKED FOR, which is what the owner approves.
      expect(localHHMM(request!.startUtc)).toBe('15:00');
      expect(localDateOnly(request!.startUtc)).toBe(f.startLocal.slice(0, 10));
      expect(await requestCount(f.serviceId)).toBe(1);

      // 2 - THE ORIGINAL IS UNTOUCHED, BY SQL. No no-UPDATE check existed on the request path at
      // all; the `it()` title at `:1472` claims "leaves the original confirmed" while its body only
      // asserts an INSERT happened. Re-reading the row is the only assertion that can tell a
      // preserved appointment from a silently moved one.
      //
      // PROVEN: adding an `UPDATE chatbot_bookings SET start_utc=…, sequence=sequence+1` to the
      // request branch of `rescheduleAsChangeRequest` still returns `requested: true`, so the
      // pre-existing flag assertion stays green, while these three re-read assertions fail
      // ("expected 1791810000000 to be 1791792000000").
      const untouched = await reread(f.original.id);
      expect(untouched.status).toBe('confirmed');
      expect(untouched.startUtc.getTime()).toBe(f.original.startUtc.getTime());
      expect(untouched.endUtc.getTime()).toBe(f.original.endUtc.getTime());
      expect(untouched.sequence).toBe(f.original.sequence);

      // 3 - THE MIRROR IS UNTOUCHED. A request that also patches the invite has already moved the
      // appointment in the only place the customer looks.
      expect(PLAN_CALENDAR.updates).toHaveLength(0);
      expect(PLAN_CALENDAR.deletes).toHaveLength(0);
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
    });
  });

  describe('[MOD-03] a not_allowed reschedule refuses, writes nothing and offers no human', () => {
    it('keeps the original row, captures no Request and creates no handoff', async () => {
      const f = await confirmedOnPolicy({ rescheduleMode: 'not_allowed' }, { startHHMM: '10:00' });
      const newLocal = `${f.startLocal.slice(0, 10)}T15:00`;

      await expect(
        f.provider.rescheduleBooking(f.customerCtx, f.original.id, localInstant(newLocal).toISOString()),
      ).rejects.toMatchObject({
        code: 'CHANGE_NOT_ALLOWED',
        // Machine-readable, so the refusal's REASON is pinned without pinning its phrasing. An
        // outright ban carries no cutoff; the cutoff case below carries one.
        details: { action: 'reschedule' },
      });

      const untouched = await reread(f.original.id);
      expect(untouched.status).toBe('confirmed');
      expect(untouched.startUtc.getTime()).toBe(f.original.startUtc.getTime());
      expect(untouched.sequence).toBe(f.original.sequence);

      expect(await requestCount(f.serviceId)).toBe(0);
      expect(await bookingCount(f.serviceId)).toBe(1);
      expect(PLAN_CALENDAR.updates).toHaveLength(0);
      expect(PLAN_CALENDAR.deletes).toHaveLength(0);

      // NO HANDOFF ROW. `docs/booking-rules.md:190` is explicit that a policy refusal must not
      // offer a human. Every existing pin for that clause asserts the GUIDANCE STRING
      // (`unit/customer-change-policy.test.ts:129-131`, `unit/builtin-tools.test.ts:1739`), which
      // proves the model was told, never that nothing was summoned. These two assertions are the
      // state half: no row in `handoff_requests`, and the real escalation tool never ran.
      expect(await handoffCount(f.sessionId)).toBe(0);
      expect(escalate).not.toHaveBeenCalled();
    });

    it('names the cutoff when a cutoff demoted an otherwise-auto reschedule', async () => {
      // `auto` plus a 10-day cutoff on an appointment 3 days out: the cutoff has already passed, so
      // `resolveCustomerChange` demotes it to `not_allowed` (`customer-change-policy.ts:53-59`).
      // This is the fifth assertion family - the refusal must NAME the duration instead of sounding
      // like the action is banned outright.
      const untilMin = 10 * 24 * 60;
      const f = await confirmedOnPolicy(
        { rescheduleMode: 'auto', rescheduleUntilMin: untilMin },
        { daysAhead: 3, startHHMM: '10:00' },
      );
      const newLocal = `${f.startLocal.slice(0, 10)}T15:00`;

      const spoken = spokenChangeCutoff(untilMin);
      expect(spoken).toBe('10 days before the appointment');

      await expect(
        f.provider.rescheduleBooking(f.customerCtx, f.original.id, localInstant(newLocal).toISOString()),
      ).rejects.toMatchObject({
        code: 'CHANGE_NOT_ALLOWED',
        details: { action: 'reschedule', reason: 'cutoff', untilMin },
        // Derived from the product's own renderer, so this is an agreement assertion rather than a
        // copy assertion: the refusal can only contain it if it rendered the same cutoff.
        message: expect.stringContaining(spoken!),
      });

      // …and it does not send the customer to the business. Asserted on the MODEL-FACING message,
      // which is the instruction the assistant acts on.
      await expect(
        f.provider.rescheduleBooking(f.customerCtx, f.original.id, localInstant(newLocal).toISOString()),
      ).rejects.toMatchObject({
        message: expect.stringContaining('Do not tell them to contact the business'),
      });

      const untouched = await reread(f.original.id);
      expect(untouched.startUtc.getTime()).toBe(f.original.startUtc.getTime());
      expect(untouched.sequence).toBe(f.original.sequence);
      expect(await requestCount(f.serviceId)).toBe(0);
      expect(await handoffCount(f.sessionId)).toBe(0);
      expect(escalate).not.toHaveBeenCalled();
    });
  });

  describe('[MOD-04] a later "was my reschedule approved?" turn', () => {
    it('reports the change still pending and the appointment that still stands', async () => {
      const f = await confirmedOnPolicy({ rescheduleMode: 'request' }, { startHHMM: '10:00' });
      const newLocal = `${f.startLocal.slice(0, 10)}T15:00`;

      await f.provider.rescheduleBooking(
        f.customerCtx,
        f.original.id,
        localInstant(newLocal).toISOString(),
      );

      // The later turn. `listBookings` is the read the status question resolves through, and its
      // `pendingRequest` projection is the machine-readable answer - the existing coverage for this
      // case rode entirely on generic STATUS guidance copy.
      const listed = await f.provider.listBookings(f.customerCtx);
      expect(listed.bookings).toHaveLength(1);
      const [entry] = listed.bookings;

      expect(entry.id).toBe(f.original.id);
      expect(entry.pendingRequest?.kind).toBe('reschedule');
      // The appointment that STILL STANDS is the original, and the requested time is reported
      // separately. Both are derived through the product's own formatter from the two rows, so a
      // projection that leaked the requested time into `displayTime` - telling the customer the
      // move already happened - fails here.
      //
      // PROVEN by the same break used for `MOD-02`: silently moving the original while still
      // returning `requested: true` fails this line with "expected 'Monday, 12 October 2026 at
      // 15:00' to be 'Monday, 12 October 2026 at 10:00'".
      expect(entry.displayTime).toBe(formatBookingDisplayTime(f.original.startUtc, PLAN_TZ));
      expect(entry.pendingRequest?.requestedDisplayTime).toBe(
        formatBookingDisplayTime(localInstant(newLocal), PLAN_TZ),
      );
      expect(entry.displayTime).not.toBe(entry.pendingRequest?.requestedDisplayTime);

      // The state behind that answer, and no human summoned for a routine status question.
      const untouched = await reread(f.original.id);
      expect(untouched.status).toBe('confirmed');
      expect(untouched.startUtc.getTime()).toBe(f.original.startUtc.getTime());
      expect(await handoffCount(f.sessionId)).toBe(0);
      expect(escalate).not.toHaveBeenCalled();
    });
  });

  describe('[MOD-06] an auto cancel cancels the row and removes the mirror', () => {
    it('cancels the booking and deletes the calendar event', async () => {
      const f = await confirmedOnPolicy({ cancelMode: 'auto' }, { startHHMM: '11:00' });

      const result = await f.provider.cancelBooking(f.customerCtx, f.original.id, 'QA cancel');
      expect(result.success).toBe(true);
      expect(result.cancelled).toBe(true);

      const cancelled = await reread(f.original.id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.sequence).toBe(f.original.sequence + 1);

      // `syncCalendarCancel` had NEVER been asserted: `deleteEvent` was a bare `vi.fn()` in the
      // unit file (`:103`, `:801-806`), so an owner left with a ghost event in their calendar after
      // a cancellation was invisible to the suite. Matching the recorded event id is what makes
      // this specific - a delete of some other event would not satisfy it.
      //
      // PROVEN: removing the `syncCalendarCancel(ctx, bookingId)` call at
      // `internal.provider.ts:4755` fails this test with "expected [] to have a length of 1".
      expect(PLAN_CALENDAR.deletes).toHaveLength(1);
      expect(PLAN_CALENDAR.deletes[0].eventId).toBe(f.mirrorEventId);
      expect(PLAN_CALENDAR.live.has(f.mirrorEventId)).toBe(false);

      // A cancel is not a request, and it leaves no second row behind.
      expect(await requestCount(f.serviceId)).toBe(0);
      expect(await bookingCount(f.serviceId, 'confirmed')).toBe(0);
      expect(await bookingCount(f.serviceId)).toBe(1);
    });
  });

  describe('[MOD-07] a request-policy cancel captures a Request and keeps the appointment', () => {
    it('writes a cancel Request row while the original stays confirmed and mirrored', async () => {
      const f = await confirmedOnPolicy({ cancelMode: 'request' }, { startHHMM: '11:00' });

      const result = await f.provider.cancelBooking(f.customerCtx, f.original.id);
      expect(result.requested).toBe(true);
      expect(result.cancelled).toBe(false);

      // The row, with the cancel `requestKind` - the existing pin for this case is tool level with
      // a mocked provider (`unit/builtin-tools.test.ts:1833-1846`), so no real cancel request row
      // had ever existed in the suite.
      const request = await AppDataSource.getRepository(Booking).findOne({
        where: { relatedBookingId: f.original.id, status: 'request_created' },
      });
      expect(request).not.toBeNull();
      expect(request!.requestKind).toBe('cancel');
      expect(request!.relatedBookingId).toBe(f.original.id);
      // A cancel Request holds the appointment's own span, so the owner sees what is being dropped.
      expect(request!.startUtc.getTime()).toBe(f.original.startUtc.getTime());

      // The original is STILL ACTIVE. Read back, and its mirror still exists: a "request" that
      // already deleted the event has cancelled the appointment in practice.
      const untouched = await reread(f.original.id);
      expect(untouched.status).toBe('confirmed');
      expect(untouched.sequence).toBe(f.original.sequence);
      expect(await bookingCount(f.serviceId, 'confirmed')).toBe(1);
      expect(PLAN_CALENDAR.deletes).toHaveLength(0);
      expect(PLAN_CALENDAR.updates).toHaveLength(0);
      expect(PLAN_CALENDAR.live.has(f.mirrorEventId)).toBe(true);
    });
  });

  describe('[MOD-08] a not_allowed cancel refuses, writes nothing and offers no human', () => {
    it('leaves the booking active by SQL, captures no Request and creates no handoff', async () => {
      const f = await confirmedOnPolicy({ cancelMode: 'not_allowed' }, { startHHMM: '11:00' });

      await expect(f.provider.cancelBooking(f.customerCtx, f.original.id)).rejects.toMatchObject({
        code: 'CHANGE_NOT_ALLOWED',
        details: { action: 'cancel' },
      });

      // "No request / booking active" BY SQL. The existing pin asserts a mocked
      // `cancelBooking` was not called (`unit/builtin-tools.test.ts:1848-1864`), which cannot see a
      // row cancelled by any other path.
      const untouched = await reread(f.original.id);
      expect(untouched.status).toBe('confirmed');
      expect(untouched.sequence).toBe(f.original.sequence);
      expect(await bookingCount(f.serviceId, 'confirmed')).toBe(1);
      expect(await requestCount(f.serviceId)).toBe(0);
      expect(PLAN_CALENDAR.deletes).toHaveLength(0);
      expect(PLAN_CALENDAR.live.has(f.mirrorEventId)).toBe(true);

      // No human summoned for a policy refusal.
      expect(await handoffCount(f.sessionId)).toBe(0);
      expect(escalate).not.toHaveBeenCalled();
    });

    it('names the cutoff when a cutoff demoted an otherwise-auto cancel', async () => {
      // The cutoff must ALREADY have passed for the demotion to fire: `resolveCustomerChange`
      // compares `now` against `start - untilMin` (`customer-change-policy.ts:57`). A 6-day cutoff
      // on an appointment 3 days out is past; a 60-minute cutoff on the same fixture is not.
      const untilMin = 6 * 24 * 60;
      const f = await confirmedOnPolicy(
        { cancelMode: 'auto', cancelUntilMin: untilMin },
        { daysAhead: 3, startHHMM: '11:00' },
      );

      const spoken = spokenChangeCutoff(untilMin);
      expect(spoken).toBe('6 days before the appointment');

      await expect(f.provider.cancelBooking(f.customerCtx, f.original.id)).rejects.toMatchObject({
        code: 'CHANGE_NOT_ALLOWED',
        details: { action: 'cancel', reason: 'cutoff', untilMin },
        message: expect.stringContaining(spoken!),
      });

      const untouched = await reread(f.original.id);
      expect(untouched.status).toBe('confirmed');
      expect(untouched.sequence).toBe(f.original.sequence);
      expect(await requestCount(f.serviceId)).toBe(0);
      expect(PLAN_CALENDAR.deletes).toHaveLength(0);
      expect(await handoffCount(f.sessionId)).toBe(0);
      expect(escalate).not.toHaveBeenCalled();
    });
  });
});
