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
| Closed by this work (`GAP`/`PARTIAL` with a delivered test) | 38 |
| Still open (audited, test not yet written) | 1 — AVL-01, blocked on a product decision (§11) |
| `EVAL` — measured by the live suite, which never runs in CI | 5 — SYS-03, SYS-04, and the model half of BK-02, BK-08 and SRV-02 |
| `RESTATE` — drop or reword the case | 4 |
| `BUG` — product defect found, left unfixed | 3 |

Several closed rows carry a named residual clause. A residual is written into the row rather than
rounded up, so `COVERED` here always means "a test would fail if this broke", never "near enough".

"Verified to fail when …" in a row means somebody broke that behaviour and watched the test go
red. Five of those breaks were re-run during the merge review — BK-07, AVL-09, MOD-06, GEO-01's
single-day guard, and BK-03's new reuse assertion — and each reproduced the failure the row
describes. The rest are the recorded claim of the test's own author, written in the file beside
the assertion it defends.

**Delivered in three waves** — one shared harness, 12 vitest files holding 87 passing tests, and one
live eval script that no CI job can reach. Waves 1 and 2 touched no production code; wave 3 is the
first that does, because the two cases it closes are defects rather than gaps.

Wave 1, the audit and the first five files:

| File | Tests | Closes |
|---|---|---|
| `src/__tests__/helpers/booking-plan-harness.ts` | — | The fixture layer this plan needed: real Postgres, calendar-port double, email ledger readers, per-test seeding |
| `src/__tests__/integration/booking-plan-harness.test.ts` | 12 | Harness self-validation; the `EXCLUDE USING gist` constraint behind CAL-01/02/04 |
| `src/__tests__/unit/booking-plan-rules.test.ts` | 17 | **AVL-07, AVL-08** (previously zero coverage at every layer), **SRV-07** (replaces a test that could not fail), AVL-12, AVL-13, AVL-02, AVL-03, SRV-09 |
| `src/__tests__/integration/booking-plan-system.test.ts` | 6 | **CON-01** (the only race-proof guarantee, never exercised), AVL-17, SYS-05 |
| `src/__tests__/integration/booking-plan-lifecycle.test.ts` | 4 | **BK-06 + CAL-07** (three-surface time agreement, never bound together), BK-01 row delta, BK-02 deterministic half |

Wave 2, written by eight parallel authors and merged into one branch:

| File | Tests | Closes |
|---|---|---|
| `src/__tests__/integration/booking-plan-false-success.test.ts` | 2 | **BK-07**, the false-success guard driven end to end through the real agent loop |
| `src/__tests__/integration/booking-plan-changes.test.ts` | 9 | **MOD-01, MOD-02, MOD-03, MOD-04, MOD-06, MOD-07, MOD-08** on persisted rows and the calendar port |
| `src/__tests__/integration/booking-plan-requests.test.ts` | 6 | **SRV-04, SYS-02, CAL-06** (state half) on real rows |
| `src/__tests__/integration/booking-plan-persistence.test.ts` | 4 | **SRV-22, SRV-11, SRV-02** (no-write half) |
| `src/__tests__/integration/booking-plan-notifications.test.ts` | 10 | **PRC-12, SRV-14, SYS-09, SYS-08, BK-03** on the calendar entry and the committed email |
| `src/__tests__/integration/booking-plan-availability.test.ts` | 11 | **AVL-09, TRV-05, GEO-01** on the offer path |
| `src/__tests__/integration/booking-plan-outlook.test.ts` | 2 | **OUT-01**, a booking through a Microsoft-typed adapter |
| `src/__tests__/live/booking-eval.ts` | 5 cases, not vitest | SYS-03, SYS-04, and the model half of BK-02, BK-08, SRV-02. Run with `npm run eval:booking-plan`; no CI job can reach it |

Wave 3, the two cases waves 1 and 2 left as defects:

| File | Tests | Closes |
|---|---|---|
| `src/__tests__/integration/booking-plan-truth-guard.test.ts` | 12 | **SYS-07** and **CAL-06** (reply half), one root cause: run state that said something happened when it had not. Changes `agent/agent.service.ts`, `agent/tools/capture-lead.tool.ts` and `guardrails/output-validation.ts` |

