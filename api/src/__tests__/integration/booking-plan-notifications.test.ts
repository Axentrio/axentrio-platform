/**
 * The booking plan's CUSTOMER-FACING surfaces: what the calendar entry says, and what the
 * committed confirmation email says.
 *
 * Every case in this file exists because the clause it covers is about a surface the customer
 * actually reads, and every existing pin stops one layer short of it.
 *
 * * [PRC-12] is the reason the file was written. There is NO price column on `Booking`
 *   (`Booking.ts:116` says the price is derived by join), so the discounted figure has exactly
 *   two carriers a customer ever sees: the calendar event description and the confirmation
 *   email. The quote side was pinned in the prompt (`unit/booking-prompt-behaviour.test.ts:1775-1817`)
 *   and the persistence side was pinned UNDISCOUNTED (`unit/internal-provider-create.test.ts:803-818`),
 *   so `discountEnabled` had never once appeared alongside a real `createBooking`. A customer could
 *   have been quoted EUR 80 in chat and invoiced EUR 100 on their invite with the suite green.
 *
 * * [SRV-14] is the email half of "show on my calendar OFF". The calendar half is pinned
 *   (`unit/booking-prompt-behaviour.test.ts:771`); the owner's notification email reuses the SAME
 *   assembled block through `ownerDetail` (`booking-email.ts:139-145`, `:245-247`), so a hidden
 *   answer must be absent there too, and the customer email must carry no intake at all.
 *
 * * [SYS-09] the owner's preparation sentence had never been passed into `sendBookingEmail` by any
 *   test, so the card at `booking-email.ts:333-338` was rendered by nothing.
 *
 * * [SYS-08] "every booking email" was INFERRED from one flag (`booking-email.ts:422-423`,
 *   `method === 'REQUEST'`). This file enumerates the kinds instead.
 *
 * * [BK-03] phone reuse is pinned (`unit/internal-provider-create.test.ts:555`, `:1367-1374`).
 *   Email reuse was not.
 *
 * Two seams, and the choice between them is deliberate:
 *
 *  1. `email_deliveries` (via `emailDeliveriesFor` / `customerEmailFor` / `emailText`) is the seam
 *     for anything the CUSTOMER receives. It is the row the platform commits before it calls
 *     Resend, so it is where a price or an attachment would have to appear for the customer to get
 *     it.
 *  2. The transport double (`MAILBOX` below) is the seam for anything the OWNER receives, and only
 *     because it has to be: the owner delivery is committed with `retainPayload: false`
 *     (`booking-email.ts:277`), so its `payload` is null and the ledger holds no owner body at all.
 *     Asserting "the hidden answer is absent from the owner email" against a null payload would be
 *     the emptiest possible pass. The double records what was actually handed to the mail service,
 *     which is the only place that body exists.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Every message handed to the mail service, in order. Hoisted because the `vi.mock` factory below
 * is lifted above the imports, and declared here rather than in the harness because only the
 * owner-email assertions need it — the harness is shared and must not grow for one file.
 */
const MAILBOX = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; body: string; attachments: string[] }>,
}));

// The harness is reached with `await import` because a `vi.mock` factory is hoisted above every
// static import in the file, so a top-level import of it is not yet initialised when the factory
// runs. This is the pattern the work order's §0 convention 3 prescribes.
vi.mock('../../scheduler/calendar-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/calendar-provider')>()),
  ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
}));
vi.mock('../../automations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automations')>()),
  getEmailService: () => ({
    send: async (options: {
      to: string | string[];
      subject: string;
      body: string;
      attachments?: Array<{ filename: string }>;
    }) => {
      MAILBOX.sent.push({
        to: (Array.isArray(options.to) ? options.to.join(',') : options.to).toLowerCase(),
        subject: options.subject,
        body: options.body,
        attachments: (options.attachments ?? []).map((a) => a.filename),
      });
      return { success: true, messageId: `qa-${MAILBOX.sent.length}` };
    },
  }),
  initializeAutomations: vi.fn(),
}));

