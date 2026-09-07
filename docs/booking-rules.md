# Booking rules

Load-bearing invariants. Break one of these and a live conversation goes wrong even if the suite is green.

Terms: `CONTEXT.md` (Service, Booking, Request, Slot, Availability Rule, Business Default, Capacity Ceiling, Buffer, Minimum Gap, Travel Time, Maximum Travel Time, Customer change policy).

Prompt copy lives in `api/src/modules/booking.module.ts`. The engine does not trust the prompt. Server gates and chips are the last word.

If this file and the code disagree, the code and its pinning test win. Update this file in the same change.

---

## Auto-book stays Auto-book

A Service with `bookingMode: auto` confirms through `create_booking` whenever the engine has confirmable Slots.

Capture a Request (`request_appointment`, status `request_created`) only when:

- the Service is request-only, or
- `check_availability` returned no confirmable times (empty diary — a full day that still had hours, or a business that never opens), or
- the check failed technically (`BOOKING_TEMPORARILY_UNAVAILABLE`) or with `CALENDAR_NOT_CONNECTED`, or
- travel left only `requestableSlots`, and the customer picks one, or
- address is outside the Service Area / unplaceable after one retry, or
- a "choose length" customer will not give a duration after being asked (only that duration exception).

These are **not** Requests on an Auto-book Service. Check the date they named, refuse the hour, offer the times that come back:

- named time outside opening hours on a day that has hours (08:30 vs 09:00–17:00)
- named date that is closed all day (`closed`) — offer **another date**, never another hour that same day
- minimum notice (`too_soon`)
- max horizon (`too_far`)
- this Service's daily cap (`service_day_full`) — offer **another date**, never another hour that same day
- `CAPACITY_REACHED` on create — offer a different time; never retry the refused one; never say closed
- `PHONE_REQUIRED` / `EMAIL_REQUIRED` / `ADDRESS_REQUIRED` / `FILE_REQUIRED` — ask for the missing field, keep the named hour, retry. Missing contact is not "unavailable"

Never call `request_appointment` on Auto-book before a `check_availability` result exists for that date. Checking is what reports travel; an unmeasured journey is a reason to call it.

Request-only Services: no `check_availability`, no chips. Ask preferred time in their words.

Pinned: `booking-prompt-behaviour.test.ts` (notice/horizon, daily cap, closed weekday, out-of-hours, check-before-capture, phone). Engine: `diagnoseEmptyRange` in `slot-engine.ts`. Tool: `outOfWindowGuidance` / empty-range `suggestedAction: 'check_availability'`.

---

## Wall clock

The model never sees a UTC instant. `data.slots` are zoneless business-local (`yyyy-MM-dd'T'HH:mm:ss`). Instants for chips, the offer record, and the invented-time guard travel on `ToolResult.availability`, off `data`.

On success without `"requested": true`, quote `booking.displayTime` exactly. Never convert `startTime`.

Customer-facing NL (or FR) and chips are one availability source. A reply that names a time nobody offered is replaced.

Constructed tool arguments are zoneless local in the business timezone. Never append `Z`.

Pinned: `builtin-tools.test.ts` wall-clock payload; `unoffered-times.test.ts`; `agent.service.ts` `safeReplyContent`.

---

## Named hour

If they named a clock time and `check_availability` includes it: confirm **that** time. Do not list others. A tapped chip is confirmation of that chip.

Keep the named hour through intake. An intake answer is not a new time. `latestCustomerTimeText` walks past intake; `confirmableLocal` is the full day, not the 8-chip prefix (or 10:00 is dropped and 00:00 chips reappear).

If that hour was refused this run (notice, horizon, `REQUEST_OUTSIDE_WINDOW`, or a later retry): it is not "already chosen". `namedTimeRefused` unlocks retry chips. Clock-only match of 10:00 on a different day is alternatives, not confirmation.

A first message that dumps name + email + time is not a yes. `CONFIRMATION_REQUIRED` → short summary → wait for explicit yes (or a tap after you asked). Then `create_booking` again. Do not send a second summary.