The headline: **roughly 40% of the plan was already pinned.** The valuable remainder was
concentrated in cross-surface agreement, the request/change-policy persistence path, and a set
of engine boundaries that had never been exercised. All three waves are now merged.

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
| BK-03 supplied information reused | P1 | `COVERED` | Phone reuse pinned (`unit/internal-provider-create.test.ts:555`, `:1367-1374`); the email half is now `integration/booking-plan-notifications.test.ts:540-609`, which books once with an address, then reschedules WITHOUT supplying one and asserts the stored address still receives the invite. Verified to fail when `internal.provider.ts:4658` stops reading the stored address. Residual: the NAME clause is still prompt prose only. |
| BK-04 preferred time survives a follow-up | P0 | `COVERED` | `unit/builtin-tools.test.ts:644-671`, twin `:675-698`; engine `unit/unoffered-times.test.ts:405-440`. |
| BK-05 final availability rechecked before write | P0 | `COVERED` | `unit/internal-provider-create.test.ts:860-866` (external busy → `SLOT_UNAVAILABLE`), `:755-765` (23P01), alternatives `:727-753`. |
| BK-06 result time equals confirmed time | P0 | `PARTIAL` | `displayTime` pinned (`unit/internal-provider-create.test.ts:352`, `:359-361`) but **no test bound row + calendar + email to one local hour**, and the real-DB `start_utc` was never asserted. Three-surface binding DELIVERED in `integration/booking-plan-lifecycle.test.ts`, which closes CAL-07 too. |
| BK-07 no false success when the write fails | P0 | `COVERED` | `integration/booking-plan-false-success.test.ts:190` drives the real agent loop against a real Availability Rule, lets the scripted model claim success on a refused write, and asserts the `messages` row the customer actually received; control at `:259`. Verified to fail when `agent/agent.service.ts:1691` ships the model's own words instead of the safe fallback. Before this, `state.bookingRecorded` was only ever asserted TRUE (`unit/agent-service.test.ts:2251`) and every guard test hand-supplied `validationContext` (`integration/guardrails-output-gate.test.ts:96`, `:110`). |
| BK-08 no silent manual-request fallback | P0 | `COVERED` | `unit/booking-prompt-behaviour.test.ts:1123-1131`, `:1237-1241`, `:1329-1333`, `:1186-1193`; write path `unit/internal-provider-create.test.ts:3236-3240` (`REQUEST_BEFORE_CHECK`). |

## 3. Service configuration (§6)