import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import type { BookingSettings } from '../../database/entities/BookingSettings';
import { formatServicePrice } from '../../booking/pricing/service-discount';
import { InternalProvider } from '../../booking/booking-providers/internal.provider';
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
  soleConfirmedBooking,
  bookingsForService,
  emailDeliveriesFor,
  customerEmailFor,
  emailText,
} from '../helpers/booking-plan-harness';

const OWNER_EMAIL = 'owner@axentrio.test';

/**
 * Give the bot an owner notification address. `notifyOwner` is skipped entirely when
 * `botSettings.ai.supportEmail` is falsy (`booking-email.ts:461`), and `createPlanBusiness` does
 * not set one — so without this the owner-email assertions would be asserting on an email that was
 * never sent, which is exactly the kind of vacuous pass this file is written to avoid.
 */
async function withOwnerEmail(bot: Bot): Promise<Bot> {
  bot.settings = { ...bot.settings, ai: { ...bot.settings.ai!, supportEmail: OWNER_EMAIL } };
  return AppDataSource.getRepository(Bot).save(bot);
}

/**
 * A booking accumulates several deliveries to the SAME customer address over its life (confirm,
 * then reschedule, then cancel). Selecting by recipient alone would silently read the first one, so
 * later phases are read as "the rows that did not exist before this action".
 */
async function deliveriesSince(bookingId: string, seen: Set<string>) {
  const rows = await emailDeliveriesFor(bookingId);
  return rows.filter((r) => !seen.has(r.id));
}

async function deliveryIds(bookingId: string): Promise<Set<string>> {
  return new Set((await emailDeliveriesFor(bookingId)).map((r) => r.id));
}

/** The plan's §3 bookable business, with a connected calendar so Auto-book actually confirms. */
async function bookableBusiness(opts: { bookingSettings?: Partial<BookingSettings> } = {}) {
  const { tenant, bot } = await createPlanBusiness(opts);
  await setPlanAvailability(bot);
  await seedPlanCalendarCredential(bot);
  return { tenant, bot: await withOwnerEmail(bot) };
}

