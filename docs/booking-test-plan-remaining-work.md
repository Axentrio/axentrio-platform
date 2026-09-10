# Booking test plan — remaining work

The work order for the rest of the Axentrio booking test plan. Written to be executed directly:
each item names the case, the exact clause that is unasserted, the seam to assert it at, the
fixture it needs, and the trap that would make it pass for the wrong reason.

Companion to `booking-test-plan-traceability.md`, which holds the full per-case audit. That
document answers *"what is the state of each case?"*; this one answers *"what do I write next, and
where?"*.

Status when this was written: **39 tests delivered across 4 new files**, all passing, no production
code touched. 15 audited cases closed, 24 open, 2 awaiting a live harness, 4 needing the plan
reworded, 4 product defects reported and unfixed.

---

## 0. Read this before writing anything

Four conventions are load-bearing. Each exists because ignoring it produces a test that passes
while testing nothing.

**1. Fixtures are PER TEST.** `src/__tests__/setup.ts` TRUNCATEs every table holding rows in an
`afterEach`. A fixture created in `beforeAll` is gone by the second test — you get
"could not find any entity", or worse, a delta-of-zero assertion that passes against an empty
database. Seed inside each `it`, or in a `beforeEach`. This bit one of the delivered tests, which is
why it is called out here.

**2. Module-level doubles must be reset.** `PLAN_CALENDAR` (the calendar-port double) is module
state and is *not* truncated. Call `PLAN_CALENDAR.reset()` in a `beforeEach`, or one test's recorded
creates and busy intervals leak into the next.

**3. `vi.mock` factories are hoisted above imports.** To reach the shared harness from inside one,
you must import it dynamically:

```ts
vi.mock('../../scheduler/calendar-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/calendar-provider')>()),
  ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
}));
```

Spread `importOriginal` rather than replacing the module — hand-rolling the export list silently
breaks other consumers (`getAutomationEngine` was missing from a partial `../../automations` mock
during this work and threw at runtime, not at compile time).

**4. Never inject an error where a real constraint exists.** Injecting `{code:'23P01'}` into a mocked
repository proves the error is *handled*, never that it is *raised*. That distinction is the entire
reason `CON-01` was a gap for as long as it was. If Postgres can be the decider, let Postgres decide.

Two more, from the plan itself:

- **Assert state, not wording.** Rows, statuses, times, recorded calendar writes, committed email
  payloads, and machine-readable codes (`CONFIRMATION_REQUIRED`, `CHANGE_NOT_ALLOWED`,
  `REQUEST_BEFORE_CHECK`, `SLOT_UNAVAILABLE`) are fair game. Exact AI phrasing is not.
- **Put the case ID in the test title**, in square brackets: `it('[MOD-02] …', …)`. The IDs are the
  traceability key; a title can be grepped, so the matrix can be re-derived instead of trusted.

### The harness you should build on

`src/__tests__/helpers/booking-plan-harness.ts` already provides, and should not be modified:

| Export | Use |
|---|---|
| `createPlanBusiness({bookingSettings?, botSettings?})` | Tenant + anchor Bot, Europe/Brussels, AI on |
| `setPlanAvailability(bot, overrides?)` | Mon–Fri 09:00–17:00, 30-min grid |
| `setPlanBookingSettings(bot, overrides)` | Upsert: ceilings, business defaults, venue, pause, travel |
| `createPlanService(bot, overrides?)` | Auto-book, fixed 30 min, no price, bookable |
| `seedPlanCalendarCredential(bot)` | Connected calendar. **Omit** to get the request/`CALENDAR_NOT_CONNECTED` path |
| `PLAN_CALENDAR` | Calendar-port double: `.busy`, `.busyError`, `.creates/.updates/.deletes/.live`, `.reset()` |
| `planSession(bot)` / `planBookingContext(...)` / `planToolContext({...})` | Session, `BookingContext`, `ToolContext` |
| `seedConfirmedBooking({...})` | A real confirmed row (raw SQL — `blocked_range` is unmapped) |
| `bookingsForService` / `bookingCount` / `requestCount` / `soleConfirmedBooking` / `localSpan` | Row readers |
| `emailDeliveriesFor` / `customerEmailFor` / `emailText` | Committed email, from the `EmailDelivery` ledger |
| `localInstant` / `localHHMM` / `localDateOnly` / `planDate` / `planLocalTime` | Wall-clock in one place |
| `PLAN_TZ`, `BUSINESS_ADDRESS`, `CUSTOMER_ADDRESS_A`, `PLAN_CUSTOMER_EMAIL` | The plan's §3 fixtures |

