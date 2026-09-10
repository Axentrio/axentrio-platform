# Booking test plan — traceability matrix

Maps every case in the external **Axentrio AI Booking System Automated Functional Test Plan
v1.0 (8 September 2026)** to what actually verifies it in this repository today.

This document is the audit that came before the tests. It exists because the plan's ~110 cases
are not all the same kind of thing: some are already pinned, some cannot be tested as written
because the feature was removed, and a few contradict the code outright. Writing 110 new tests
without that distinction would have produced duplicate coverage and a handful of tests that
assert behaviour the product does not have.

**Verdict vocabulary**

| Verdict | Meaning |
|---|---|
| `COVERED` | A test exists that would FAIL if this behaviour broke. Cited with `file:line`. |
| `PARTIAL` | Something is pinned, but a specific clause of the case is not. The unasserted clause is named. |
| `GAP` | Nothing would fail. Implemented by this work — see the *New test* column. |
| `EVAL` | Genuinely the model's judgement. A scripted model always obeys, so a deterministic test cannot prove it; covered by the non-CI live suite. |
| `RESTATE` | The plan describes a feature that no longer exists, or wording that contradicts the code. Not automatable as written. |
| `BUG` | The test would fail against current behaviour, i.e. this is a product defect, not a missing test. |

Paths below are relative to `api/` unless stated otherwise.

---

## 1. Status summary

| Verdict | Count |
|---|---|
| `COVERED` — already pinned, no work needed | 46 |
| Closed by this work (`GAP`/`PARTIAL` with a delivered test) | 15 |
| Still open (audited, test not yet written) | 24 |
| `EVAL` — needs the non-CI live suite (not built yet) | 2 |
| `RESTATE` — drop or reword the case | 4 |
| `BUG` — product defect found, left unfixed | 4 |

**Delivered in this change** — 4 new test files, 39 passing tests, no production code touched:

| File | Tests | Closes |
|---|---|---|
| `src/__tests__/helpers/booking-plan-harness.ts` | — | The fixture layer this plan needed: real Postgres, calendar-port double, email ledger readers, per-test seeding |
| `src/__tests__/integration/booking-plan-harness.test.ts` | 12 | Harness self-validation; the `EXCLUDE USING gist` constraint behind CAL-01/02/04 |
| `src/__tests__/unit/booking-plan-rules.test.ts` | 17 | **AVL-07, AVL-08** (previously zero coverage at every layer), **SRV-07** (replaces a test that could not fail), AVL-12, AVL-13, AVL-02, AVL-03, SRV-09 |
| `src/__tests__/integration/booking-plan-system.test.ts` | 6 | **CON-01** (the only race-proof guarantee, never exercised), AVL-17, SYS-05 |
| `src/__tests__/integration/booking-plan-lifecycle.test.ts` | 4 | **BK-06 + CAL-07** (three-surface time agreement, never bound together), BK-01 row delta, BK-02 deterministic half |

The headline: **roughly 40% of the plan was already pinned.** The valuable remainder is
concentrated in cross-surface agreement, the request/change-policy persistence path, and a set
of engine boundaries that had never been exercised.

Two of the delivered tests correct rather than merely extend:
**SRV-07** was verified to FAIL when the buffers are zeroed, which the test it replaces could not do;
**SYS-05** initially asserted `success === false` and "failed" while the product was behaving
correctly, because the write path *throws* `SLOT_UNAVAILABLE` rather than returning a failure —
the test was corrected to the real contract rather than the contract bent to the test.

---

## 2. Core booking lifecycle (§5)

| Case | Pri | Verdict | Evidence / new test |
|---|---|---|---|
| BK-01 require explicit confirmation | P0 | `PARTIAL` | Was a mocked-service CALL count only (`unit/builtin-tools.test.ts:1016-1018`, `:1078`), never a row delta. Row-delta half DELIVERED in `integration/booking-plan-lifecycle.test.ts`. |
| BK-02 no booking from a price-only question | P1 | `GAP` | Zero coverage anywhere. Deterministic half DELIVERED in `integration/booking-plan-lifecycle.test.ts`; model half still needs the live `EVAL`. |
| BK-03 supplied information reused | P1 | `PARTIAL` | Phone reuse pinned (`unit/internal-provider-create.test.ts:555`, `:1367-1374`); name is prompt prose only; **email reuse was asserted nowhere**. Email half **still open**. |
| BK-04 preferred time survives a follow-up | P0 | `COVERED` | `unit/builtin-tools.test.ts:644-671`, twin `:675-698`; engine `unit/unoffered-times.test.ts:405-440`. |
| BK-05 final availability rechecked before write | P0 | `COVERED` | `unit/internal-provider-create.test.ts:860-866` (external busy → `SLOT_UNAVAILABLE`), `:755-765` (23P01), alternatives `:727-753`. |
| BK-06 result time equals confirmed time | P0 | `PARTIAL` | `displayTime` pinned (`unit/internal-provider-create.test.ts:352`, `:359-361`) but **no test bound row + calendar + email to one local hour**, and the real-DB `start_utc` was never asserted. Three-surface binding DELIVERED in `integration/booking-plan-lifecycle.test.ts`, which closes CAL-07 too. |
| BK-07 no false success when the write fails | P0 | `PARTIAL` | The guard exists but was never wired end-to-end: `state.bookingRecorded` is only ever asserted TRUE (`unit/agent-service.test.ts:2251`), and every guard test hand-supplies `validationContext` (`integration/guardrails-output-gate.test.ts:96`, `:110`). Wiring test added in `integration/booking-plan-lifecycle.test.ts`. |
| BK-08 no silent manual-request fallback | P0 | `COVERED` | `unit/booking-prompt-behaviour.test.ts:1123-1131`, `:1237-1241`, `:1329-1333`, `:1186-1193`; write path `unit/internal-provider-create.test.ts:3236-3240` (`REQUEST_BEFORE_CHECK`). |