describe('booking plan · customer-facing notifications', () => {
  beforeEach(() => {
    // Both doubles are module state and outlive the DB truncation that clears everything else.
    PLAN_CALENDAR.reset();
    MAILBOX.sent.length = 0;
  });

  // ── PRC-12 ────────────────────────────────────────────────────────────────
  describe('[PRC-12] the discounted price is what the customer is shown', () => {
    /**
     * `priceDisplayType: 'fixed'`, EUR 100 list, 20% off, open-ended window — the plan's §2.1
     * fixture. `formatServicePrice` renders whole euros unpadded, so the payable figure is the
     * exact string `€80` and the list figure would be `€100`.
     */
    const DISCOUNTED = {
      priceDisplayType: 'fixed' as const,
      fixedPrice: 100,
      discountEnabled: true,
      discountType: 'percentage' as const,
      discountValue: 20,
    };

    async function bookWithPrice(mentionDiscountInChat: boolean) {
      const { tenant, bot } = await bookableBusiness();
      const service = await createPlanService(bot, { ...DISCOUNTED, mentionDiscountInChat });
      const session = await planSession(bot);
      const day = planLocalTime(41, '10:00');

      const result = await new InternalProvider().createBooking(
        planBookingContext(tenant, bot, session),
        `idem-price-${randomUUID()}`,
        localInstant(day).toISOString(),
        { name: 'QA Payable', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      expect(result.success).toBe(true);
      expect(result.requested).toBeFalsy();
      return { service, booking: await soleConfirmedBooking(service.id) };
    }

    it('carries the final discounted figure on the calendar entry and the email, and never the list price', async () => {
      const { service, booking } = await bookWithPrice(true);

      // Carrier 1 — the calendar entry. There is no price column, so this IS the record.
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
      const description = PLAN_CALENDAR.creates[0].input.description ?? '';
      expect(description).toContain('Price: €80');
      expect(description).not.toContain('€100');

      // Carrier 2 — the committed confirmation email.
      const customer = await customerEmailFor(booking.id, PLAN_CUSTOMER_EMAIL);
      expect(customer).toBeDefined();
      const text = emailText(customer!);
      expect(text).toContain('Price: €80');
      expect(text).not.toContain('€100');

      /**
       * The counterfactual, stated rather than assumed, and deliberately LAST so a regression is
       * reported on the customer's surface rather than on a helper call. `€100` is the string this
       * same service WOULD render with the discount off, which is what makes the two
       * `not.toContain('€100')` assertions above discriminating instead of a claim about a figure
       * the code never produces.
       *
       * Proven by breaking the renderer, not the fixture: with `active` forced false in
       * `formatServicePrice` (`booking/pricing/service-discount.ts:121`) the discount stops being
       * applied while the Service still says 20% off, and this test fails on
       * `expect(description).toContain('Price: €80')` with the calendar entry reading
       * `Price: €100`. Restored afterwards.
       */
      expect(formatServicePrice({ ...service, discountEnabled: false }, PLAN_TZ)).toBe('€100');
      expect(formatServicePrice(service, PLAN_TZ)).toBe('€80');
    });

    it('the calendar entry and the email carry only the payable figure', async () => {
      const { service, booking } = await bookWithPrice(false);

      /**
       * `mentionDiscountInChat` gates the SERVICES prompt line only (`booking.module.ts:74-104`,
       * which renders `was €100, now €80 (20% off) · do not mention`). The calendar entry and the
       * email quote `formatServicePrice`, which never renders a "was" price or a percentage on
       * either setting.
       *
       * So this test is not asserting that the flag suppresses something — it pins that the two
       * carriers show ONLY the payable figure, and that the flag's "do not mention" promise is not
       * quietly broken by a future change that starts threading the before/after copy onto the
       * invite. The `€100` and `20%` assertions are what would catch that; the `€80` assertion is
       * what stops the test passing by the price disappearing altogether.
       */
      expect(formatServicePrice(service, PLAN_TZ)).toBe('€80');

      const description = PLAN_CALENDAR.creates[0].input.description ?? '';
      const text = emailText((await customerEmailFor(booking.id, PLAN_CUSTOMER_EMAIL))!);

      for (const surface of [description, text]) {
        expect(surface).toContain('€80');
        expect(surface).not.toContain('€100');
        expect(surface).not.toContain('20%');
        // Opaque URLs are stripped first. The manage link carries a signed JWT, so its base64
        // payload is different on every run and could contain any letter sequence — a wording
        // assertion against it would be intermittently and inexplicably red. The attendee name is
        // chosen for the same reason: an earlier fixture called "QA Discount" failed this line by
        // matching its own customer name, which is precisely the wrong-reason outcome this file
        // exists to prevent.
        expect(surface.replace(/https?:\/\/\S+/g, '')).not.toMatch(/discount/i);
      }
    });
  });

  // ── SRV-14 ────────────────────────────────────────────────────────────────
  describe('[SRV-14] an intake answer marked "do not show on my calendar"', () => {
    it('is stored on the booking, absent from the calendar entry, absent from the owner email, and the customer email carries no intake at all', async () => {
      const { tenant, bot } = await bookableBusiness();

      /**
       * TWO questions, and that is the whole point. One is shown, one is hidden. A test with only
       * the hidden question passes just as well when the intake block is broken, missing, or
       * renders nothing at all. The shown answer is the positive control: the calendar entry must
       * contain it, which proves the intake block ran and that the hidden answer's absence is a
       * decision rather than an outage.
       */
      const service = await createPlanService(bot, {
        intakeQuestions: [
          { id: randomUUID(), label: 'Which floor?', type: 'text', required: true },
          { id: randomUUID(), label: 'Gate code', type: 'text', required: true, includeInCalendar: false },
        ],
      });
      const [shown, hidden] = service.intakeQuestions!;
      const SHOWN_ANSWER = 'Second floor, left';
      const HIDDEN_ANSWER = 'ZX-4417-QQ';

      const session = await planSession(bot);
      const day = planLocalTime(42, '11:00');
      const result = await new InternalProvider().createBooking(
        planBookingContext(tenant, bot, session),
        `idem-intake-${randomUUID()}`,
        localInstant(day).toISOString(),
        { name: 'QA Intake', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
        { [shown.id]: SHOWN_ANSWER, [hidden.id]: HIDDEN_ANSWER },
      );
      expect(result.success).toBe(true);

      // 1. STORED. "Do not show on my calendar" is a display choice, not a collection choice: the
      //    owner still needs the gate code in the portal.
      const booking = await soleConfirmedBooking(service.id);
      expect(booking.intakeAnswers).toEqual({ [shown.id]: SHOWN_ANSWER, [hidden.id]: HIDDEN_ANSWER });

      // 2. ABSENT from the calendar entry, while the shown answer is present.
      expect(PLAN_CALENDAR.creates).toHaveLength(1);
      const description = PLAN_CALENDAR.creates[0].input.description ?? '';
      expect(description).toContain(`${shown.label}: ${SHOWN_ANSWER}`);
      expect(description).not.toContain(HIDDEN_ANSWER);
      expect(description).not.toContain(hidden.label);

      // 3. ABSENT from the owner email, which reuses the same assembled block via `ownerDetail`.
      //    Read from the transport: the owner delivery keeps no payload.
      const owner = MAILBOX.sent.filter((m) => m.to === OWNER_EMAIL);
      expect(owner).toHaveLength(1);
      expect(owner[0].body).toContain(SHOWN_ANSWER);
      expect(owner[0].body).not.toContain(HIDDEN_ANSWER);

      // 4. The customer email carries NO intake — not the hidden answer, and not the shown one
      //    either. The invite the customer keeps is not the owner's job sheet.
      const text = emailText((await customerEmailFor(booking.id, PLAN_CUSTOMER_EMAIL))!);
      expect(text).not.toContain(HIDDEN_ANSWER);
      expect(text).not.toContain(SHOWN_ANSWER);
      expect(text).not.toContain(shown.label);
      expect(text).not.toContain(hidden.label);
    });
  });

  // ── SYS-09 ────────────────────────────────────────────────────────────────
  describe('[SYS-09] the owner preparation sentence', () => {
    it('reaches the customer confirmation email, and is left off the cancellation', async () => {
      const PREPARATION = 'Please unlock the side gate marked ZQ-7788 before we arrive.';
      const { tenant, bot } = await bookableBusiness();
      const service = await createPlanService(bot, { preparationInstructions: PREPARATION });
      const session = await planSession(bot);
      const ctx = planBookingContext(tenant, bot, session);
      const provider = new InternalProvider();

      const created = await provider.createBooking(
        ctx,
        `idem-prep-${randomUUID()}`,
        localInstant(planLocalTime(43, '14:00')).toISOString(),
        { name: 'QA Preparation', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      expect(created.success).toBe(true);
      const booking = await soleConfirmedBooking(service.id);

      const confirmation = await customerEmailFor(booking.id, PLAN_CUSTOMER_EMAIL);
      expect(confirmation).toBeDefined();
      expect(emailText(confirmation!)).toContain(PREPARATION);

      /**
       * The negative half, and the reason this test cannot pass by the sentence leaking into every
       * template: a cancellation must not tell the customer to unlock a gate for an appointment
       * that is off.
       *
       * Two independent guards keep it off the cancellation, and BOTH had to be broken to make
       * this assertion fail — which is what proves it discriminates rather than describing a
       * surface the sentence could never reach. `cancelBooking` does not pass
       * `preparationInstructions` at all (`internal.provider.ts:4728-4746`), and the card itself is
       * gated on `!cancelled` (`booking-email.ts:333-338`). Adding the parameter to that call site
       * AND dropping the `!cancelled` guard makes the cancellation body carry the sentence and
       * fails the assertion below. Both edits reverted.
       */
      const seen = await deliveryIds(booking.id);
      const cancelled = await provider.cancelBooking(ctx, booking.id, 'QA cancel');
      expect(cancelled.cancelled).toBe(true);

      const after = (await deliveriesSince(booking.id, seen)).filter(
        (r) => r.recipientEmail.toLowerCase() === PLAN_CUSTOMER_EMAIL,
      );
      expect(after).toHaveLength(1);
      expect(emailText(after[0])).not.toContain(PREPARATION);
    });
  });

  // ── SYS-08 ────────────────────────────────────────────────────────────────
  /**
   * The plan's clause is "every booking email carries the general information". Today that is
   * inferred from a single flag: `booking-email.ts:422-423` loads the extras only when
   * `method === 'REQUEST'`, and four different provider call sites happen to pass that literal
   * (`internal.provider.ts:1993` create, `:2977` accept, `:3449` invite re-issue, `:4632`
   * reschedule). One test on one path would keep passing while a fifth kind shipped with the flag
   * forgotten, so each kind is driven and asserted here by name. A new confirmation kind belongs in
   * this block.
   *
   * The negative case is a cancellation (`:4730`, `method: 'CANCEL'`), which must NOT carry the
   * extras. Without it the four positive assertions would also pass if the extras were welded onto
   * every template unconditionally.
   *
   * That negative is guarded twice, and BOTH guards had to be broken to make it fail, which is how
   * it was proven to discriminate: the load itself is gated on `method === 'REQUEST'`
   * (`booking-email.ts:422-423`) and the information card is gated again on `!cancelled`
   * (`:340-346`). Removing only one changed nothing; removing both put the text on the
   * cancellation body and failed the assertion. Reverted.
   *
   * Attachments are deliberately not exercised: `loadConfirmationExtras` reads them from object
   * storage, and the text and the files come from the same row through the same `method` gate, so
   * the text is the discriminating signal and the file read would only add an S3 double.
   */
  describe('[SYS-08] the confirmation extras, per email kind', () => {
    const EXTRA_INFO = 'Arrive at reception desk QZ-31 and ask for the duty engineer.';

    async function business() {
      return bookableBusiness({ bookingSettings: { confirmationExtraInfo: EXTRA_INFO } });
    }

    it('reach the customer on a confirmed create', async () => {
      const { tenant, bot } = await business();
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      const result = await new InternalProvider().createBooking(
        planBookingContext(tenant, bot, session),
        `idem-x-create-${randomUUID()}`,
        localInstant(planLocalTime(44, '09:00')).toISOString(),
        { name: 'QA Create', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      expect(result.success).toBe(true);

      const booking = await soleConfirmedBooking(service.id);
      expect(emailText((await customerEmailFor(booking.id, PLAN_CUSTOMER_EMAIL))!)).toContain(EXTRA_INFO);
    });

    it('reach the customer when the owner accepts a captured request', async () => {
      const { tenant, bot } = await business();
      // Request-only, so `requestAppointment` captures a `request_created` row the owner accepts.
      const service = await createPlanService(bot, { bookingMode: 'request' });
      const session = await planSession(bot);
      const ctx = planBookingContext(tenant, bot, session);
      const provider = new InternalProvider();

      const requested = await provider.requestAppointment(
        ctx,
        `idem-x-req-${randomUUID()}`,
        localInstant(planLocalTime(45, '09:00')).toISOString(),
        { name: 'QA Accept', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      expect(requested.success).toBe(true);

      const [row] = await bookingsForService(service.id);
      expect(row.status).toBe('request_created');
      // Capturing a request commits no ledger row of its own, so anything found after the accept
      // is the accept's own email.
      expect(await emailDeliveriesFor(row.id)).toHaveLength(0);

      const accepted = await provider.acceptRequest(ctx, row.id);
      expect(accepted.success).toBe(true);

      const customer = await customerEmailFor(row.id, PLAN_CUSTOMER_EMAIL);
      expect(customer).toBeDefined();
      expect(emailText(customer!)).toContain(EXTRA_INFO);
    });

    it('reach the customer on a reschedule', async () => {
      const { tenant, bot } = await business();
      const service = await createPlanService(bot);
      const session = await planSession(bot);
      const ctx = planBookingContext(tenant, bot, session);
      const provider = new InternalProvider();

      await provider.createBooking(
        ctx,
        `idem-x-resched-${randomUUID()}`,
        localInstant(planLocalTime(46, '09:00')).toISOString(),
        { name: 'QA Reschedule', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      const booking = await soleConfirmedBooking(service.id);
      const seen = await deliveryIds(booking.id);

      const moved = await provider.rescheduleBooking(
        ctx,
        booking.id,
        localInstant(planLocalTime(46, '15:00')).toISOString(),
      );
      expect(moved.success).toBe(true);

      const after = (await deliveriesSince(booking.id, seen)).filter(
        (r) => r.recipientEmail.toLowerCase() === PLAN_CUSTOMER_EMAIL,
      );
      expect(after).toHaveLength(1);
      expect(emailText(after[0])).toContain(EXTRA_INFO);
    });

    it('reach the customer on an invite re-issued to a corrected address', async () => {
      const { tenant, bot } = await business();
      const service = await createPlanService(bot);
      const session = await planSession(bot);
      const ctx = planBookingContext(tenant, bot, session);
      const provider = new InternalProvider();

      await provider.createBooking(
        ctx,
        `idem-x-reissue-${randomUUID()}`,
        localInstant(planLocalTime(47, '09:00')).toISOString(),
        { name: 'QA Reissue', email: 'qa-typo@axentrio.test' },
        undefined,
        service.id,
      );
      const booking = await soleConfirmedBooking(service.id);

      const updated = await provider.updateBooking(ctx, {
        bookingId: booking.id,
        attendeeEmail: PLAN_CUSTOMER_EMAIL,
      });
      expect(updated.success).toBe(true);
      expect(updated.emailSent).toBe(true);

      // The corrected address has exactly one delivery: the re-issued invite. Selecting by the new
      // recipient is what keeps this off the original invite and off the CANCEL sent to the old one.
      const reissued = await customerEmailFor(booking.id, PLAN_CUSTOMER_EMAIL);
      expect(reissued).toBeDefined();
      expect(emailText(reissued!)).toContain(EXTRA_INFO);
    });

    it('are left off a cancellation', async () => {
      const { tenant, bot } = await business();
      const service = await createPlanService(bot);
      const session = await planSession(bot);
      const ctx = planBookingContext(tenant, bot, session);
      const provider = new InternalProvider();

      await provider.createBooking(
        ctx,
        `idem-x-cancel-${randomUUID()}`,
        localInstant(planLocalTime(48, '09:00')).toISOString(),
        { name: 'QA Cancel', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      const booking = await soleConfirmedBooking(service.id);
      const seen = await deliveryIds(booking.id);

      const cancelled = await provider.cancelBooking(ctx, booking.id, 'QA cancel');
      expect(cancelled.cancelled).toBe(true);

      const after = (await deliveriesSince(booking.id, seen)).filter(
        (r) => r.recipientEmail.toLowerCase() === PLAN_CUSTOMER_EMAIL,
      );
      expect(after).toHaveLength(1);
      expect(emailText(after[0])).not.toContain(EXTRA_INFO);
    });
  });

  // ── BK-03 ─────────────────────────────────────────────────────────────────
  describe('[BK-03] an email address given once', () => {
    it('lands on the booking, addresses the confirmation, and is reused on a later reschedule', async () => {
      const { tenant, bot } = await bookableBusiness();
      /**
       * `customerEmailRequired: true` is load-bearing. The entity default is FALSE
       * (`ServiceType.ts:249-250`), so on a default plan service a missing address is simply
       * accepted and `EMAIL_REQUIRED` can never fire — a "the gate did not fire" assertion would
       * then be true for the wrong reason. The negative case at the end proves the gate is armed on
       * this fixture.
       */
      const service = await createPlanService(bot, { customerEmailRequired: true });
      const session = await planSession(bot);
      const ctx = planBookingContext(tenant, bot, session);
      const provider = new InternalProvider();

      const result = await provider.createBooking(
        ctx,
        `idem-email-${randomUUID()}`,
        localInstant(planLocalTime(49, '10:00')).toISOString(),
        { name: 'QA Email Reuse', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      expect(result.success).toBe(true);
      expect(result.requested).toBeFalsy();

      // Given once, kept: on the row…
      const booking = await soleConfirmedBooking(service.id);
      expect(booking.attendeeEmail).toBe(PLAN_CUSTOMER_EMAIL);

      // …and reused as the confirmation's recipient, so the customer is never asked twice.
      const deliveries = await emailDeliveriesFor(booking.id);
      const recipients = deliveries.map((r) => r.recipientEmail.toLowerCase());
      expect(recipients).toContain(PLAN_CUSTOMER_EMAIL);

      // The gate is real on this service: the same call without an address is refused.
      await expect(
        provider.createBooking(
          ctx,
          `idem-email-missing-${randomUUID()}`,
          localInstant(planLocalTime(49, '11:00')).toISOString(),
          { name: 'QA No Email' },
          undefined,
          service.id,
        ),
      ).rejects.toMatchObject({ code: 'EMAIL_REQUIRED' });

      // THE REUSE CLAUSE, and the half a create-only test cannot reach. `rescheduleBooking` takes
      // NO attendee argument, so the invite it issues can only find the customer by reading the
      // address the first turn stored: the row supplies it at `internal.provider.ts:4658`.
      // Asserting the create alone would prove only that a field passed in comes back out, which
      // is plumbing rather than the plan's "supplied information reused, so the customer is never
      // asked twice".
      //
      // PROVEN by breaking it, not assumed: with `attendeeEmail: booking.attendeeEmail ?? ''`
      // at `internal.provider.ts:4658` replaced by `''`, the reschedule invite reaches nobody and
      // the last assertion below fails with `expected [] to have a length of 1`. Restored.
      // Worth recording honestly: SYS-08's reschedule case (`:447`) fails on that same break. This
      // case is the one that NAMES the reuse clause; it is not the only guard on that line.
      const seen = await deliveryIds(booking.id);
      const movedStart = localInstant(planLocalTime(49, '15:00'));
      const moved = await provider.rescheduleBooking(ctx, booking.id, movedStart.toISOString());
      expect(moved.success).toBe(true);

      // The appointment really moved, so the delivery below is the reschedule's own invite and not
      // the original confirmation read a second time.
      const rebooked = await soleConfirmedBooking(service.id);
      expect(rebooked.id).toBe(booking.id);
      expect(rebooked.startUtc.getTime()).toBe(movedStart.getTime());
      expect(rebooked.attendeeEmail).toBe(PLAN_CUSTOMER_EMAIL);

      // Nobody was asked again: the new invite reached the stored address, exactly once.
      const afterMove = (await deliveriesSince(booking.id, seen)).filter(
        (r) => r.recipientEmail.toLowerCase() === PLAN_CUSTOMER_EMAIL,
      );
      expect(afterMove).toHaveLength(1);
    });
  });
});