Pinned: `builtin-tools.test.ts` intake named-time; `agent-service.test.ts` horizon retry chips / 08:30 out-of-hours chips.

---

## Hours and day parts

Opening hours in the prompt answer "when are you open?". They do not settle a particular date (overrides exist) and they do not by themselves refuse a booking.

Date overrides win even on always-open. Closures belong in `{openingHours}` and the OPENING HOURS block.

**Day part** (namiddag / afternoon / morning / evening): filter starts to that window.

| part | window |
|---|---|
| morning / voormiddag | 00:00–12:00 |
| afternoon / namiddag | 12:00–18:00 |
| evening / avond | 17:00–24:00 |
| `earliestTime: "12:00"` omitted latest | 12:00–24:00 |

Namiddag chips are ≥ 12:00. If the day-part window matches nothing, keep the day's slots for prose but **do not** chip the morning. The model asks before offering another part.

**Exact clock** (08:30): omit `earliestTime` / `latestTime`. A ≤2h probe around that clock is dropped. On a miss, chip the rest of the day's Auto-book times.

A named clock newer than a day-part cancels the day-part preference.

Pinned: `day-part.test.ts`; `agent-service.test.ts` out-of-hours chips vs namiddag withhold.

---

## Chips

Chips are drawn from `availability.slots` (UTC instants), max 8, never from `data.slots`.

Attach chips when the customer still needs to pick a confirmable time.

Leave chips off when:

- they already named a confirmable hour (`alreadyChoseTime`) and it was not refused this run
- unmatched **day-part** window
- `suggestedAction: 'confirm_existing'` (they already hold that time)
- requestable-only travel (prose, then `request_appointment`)
- request-only Service

`NO_SLOTS_ON_SCREEN_FALLBACK` ("tell me which time suits you") fires only when `av` has deliverable times, chips are off, and the reply names an unoffered hour. That sentence is a last-resort replacement, not an Auto-book strategy. If utcSlots exist for an exact-time miss, chips stay on so the fallback cannot fire.

Address picker must not displace chips when utcSlots exist.

Pinned: `buildSlotQuickReplies` in `agent.service.ts`; `address-picker-affordance.test.ts`.

---

## Empty range diagnosis

`slots: []` is not one thing.

| `emptyRange.reason` | meaning | next |
|---|---|---|
| `too_soon` | whole range inside minimum notice | retry later range; Auto-book |
| `too_far` | whole range past horizon | retry earlier range; Auto-book |
| `service_day_full` | only this Service's daily cap emptied the day | retry the **next** day; say the cap; Auto-book |
| `closed` | the asked range has no hours, and the next 7 days do | retry those days; say closed; Auto-book |
| absent | full, mixed, or never-open | ordinary empty: capture a Request |

`boundary` is a policy instant, never a bookable time. It stays off `data`. Guidance names a retry **date range**, never the bound clock.

A range that still has policy-allowed starts which busy time removed is an ordinary empty range.

Pinned: `diagnoseEmptyRange`; `booking-prompt-behaviour.test.ts` policy-ruled-out range / closed weekday.

---

## Timing resolution

Inheritable fields (buffers, min notice, horizon): Service → Business Default → platform. `typeof === 'number'` — explicit `0` is an answer; `null` inherits. A PUT that sends explicit `null` means inherit, not "zero".

Capacity Ceiling (max bookings/day, max booked minutes/day, Minimum Gap) always applies. Stricter of Service vs business wins. `null` or `0` on a ceiling is unlimited, never "no bookings".

Buffer is per-Service prep/cleanup. Minimum Gap is business-wide clearance around every occupied diary interval — Axentrio bookings and events already on the connected calendar. Additive.

Pinned: `service-timing.ts`; `loadAllBusy` in `busy.ts`; `CONTEXT.md` Ceiling vs Default.

---

## Contact and files

Ask, then retry the same tool. Never treat a missing field as the Service being unavailable. Never capture a Request because phone / email / file / address is missing.