| Case | Pri | Verdict | Evidence / new test |
|---|---|---|---|
| SRV-01 single clear service match | P1 | `COVERED` | `unit/find-bookable-service.test.ts:49`, `:27-31`. |
| SRV-02 ambiguous match asks once | P1 | `COVERED` (no-write half) + `EVAL` (ask count) | `SERVICE_REQUIRED` is pinned (`unit/find-bookable-service.test.ts:54`). The pre-clarification no-write half is now `integration/booking-plan-persistence.test.ts:242-299`: both the confirm path and the request path refuse, and the tenant holds zero Booking rows; control at `:301`. The ASK COUNT stays `EVAL` — it is a conversational property, measured at `live/booking-eval.ts:563`. |
| SRV-03 no active matching service | P0 | `COVERED` | `unit/internal-provider-create.test.ts:877-883`, copy `:1023-1040`. |
| SRV-04 request-only creates a Request | P0 | `COVERED` | `integration/booking-plan-requests.test.ts:127-207` asserts the persisted `status='request_created'` row with `requestKind='new'` and no confirmed booking; control at `:181` books the identical fixture on auto, so the MODE is the cause. Before this, only the TS `requested: true` flag was asserted (`unit/internal-provider-create.test.ts:1052-1060`). |
| SRV-05 fixed duration | P0 | `COVERED` | `unit/internal-provider-create.test.ts:1105`, `:1153`; `unit/service-duration.test.ts:59`. |
| SRV-06 customer chooses duration | P1 | `COVERED` | `unit/service-duration.test.ts:84-97`; `unit/internal-provider-create.test.ts:1111-1165`. Residual: availability is never pinned to the chosen length. |
| SRV-07 service buffer before/after | P0 | `GAP` — **and the existing test cannot fail** | The only buffer test (`unit/slot-engine.test.ts:115-127`) passes with **both buffers zeroed**, so prep/cleanup time could be lost with the suite green. Discriminating test DELIVERED in `unit/booking-plan-rules.test.ts` — verified to FAIL when the buffers are zeroed. |
| SRV-08 service minimum notice | P0 | `COVERED` | `unit/slot-engine.test.ts:56`; `unit/internal-provider-create.test.ts:2872`, `:3043`. |
| SRV-09 service max horizon | P0 | `PARTIAL` | Bound pinned only at DAY level ~11h inside it (`unit/slot-engine.test.ts:312`), so flipping the comparator (`slot-engine.ts:285`) kept every test green. Exact-instant test DELIVERED in `unit/booking-plan-rules.test.ts`. |
| SRV-10 price display "No price" | P1 | `COVERED` | `unit/service-discount.test.ts:112-117`; `unit/booking-prompt-behaviour.test.ts:640-661`. |
| SRV-11 required intake question | P0 | `COVERED` | `integration/booking-plan-persistence.test.ts:193-239` asserts `intake_answers` on the CONFIRMED row, keyed by the question's server-minted uuid, with an invented key dropped. Persistence used to be pinned on the Request path only (`unit/internal-provider-create.test.ts:1606-1614`). |
| SRV-12 optional intake still asked | P1 | `PARTIAL` | "Still asked" is prompt text only (`unit/booking-prompt-behaviour.test.ts:736`); no behavioural test. |
| SRV-13 "Ask this" OFF | P1 | `COVERED` | `unit/booking-prompt-behaviour.test.ts:706-805`; behavioural `unit/internal-provider-create.test.ts:614`. |
| SRV-14 "Show on my calendar" OFF | P1 | `COVERED` | `integration/booking-plan-notifications.test.ts:252-312`: the hidden answer is stored on the row, absent from the calendar description and from the owner email, while a SHOWN answer is present in both — and the customer email carries no intake at all. The calendar clause was already pinned (`unit/booking-prompt-behaviour.test.ts:771`); the email clause was unasserted. |
| SRV-15 at my business location | P1 | `COVERED` | `unit/booking-venue-and-split.test.ts:262-268`; `unit/service-location-mode.test.ts:232`. |
| SRV-16 video call meeting link | P0 | `COVERED` | `unit/internal-provider-create.test.ts:780-784`, `:844-858`, `:787-800`. |
| SRV-17 phone call service | P0 | `COVERED` | `unit/internal-provider-create.test.ts:1324-1334`, `:1367-1374`; `unit/booking-venue-and-split.test.ts:312-320`. |
| SRV-18 something else / no location | P1 | `COVERED` | `unit/booking-venue-and-split.test.ts:323-338`, `:188-199`. (Conference-off half of `custom` is INFERRED — the test uses `in_person`.) |
| SRV-19 at customer location needs full address | P0 | `COVERED` | `unit/contact-fields.test.ts:105-121`; `unit/internal-provider-create.test.ts:2593-2600`; `unit/booking-venue-and-split.test.ts:233-256`. |
| SRV-20 required customer phone | P0 | `COVERED` | `unit/internal-provider-create.test.ts:1277-1284` (`PHONE_REQUIRED`, no INSERT), `:1324-1334`. |
| SRV-21 file upload optional | P1 | `COVERED` | `unit/booking-prompt-behaviour.test.ts:270-287`; `unit/internal-provider-create.test.ts:1248-1264`. |
| SRV-22 uploaded file survives | P0 | `COVERED` | `integration/booking-plan-persistence.test.ts:110-190` asserts the persisted `uploaded_files` jsonb re-read from Postgres AND the `uploadedFileSnapshots` projection through `adminListBookings`, with a `scanning` upload as the negative control. Residual, recorded by the test itself at `:129-134`: the READY filter has two layers (`upload.service.ts:748`, `internal.provider.ts:2688`) and breaking either alone leaves this test green, so it guards the pair, not each layer. |
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
| PRC-12 discount consistent through booking | P0 | `COVERED` | `integration/booking-plan-notifications.test.ts:150-249`: a real `createBooking` on a 20%-off EUR 100 Service puts `Price: €80` on both carriers — the calendar description and the committed confirmation email — and `€100` on neither. **There is no Booking price column**, so those two surfaces are the whole record. Verified to fail when `booking/pricing/service-discount.ts:121` stops applying the discount. Residual, unchanged and NOT closed by a test: `sync-reconciler.ts:311` re-derives the discount at reconcile time with its own `now` (§11, defect 4). |