Two boundaries to respect. The email seam is the **`email_deliveries` table**, not the transport:
it is the row the platform commits before it calls Resend, and it is where an attachment or a price
would have to appear for the customer to receive it. And wall-clock conversion belongs in the
harness helpers — `BK-06` exists because a timezone drifted, so a second ad-hoc conversion is how
that bug comes back.

---

## 1. P0 — do these first

### 1.1 `BK-07` — the false-success guard, wired end to end

**Unasserted:** the wiring itself. `state.bookingRecorded` defaults false
(`newRunLoopState` in `agent/agent.service.ts`) and flips true in `absorbRecordedOutcome`, and it is only ever asserted **TRUE**
(`unit/agent-service.test.ts:2251`). Every output-guard test hand-supplies `validationContext`
(`integration/guardrails-output-gate.test.ts:96`, `:110`), so no test has ever driven a run in which
the write failed and the model then claimed success. `docs/booking-rules.md:225` — *"Announcing
'I'll book that now' without calling the tool in the same reply is a false confirmation"* — carries
no `Pinned:` line and no pinning test.

**Why it matters:** this is the rule that stops the product telling a customer they are booked when
they are not. It is the highest-consequence honesty guarantee in the plan, and it is the one with no
end-to-end coverage.

**Seam:** the deterministic multi-turn drive in `integration/agent-escalation-handoff.test.ts` —
real `AgentService` + real `ToolRegistry`, only the LLM scripted via `chatMock`, wired with
`initializeAgentService(realAgent())` and driven with `forwardMessageToN8n(session, message)`. Copy
its companion mocks (`billing/token-budget.service`, `websocket/socket.handler`, `llm/localize`,
`channels/outbound-router`, `llm/rag.service`), import the SUT *after* them, and reset with
`initializeAgentService(null)` in an `afterEach`.

**Fixture:** a bookable business, a connected calendar, a scripted model that calls `create_booking`
and then — after the write fails — replies with a success claim.

**Force the failure at a faithful seam.** Options in rough order of fidelity: a Service/date that
cannot be written; `PLAN_CALENDAR.busyError` set so availability fails; or a rejected
`booking.service.createBooking`. Say in a comment which you chose and why it is faithful.

**Assertions:**
- no confirmed Booking row exists;
- the customer-visible reply does **not** claim a confirmed/booked/reserved appointment;
- ideally the reply is the guard's replacement text or a non-committal failure message.

**Trap:** asserting on the *tool result* instead of the *reply*. The tool correctly returns
`success: false` (`unit/builtin-tools.test.ts:1495-1506`) — that half is already pinned. What is
missing is the reply the customer actually reads.

**Note:** no test in this repository has ever driven the real agent loop into a real booking tool.
If that proves impractical, a tool-level test plus an explicit written statement of what remains
unproven is the honest outcome. Do not present it as equivalent.

---

### 1.2 `MOD-01` … `MOD-08` — the change-policy persistence path

The largest remaining block, and the one where every existing pin is one layer short of the
guarantee.

**Unasserted, case by case:**