## 3. Service configuration (§6)

| Case | Pri | Verdict | Evidence / new test |
|---|---|---|---|
| SRV-01 single clear service match | P1 | `COVERED` | `unit/find-bookable-service.test.ts:49`, `:27-31`. |
| SRV-02 ambiguous match asks once | P1 | `PARTIAL` | `SERVICE_REQUIRED` is pinned (`unit/find-bookable-service.test.ts:54`); the **ask count** and pre-clarification no-write were not. **Still open** — needs a live `EVAL` for the ask count, plus a no-write assertion. |
| SRV-03 no active matching service | P0 | `COVERED` | `unit/internal-provider-create.test.ts:877-883`, copy `:1023-1040`. |
| SRV-04 request-only creates a Request | P0 | `PARTIAL` | Only the TS `requested: true` flag was asserted (`unit/internal-provider-create.test.ts:1052-1060`); the **persisted `status='request_created'` was never asserted**, and no real-DB request row existed in the suite. **Still open** — the provider-level change-policy file is not written yet. |
| SRV-05 fixed duration | P0 | `COVERED` | `unit/internal-provider-create.test.ts:1105`, `:1153`; `unit/service-duration.test.ts:59`. |
| SRV-06 customer chooses duration | P1 | `COVERED` | `unit/service-duration.test.ts:84-97`; `unit/internal-provider-create.test.ts:1111-1165`. Residual: availability is never pinned to the chosen length. |
| SRV-07 service buffer before/after | P0 | `GAP` — **and the existing test cannot fail** | The only buffer test (`unit/slot-engine.test.ts:115-127`) passes with **both buffers zeroed**, so prep/cleanup time could be lost with the suite green. Discriminating test DELIVERED in `unit/booking-plan-rules.test.ts` — verified to FAIL when the buffers are zeroed. |
| SRV-08 service minimum notice | P0 | `COVERED` | `unit/slot-engine.test.ts:56`; `unit/internal-provider-create.test.ts:2872`, `:3043`. |
| SRV-09 service max horizon | P0 | `PARTIAL` | Bound pinned only at DAY level ~11h inside it (`unit/slot-engine.test.ts:312`), so flipping the comparator (`slot-engine.ts:285`) kept every test green. Exact-instant test DELIVERED in `unit/booking-plan-rules.test.ts`. |
| SRV-10 price display "No price" | P1 | `COVERED` | `unit/service-discount.test.ts:112-117`; `unit/booking-prompt-behaviour.test.ts:640-661`. |
| SRV-11 required intake question | P0 | `PARTIAL` | Persistence was pinned on the **Request** path only (`unit/internal-provider-create.test.ts:1606-1614`); `intake_answers` on the **confirmed** INSERT was unasserted. *Not yet closed — see §14.* |
| SRV-12 optional intake still asked | P1 | `PARTIAL` | "Still asked" is prompt text only (`unit/booking-prompt-behaviour.test.ts:736`); no behavioural test. |
| SRV-13 "Ask this" OFF | P1 | `COVERED` | `unit/booking-prompt-behaviour.test.ts:706-805`; behavioural `unit/internal-provider-create.test.ts:614`. |
| SRV-14 "Show on my calendar" OFF | P1 | `PARTIAL` | Calendar clause pinned (`unit/booking-prompt-behaviour.test.ts:771`); the **email clause was entirely unasserted**. *Not yet closed — see §14.* |
| SRV-15 at my business location | P1 | `COVERED` | `unit/booking-venue-and-split.test.ts:262-268`; `unit/service-location-mode.test.ts:232`. |
| SRV-16 video call meeting link | P0 | `COVERED` | `unit/internal-provider-create.test.ts:780-784`, `:844-858`, `:787-800`. |
| SRV-17 phone call service | P0 | `COVERED` | `unit/internal-provider-create.test.ts:1324-1334`, `:1367-1374`; `unit/booking-venue-and-split.test.ts:312-320`. |
| SRV-18 something else / no location | P1 | `COVERED` | `unit/booking-venue-and-split.test.ts:323-338`, `:188-199`. (Conference-off half of `custom` is INFERRED — the test uses `in_person`.) |
| SRV-19 at customer location needs full address | P0 | `COVERED` | `unit/contact-fields.test.ts:105-121`; `unit/internal-provider-create.test.ts:2593-2600`; `unit/booking-venue-and-split.test.ts:233-256`. |
| SRV-20 required customer phone | P0 | `COVERED` | `unit/internal-provider-create.test.ts:1277-1284` (`PHONE_REQUIRED`, no INSERT), `:1324-1334`. |
| SRV-21 file upload optional | P1 | `COVERED` | `unit/booking-prompt-behaviour.test.ts:270-287`; `unit/internal-provider-create.test.ts:1248-1264`. |
| SRV-22 uploaded file survives | P0 | `PARTIAL` | Only the mocked-repo INSERT parameter was proven (`unit/internal-provider-create.test.ts:1180-1246`); real persistence and the `uploadedFileSnapshots` read-back (`booking/booking.service.ts:517`) were untested. **Still open.** |
| SRV-23 max bookings per day | P0 | `COVERED`; integration added | `unit/booking-capacity-gates.test.ts:138-165`; `unit/internal-provider-create.test.ts:1066-1094`. Every check was a canned row with no integration test and **no fixture set BOTH a service cap and a business cap**, so "the stricter binds" was unproven. DELIVERED in `integration/booking-plan-system.test.ts`. |
| SRV-24 active / online-bookable flags | P0 | `COVERED` | `unit/find-bookable-service.test.ts:34-55`; `unit/internal-provider-create.test.ts:999`, `:1015`; `unit/booking-catalog-filter.test.ts:41-49`. |