## 5. Availability and global rules (§8)

| Case | Pri | Verdict | Evidence / new test |
|---|---|---|---|
| AVL-01 time before opening rejected | P0 | `BUG` + `PARTIAL` | The offer side is pinned (`unit/slot-engine.test.ts:45`; `unit/agent-service.test.ts:1726`). But the plan's "no request fallback" clause is **not enforced server-side**: `internal.provider.ts:2414-2443` gates past / too_soon / too_far / closed-day / service-cap / no-check and **not** an out-of-hours hour on an open day, which `docs/booking-rules.md:26-28` explicitly forbids. Enforced by prompt copy alone. See §11. |
| AVL-02 always open 24/7 | P0 | `PARTIAL` | `unit/slot-engine.test.ts:149`; every fixture pairs `always_open` with an **empty** grid, so a mode that failed to bypass a configured grid would pass. DELIVERED in `unit/booking-plan-rules.test.ts`. |
| AVL-03 day-specific hours | P0 | `PARTIAL` | Tuesday-opens-at-12:00 was pinned with **injected** slots (`unit/internal-provider-create.test.ts:2973`, `unit/agent-service.test.ts:1971`). Engine-level test with two differing weekdays added in `unit/booking-plan-rules.test.ts`. |
| AVL-04 exact end allowed | P0 | `COVERED` | `unit/slot-engine.test.ts:45`; `unit/business-capacity.test.ts:44`. |
| AVL-05 overrun blocked | P0 | `COVERED` | `unit/slot-engine.test.ts:45`, `:211`; `unit/closure-ranges.test.ts:79`. |
| AVL-06 closed weekday | P0 | `COVERED` | `unit/slot-engine.test.ts:427-438`; write path `unit/internal-provider-create.test.ts:3161`. |
| AVL-07 multiple availability blocks | P0 | `GAP` | **Nothing called the engine with a two-window day at any layer.** A regression could offer appointments inside the owner's lunch break with the suite green. DELIVERED in `unit/booking-plan-rules.test.ts`. |
| AVL-08 duration cannot cross a gap | P0 | `GAP` | Same — no fixture with a gap after a window end. DELIVERED in `unit/booking-plan-rules.test.ts`. |
| AVL-09 duration cannot cross closing | P0 | `COVERED` | `integration/booking-plan-availability.test.ts:210-282` drives `checkAvailability` with a 60-minute Service on a 30-minute grid: 16:00 is the last start offered, 16:30 never appears, every offered span really is 60 minutes, and the duration-30 control at `:262` gets 16:30 back. Verified to fail (both cases, control green) when `booking-providers/slot-engine.ts:273` validates the START against closing instead of the END. |
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
| CAL-06 disconnected calendar | P0 | `COVERED` (state + reply) | State half: `integration/booking-plan-requests.test.ts:340-408` — an Auto-book Service on a business with NO credential persists `status='request_created'`, confirms nothing and writes no mirror; the control at `:383` seeds the credential and the same call confirms, so the credential is the cause. Reply half, closed here: `integration/booking-plan-truth-guard.test.ts:290` drives the real agent loop over that same fixture, lets the scripted model announce a confirmation twice, and asserts the `messages` row the customer received is the safe fallback; the control at `:334` seeds the credential and the same script ships the confirmation unchanged. On the same Request, `:367` shows that the loop also stops the booked claims the output gate leaves out (Dutch "je afspraak is bevestigd", "I've scheduled", "successfully booked"), and `:396` shows that the honest "your booking has been submitted" ships unchanged. `:427` shows that a captured lead does not stop the nudge for "I'll go ahead and book". The defect behind it was `agent.service.ts:2225-2233`, which set `state.bookingRecorded` from `result.success` alone — true for the `CALENDAR_NOT_CONNECTED` downgrade — so the false-confirmation guard stood down. The flag is now set from `requested` in the result. Verified to fail when that split is reverted to the old single assignment. Both files restore the real credential check, because the shared harness stub answers "healthy" whether or not a credential row exists (`helpers/booking-plan-harness.ts:509`, whose comment now says so). |
| CAL-07 row + calendar + email agree | P0 | `GAP` | **Nothing on the same value across surfaces**: the calendar start was never asserted, the email's local hour was asserted nowhere, and the real-DB `start_utc` was never checked. Closed by BK-06 in `integration/booking-plan-lifecycle.test.ts`. |

