/**
 * The booking plan's REQUEST and RESET paths, asserted on persisted state.
 *
 * Three cases live here because all three turn on the same row shape — a `request_created`
 * Booking — and on the same trap: the TypeScript `requested: true` flag is already pinned
 * everywhere, and it is exactly the thing that cannot tell a real row from a mocked INSERT.
 *
 * * [SRV-04] — before this file, NO real-DB request row existed anywhere in the suite. The only
 *   coverage was `unit/internal-provider-create.test.ts:1052-1060`, which asserts the returned
 *   `requested: true` flag against a MOCKED repository, so the request INSERT itself was never
 *   inspected. Here the literal persisted `status = 'request_created'` is read back from Postgres.
 *
 * * [SYS-02] — the plan's premise is WRONG, and this file pins the truth. See the case's own
 *   comment: the row survives but is CANCELLED and its calendar mirror is DELETED. The calendar
 *   half had never been checked, because `integration/conversation-reset.test.ts:49-51` replaces
 *   `syncCalendarCancel` with a bare `vi.fn()` and asserts nothing about it. This file does NOT
 *   mock `calendar-sync`: the real function runs and the calendar PORT records the deletion.
 *
 * * [CAL-06] — the result code `CALENDAR_NOT_CONNECTED` is pinned three times over; the row it
 *   produces on the create path is not. What this file can and cannot prove about the REPLY is
 *   stated in that case's comment, without pretending.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The calendar port double. `calendar-sync` is deliberately NOT mocked anywhere in this file:
// [SYS-02]'s whole unasserted clause is that the real `syncCalendarCancel` reaches the provider,
// so replacing it with a spy would remove the only thing the case is about.
//
// ONE HARNESS BEHAVIOUR IS OVERRIDDEN HERE, and [CAL-06] cannot exist without it.
// `planCalendarMockModule()` stubs `hasHealthyCalendarConnection` as `busyError === null`, so it
// answers TRUE whether or not a `CalendarCredential` row exists. Omitting
// `seedPlanCalendarCredential` therefore does NOT reach the disconnected path — the first draft of
// [CAL-06] confirmed a booking on a business with no calendar at all, which is how this was found.
// The override restores the real predicate by delegating to the module's own
// `loadActiveCredential`, so "connected" means a live credential row, exactly as production
// decides it. The harness file itself is untouched.
vi.mock('../../scheduler/calendar-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/calendar-provider')>();
  return {
    ...actual,
    ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
    hasHealthyCalendarConnection: async (botId: string) => {
      const cred = await actual.loadActiveCredential(botId);
      return !!cred && !cred.reauthRequired;
    },
  };
});
vi.mock('../../automations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automations')>()),
  getEmailService: () => ({ send: vi.fn().mockResolvedValue({ success: true, messageId: 'qa' }) }),
  initializeAutomations: vi.fn(),
}));
// Reminder JOBS are BullMQ, not a booking guarantee. `importOriginal` is spread so the scheduling
// side the confirmed create needs keeps working and only the queue drop is silenced.
vi.mock('../../booking/booking-providers/reminders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../booking/booking-providers/reminders')>()),
  cancelReminders: vi.fn().mockResolvedValue(undefined),
  scheduleReminders: vi.fn().mockResolvedValue(['qa-reminder-job']),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));
vi.mock('../../llm/localize', () => ({
  localizeMessage: vi.fn((message: string) => Promise.resolve(message)),
}));
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
  routeTypingIndicator: vi.fn().mockResolvedValue(undefined),
  sendChannelTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

// Reset clears identity scratch through Redis. An in-memory map keeps the clear REAL (the keys are
// written and then read back as absent) without a live server.
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
import { conversationCommands } from '../../services/conversation-command.service';
import { sessionScratchKeys } from '../../services/conversation-reset-state';
import { createTestUser, createTestAgent } from '../helpers/factories';
import {
  createPlanBusiness,
  createPlanService,
  setPlanAvailability,
  seedPlanCalendarCredential,
  PLAN_CALENDAR,
  PLAN_CUSTOMER_EMAIL,
  planSession,
  planBookingContext,
  planLocalTime,
  localInstant,
  localSpan,
  bookingCount,
  requestCount,
  bookingsForService,
} from '../helpers/booking-plan-harness';

const CUSTOMER = { name: 'QA Requester', email: PLAN_CUSTOMER_EMAIL };

describe('booking plan · requests and reset', () => {
  beforeEach(() => {
    // The calendar double is module state and survives the `afterEach` TRUNCATE, so one case's
    // recorded creates and deletes would otherwise leak into the next and make a "the mirror was
    // deleted" assertion pass against a previous test's delete.
    PLAN_CALENDAR.reset();
    redisData.clear();
  });

  describe('[SRV-04] a request-only service persists a Request, not a booking', () => {
    it('writes a real request_created row with requestKind new, and no confirmed booking', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      // A CONNECTED calendar is what makes this case about the SERVICE MODE. Without a credential
      // the write path downgrades ANY auto-book service to a request for a completely different
      // reason (`CALENDAR_NOT_CONNECTED`, asserted separately below), so this test would pass with
      // `bookingMode: 'request'` deleted from the fixture entirely.
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot, { bookingMode: 'request' });
      const session = await planSession(bot);

      const local = planLocalTime(30, '10:00');
      const provider = new InternalProvider();
      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-srv04-${randomUUID()}`,
        localInstant(local).toISOString(),
        CUSTOMER,
        undefined,
        service.id,
      );

      // The flag is asserted only so the row assertion below is known to describe the same call.
      // It is NOT the guarantee: `requested: true` is already pinned against a mocked repository,
      // and a mock cannot tell a committed row from an INSERT nobody ran.
      expect(result.success).toBe(true);
      expect(result.requested).toBe(true);

      const rows = await bookingsForService(service.id);
      expect(rows).toHaveLength(1);
      // The literal persisted status. This is the clause that had no test anywhere.
      expect(rows[0].status).toBe('request_created');
      expect(rows[0].requestKind).toBe('new');
      // A NEW request is not a change request, so it hangs off no original.
      expect(rows[0].relatedBookingId).toBeNull();

      expect(await bookingCount(service.id, 'confirmed')).toBe(0);
      expect(await requestCount(service.id)).toBe(1);

      // The owner has to be able to see WHAT was asked for, so the preferred time is retained on
      // the row rather than being carried only in the chat transcript. Compared in local clock
      // terms, because a UTC-vs-local drift is what BK-06 exists for.
      expect(localSpan(rows[0])).toMatchObject({
        date: local.slice(0, 10),
        start: '10:00',
        end: '10:30',
      });

      // No mirror. A request holds no time, so nothing may appear on the owner's diary — an event
      // here would show a job nobody has agreed to.
      expect(PLAN_CALENDAR.creates).toHaveLength(0);
    });

    it('confirms the identical fixture once the service is auto-book, so the mode is the cause', async () => {
      // The control that makes the case above discriminating. Same business, same calendar, same
      // time; only `bookingMode` differs. Without this, a fixture broken in some unrelated way
      // (an unavailable slot, a missing credential) would still produce a request row and the
      // case above would report success while proving nothing about request mode.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot, { bookingMode: 'auto' });
      const session = await planSession(bot);

      const provider = new InternalProvider();
      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-srv04-auto-${randomUUID()}`,
        localInstant(planLocalTime(31, '10:00')).toISOString(),
        CUSTOMER,
        undefined,
        service.id,
      );

      expect(result.requested).toBeFalsy();
      expect(await bookingCount(service.id, 'confirmed')).toBe(1);
      expect(await requestCount(service.id)).toBe(0);
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
    });
  });

  describe('[SYS-02] reset keeps the booking row and removes its calendar mirror', () => {
    /**
     * THE PLAN'S WORDING DOES NOT MATCH THE CODE, AND THIS TEST PINS THE CODE.
     *
     * The plan says a reset "must not delete real persisted bookings" and that a booking
     * "still exists". Both halves of that sentence are true only in the narrow sense that the ROW
     * is not deleted. What `services/conversation-reset-state.ts:255-291` actually does is CANCEL
     * every live booking on the wiped sessions (`status → 'cancelled'`, `sequence + 1`,
     * `reminder_job_ids` emptied), and then `:121-131` deletes each one's calendar mirror through
     * `syncCalendarCancel`. `intake_answers` survive on the cancelled row.
     *
     * So the real contract is "no DATA loss, but the appointment is gone" — not "the appointment
     * still exists". That difference is customer-visible: the event disappears from the owner's
     * diary. The wording question is raised as a separate deliverable; this test asserts the
     * behaviour the code has, and would fail if that behaviour changed under it.
     */
    it('cancels the live booking, keeps its intake answers, and deletes the calendar event', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot, {
        intakeQuestions: [{ id: 'q-detail', label: 'What is the job?', type: 'text', required: true }],
      });
      const session = await planSession(bot);

      // A REAL confirmed booking, written through the provider rather than seeded by SQL. That is
      // load-bearing here and not tidiness: the mirror deletion resolves the event id through the
      // `booking_calendar_refs` row that only the real create path writes, so a hand-seeded row
      // would make `syncCalendarCancel` return early and `deletes` stay empty for a reason that
      // has nothing to do with reset.
      const provider = new InternalProvider();
      const created = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-sys02-${randomUUID()}`,
        localInstant(planLocalTime(32, '11:00')).toISOString(),
        CUSTOMER,
        undefined,
        service.id,
        { 'q-detail': 'Broken boiler in the cellar' },
      );
      expect(created.requested).toBeFalsy();
      const bookingId = created.booking?.id as string;
      expect(bookingId).toBeTruthy();

      const [beforeReset] = await bookingsForService(service.id);
      expect(beforeReset.status).toBe('confirmed');
      const sequenceBefore = beforeReset.sequence;
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
      const mirroredEventId = PLAN_CALENDAR.creates[0].result.eventId;
      expect(PLAN_CALENDAR.live.has(mirroredEventId)).toBe(true);

      // Conversation scratch the reset is supposed to clear. Written through the same key helper
      // the production wipe reads, so the assertion below cannot pass against a key nobody uses.
      for (const key of sessionScratchKeys(session.id)) redisData.set(key, 'stale');

      const user = await createTestUser(tenant.id, { role: 'super_admin' });
      const actor = await createTestAgent(tenant.id, user.id);
      const reset = await conversationCommands.resetConversation(
        session.id,
        { kind: 'agent', agentId: actor.id },
        undefined,
        { tenantId: tenant.id },
      );

      expect(reset.outcome).toBe('reset');
      expect(reset.cancelledBookingIds).toContain(bookingId);

      // 1. No DATA loss — the row is still there. This is the plan's real intent.
      const after = await bookingsForService(service.id);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(bookingId);

      // 2. But the appointment does not stand: it is cancelled, its sequence advanced so the
      //    iCalendar update supersedes the invite, and its reminder jobs are gone.
      expect(after[0].status).toBe('cancelled');
      expect(after[0].sequence).toBe(sequenceBefore + 1);
      expect(after[0].reminderJobIds).toEqual([]);

      // 3. The intake answers survive on the cancelled row, so nothing the customer told the
      //    business is destroyed by a reset.
      expect(after[0].intakeAnswers).toEqual({ 'q-detail': 'Broken boiler in the cellar' });

      // 4. THE UNASSERTED HALF. The calendar mirror is deleted, through the real
      //    `syncCalendarCancel` and the same port `calendar-sync.ts` writes through. Asserted on
      //    the event id the create recorded, not merely on a non-empty list: a delete of some
      //    other event, or a leaked delete from an earlier test, would satisfy `toHaveLength(1)`
      //    while the customer's event stayed on the diary.
      //
      //    PROVEN, not assumed. `syncCalendarCancel` was temporarily replaced with
      //    `vi.fn().mockResolvedValue(undefined)` — the exact stub
      //    `integration/conversation-reset.test.ts:49-51` ships — and this assertion FAILED
      //    (`expected [] to deeply equal [ '<eventId>' ]`) while the other five tests in this file
      //    stayed green. The stub was then removed. So this line cannot pass without the real
      //    mirror deletion, which is the clause the plan's existing coverage never checked.
      expect(PLAN_CALENDAR.deletes.map((d) => d.eventId)).toEqual([mirroredEventId]);
      expect(PLAN_CALENDAR.live.has(mirroredEventId)).toBe(false);

      // 5. Conversation-scoped state is cleared, which is what stops the next inbound being
      //    `alreadyHeld` against the appointment just cancelled.
      expect(reset.scratchCleared).toBe(true);
      for (const key of sessionScratchKeys(session.id)) {
        expect(redisData.has(key)).toBe(false);
      }
    });

    it('deletes no calendar event when the session holds no live booking', async () => {
      // The control for clause 4. `PLAN_CALENDAR.deletes` is module state, so "non-empty after a
      // reset" only means something if the same fixture leaves it EMPTY when there is nothing to
      // cancel. Without this, a stray delete from any other code path would carry the case above.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      const user = await createTestUser(tenant.id, { role: 'super_admin' });
      const actor = await createTestAgent(tenant.id, user.id);
      const reset = await conversationCommands.resetConversation(
        session.id,
        { kind: 'agent', agentId: actor.id },
        undefined,
        { tenantId: tenant.id },
      );

      expect(reset.outcome).toBe('reset');
      expect(reset.cancelledBookingIds).toEqual([]);
      expect(PLAN_CALENDAR.deletes).toEqual([]);
      expect(await bookingsForService(service.id)).toEqual([]);
    });
  });

  describe('[CAL-06] a disconnected calendar captures a Request and confirms nothing', () => {
    it('persists a request_created row and writes no confirmed booking', async () => {
      // `seedPlanCalendarCredential` is OMITTED. That is the fixture: an AUTO-BOOK service on a
      // business with no connected calendar cannot be auto-confirmed, so the write path downgrades
      // it (`internal.provider.ts:1414-1421`).
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      const service = await createPlanService(bot, { bookingMode: 'auto' });
      const session = await planSession(bot);

      const provider = new InternalProvider();
      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-cal06-${randomUUID()}`,
        localInstant(planLocalTime(33, '14:00')).toISOString(),
        CUSTOMER,
        undefined,
        service.id,
      );

      expect(result.requested).toBe(true);

      // A request row exists, so customer-facing text is ALLOWED to say a request was captured.
      // The plan's honesty rule is exactly this: the claim is permitted only when the row is real.
      const rows = await bookingsForService(service.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('request_created');
      expect(await bookingCount(service.id, 'confirmed')).toBe(0);

      // And nothing that a reply could read as a confirmation was produced: no mirror was put on
      // the owner's diary at all.
      expect(PLAN_CALENDAR.creates).toHaveLength(0);

      // WHAT THIS DOES NOT PROVE: the reply. `modules/booking.module.ts:623` - "Never tell the
      // customer it is booked or confirmed" - is judged in the agent loop, not at this seam. The
      // create returns `success: true` with `requested: true` here, and `absorbRecordedOutcome`
      // in `agent.service.ts` reads `requested` to set `state.requestRecorded`, never
      // `state.bookingRecorded`, so the false-confirmation guard stays armed on this path. The
      // reply half is pinned end to end over this same fixture in
      // `integration/booking-plan-truth-guard.test.ts` (CAL-06), with its known residuals pinned
      // as `it.fails`.
    });

    it('confirms the identical fixture once a calendar is connected, so the credential is the cause', async () => {
      // Proves the request above came from the MISSING CREDENTIAL and not from the service, the
      // slot, or the availability rule. This control was written after watching the case above:
      // with the credential seeded the same call confirms, so the downgrade is caused by the one
      // fixture line that differs.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot, { bookingMode: 'auto' });
      const session = await planSession(bot);

      const provider = new InternalProvider();
      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-cal06-ok-${randomUUID()}`,
        localInstant(planLocalTime(34, '14:00')).toISOString(),
        CUSTOMER,
        undefined,
        service.id,
      );

      expect(result.requested).toBeFalsy();
      expect(await bookingCount(service.id, 'confirmed')).toBe(1);
      expect(await requestCount(service.id)).toBe(0);
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
    });
  });
});