## 4. Pricing and discounts (§7)

| Case | Pri | Verdict | Evidence |
|---|---|---|---|
| PRC-01 fixed price | P1 | `COVERED` | `unit/service-discount.test.ts:119-138`; `unit/internal-provider-create.test.ts:803-818`. |
| PRC-02 starting from | P1 | `COVERED` | `unit/service-discount.test.ts:129`, `:136`. |
| PRC-03 range | P1 | `COVERED` | `unit/service-discount.test.ts:130`, `:137`. |
| PRC-04 on request | P1 | `COVERED` | `unit/internal-provider-create.test.ts:3264`; `unit/service-discount.test.ts:131`. |
| PRC-05 free | P1 | `COVERED` | `unit/service-discount.test.ts:128`; `unit/booking-prompt-behaviour.test.ts:631-668`. |
| PRC-06 percentage, mention ON | P1 | `COVERED` | `unit/booking-prompt-behaviour.test.ts:1804-1817`. |
| PRC-07 percentage, mention OFF | P1 | `COVERED` | `unit/booking-prompt-behaviour.test.ts:1819-1836`, `:1788-1802`. |
| PRC-08 fixed amount discount | P1 | `COVERED` | `unit/service-discount.test.ts:16-36`; `unit/booking-prompt-behaviour.test.ts:1852-1865`. |
| PRC-09 future discount inactive | P1 | `COVERED` | `unit/service-discount.test.ts:40`, `:59`. |
| PRC-10 expired discount inactive | P1 | `COVERED` | `unit/service-discount.test.ts:60`. |
| PRC-11 discount active on the boundary | P1 | `COVERED` | `unit/service-discount.test.ts:58` with false neighbours `:59`/`:60`, so either bound made exclusive fails. |
| PRC-12 discount consistent through booking | P0 | `GAP` | The quote side is pinned (`unit/booking-prompt-behaviour.test.ts:1775-1817`) and the persistence side is pinned **undiscounted** (`unit/internal-provider-create.test.ts:803-818`). `discountEnabled` never appears alongside `createBooking`/`createCalendarEvent`/`sendBookingEmail`. **There is no Booking price column**, so the carriers are the calendar description and the email. *Not yet closed — see §14.* |

## 5. Availability and global rules (§8)