- Phone-call Auto-book: `PHONE_REQUIRED` → ask for the number. WhatsApp session phone fills it. Keep the named hour.
- Needs email: never offer to book without it; never put `example.com` in a summary.
- Needs address (customer-location): street, house number, postcode, city before times. City or the business venue is not the door.
- Customer chooses location: ask business vs customer first. Address only when they chose theirs.
- `Ask this` on an intake question means pose it. `Required` means the booking waits. Optional still gets asked; decline continues.
- Files are always allowed. Existing chat files attach on create/request. After a Booking exists, `update_booking`. Never escalate just to attach a file.

Paused required questions must not deadlock the Service.

---

## Travel

Travel Time is feasibility. Maximum Travel Time (`maxTravelMin`) is the only owner-set refuse on drive length. Null/0 = no limit. Grouping (Preferred Slot) reorders; it never refuses, withholds, or downgrades a Slot.

A Request the travel gate captured is for the owner; accepting it runs no travel check.

Vague address → ask postcode, retry once, then Request. `ADDRESS_NOT_PLACEABLE` is not a refusal.

Outside Service Area → Request. Never promise a visit. Never just say no.

Base is the day's first-opening departure when enabled. Return-home is never gated.

---

## Customer change policy

New Service: reschedule and cancel default to `request`. Missing mode reads as `request`. Auto-book of the original is not a change grant.

`not_allowed`: refuse immediately. Do not ask, do not summarise, do not call the tool. Name the cutoff if there is one. Do not send them to the business on the first refusal. If they keep insisting, ask whether they want a human.

`request`: capture a change Request; original Booking stays put.

`auto`: execute after confirmation.

Cutoff only tightens. `null` = no extra cutoff; `0` = until the start instant. Do not compute catalog cutoffs in the model; `list_bookings` / `check_availability` already applied them.

Address change on an existing Booking is a reschedule.

---

## Price

Quote the SERVICES line exactly. That number is already final (discount included).

Say free / €0 only when the line shows `free`, or it is the discounted final of a listed Discount. `none` is silence — not free.

`on request` → capture a Request so the owner can quote. Never invent a number.

`may mention` / `do not mention` gate advertising the reduction, not the final price.

---

## Confirmation and honesty

`requested: true` is not booked, moved, cancelled, or confirmed. The original appointment is unchanged. Do not quote `displayTime` as a confirmed clock.

`CONFIRMATION_REQUIRED` is not a Booking.

Announcing "I'll book that now" without calling the tool in the same reply is a false confirmation.

`confirm_existing`: they already hold that time. Drop leftover diary chips.

A yes on a pending move summary calls `reschedule_booking`, not another availability check.

---

## Calendar and skill

The Booking row is source of truth. The Calendar Mirror follows the row (ADR-0021). Missing mirror ≠ missing Booking.

`CALENDAR_NOT_CONNECTED`: no slots, capture a Request, never say confirmed.

Unconfigured booking (no hours / no Service) drops booking tools while skill-state is on. `SKILL_STATE_ENABLED=false` is the break-glass that **keeps** the tools and restores prompt-only gating.

---

## When you change X

| change | also check |
|---|---|
| SERVICES prompt / `AVAILABILITY_RULE` | Auto-book stays Auto-book; out-of-hours still offers times; a closed weekday still offers the next open day |
| `check_availability` empty path | `emptyRange` vs ordinary empty; `suggestedAction`; `closed` stays Auto-book |
| `clockWindow` / day-part | namiddag chips ≥12:00; exact 08:30 still chips the day |
| `buildSlotQuickReplies` / `safeReplyContent` | `NO_SLOTS_ON_SCREEN_FALLBACK` cannot fire while utcSlots exist for an exact-time miss |
| named-time / intake | hour survives intake; chips stay off when they already chose a free hour |
| create/request contact errors | ask, don't Request |
| timing PUT | explicit `null` inherits; explicit `0` is zero |
| travel | grouping does not refuse; only `maxTravelMin` refuses a long drive |
| reschedule/cancel | default `request`; `not_allowed` never pretends a Request was filed |

Pin new behaviour at the seam the live bug used (tool result, chips, prompt line), not a mock of empty `slots` when the diary had times.