| Case | Unasserted clause | Evidence |
|---|---|---|
| MOD-01 | the mirror's **new** start/end after a move; absence of a duplicate row | `unit/internal-provider-reschedule-cancel.test.ts:606-637` use `objectContaining({location…})` |
| MOD-02 | **"original untouched"** — no no-UPDATE check exists on the request path (it does for `not_allowed` `:1424`) | `:1472-1522`; the `it()` title at `:1472` over-claims its body |
| MOD-03 | **no human handoff** — copy-only today | `unit/builtin-tools.test.ts:1739`; `unit/customer-change-policy.test.ts:129-131` |
| MOD-04 | a later "was my reschedule approved?" **turn**; no handoff-row assertion | rides on generic STATUS guidance copy |
| MOD-05 | *covered* — skip | `:738-749`, `:408-420` |
| MOD-06 | `syncCalendarCancel` **never asserted** — `deleteEvent` is a bare `vi.fn()` | `:103`, `:801-806`; `booking/booking-providers/calendar-sync.ts:236` |
| MOD-07 | a real `request_created` row for a cancel, original still active | tool level only, `unit/builtin-tools.test.ts:1833-1846` |
| MOD-08 | "no request / booking active" by **SQL**, not by "the writer was not called"; no handoff | `unit/builtin-tools.test.ts:1848-1864` |

**Layer:** integration, real Postgres, via `InternalProvider` + `planBookingContext`.
Suggested file: `src/__tests__/integration/booking-plan-changes.test.ts`.

**Fixtures:** a confirmed booking seeded with `seedConfirmedBooking`, a connected calendar, and
`rescheduleMode` / `cancelMode` set per case (`'auto'` / `'request'` / `'not_allowed'`), with
`rescheduleUntilMin` / `cancelUntilMin` for the cutoff case.

**Assertions, in the order that matters:**
1. **Row shape:** a request path writes a `request_created` row with the right `requestKind`
   (`'reschedule'` / `'cancel'`) and, for a change request, a `relatedBookingId`.
2. **Original untouched, by SQL:** re-read the original row and assert `startUtc`, `status` and
   `sequence` are unchanged — not that a service function was skipped.
3. **Mirror, against the port:** `PLAN_CALENDAR.updates` carries the new local start on an auto
   reschedule; `PLAN_CALENDAR.deletes` is non-empty on an auto cancel; on a *request* policy both
   are empty.
4. **No handoff row:** count `HandoffRequest` for the session and assert **0** on a `not_allowed`
   refusal, and that `escalate_to_human` was never invoked. `docs/booking-rules.md:190` is explicit:
   a policy refusal must not offer a human, and insisting is not a request for a person. Every
   existing no-handoff pin is guidance copy — this is the clause with no row-level test anywhere.
5. **Cutoff:** with a cutoff set, the refusal **names the cutoff** and does not send the customer to
   the business (`docs/booking-rules.md:192-193`).

**Traps:** (a) asserting `requested: true` instead of reading the row — that flag is already pinned
and is exactly the gap; (b) trusting an `it()` title. Three titles in this area over-claim their
bodies (`internal-provider-reschedule-cancel.test.ts:1472`,
`integration/conversation-reset.test.ts:187`, `integration/bot-ai-settings.test.ts:432`) — read the
body, not the title, when deciding what is covered.

---

### 1.3 `SRV-04` — the persisted Request

**Unasserted:** the literal persisted `status = 'request_created'`. Only the TypeScript
`requested: true` flag is pinned (`unit/internal-provider-create.test.ts:1052-1060`); the request
INSERT is mocked and uninspected, so **no real-DB request row exists anywhere in the suite**.

**Fixture:** `bookingMode: 'request'`; drive `InternalProvider.requestBooking` (or the
`RequestAppointmentTool` via `planToolContext`).

**Assertions:** a real row exists with `status === 'request_created'` and `requestKind === 'new'`;
**no** `confirmed` row; **no** calendar create recorded; the requested start/end are retained so the
owner can see what was asked for.

---

### 1.4 `SYS-02` — the reset's real contract

**The plan's premise is wrong, so pin the truth and flag the mismatch.**

Plan wording: a reset "must not delete real persisted bookings" and a booking "still exists". What
the code does: the **row survives** but is **cancelled** (`status → 'cancelled'`, `sequence+1`,
`reminder_job_ids` cleared — `services/conversation-reset-state.ts:255-291`), its **calendar mirror
is deleted** (`:121-131` → `booking/booking-providers/calendar-sync.ts:236`), and
`intake_answers` / `uploaded_files` **survive on the cancelled row**.