| Case | Pri | Verdict | Evidence / new test |
|---|---|---|---|
| AVL-01 time before opening rejected | P0 | `BUG` + `PARTIAL` | The offer side is pinned (`unit/slot-engine.test.ts:45`; `unit/agent-service.test.ts:1726`). But the plan's "no request fallback" clause is **not enforced server-side**: `internal.provider.ts:2414-2443` gates past / too_soon / too_far / closed-day / service-cap / no-check and **not** an out-of-hours hour on an open day, which `docs/booking-rules.md:26-28` explicitly forbids. Enforced by prompt copy alone. See §13. |
| AVL-02 always open 24/7 | P0 | `PARTIAL` | `unit/slot-engine.test.ts:149`; every fixture pairs `always_open` with an **empty** grid, so a mode that failed to bypass a configured grid would pass. DELIVERED in `unit/booking-plan-rules.test.ts`. |
| AVL-03 day-specific hours | P0 | `PARTIAL` | Tuesday-opens-at-12:00 was pinned with **injected** slots (`unit/internal-provider-create.test.ts:2973`, `unit/agent-service.test.ts:1971`). Engine-level test with two differing weekdays added in `unit/booking-plan-rules.test.ts`. |
| AVL-04 exact end allowed | P0 | `COVERED` | `unit/slot-engine.test.ts:45`; `unit/business-capacity.test.ts:44`. |
| AVL-05 overrun blocked | P0 | `COVERED` | `unit/slot-engine.test.ts:45`, `:211`; `unit/closure-ranges.test.ts:79`. |
| AVL-06 closed weekday | P0 | `COVERED` | `unit/slot-engine.test.ts:427-438`; write path `unit/internal-provider-create.test.ts:3161`. |
| AVL-07 multiple availability blocks | P0 | `GAP` | **Nothing called the engine with a two-window day at any layer.** A regression could offer appointments inside the owner's lunch break with the suite green. DELIVERED in `unit/booking-plan-rules.test.ts`. |
| AVL-08 duration cannot cross a gap | P0 | `GAP` | Same — no fixture with a gap after a window end. DELIVERED in `unit/booking-plan-rules.test.ts`. |
| AVL-09 duration cannot cross closing | P0 | `PARTIAL` | Every fixture had `duration == granularity`, so closing was only ever crossed by a start exactly ON closing; `duration > granularity` (60-min service on a 30-min grid) was never exercised. |
| AVL-10 slot interval 30 off-grid | P1 | `COVERED` | `unit/internal-provider-create.test.ts:698`; `unit/internal-provider-reschedule-cancel.test.ts:731`. |
| AVL-11 slot interval 15 | P1 | `COVERED` | `unit/internal-provider-reschedule-cancel.test.ts:738-748`. Residual: only the reschedule seam. |
| AVL-12 global min notice inherited | P0 | `PARTIAL` | The arithmetic is pinned (`unit/business-capacity.test.ts:157-161`) but **never ENFORCED**: every refusal fixture sets the value on the Service, so a wiring break at `internal.provider.ts:330`/`:2418` left the suite green. Enforcement test added in `unit/booking-plan-rules.test.ts`. |
| AVL-13 global max horizon inherited | P0 | `PARTIAL` | Same shape (`unit/business-capacity.test.ts:160`). DELIVERED in `unit/booking-plan-rules.test.ts`. |
| AVL-14 minimum gap vs external events | P0 | `COVERED` | `unit/internal-provider-create.test.ts:467`, `:489` — busy sourced from the external calendar provider; `unit/busy.test.ts:45-76`. |
| AVL-15 max appointments per day | P0 | `COVERED`; integration added | `unit/internal-provider-create.test.ts:1896-1943`; SQL never executes (canned count). Integration test DELIVERED in `integration/booking-plan-system.test.ts`. |
| AVL-16 max booked hours per day | P0 | `COVERED`; integration added | `unit/internal-provider-create.test.ts:1910`; `unit/booking-capacity-gates.test.ts:237-262`. DELIVERED in `integration/booking-plan-system.test.ts`. |
| AVL-17 pause new online bookings | P0 | `COVERED`; end-to-end added | `unit/internal-provider-create.test.ts:2135`, `:829`, `:3121`. DELIVERED in `integration/booking-plan-system.test.ts`. **Note:** pause does not refuse — it downgrades a would-be auto-confirm into a **Request**, and Requests consume no capacity, so a "pause blocks bookings" assertion about capacity would be wrong. |

## 6. Calendar integration (§9)

