/**
 * What the booking plan says the platform KEEPS — asserted against real Postgres rows.
 *
 * Three cases, and each one closes the same shape of gap: something adjacent was already
 * pinned, so the case looked covered while the guarantee itself was not.
 *
 * * [SRV-22] — `uploaded_files` was pinned as an INSERT PARAMETER against a MOCKED repository
 *   (`unit/internal-provider-create.test.ts:1180-1246`). A parameter is not persistence: a jsonb
 *   column that silently drops its payload, a projection that filters the rows back out, or a
 *   column that never received the value would all leave that test green. There is no
 *   `BookingAttachment` entity, so this jsonb IS the attachment record — if it is wrong, the
 *   owner has no other copy. Here the row is read back out of the database, and then read a
 *   second time through the admin projection (`booking/booking.service.ts:517`,
 *   `uploadedFileSnapshots`), which had no test at all.
 *
 * * [SRV-11] — intake answers were pinned on the REQUEST path only
 *   (`unit/internal-provider-create.test.ts:1606-1614`), while the CONFIRMED INSERT
 *   (`internal.provider.ts:1552`) carries them too. A confirmed appointment is the one the owner
 *   turns up to, so it is the one whose answers matter most, and it was the untested half.
 *
 * * [SRV-02] — `SERVICE_REQUIRED` was pinned as a thrown code against mocks
 *   (`unit/find-bookable-service.test.ts:54`). Nothing asserted the DIARY: that an ambiguous
 *   request writes no Booking, no Request and no calendar event before the clarification. A
 *   refusal that still captures a lead, or still mirrors an invite, is the failure worth
 *   catching, and a thrown-code assertion cannot see it.
 *
 * Deliberately NOT claimed here: the plan's "exactly one clarifying question" clause of SRV-02.
 * The ask COUNT is the model's judgement, and a scripted model always obeys, so pinning it
 * deterministically would manufacture confidence rather than measure anything. It belongs in the
 * live eval suite (work order §4).
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

import { AppDataSource } from '../../database/data-source';
import { UploadSession } from '../../database/entities/UploadSession';
import type { UploadSessionStatus } from '../../database/entities/UploadSession';
import { Booking } from '../../database/entities/Booking';
import { InternalProvider } from '../../booking/booking-providers/internal.provider';
import { adminListBookings } from '../../booking/booking.service';
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
  bookingCount,
  requestCount,
  bookingsForService,
  soleConfirmedBooking,
} from '../helpers/booking-plan-harness';

/**
 * A row in `upload_sessions`, seeded the way the widget's upload pipeline leaves one.
 *
 * The work order describes this as "book with a `fileSessionId` extra". The production path does
 * not take one: `InternalProvider.resolveFileSessionIds` (`internal.provider.ts:2578`) asks the
 * upload service for the READY sessions belonging to this chat
 * (`file-handling/upload.service.ts:744`). So the fixture is the row, and the booking picks it up
 * on its own — which is also the more faithful test, because it exercises the real collection
 * step rather than hand-feeding its output.
 */
async function seedUploadSession(input: {
  tenantId: string;
  chatSessionId: string;
  originalName: string;
  status?: UploadSessionStatus;
}): Promise<UploadSession> {
  const repo = AppDataSource.getRepository(UploadSession);
  const sessionId = randomUUID();
  return repo.save(
    repo.create({
      sessionId,
      tenantId: input.tenantId,
      chatSessionId: input.chatSessionId,
      userId: `widget-${sessionId.slice(0, 8)}`,
      fileKey: `uploads/${input.tenantId}/${sessionId}.jpg`,
      fileHash: sessionId.replace(/-/g, ''),
      originalName: input.originalName,
      fileSize: 4096,
      mimeType: 'image/jpeg',
      uploadUrl: `https://uploads.test/${sessionId}`,
      publicUrl: `https://cdn.test/${sessionId}`,
      status: input.status ?? 'ready',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }),
  );
}