**Unasserted:** the calendar half. `syncCalendarCancel` is mocked with **no expectation**
(`integration/conversation-reset.test.ts:49-51`), so the mirror deletion has never been checked even
though the cancel itself is asserted (`:498-511`).

**Assertions:** the row still exists (the plan's real intent — no data loss); its status is
`cancelled`; `PLAN_CALENDAR.deletes` is non-empty; conversation scratch/state is cleared. Then add a
comment that this is the actual contract and differs from the plan's wording.

**Deliverable beyond the test:** raise the wording question. Either "reset cancels live bookings and
removes their calendar events" is intended — in which case the plan must say so — or it is a bug.

---

### 1.5 `AVL-17` — pause, end to end

**Already delivered** in `integration/booking-plan-system.test.ts` (both the paused and the lifted
control). Listed here only because the trap is worth repeating for anyone extending it: **a paused
business neither refuses nor blocks capacity — it downgrades a would-be confirmation into a Request.**
Requests consume no capacity, so any test written as "pause blocks new bookings" asserts a behaviour
the product does not have. And the test needs a **connected calendar** to be meaningful, because a
missing calendar produces the identical `requested: true` signal for a completely different reason.

---

## 2. P1 — the remaining audited clauses

### 2.1 `PRC-12` — the discount reaching the customer's surfaces

**Unasserted:** the whole persistence leg. The quote side is pinned
(`unit/booking-prompt-behaviour.test.ts:1775-1817`) and the persistence side is pinned
**undiscounted** (`unit/internal-provider-create.test.ts:803-818`). `discountEnabled` never appears
alongside `createBooking` / `createCalendarEvent` / `sendBookingEmail`.

**Critical constraint:** there is **no Booking price column** — the entity has none, and the comment
at `Booking.ts:116` says price is derived by join. So the only carriers a customer actually sees are
the **calendar description** and the **email**. Those are what to assert.

**Fixture:** `priceDisplayType: 'fixed'`, `fixedPrice: 100`, `discountEnabled: true`,
`discountType: 'percentage'`, `discountValue: 20`, `mentionDiscountInChat` per case.

**Assertions:** the confirmation email's text carries the final **€80**; the calendar event input's
`description` carries €80; and **€100 never appears as a payable figure**. For
`mentionDiscountInChat: false`, additionally assert the reduction is not advertised (no "20%" /
"discount" wording) while the final price still appears.

**Also chase the suspected defect:** `scheduler/sync-reconciler.ts:311` re-derives the price using
its own `now`, so a discount window opening or closing between booking and reconcile can silently
change the price on the calendar mirror relative to the price emailed to the customer.
`unit/sync-reconciler.test.ts:309-378` never asserts price. Report it; do not fix it here.

### 2.2 `CAL-06` — "never say confirmed" on a disconnected calendar

**Closed** (wave 3). The state half and the reply half are both pinned. See the CAL-06 row in
`booking-test-plan-traceability.md` for the tests, the falsification and the residual.

### 2.3 `SRV-22` — real persistence, and the read-back

**Unasserted:** real DB persistence and the projection. Existing coverage proves the **INSERT
parameter** of `uploaded_files` against a *mocked* repo
(`unit/internal-provider-create.test.ts:1180-1246`), and `uploadedFileSnapshots`
(`booking/booking.service.ts:517`) is untested. There is no `BookingAttachment` entity.

**Fixture:** a ready `UploadSession` row; book with a `fileSessionId` extra.

**Assertions:** the persisted row's `uploadedFiles` jsonb contains
`Array<{fileSessionId, fileName}>` (`internal.provider.ts:2060`, `:1578`); reading it back through
the service projection returns it.

### 2.4 `SRV-11` — intake answers on the *confirmed* INSERT

**Unasserted:** `intake_answers` on the confirmed booking — persistence was pinned on the **Request**
path only (`unit/internal-provider-create.test.ts:1606-1614`), while the confirmed INSERT at
`internal.provider.ts:1552` carries it too.

**Assertions:** a confirmed booking's `intakeAnswers` holds the answer under the question's
server-minted uuid.

### 2.5 `SRV-14` — the email half of "show on my calendar OFF"

**Unasserted:** the email clause, *entirely*. The calendar half is pinned
(`unit/booking-prompt-behaviour.test.ts:771`), and the mechanism is `booking-content.ts:152-167` +
`:199-207`. The owner's notification email **reuses the same assembled block** as `ownerDetail`
(`booking-email.ts:133-142`, `:245-247`), which is why a hidden answer should be absent there too.
The customer email never carries intake at all.

**Fixture:** a required intake question with `includeInCalendar: false`, and a distinctive answer.

**Assertions:** the answer is **stored** on the booking; it is **absent** from the calendar
description; it is **absent** from the owner email; and the customer email carries no intake.

### 2.6 `SYS-09` — preparation instructions reaching the email

**Unasserted:** the email. `booking-email.ts:333-337` renders a preparation card, but **no test
passes `preparationInstructions` to `sendBookingEmail`**, and nothing shows the Service row's value
reaching the provider's email params (`internal.provider.ts:1648`). The calendar body and chat notice
are pinned elsewhere.

**Assertions:** a distinctive sentence set on the Service appears in the customer's confirmation
email read from the `EmailDelivery` ledger — and is absent from an email where it should not appear,
so the test cannot pass by the text leaking everywhere.

### 2.7 `OUT-01` — the Outlook path

**Unasserted:** everything end-to-end. All Outlook coverage is axios-mocked
(`unit/outlook-events-service.test.ts`, `unit/outlook-calendar-service.test.ts`,
`unit/calendar-provider.test.ts:62`), and the only "busy blocks a booking" test is Google-sourced.

**Seam:** `scheduler/calendar-provider.ts:98-110` assembles the microsoft adapter; `getBusy` maps to
`getOutlookBusyForBot` (`integrations/microsoft/outlook-events.service.ts:82`). Build a
Microsoft-typed double (the port's `providerType` is read-only, so a local adapter is likely easier
than reusing `PLAN_CALENDAR`).

**Assertions:** (a) a valid booking records a mirror write through the microsoft adapter; (b) a
seeded busy Outlook interval makes that slot unavailable, so no double booking is created.

**Be explicit in a comment** that this exercises the provider-agnostic path with a Microsoft-typed
double and does **not** call Graph — and state what that leaves unproven.

### 2.8 `SRV-02` — one clarification, and nothing written before it

**Unasserted:** the ask count. `SERVICE_REQUIRED` is pinned
(`unit/find-bookable-service.test.ts:54`); nothing asserts a single clarification or the absence of a
write beforehand.

**Fixture:** two active Services with overlapping names/descriptions.

**Assertions:** no Booking row, no Request row, and no calendar create before the clarification;
`SERVICE_REQUIRED` is the machine-readable outcome. The *ask count itself* is model judgement and
belongs in the live suite (§4) — do not fake it deterministically.

### 2.9 `BK-03` — email reuse

**Unasserted:** email reuse, specifically. Phone reuse is pinned
(`unit/internal-provider-create.test.ts:555`, `:1367-1374`) and name reuse is prompt prose only.

**Assertions:** supplying the email once lands it on the created booking
(`booking.attendeeEmail`) and as the confirmation email's recipient, with `EMAIL_REQUIRED` not
firing.

### 2.10 `AVL-09` — duration longer than the grid crossing closing

**Unasserted:** every existing fixture had `duration == granularity`, so closing was only ever
crossed by a start exactly **ON** closing. A 60-minute Service on a 30-minute grid — where 16:30
would run to 17:30 — has never been exercised. `AVL-08` now covers the same shape across a lunch
break; this is the closing-time twin.

### 2.11 `TRV-05` — the Base's located coordinates on the offer path

**Unasserted:** `travelBaseFor`'s located branch (`internal.provider.ts:1019-1027`), because every
`checkAvailability` fixture passes `venue: null` (`unit/internal-provider-create.test.ts:2559`). The
Base-as-predecessor logic is pinned (`unit/travel-gate.test.ts:626-630`); measuring the day's first
job from the Base's own coordinates is not.

### 2.12 `GEO-01` — grouping wiring

**Unasserted:** the provider wiring at `internal.provider.ts:914-920` is never driven with
`groupingPeriod !== 'none'`. The reorder-only invariant is pinned at function level
(`unit/apply-grouping.test.ts:45-52`), not through the booking path.

### 2.13 `SYS-08` — enumerate the confirmation-email kinds

**Partly unasserted:** "every booking email" is **inferred** from one flag
(`booking-email.ts:423`, `method === 'REQUEST'`) rather than enumerated. Accept, reschedule and
re-issue all send `'REQUEST'` (`internal.provider.ts:2977`, `:3449`, `:4632`), so the general
information and attachment are expected on each. Enumerate them, so a future kind that forgets the
flag is caught.

---

## 3. Blocked on a product decision — do not write a test yet

One item cannot be honestly tested until someone decides what the behaviour should be. **This is
not a test-effort gap**, and writing a test now would only pin the current, contradicted behaviour.

### 3.1 `SYS-07` — a false "we forwarded your request" claim ships green

**Closed** (wave 3). It was never blocked: `docs/booking-rules.md:223` and `:225` already decide it.
See the SYS-07 row in `booking-test-plan-traceability.md` for the tests, the condition and the
residuals.

### 3.2 `AVL-01` — no opening-hours gate on the request path

`internal.provider.ts:2414-2443` refuses past / too_soon / too_far / closed-day / service-cap /
no-check — but **not** an out-of-hours hour on a day that has hours. So after any check for that
date, a model that names 08:30 on a 09:00 day can capture a Request on an **Auto-book** service,
which `docs/booking-rules.md:26-28` explicitly forbids and calls load-bearing
(*"Stay in the auto-book flow"*). The offer side is correctly pinned
(`unit/slot-engine.test.ts:45`, `unit/agent-service.test.ts:1726`); the write side is not gated.

### 3.3 `GEO-05` — ambiguous as written

The case says a "maximum extra travel" setting affects suggestion only, never hard availability. That
contradicts the product: **Maximum Travel Time** (`maxTravelMin`) *is* a hard refusal for the Agent
(`docs/adr/0019:5-7`; asserted at `unit/travel-gate.test.ts:812`,
`unit/internal-provider-create.test.ts:2381-2400`). Only **Geographic Grouping** may reorder. The
case must say which of the two it means before it can be automated. See §5.

---

## 4. The live LLM eval suite (not built)

**Nothing here exists yet.** `api/src/__tests__/live/booking-flow-live.ts` is a manual script with
zero `expect()`, is not matched by the vitest include, and runs in no CI job — it is not a substitute.

**Why this layer is necessary rather than optional:** for the cases below the behaviour *is* the
model's judgement. A scripted model always obeys, so a deterministic test can pin the server gate or
the prompt text but can never prove the model's choice. Claiming otherwise would be the most
expensive kind of false confidence in this suite.

| Case | What only a live model can show | Why deterministic cannot |
|---|---|---|
| `SYS-03` | a Dutch-configured bot answers `hey` in Dutch | the rule is prompt text only (`config/bot-language.ts:39-51`); no server gate exists |
| `SYS-04` | an explicitly English message may be answered in English | same |
| `BK-02` | a price question does not trigger a booking write | the deterministic half (delivered) proves only that `check_availability` is side-effect-free |
| `BK-08` | the model stays in Auto-book and does not offer a manual request | existing pins are prompt copy plus `REQUEST_BEFORE_CHECK`, not the model's choice |
| `SRV-02` | **exactly one** clarifying question | the ask count is a conversational property |

**Shape:** a `npx tsx` script deliberately **not** named `*.test.ts`, so vitest and therefore CI can
never pick it up, plus an `api/package.json` script following the existing `eval:leads` /
`eval:proactive` pattern. Each case reports PASS/FAIL/SKIPPED with the observed evidence (actual
reply, actual tool calls, actual rows), exits non-zero on failure, and exits non-zero on skip unless
`--allow-skip` is passed — **a suite that goes green when nothing ran is worse than no suite**. Add a
`--dry-run` mode using a stub provider so the plumbing is reviewable without spend or a key.

**Grade tool calls and state, not wording.** For `BK-02` and `BK-08` the discriminating signal is
whether `create_booking` / `request_appointment` were invoked, and whether rows exist — not the
sentence. For `SYS-03` use a language classifier, not a string match.

---

## 5. Send these back to the plan's author

Four cases cannot be automated as written. Two describe a **removed design generation**, one
contradicts the product, and one has a premise the code does not share.

| Case | Problem | Action |
|---|---|---|
| `TRV-04` "Extra minutes per journey" | setting removed — `travel_slack_min` dropped (`database/migrations/1794700000000-RouteOptimizationMvp.ts:25`); `docs/adr/0019:15` records the removal ("one cushion cannot be charged twice"). Zero `extraMinutes`/`slack` hits remain in `api/src` | **drop or reword** to the Minimum Gap + per-Service Buffer, already pinned at `unit/travel-gate.test.ts:864-880` |
| `GEO-03` "Nearest first" | Route Priority removed (`docs/adr/0019:13`, `CONTEXT.md:169`); the column and its tests are gone | **drop** |
| `GEO-04` "Farthest first" | same removal | **drop** |
| `GEO-05` "max extra travel affects suggestion, not availability" | contradicts the product (§3.3) | **reword** to name either Maximum Travel Time (a hard refusal) or Geographic Grouping (reorder only) |

Two smaller wording corrections, both now pinned as-is with a comment:

- **`SYS-02`** — "reset does not delete persisted bookings" is true of the **rows** but not the
  **status or the mirror** (§1.4).
- **`SYS-05`** — "never create or offer a request for a past time" is contradicted for a
  **request-only** Service, which still captures one (`unit/internal-provider-create.test.ts:3059-3064`).
  Note also that the Auto-book write path **throws** `SLOT_UNAVAILABLE` rather than returning a
  failure result, so the assertion shape matters.

---

## 6. Product defects found

Reported rather than patched — each is a behaviour change needing an owner's decision. The
exception is SYS-07, which wave 3 fixed.

1. **`SYS-07`** - fixed in wave 3 (§3.1).
2. **`AVL-01`** — no opening-hours gate on the request path; an Auto-book service can capture an
   out-of-hours Request (§3.2).
3. **`SYS-02`** — a conversation reset cancels live Bookings and deletes their calendar mirrors,
   which is broader than "clear conversation state, keep bookings" (§1.4).
4. **`PRC-12` / `sync-reconciler.ts:311`** — the discount is re-derived at reconcile time with its
   own `now`, so a window opening or closing between booking and reconcile can change the price on
   the calendar mirror relative to the emailed price (§2.1).

One incidental, unpinned: `booking/customer-change-policy.ts:163-165` sets the customer-facing
`customerMessage` to *"Please contact the business directly."* while the model-facing `message` in
the same function forbids sending the customer to the business. `unit/booking-public-messages.test.ts:110-121`
hand-builds its `BookingError` rather than calling the factory, so that copy is unasserted.

---

## 7. Definition of done

- `cd api && npx tsc --noEmit` clean.
- `npm run lint` exit 0, with no new warnings from added files.
- Every new test title carries its case ID in square brackets.
- No production file modified. Defects reported, not fixed.
- Any test that could pass for the wrong reason states in a comment **why it cannot** — and where a
  test replaces a non-discriminating one, **prove it by breaking the behaviour and watching it fail**
  (that is how `SRV-07` was verified: zero the buffers, the test fails, restore).
- The traceability matrix updated, including anything that turned out to be `RESTATE` or blocked.
- **Do not mark a case covered because a nearby test exists.** Three `it()` titles in this area
  over-claim their bodies; read the assertions.