| Case | Pri | Verdict | Evidence / new test |
|---|---|---|---|
| CAL-01 exact conflict | P0 | `COVERED` | **Real Postgres** `integration/booking-plan-harness.test.ts` (16 validation tests incl. `excl_chatbot_bookings_slot`); offer side `unit/slot-engine.test.ts:100-113`; write `unit/internal-provider-create.test.ts:861-868`. |
| CAL-02 partial overlap | P0 | `COVERED` | Real Postgres `integration/booking-plan-harness.test.ts`; `unit/slot-engine.test.ts:100-113`. |
| CAL-03 abutting before event | P0 | `COVERED` | `unit/slot-engine.test.ts:100-113` (comment at `:107` names boundary-touching). |
| CAL-04 abutting after event | P0 | `COVERED` | `unit/slot-engine.test.ts:100-113`; `unit/business-capacity.test.ts:94-103`; real DB `integration/booking-plan-harness.test.ts`. |
| CAL-05 contained inside event | P0 | `COVERED` | `unit/slot-engine.test.ts:329-338`; `unit/internal-provider-create.test.ts:443-465`. |
| CAL-06 disconnected calendar | P0 | `PARTIAL` | `unit/internal-provider-create.test.ts:2075`, `:935`, `:3258`. The rule "never tell the customer it is booked" (`modules/booking.module.ts:623`) has no reply-layer test. |
| CAL-07 row + calendar + email agree | P0 | `GAP` | **Nothing on the same value across surfaces**: the calendar start was never asserted, the email's local hour was asserted nowhere, and the real-DB `start_utc` was never checked. Closed by BK-06 in `integration/booking-plan-lifecycle.test.ts`. |

## 7. Reschedule and cancellation (§10)

| Case | Pri | Verdict | Evidence / new test |
|---|---|---|---|
| MOD-01 reschedule auto | P0 | `PARTIAL` | Gate pinned (`unit/builtin-tools.test.ts:1745-1764`); the mirror's **new** start/end was never asserted (`unit/internal-provider-reschedule-cancel.test.ts:606-637` use `objectContaining({location…})`), nor was absence of a duplicate row. **Still open** — the provider-level change-policy file is not written yet. |
| MOD-02 reschedule request | P0 | `PARTIAL` | `unit/internal-provider-reschedule-cancel.test.ts:1472-1522`. "Original untouched" was unasserted — no no-UPDATE check exists on the request path (it does for `not_allowed` `:1424`), and the `it()` title at `:1472` over-claims its body. **Still open** — the provider-level change-policy file is not written yet. |
| MOD-03 reschedule not allowed | P1 | `PARTIAL` | Refusal pinned (`unit/internal-provider-reschedule-cancel.test.ts:1418-1425`), but **no-handoff was copy-only** (`unit/builtin-tools.test.ts:1739`). **Still open** — asserting an absent `HandoffRequest` row is not written yet. |
| MOD-04 approved reschedule verified later | P1 | `PARTIAL` | Listing pinned (`unit/internal-provider-reschedule-cancel.test.ts:851-878`); no later "approved?" **turn** was ever driven, and no handoff-row assertion existed. |
| MOD-05 false planning conflict | P0 | `COVERED` | `unit/internal-provider-reschedule-cancel.test.ts:738-749`, `:408-420`. |
| MOD-06 cancellation auto | P0 | `PARTIAL` | Cancel pinned (`:801-806`); **`syncCalendarCancel` was never asserted** — `deleteEvent` is a bare `vi.fn()` (`:103`). **Still open** — the mirror deletion is still unasserted. |
| MOD-07 cancellation request | P0 | `PARTIAL` | Tool level only (`unit/builtin-tools.test.ts:1833-1846`); no provider-level proof that a `request_created` row is written while the original stays active. **Still open** — the provider-level change-policy file is not written yet. |
| MOD-08 cancellation not allowed | P1 | `PARTIAL` | `unit/builtin-tools.test.ts:1848-1864`; "no request / booking active" was pinned only as "the writer was never called", not by SQL, and no-handoff was copy-only. **Still open** — the provider-level change-policy file is not written yet. |

## 8. Travel time and geography (§11)