describe('booking plan · persistence and clarification', () => {
  beforeEach(() => {
    PLAN_CALENDAR.reset();
  });

  describe('[SRV-22] an attached file survives the write and comes back out', () => {
    it('persists the uploaded_files jsonb and returns it through the service projection', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      const ready = await seedUploadSession({
        tenantId: tenant.id,
        chatSessionId: session.id,
        originalName: 'boiler-leak.jpg',
      });
      // A NEGATIVE CONTROL in the same chat, and the reason this test cannot pass for the wrong
      // reason. Without it, "uploadedFiles has a row" would also pass if the platform snapshotted
      // every upload session it could find, ready or not — which would attach a file the scanner
      // has not cleared to an owner's email. The second row makes the assertion discriminate
      // between "the ready one" and "any of them".
      //
      // PROVED, not assumed. The "ready" filter has TWO layers — the query at
      // `upload.service.ts:748` and `readyUploadRow` at `internal.provider.ts:2688` — and
      // breaking either alone left this test green, so both were relaxed together: the row count
      // then read 2 and the test failed. Both were restored. That two-layer result is itself
      // worth recording: a single-layer regression is caught by the OTHER layer, not by this
      // test.
      const notReady = await seedUploadSession({
        tenantId: tenant.id,
        chatSessionId: session.id,
        originalName: 'still-scanning.jpg',
        status: 'scanning',
      });

      const day = planLocalTime(40, '10:00');
      const provider = new InternalProvider();
      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-files-${randomUUID()}`,
        localInstant(day).toISOString(),
        { name: 'QA Files', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      expect(result.success).toBe(true);
      expect(result.requested).toBeFalsy();

      // Surface 1 — the persisted jsonb, re-read from Postgres rather than inspected as an INSERT
      // argument. This is the whole point of the case: there is no BookingAttachment entity, so
      // this column is the only record that the file belongs to this appointment.
      const row = await soleConfirmedBooking(service.id);
      expect(Array.isArray(row.uploadedFiles)).toBe(true);
      expect(row.uploadedFiles).toHaveLength(1);
      expect(row.uploadedFiles?.[0]).toMatchObject({
        fileSessionId: ready.sessionId,
        fileName: 'boiler-leak.jpg',
      });
      // The shape the downstream carriers read (`internal.provider.ts:2060`, `:2685`): the owner
      // email's attachment builder needs the key and the type, not just the name.
      expect(row.uploadedFiles?.[0]).toMatchObject({
        mimeType: 'image/jpeg',
        fileSize: 4096,
        fileKey: ready.fileKey,
      });
      const persistedIds = (row.uploadedFiles ?? []).map((f) =>
        f && typeof f === 'object' && 'fileSessionId' in f ? f.fileSessionId : undefined,
      );
      expect(persistedIds).not.toContain(notReady.sessionId);

      // Surface 2 — the read-back. `uploadedFileSnapshots` (`booking.service.ts:449`) filters
      // every entry that is not a well-formed `{fileSessionId, fileName}` pair, so a column
      // written in a shape the projection rejects would persist and still be invisible to the
      // owner. Asserting the column alone cannot see that; this is the half that can.
      // PROVED: making `uploadedFileSnapshots` return `[]` for a non-empty column failed this
      // assertion (`expected [] to deeply equal [ {…} ]`) while every row-level assertion above
      // still passed. Restored.
      const listed = await adminListBookings('scheduler-admin', tenant.id, 'upcoming', 50, 0);
      const projected = listed.bookings.find((b) => b.id === row.id);
      expect(projected).toBeDefined();
      expect(projected!.uploadedFiles).toEqual([
        { fileSessionId: ready.sessionId, fileName: 'boiler-leak.jpg', mimeType: 'image/jpeg' },
      ]);
    });
  });

  describe('[SRV-11] intake answers on the CONFIRMED booking', () => {
    it('stores the answer under the question\u2019s server-minted uuid on a confirmed row', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const service = await createPlanService(bot, {
        requiredIntakeQuestion: 'Which floor is the boiler on?',
      });
      const session = await planSession(bot);

      // The KEY is minted by the server when the question is created, and is not the label. That
      // is the clause under test: an implementation that keyed answers by label or by array index
      // would still show the owner an answer today and lose it the moment a question is renamed
      // or reordered. So the expected key is read off the Service row, never hard-coded.
      const questionId = service.intakeQuestions?.[0]?.id;
      expect(typeof questionId).toBe('string');

      const day = planLocalTime(41, '10:00');
      const provider = new InternalProvider();
      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-intake-${randomUUID()}`,
        localInstant(day).toISOString(),
        { name: 'QA Intake', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
        { [questionId!]: 'Second floor, by the window', 'not-a-question-id': 'noise' },
      );
      expect(result.success).toBe(true);

      const row = await soleConfirmedBooking(service.id);
      // CONFIRMED, not `request_created`. The request path was already pinned, so a fixture that
      // quietly downgraded (a missing calendar credential does exactly that) would re-prove the
      // covered half and claim the uncovered one.
      expect(row.status).toBe('confirmed');
      expect(await requestCount(service.id)).toBe(0);

      const answers = row.intakeAnswers ?? {};
      expect(answers).toEqual({ [questionId!]: 'Second floor, by the window' });
      // Stated separately from the equality above, because this is the clause: the answer is
      // reachable BY the question's uuid, and the unknown key the model invented was dropped
      // rather than persisted (`booking-providers/intake.ts:26`).
      // PROVED: disabling the id filter in `normalizeIntakeAnswers` made this test fail with
      // `expected { 'not-a-question-id': 'noise', …(1) }`. Restored.
      expect(answers[questionId!]).toBe('Second floor, by the window');
      expect(Object.keys(answers)).toEqual([questionId!]);
    });
  });

  describe('[SRV-02] two services with overlapping names write nothing', () => {
    it('refuses with SERVICE_REQUIRED and leaves no booking, no request and no invite', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      // Overlapping names, which is the case's fixture: the ambiguity is real to a reader, not an
      // artefact of two unrelated services existing.
      const boilerRepair = await createPlanService(bot, { name: 'Boiler repair' });
      const boilerService = await createPlanService(bot, { name: 'Boiler repair and service' });
      const session = await planSession(bot);

      const day = planLocalTime(42, '10:00');
      const provider = new InternalProvider();
      const ctx = planBookingContext(tenant, bot, session);

      // The machine-readable outcome. Asserted as the CODE, not as a sentence — the customer-facing
      // wording is copy and is localized (`booking/booking-copy.ts:117`).
      // PROVED: removing the `active.length > 1` refusal in `find-bookable-service.ts` made this
      // assertion fail with `promise resolved "{ success: true, …(4) }" instead of rejecting`,
      // and the diary assertions below would have failed with it. Restored.
      await expect(
        provider.createBooking(
          ctx,
          `idem-ambiguous-${randomUUID()}`,
          localInstant(day).toISOString(),
          { name: 'QA Ambiguous', email: PLAN_CUSTOMER_EMAIL },
        ),
      ).rejects.toMatchObject({ code: 'SERVICE_REQUIRED' });

      // The request path resolves the service too (`internal.provider.ts:2379`). Without this the
      // case would be half-asserted: an ambiguous ask that refuses to CONFIRM but happily captures
      // a lead has still written a row the owner must now deal with.
      await expect(
        provider.requestAppointment(
          ctx,
          `idem-ambiguous-req-${randomUUID()}`,
          localInstant(day).toISOString(),
          { name: 'QA Ambiguous', email: PLAN_CUSTOMER_EMAIL },
        ),
      ).rejects.toMatchObject({ code: 'SERVICE_REQUIRED' });

      // The diary, which is what a thrown-code assertion cannot see.
      for (const svc of [boilerRepair, boilerService]) {
        expect(await bookingCount(svc.id)).toBe(0);
        expect(await requestCount(svc.id)).toBe(0);
        expect(await bookingsForService(svc.id)).toEqual([]);
      }
      // Including rows written with no service attached at all, which the per-service counters
      // above would miss.
      const anyRow = await AppDataSource.getRepository(Booking).count({
        where: { tenantId: tenant.id },
      });
      expect(anyRow).toBe(0);

      expect(PLAN_CALENDAR.creates).toHaveLength(0);
      expect(PLAN_CALENDAR.updates).toHaveLength(0);
      expect(PLAN_CALENDAR.deletes).toHaveLength(0);
    });

    it('books the same request once the ambiguity is gone', async () => {
      // The control, and the reason the refusal above is attributable to the AMBIGUITY. Every
      // other ingredient is identical — same availability, same calendar, same time, same
      // attendee, same omitted serviceId — and only the number of active services differs. Without
      // this, a fixture that could never book for an unrelated reason would produce the same
      // green refusal and the same empty diary.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      const only = await createPlanService(bot, { name: 'Boiler repair' });
      const session = await planSession(bot);

      const day = planLocalTime(43, '10:00');
      const provider = new InternalProvider();
      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-sole-${randomUUID()}`,
        localInstant(day).toISOString(),
        { name: 'QA Ambiguous', email: PLAN_CUSTOMER_EMAIL },
      );

      expect(result.success).toBe(true);
      expect(await bookingCount(only.id, 'confirmed')).toBe(1);
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
    });
  });
});