## 7. Reschedule and cancellation (§10)

| Case | Pri | Verdict | Evidence / new test |
|---|---|---|---|
| MOD-01 reschedule auto | P0 | `COVERED` | `integration/booking-plan-changes.test.ts:181-226`: the row moves to the new local hour with `sequence + 1`, the mirror is PATCHED to the same new hour on the recorded event id, and no second row or second invite appears. Verified to fail when the mirror is written from the old `startUtc`. The old pin used `objectContaining({location…})` (`unit/internal-provider-reschedule-cancel.test.ts:606-637`), which passes against an unchanged start. |
| MOD-02 reschedule request | P0 | `COVERED` | `integration/booking-plan-changes.test.ts:228-276`: a real `request_created` row with `requestKind='reschedule'` and `relatedBookingId`, the requested time on the request row, and the original re-read by SQL to prove `startUtc`, `status` and `sequence` are untouched. Verified to fail when the request branch also UPDATEs the original, which the pre-existing flag assertion at `:1472-1479` cannot see. |
| MOD-03 reschedule not allowed | P1 | `COVERED` | `integration/booking-plan-changes.test.ts:278-351`: `CHANGE_NOT_ALLOWED` with machine-readable `details`, the original untouched by SQL, no Request row, and **no human summoned** — zero `handoff_requests` rows plus a spy on the real `EscalationTool`. The cutoff twin at `:311` derives the expected duration through the product's own `spokenChangeCutoff`. Every earlier no-handoff pin was guidance copy. |
| MOD-04 approved reschedule verified later | P1 | `COVERED` | `integration/booking-plan-changes.test.ts:353-394`: the later turn reads `listBookings`, whose `pendingRequest` projection reports the change as pending while `displayTime` still shows the appointment that stands; both are derived through the product's own formatter, and no handoff row is written for a status question. |
| MOD-05 false planning conflict | P0 | `COVERED` | `unit/internal-provider-reschedule-cancel.test.ts:738-749`, `:408-420`. Deliberately not repeated in the new file (`changes.test.ts:33-34`). |
| MOD-06 cancellation auto | P0 | `COVERED` | `integration/booking-plan-changes.test.ts:396-424`: the row is cancelled with `sequence + 1` AND the mirror is deleted, matched on the event id the create recorded. Verified to fail (`expected [] to have a length of 1`) when the `syncCalendarCancel` call at `internal.provider.ts:4755` is removed. `deleteEvent` used to be a bare `vi.fn()` (`unit/internal-provider-reschedule-cancel.test.ts:103`). |
| MOD-07 cancellation request | P0 | `COVERED` | `integration/booking-plan-changes.test.ts:426-456`: a `request_created` row with `requestKind='cancel'` carrying the appointment's own span, while the original stays confirmed, keeps its sequence and keeps its live mirror. The old pin was tool level with a mocked provider (`unit/builtin-tools.test.ts:1833-1846`). |
| MOD-08 cancellation not allowed | P1 | `COVERED` | `integration/booking-plan-changes.test.ts:458-509`: refusal by code, the booking still confirmed BY SQL, no Request, the mirror still live, and no handoff row or escalation call; cutoff twin at `:483`. The old pin asserted only that a mocked `cancelBooking` was never called (`unit/builtin-tools.test.ts:1848-1864`). |