| Case | Pri | Verdict | Evidence |
|---|---|---|---|
| TRV-01 address before route check | P0 | `COVERED` | `unit/internal-provider-create.test.ts:2614-2618`, `:2593-2600`; refusal precedes placement at `:2596`. |
| TRV-02 travel from previous appointment | P0 | `COVERED` | `unit/internal-provider-create.test.ts:2644-2656`; `unit/travel-gate.test.ts:100-110`. |
| TRV-03 travel to next appointment | P0 | `COVERED` | `unit/travel-gate.test.ts:113-121`, `:406-420`. |
| TRV-04 extra minutes per journey | P1 | **`RESTATE`** | **Removed feature.** `travel_slack_min` was dropped (`database/migrations/1794700000000-RouteOptimizationMvp.ts:25`) and `docs/adr/0019-maximum-travel-time-is-a-limit.md:15` records the removal ("one cushion cannot be charged twice"). Zero `extraMinutes`/`slack` hits remain in `api/src`. Replacement is `minGapMin` + per-Service Buffer, already pinned (`unit/travel-gate.test.ts:864-880`). |
| TRV-05 start day from own address | P1 | `PARTIAL` | Base-as-predecessor pinned (`unit/travel-gate.test.ts:626-630`); the **offer path** measuring from the Base's own located coordinates is unpinned because every `checkAvailability` fixture passes `venue: null` (`unit/internal-provider-create.test.ts:2559`), leaving `travelBaseFor`'s located branch (`internal.provider.ts:1019-1027`) unexercised. |
| TRV-06 minutes leave before opening | P1 | `COVERED` | `unit/travel-base-departure.test.ts:51-62`, `:45`, `:143-160`. |
| GEO-01 grouping reorders, never invalidates | P1 | `COVERED` | `unit/apply-grouping.test.ts:45-52`, `:171-182`; `unit/slot-ordering.test.ts:55-63`. Residual: the provider wiring is never driven with `groupingPeriod !== 'none'`. |
| GEO-02 route priority Auto | P1 | **`RESTATE`** | No selectable priority exists. Auto Optimize (cheapest insertion first) is the only order (`docs/adr/0019:13`); the behaviour is pinned at `unit/slot-ordering.test.ts:30-36`. Reword to "grouping/insertion order". |
| GEO-03 nearest first | P1 | **`RESTATE`** | **Removed feature.** `travel_route_priority` was dropped with its CHECK constraint (`1794700000000-RouteOptimizationMvp.ts:13-18`); `CONTEXT.md:169` lists nearest-first/farthest-first as removed. Its tests were deleted. |
| GEO-04 farthest first | P1 | **`RESTATE`** | Same as GEO-03. |
| GEO-05 max extra travel affects ranking only | P1 | **`RESTATE`** | The case as worded **contradicts the code**: `maxTravelMin` (Maximum Travel Time) IS a hard refusal for the Agent (`docs/adr/0019:5-7`; asserted at `unit/travel-gate.test.ts:812`, `unit/internal-provider-create.test.ts:2381-2400`). What cannot refuse is **Geographic Grouping**, which only reorders (`ADR-0017`). The plan conflates the two; it must say which it means. |

## 9. Overrides, concurrency, system (§12)

| Case | Pri | Verdict | Evidence / new test |
|---|---|---|---|
| OVR-01 closed date override | P0 | `COVERED` | `unit/slot-engine.test.ts:79-87`, `:168-181`, `:447-460`; `unit/closure-ranges.test.ts:78+`. (Note `integration/bot-ai-settings.test.ts:432` over-claims in its title.) |
| OVR-02 one-off hours override | P0 | `COVERED` | `unit/slot-engine.test.ts:89-98` — weekly hours replaced, not merged. |
| CON-01 two customers race one slot | P0 | `GAP` | The exclusion constraint ships (`1784400000000-CreateInternalSchedulerBookings.ts:57-58`, in the test schema) but **was never exercised**: every 23P01 assertion injects the error into a mocked repository. DELIVERED in `integration/booking-plan-system.test.ts`. |
| SYS-01 reset clears conversational state | P0 | `COVERED` | `integration/conversation-reset.test.ts:405-407`, `:487-528`; real-Redis twin `integration/conversation-reset-redis.test.ts:120-121`. Residual: the "next `Ik wil boeken` turn" in the title is never executed as a turn. |
| SYS-02 reset does not delete persisted bookings | P0 | `BUG` + `PARTIAL` | **The plan's premise is wrong.** A reset does not delete rows, but it does **cancel** live Bookings (`services/conversation-reset-state.ts:255-291`) and **delete their calendar mirrors** (`:121-131` → `booking/booking-providers/calendar-sync.ts:236`), leaving `intake_answers`/`uploaded_files` intact. The calendar half was mocked with no expectation (`integration/conversation-reset.test.ts:49-51`). **Still open** — pinning the reset's real contract is not written yet. |
| SYS-03 Dutch wins on ambiguous greeting | P1 | `EVAL` + `PARTIAL` | The rule is **prompt text only** (`config/bot-language.ts:39-51`) — there is no server gate, so a deterministic assertion cannot prove the answer's language. Prompt pinned (`unit/booking-placeholders.test.ts:174-188`); behaviour measured in the live suite. |
| SYS-04 customer can switch language | P1 | `EVAL` + `PARTIAL` | Same: snapshot pins the clause (`unit/prompt-composition-characterization.test.ts:83`); no turn-level assertion possible deterministically. Live suite. |
| SYS-05 past-time guardrail | P0 | `PARTIAL` + contradicted clause | Past excluded and refused (`unit/slot-engine.test.ts:56-65`, `unit/internal-provider-create.test.ts:3051-3057`), but "no request for a past time" is **contradicted** for a request-only Service (`:3059-3064` still captures). **Still open** — pinning the reset's real contract is not written yet. |
| SYS-06 broad time preference respected | P1 | `COVERED` | `unit/clock-window.test.ts:11-16`; `unit/day-part.test.ts:5-8`; chips `unit/agent-service.test.ts:1930-1967`. |
| SYS-07 no false request-forwarding claim | P1 | `BUG` | **Actively contradicted.** `claimsBookingDone` (`guardrails/output-validation.ts:49-73`, submission regex `:60`) matches BOOKING-shaped claims only, and `unit/guardrails-output-validation.test.ts:232` **positively asserts** that `"Your request has been submitted."` PASSES with `bookingRecorded: false`. So a "forwarded to the owner" lie ships green, guarded by prompt prose alone. This needs a **product decision**, not a test — see §13. |
| SYS-08 general booking email info + attachments | P1 | `COVERED`; enumerated | `unit/booking-email-template.test.ts:93-136`, negations `:171-199`. "Every booking email" was inferred from one flag (`booking-email.ts:423`) rather than enumerated; the end-to-end enumeration is **still open**. |
| SYS-09 preparation instructions preserved | P1 | `PARTIAL` | Calendar body and chat notice pinned (`unit/booking-content.test.ts:55-73`; `unit/booking-preparation-chat.test.ts:76-90`), but **no test ever passed `preparationInstructions` to `sendBookingEmail`**, and the Service→email plumbing (`internal.provider.ts:1648`) was unasserted. **Still open.** |
| OUT-01 Outlook smoke test | P1 | `GAP` | All Outlook coverage is axios-mocked; nothing drove a booking through the microsoft adapter and nothing showed a busy Outlook event preventing a double booking. **Still open.** |

---

## 10. Cases to restate or drop (4)

Send these back to whoever wrote the plan. They cannot be automated because the feature is gone
or the wording contradicts the product.

1. **TRV-04 "Extra minutes per journey"** — the setting was removed (`docs/adr/0019:15`; column
   `travel_slack_min` dropped). Replacement: the business-wide **Minimum Gap** plus the per-Service
   **Buffer**.
2. **GEO-03 "Nearest first"** — Route Priority was removed (`docs/adr/0019:13`, `CONTEXT.md:169`);
   the column and its tests are gone.
3. **GEO-04 "Farthest first"** — same removal.
4. **GEO-05 "Maximum extra travel affects suggestion, not hard availability"** — as worded this
   contradicts the product. **Maximum Travel Time** (`maxTravelMin`) *is* a hard refusal for the
   Agent; it is **Geographic Grouping** that may only reorder. The case must say which of the two
   it means.

Two smaller wording corrections, which the new tests pin as-is with a comment:

5. **SYS-02** says a reset "must not delete real persisted bookings". True for the ROWS, but the
   reset **cancels** live Bookings and **deletes their calendar mirrors**. Decide whether the
   wording or the behaviour is the bug.
6. **SYS-05** says never create or offer a Request for a past time. A **request-only** Service
   still captures one.

## 11. Product defects found (4, all left UNFIXED)

Reported rather than patched, because each is a behaviour change that needs an owner's decision.

1. **SYS-07 — the output guard deliberately excludes request-shaped claims.** A false "your
   request has been forwarded" claim reaches the customer, and an existing test asserts that the
   sentence is permitted. `docs/booking-rules.md:186-231` (customer change policy, confirmation
   and honesty) carries **no `Pinned:` line** — which maps 1:1 onto this and the next finding.
2. **AVL-01 — no opening-hours gate on the request path.** `internal.provider.ts:2414-2443`
   refuses past / too_soon / too_far / closed-day / service-cap / no-check but **not** an
   out-of-hours hour on a day that has hours, so an Auto-book Service can capture a Request for
   08:30 on a 09:00 day. `docs/booking-rules.md:26-28` explicitly forbids that Request and calls
   the invariant load-bearing; it is enforced by prompt copy alone.
3. **SYS-02 — a reset mutates and un-mirrors live Bookings.** Cancel + mirror delete
   (`services/conversation-reset-state.ts:255-291`, `:121-131`) is broader than the plan's
   "clear conversation state, keep bookings". Worth confirming this is intended.
4. **PRC-12 / `sync-reconciler.ts:311` — the discount is re-derived at reconcile time with its own
   `now`.** A discount window opening or closing between booking and reconcile can silently change
   the price on the calendar mirror relative to the price emailed to the customer.

One more, incidental and unpinned: `booking/customer-change-policy.ts:163-165` sets the
customer-facing `customerMessage` to *"Please contact the business directly."* while the
model-facing `message` in the same function forbids sending the customer to the business.
`unit/booking-public-messages.test.ts:110-121` hand-builds its `BookingError` instead of calling
the factory, so that copy is unasserted.

## 12. How the new tests are shaped

- **Case IDs live in the test titles**, in square brackets: `it('[AVL-07] a lunch break is not
  bookable', …)`. That is the traceability key — a case ID in a title can be grepped, so this
  matrix can be re-derived mechanically instead of trusted.