## 8. Travel time and geography (§11)

| Case | Pri | Verdict | Evidence |
|---|---|---|---|
| TRV-01 address before route check | P0 | `COVERED` | `unit/internal-provider-create.test.ts:2614-2618`, `:2593-2600`; refusal precedes placement at `:2596`. |
| TRV-02 travel from previous appointment | P0 | `COVERED` | `unit/internal-provider-create.test.ts:2644-2656`; `unit/travel-gate.test.ts:100-110`. |
| TRV-03 travel to next appointment | P0 | `COVERED` | `unit/travel-gate.test.ts:113-121`, `:406-420`. |
| TRV-04 extra minutes per journey | P1 | **`RESTATE`** | **Removed feature.** `travel_slack_min` was dropped (`database/migrations/1794700000000-RouteOptimizationMvp.ts:25`) and `docs/adr/0019-maximum-travel-time-is-a-limit.md:15` records the removal ("one cushion cannot be charged twice"). Zero `extraMinutes`/`slack` hits remain in `api/src`. Replacement is `minGapMin` + per-Service Buffer, already pinned (`unit/travel-gate.test.ts:864-880`). |
| TRV-05 start day from own address | P1 | `COVERED` | `integration/booking-plan-availability.test.ts:299-422` drives `checkAvailability` with a located premises address: a far Base makes 09:00 UNREACHABLE (not merely undecided, which only a located base can prove), a near Base offers it, switching `travelStartFromBase` off restores it, and the recorded leg departs at 08:30 — opening minus the owner's offset — toward the customer. Verified to fail when `travelBaseFor` is forced to `location: { kind: 'unresolved' }`, the state `venue: null` produces. |
| TRV-06 minutes leave before opening | P1 | `COVERED` | `unit/travel-base-departure.test.ts:51-62`, `:45`, `:143-160`. |
| GEO-01 grouping reorders, never invalidates | P1 | `COVERED` | Engine level `unit/apply-grouping.test.ts:45-52`, `:171-182`; `unit/slot-ordering.test.ts:55-63`. The provider WIRING is now `integration/booking-plan-availability.test.ts:438-581`, driven with `travelGroupingPeriod: 'full_day'`: same times in a different order, the cheapest insertion first on geometry rather than a hand-picked table, no promotion of a time the gate could not confirm, and grouping off for a two-day range. Verified to fail when `pilotOn` is forced false, and the single-day case verified to fail when `singleDay` is forced true (`internal.provider.ts:926-928`). |
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
| SYS-02 reset does not delete persisted bookings | P0 | `COVERED` (the real contract) + `BUG` (the plan's premise) | **The plan's premise is wrong, and the test pins the code.** A reset does not delete rows, but it does **cancel** live Bookings (`services/conversation-reset-state.ts:255-291`) and **delete their calendar mirrors** (`:121-131` → `calendar-sync.ts:236`). `integration/booking-plan-requests.test.ts:209-337` asserts exactly that: the row survives, its status becomes `cancelled` with `sequence + 1`, the reminder jobs are emptied, `intake_answers` survive, and the mirror delete matches the event id the create recorded; the control at `:314` proves an empty session deletes nothing. Verified to fail when `syncCalendarCancel` is stubbed the way `integration/conversation-reset.test.ts:49-51` stubs it. The wording question stays open for the plan's author (§10). |
| SYS-03 Dutch wins on ambiguous greeting | P1 | `EVAL` + `PARTIAL` | The rule is **prompt text only** (`config/bot-language.ts:39-51`) — there is no server gate, so a deterministic assertion cannot prove the answer's language. Prompt pinned (`unit/booking-placeholders.test.ts:174-188`); behaviour measured in the live suite. |
| SYS-04 customer can switch language | P1 | `EVAL` + `PARTIAL` | Same: snapshot pins the clause (`unit/prompt-composition-characterization.test.ts:83`); no turn-level assertion possible deterministically. Live suite. |
| SYS-05 past-time guardrail | P0 | `COVERED` + contradicted clause | Past excluded and refused (`unit/slot-engine.test.ts:56-65`, `unit/internal-provider-create.test.ts:3051-3057`); driven end to end in `integration/booking-plan-system.test.ts`. The clause "no request for a past time" is **contradicted** for a request-only Service (`unit/internal-provider-create.test.ts:3059-3064` still captures one), so the plan wording needs a correction (§10). |
| SYS-06 broad time preference respected | P1 | `COVERED` | `unit/clock-window.test.ts:11-16`; `unit/day-part.test.ts:5-8`; chips `unit/agent-service.test.ts:1930-1967`. |
| SYS-07 no false request-forwarding claim | P1 | `COVERED` (on the condition below) | Closed, not deferred: `docs/booking-rules.md:223` and `:225` already decide it. **The condition.** SYS-07 holds on every tenant whose bot has a tool that can record a request (`capture_lead`, `escalate_to_human`, or a booking tool). There, the in-loop request guard nudges once and then sends a safe fallback, also in the default shadow mode. A bot with none of these tools has only the output gate. That gate stops the claim only when the tenant sets guardrails to enforce. In shadow mode it logs `fake_request_confirmation` and still sends the reply. **The mechanism.** `claimsBookingDone` still excludes request language on purpose, and the missing half was STATE — `guardrails/output-validation.ts` now carries `requestRecorded` beside `bookingRecorded` plus a `claimsRequestForwarded` matcher (English, Dutch, French). `agent.service.ts` sets the new flag only when a Request, lead or handoff row is really written: `capture_lead` counts only when it reports `captured`. The flag also carries to later turns of the same conversation through `chat_sessions.metadata.requestOnRecord`, so an honest restatement passes. `unit/guardrails-output-validation.test.ts:266` still asserts `"Your request has been submitted."` PASSES, now with `requestRecorded: true`, so it passes for the reason that makes it true; the false-positive case at `:331` keeps "I'll forward your request to our business owner" and "I'll go ahead and request your phone number" legal. End to end at `integration/booking-plan-truth-guard.test.ts:456`: a bot with no tool that can record a request claims the request was forwarded with no tool call, and the customer reads the tenant fallback while `guardrail_output_logs` records `fake_request_confirmation`; the control at `:485` calls `capture_lead` first and the same sentence ships unchanged. `:510` pins the shadow-mode half: the loop sends the safe fallback, and its control at `:526` records the lead after the nudge. `:548` pins the later turn: the restatement ships and the bot stays on. Verified to fail when the new check is removed. |
| SYS-08 general booking email info + attachments | P1 | `COVERED`; enumerated end to end | Template level `unit/booking-email-template.test.ts:93-136`, negations `:171-199`. The enumeration is now `integration/booking-plan-notifications.test.ts:389-537`: the extras reach the customer on a confirmed create, on an owner-accepted request, on a reschedule and on an invite re-issued to a corrected address, and are absent from a cancellation. "Every booking email" is no longer inferred from one flag. Residual, stated at `:385-387`: the ATTACHMENT files are not exercised, because they come from object storage through the same `method` gate as the text. |
| SYS-09 preparation instructions preserved | P1 | `COVERED` | `integration/booking-plan-notifications.test.ts:316-362`: the Service's `preparationInstructions` reach the committed customer confirmation email, and are absent from the cancellation email. Before this, no test ever passed `preparationInstructions` to `sendBookingEmail`, so the card at `booking-email.ts:333-338` was rendered by nothing. Both guards had to be broken together to make the negative fail, which the test records. |
| OUT-01 Outlook smoke test | P1 | `COVERED` (provider-agnostic path) | `integration/booking-plan-outlook.test.ts:260-392`: a booking on a Microsoft `CalendarCredential` auto-confirms rather than downgrading, the mirror is written through a Microsoft-typed adapter, the `BookingReference` row records `providerType='microsoft'` and the id the provider minted, and an Outlook busy interval refuses a slot while a free one on the same day books. Residual, stated by the file at `:14-26`: nothing here speaks Graph. The wire format stays covered only by `unit/outlook-events-service.test.ts` and `unit/outlook-calendar-service.test.ts`, and the real `microsoftProvider` wiring by `unit/calendar-provider.test.ts`. |

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

## 11. Product defects found (4, one now FIXED)

Reported rather than patched, because each is a behaviour change that needs an owner's decision.
The exception is SYS-07, whose decision `docs/booking-rules.md:223-225` had already taken.

1. **SYS-07 — the output guard excluded request-shaped claims. FIXED** (wave 3). A false "your
   request has been forwarded" claim reached the customer, and a test asserted the sentence was
   permitted. The rule was never open: `docs/booking-rules.md:225` calls announcing an act you
   did not perform a false confirmation, and `:223` says `CONFIRMATION_REQUIRED` is not a
   Booking. The guard now judges a request claim against `requestRecorded`, and the same root
   cause closed CAL-06's reply half. See both rows for the tests and the falsification. The
   SYS-07 row states the condition under which the fix holds.
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

- **Case IDs live in the test NAME**, in square brackets: either on the `it` (`it('[AVL-07] a lunch
  break is not bookable', …)`) or on the `describe` that wraps it (`describe('[MOD-01] an auto
  reschedule moves the appointment and its mirror', …)`). Wave 1 puts it on the `it`; most of
  wave 2 puts it on the `describe`. The full test name therefore always carries the ID, and a
  reporter run re-derives this matrix mechanically — but a plain source grep for `it('[` misses
  the wave-2 cases, so grep the reporter output, not the files.
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

Honest open list, so this matrix is not mistaken for completion. Everything the three waves closed
has moved into the tables above with a `file:line`; what follows is what is genuinely left.

**Blocked on a product decision, not on test effort** (§11). Until the decision lands, a test could
only pin the current, contradicted behaviour:

1. **AVL-01** — no opening-hours gate on the request path, so an Auto-book Service can capture an out-of-hours Request. Forbidden by `docs/booking-rules.md:26-28`, enforced by prompt copy alone.

SYS-07 and CAL-06's reply half were on this list and are now closed by wave 3. They were never
blocked: `docs/booking-rules.md:223` and `:225` had already decided both, and the code simply did
not honour the rule.

**Named residuals inside closed rows** (each is written into its row, not rounded away):

- **SRV-22** — the READY filter has two layers and the test guards the pair, not each layer.
- **SYS-08** — the attachment FILES are not read; only the extras text is enumerated.
- **OUT-01** — no Microsoft Graph wire format, and the real `microsoftProvider` wiring is mocked out.
- **PRC-12** — `sync-reconciler.ts:311` re-derives the discount at reconcile time (§11, defect 4).
- **BK-03** — the NAME clause is still prompt prose; the email and phone clauses are pinned.
- **SRV-06, SRV-12, SRV-18, AVL-11, SYS-01** — residuals recorded in their own rows, unchanged by this work.

**Wording corrections owed to the plan's author:** SYS-02 and SYS-05 (§10), plus the four `RESTATE`
cases.

**Built, and outside CI on purpose: the live eval suite.** `api/src/__tests__/live/booking-eval.ts`
covers SYS-03, SYS-04 and the model half of BK-02, BK-08 and SRV-02. It is deliberately not named
`*.test.ts`, so no vitest include and no CI job can reach it; run it with `npm run eval:booking-plan`.
It needs `TEST_DATABASE_URL` always and `OPENAI_API_KEY` only in live mode, creates and drops its
own database, and grades tool calls and rows rather than wording. Two dry modes make it reviewable
without spend: `--dry-run` (all five PASS) and `--dry-run-broken`, which feeds every case the
forbidden behaviour and fails the run unless every grader rejects it. The older
`api/src/__tests__/live/booking-flow-live.ts` remains a manual script with zero assertions and is
not a substitute.