- **State, not wording.** Assertions are about persisted rows, recorded calendar writes, committed
  email payloads, and machine-readable codes (`CONFIRMATION_REQUIRED`, `CHANGE_NOT_ALLOWED`,
  `REQUEST_BEFORE_CHECK`). Exact AI phrasing is asserted nowhere, per the plan's own §1.
- **Two layers, chosen deliberately per case.** Deterministic tests pin the *server gates and
  prompt rules that enforce* a behaviour; the **live suite** (`npm run eval:booking-plan`, not in
  CI) measures what the real model does. A scripted model always obeys, so a deterministic test
  can never prove a model-judgement case — pretending otherwise would be the most expensive kind
  of false confidence in this suite.
- **No injected errors where a real constraint exists.** CON-01 and the calendar-conflict cases run
  against real Postgres and the real `EXCLUDE USING gist` constraint, because injecting a 23P01
  error into a mock proves only the error *handling*, never the *guarantee*.
- **Every fixture is per-test.** `src/__tests__/setup.ts` truncates every table in `afterEach`, so
  a `beforeAll` fixture silently vanishes and a test can pass against an empty database. The shared
  harness documents this.

## 13. Shared harness

`src/__tests__/helpers/booking-plan-harness.ts` is the fixture layer this plan needed and did not
have: it seeds a complete bookable business (Tenant + Bot + Availability Rule + Service +
`BookingSettings`), doubles the `CalendarProvider` port so mirror writes and external busy time are
recorded rather than called, reads the `EmailDelivery` ledger for committed email copy, and does all
wall-clock conversion in one place against `Europe/Brussels`.

Two deliberate design choices:

- It doubles the **real port** (`scheduler/calendar-provider`), typed against the interface rather
  than cast, so it cannot drift from the seam `calendar-sync.ts` actually writes through.
- It seeds busy time as raw SQL, because `blocked_range` is a `tstzrange` guarded by an exclusion
  constraint and is unmapped on the entity. Consequence worth knowing: a booking seeded this way
  carries no buffer expansion, so **buffer behaviour must be asserted at the engine seam
  (`SRV-07`), not against a seeded row.**

## 14. Not yet closed

Honest open list, so this matrix is not mistaken for completion.

**Audited but not yet written** (the highest-value remaining work, in risk order):

1. **BK-07** — the false-success guard wired end-to-end. `state.bookingRecorded` is still only ever
   asserted TRUE, and no test drives a failed write that the model then claims as done. This is
   `docs/booking-rules.md:225` with no pinning test.
2. **SYS-07 and AVL-01** — blocked on a **product decision**, not on test effort (§11). Until that
   decision lands, a test could only pin the current (contradicted) behaviour.
3. **MOD-01…MOD-08** — the change-policy persistence path: real `request_created` rows with
   `requestKind`, "original untouched" by SQL rather than by "the writer was not called", mirror
   update/delete asserted against the port, and **absent `HandoffRequest` rows** on a `not_allowed`
   refusal (every existing no-handoff pin is guidance copy).
4. **SRV-04** — the literal persisted `status = 'request_created'`; no real-DB request row exists.
5. **CON-01's counterpart in the change path** is covered, but **SYS-02** is not: the reset's real
   contract (rows cancelled, mirrors deleted) is still unasserted.
6. **PRC-12** — the discount reaching the calendar description and the email on a real booking.
   Remember there is **no Booking price column**, so those two surfaces are the only carriers.
7. **CAL-06** — the reply-layer "never say confirmed" rule on a disconnected calendar.
8. **SRV-22** — real DB persistence and the `uploadedFileSnapshots` read-back.
9. **SRV-11** — `intake_answers` on the *confirmed* INSERT (only the Request path is pinned).
10. **SRV-14** — the email half of "show on my calendar OFF".
11. **SYS-09** — the customer-email preparation card and the Service→email plumbing.
12. **OUT-01** — no end-to-end Outlook path at all.
13. **SRV-02** — the single-clarification ask count.
14. **BK-03** — email reuse.
15. **AVL-09** — `duration > granularity` crossing closing (every existing fixture had
    `duration == granularity`).
16. **TRV-05** — the offer path measuring from the Base's located coordinates.
17. **GEO-01** — provider wiring with `groupingPeriod !== 'none'`.
18. **SYS-08** — enumerating every confirmation-email kind rather than inferring from one flag.

**Not built: the live eval suite.** `SYS-03` and `SYS-04` are marked `EVAL` because the rule is
prompt text only and a deterministic test cannot prove which language the model answers in — same
for the model half of BK-02 and BK-08. `api/src/__tests__/live/booking-flow-live.ts` remains a
manual script with zero `expect()` that no CI job runs; it is not a substitute.
