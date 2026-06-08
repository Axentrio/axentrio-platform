# P5: Extended service fields

The keystone added the *columns* for five capabilities and left their *behavior* to a
later slice. P5 wires that behavior: the agent collects address/phone/files, capacity is
enforced, duration can vary, and price can be quoted on a request. Almost every column
already exists; the **one** new column P5 adds is `Booking.booked_duration_min` (P5c,
detailed there). Otherwise P5 is behavior + the portal UI to author it.

## What the keystone already provides (verified)

On `ServiceType` (`api/src/database/entities/ServiceType.ts`) — all present, all defaulted:
- `customerLocationRequired` / `customerAddressRequired` (`boolean`, default false)
- `maxBookingsPerDay` (`int`, nullable)
- `durationMode` (`'fixed'|'range'|'ai'`, default `'fixed'`), `minDurationMin`,
  `maxDurationMin` (`int`, nullable). Only `durationMin` (fixed) is consumed today.
- `priceDisplayType` (`'none'|'fixed'|'from'|'range'|'on_request'`) + `fixedPrice` /
  `minPrice` / `maxPrice` / `priceNote`.
- `fileUploadAllowed` (`boolean`, default false), `preparationInstructions` (`text`).

On `Booking` (`api/src/database/entities/Booking.ts`) — all present, all nullable:
- `customerPhone` (`varchar 64`), `customerAddress` (`varchar 512`)
- `uploadedFiles` (`jsonb`, typed `unknown[] | null`)
- `intakeAnswers` (`jsonb`) — owned by P3, not touched here.

Also already shipped (so P5 only *reads* these seams):
- The zod `serviceInputSchema` (`api/src/schemas/scheduler.schema.ts`) **already accepts every
  P5 field** with per-field bounds (`customerLocationRequired`, `customerAddressRequired`,
  `maxBookingsPerDay` `1..100`, `durationMode`, `minDurationMin`/`maxDurationMin` each
  `5..1440`, `fileUploadAllowed`, `preparationInstructions`, price columns). The CRUD endpoints
  (`POST/PUT /scheduler/services`) therefore accept them today; the portal form
  (`portal/src/components/settings/ServicesSection.tsx`) just renders **no inputs** for them
  yet. **One schema gap (called out, not "already complete"):** the schema validates each
  duration bound *independently* but has **no cross-field** `min ≤ max` check, so P5c adds a
  `.superRefine` (detailed in P5c). Apart from that one refinement, P5 portal work is form
  fields only — no new endpoint, no new column except P5c's `Booking.booked_duration_min`.
- The portal `Service` / `ServiceInput` TS types
  (`portal/src/queries/useSchedulerQueries.ts`) already include all these fields.
- `priceHint()` in `api/src/agent/prompt-builder.ts` already renders the price one-liner
  into the SERVICES catalog from `priceDisplayType` + price columns. **Price display is
  done.** P5's price slice is only the *quote-on-request* behavior beyond display.
- The slot engine (`api/src/n8n/booking-providers/slot-engine.ts`) already takes the
  service's `durationMin`/buffers/notice/horizon per call — but reads **only** `durationMin`
  for slot length.
- File infra (`api/src/file-handling/upload.service.ts`, `routes/files.routes.ts`):
  presigned-S3 upload, 25 MB cap, mime/extension allowlist (`validation.service.ts`),
  virus scan (`/upload-complete` → `performScan`), tenant quota, plan-gate
  (`requireFeature('fileUpload')`). **But every file route is Clerk-authenticated
  (`requireClerkAuth`)** — it is the owner/portal upload path. There is **no public
  (widget-visitor) upload endpoint** today. This is the one real gap P5e must close.

## Goal

A solo owner can, per service, require the customer's address/phone (mobile/service-area
jobs), cap how many of that service are booked per day, let a service's duration be a range
or AI-estimated, surface a price the agent can quote on a request, and let the customer
attach files — and all of it shows on the booking/request row in the portal. Reuse the
existing intake-style collection (agent tool params → `Booking` columns), the existing
slot engine, and the existing upload infra. The only new code structures are **local
helpers/wrappers** — `resolveDuration(service, requested?)`, `requiredContactFields(service)`,
and the two widget upload route handlers that thin-wrap the existing `UploadService` — not new
layers or abstractions.

## Locked global decisions

- **Collection mechanism = tool params, exactly like the keystone/P2 pattern.** Address,
  phone, and file references are added as optional params on `create_booking` /
  `request_appointment` and threaded through `booking.service.ts` →
  `InternalProvider.createBooking` / `requestAppointment` → SQL INSERT, identical to how
  `notes`/`aiSummary` already thread. The prompt instructs the agent *when* to collect
  them. No new "collect contact" tool.
- **Enforcement vs display, per feature:** only **capacity** and **duration range/ai** touch
  the slot/create path; **address/phone**, **price quoting**, and **file upload** are
  pure create-path (no slot-engine change). Stated explicitly per slice below.
- **Per-bot, per-service.** All five toggles already live on `ServiceType`; nothing is bot-
  or tenant-wide. The service is resolved by the existing `resolveService(botId, serviceId?)`,
  so the rules a given booking is held to are exactly the resolved service's.
- **Create-time revalidation already re-resolves the service** inside `createBooking` under
  the advisory lock; every P5 create-path rule (required address present, capacity not
  exceeded, duration within range) is enforced **there**, after re-resolution, never trusted
  from a stale slot chip.
- **Customer chat is anonymous (no Clerk).** Any customer-facing endpoint P5 adds (only P5e
  needs one) authenticates via the existing **widget session** (`authenticateWidget`), never
  `requireClerkAuth`.
- **Provider enforces its own invariants — the API schema is not the only guard (issue 18).**
  The zod `serviceInputSchema` validates per-field ranges, but forms/API clients can be
  bypassed and legacy rows predate new refinements. So every create-path rule is enforced in
  the **provider** at booking time, not assumed from validation: required address/phone
  (P5a), capacity ≥ 0 / null = unlimited (P5b), `min ≤ effective ≤ max` with an
  invalid-range fallback to fixed (P5c), and file readiness/ownership (P5e). The portal/schema
  changes are authoring convenience; the provider is the source of truth.

## Out of scope (clean seams, explicitly excluded)

- **Real payments / charging / deposits.** Price is display + a quote string on a request;
  no Stripe, no checkout, no payment status. (`priceDisplayType` stays presentational.)
- **Multi-day / rolling-window capacity.** Capacity is **per calendar day in the service's
  business timezone** only. No "max per week", no "max concurrent", no per-resource capacity.
- **Travel-time / geocoding / service-area-radius logic.** Address/phone are *captured*
  strings; we do not validate an address, compute travel time, or gate slots by distance.
- **AI duration as a learned model.** `'ai'` mode = the agent estimates within the configured
  min/max bounds; it is not a trained predictor and never exceeds the bounds.
- **Per-service availability/day-filters** (keystone deferred those; still deferred).
- **Editing uploaded files / re-scanning / owner-side file management UI** beyond a download
  link on the booking row.
- **File upload on confirmed auto-bookings is allowed but not required**; the primary driver
  is request-mode jobs ("send a photo of the room"). No change to email/ICS attachments.

---

## P5a — Mobile / service-area (address + phone capture)  *(create-path only, no slot-engine change)*

Simplest first: data capture with a single required-field gate, no slot-engine change.

**Storage:** `Booking.customerAddress` (≤512) and `Booking.customerPhone` (≤64), both
already on the entity.

**Who/when collects:** the agent. Two new optional params on **both** `create_booking` and
`request_appointment` (`api/src/agent/tools/booking.tool.ts`): `customerAddress`,
`customerPhone`. Prompt rule (added to the SERVICES block in `prompt-builder.ts`): *"If the
selected service requires an address/phone (the catalog will flag it), ask for it before
booking or capturing the request, and pass it as customerAddress / customerPhone."*

**Flag semantics (locked — the two booleans are orthogonal):**
- `customerAddressRequired` → **address is required** (hard gate). Maps to
  `Booking.customerAddress`.
- `customerLocationRequired` → **phone is required** (a callback number for a mobile/on-site
  job). Maps to `Booking.customerPhone`.

These are independent: an owner can require address only, phone only, both, or neither. (We
deliberately do **not** couple them.) The catalog appends a `needs address` and/or
`needs phone` hint to the SERVICES line per the flags set.

**Naming wart (acknowledged, not renamed — issue 12):** the column name
`customerLocationRequired` reads like "address" but P5 maps it to **phone**. This is a keystone
column name we are **not** renaming (a prod migration + external-payload churn for cosmetics
is out of scope, per the keystone's column-stability rule). To prevent misuse, the mapping is
centralized in **one** place — a `requiredContactFields(service)` helper returning
`{ address: boolean, phone: boolean }` — used by both the prompt catalog and the provider gate,
and the portal labels describe **behavior** ("Requires customer phone (mobile / on-site job)"),
never the raw column name. Future readers touch the helper, not scattered `service.customerLocationRequired`
checks.

**Enforcement point:** in `InternalProvider.createBooking` **and** `requestAppointment`,
after `resolveService`:
- if `service.customerAddressRequired` and no non-empty `customerAddress` → throw
  `BookingError('Address is required for this service', 'ADDRESS_REQUIRED', 400)`;
- if `service.customerLocationRequired` and no non-empty `customerPhone` → throw
  `BookingError('A contact phone number is required for this service', 'PHONE_REQUIRED', 400)`.
Both are recoverable (the agent asks and retries). Whitespace-only values are treated as
absent. When not required, both fields are best-effort: stored if the agent supplies them,
never blocking. **Validation = presence + length cap (locked):** the gate checks non-empty and
**caps length to the DB column** (`customerPhone` ≤ 64, `customerAddress` ≤ 512) — overlong
input is truncated-with-trim (or rejected with a recoverable `INVALID_CONTACT_FIELD`), so an
oversized value never reaches the INSERT as a raw `varchar` overflow. Phone-format / E.164 /
locale validation is explicitly **out of scope** — presence + length only, no regex/locale
drift. Threaded into both INSERTs as two new columns.

**Portal authoring:** two independent checkboxes in `ServicesSection.tsx` ("Requires customer
address" → `customerAddressRequired`; "Requires customer phone (mobile / on-site job)" →
`customerLocationRequired`). API already accepts them (schema verified).

**Display:** `AdminBookingRow` (`booking.service.ts`) gains `customerAddress?` /
`customerPhone?`; `adminListBookings` selects them; `Bookings.tsx` row renders them under the
attendee line when present.

*Demoable end-to-end:* mark a service "requires address", ask to book it in chat — the agent
collects the address, the booking row in the portal shows it; omitting the address yields a
recoverable `ADDRESS_REQUIRED` the agent recovers from.

---

## P5b — Capacity (max bookings per day)  *(create-path; reads bookings, not the slot engine)*

**Storage:** `ServiceType.maxBookingsPerDay` (nullable int; **null = unlimited**). The zod
schema constrains it to `min(1).max(100)` (verified) — so **`0` is not an allowed value**;
"no bookings allowed" is expressed by making the service inactive, not by `max=0`. **Runtime
rule for any bypassed/legacy value (locked):** the provider treats `null`/absent **or any value
`≤ 0`** as **unlimited** (skip the check) and only enforces a **strictly positive** cap — so a
malformed `0`/negative row degrades to "unlimited", never to "no bookings ever", and the check
is `positive && count >= max`.

**Definition (locked — exact status set):** the cap counts `Booking` rows for the same
`event_type_id` (service) whose `status IN ('pending','confirmed')` and whose `start_utc`
falls on the target calendar day in the business timezone. The full `BookingStatus` enum is
`'pending' | 'confirmed' | 'cancelled' | 'failed' | 'request_created'` (verified on
`Booking.ts`); there is **no** `rescheduled`/`expired`/soft-delete status (a reschedule keeps
`status='confirmed'` and mutates `start_utc`; a cancel sets `status='cancelled'`). So
`('pending','confirmed')` is exactly "currently-held slots" — the **same** set the
`EXCLUDE`/busy queries already use (`loadBusy` filters `status IN ('pending','confirmed')`),
keeping capacity consistent with conflict detection. `cancelled`/`failed`/`request_created`
do not count.

**Requests are intentionally uncapped (locked — issue 8):** `maxBookingsPerDay` caps **held
appointments**, not requests. A `request_created` row (including `on_request` services routed
to a request by P5d) is an unconfirmed intent the owner triages, so collecting several same-day
requests for a capped service is **intended** — the cap applies when/if the owner converts a
request into a confirmed booking (a future approval-workflow concern, out of scope here). This
is the product decision, stated rather than assumed.

**Enforcement point:** inside the **existing advisory-lock transaction** in
`createBooking` (the `pg_advisory_xact_lock(hashtext(calendarKey))` block), **before** the
INSERT, run a `SELECT count(*)` of qualifying rows for that service+day; if
`count >= maxBookingsPerDay` → throw `BookingError('No more openings for this service that
day', 'CAPACITY_REACHED', 409)`.

**Capacity-gate invariant — every transition INTO a held slot, not just inserts (locked —
issues 1, 4):** the gate must run on **any** mutation that adds a `pending`/`confirmed` row to
a service+day, namely:
- **`createBooking`** — the count-then-insert described above (the common path).
- **`rescheduleBooking`** — a reschedule moving a confirmed booking to a **different local
  day** increases the target day's count, so it is a capacity-consuming transition. Locked:
  inside reschedule's advisory-lock transaction, if the new local day differs from the old, run
  the same per-service count for the **target** day **excluding this booking's own id** (it
  already excludes itself from busy/EXCLUDE), and reject with `CAPACITY_REACHED` if full.
  Same-day reschedules (time-only) don't change the count and skip the check. **Reschedule
  cannot change the service (locked — issue 3):** `rescheduleBooking` resolves the service via
  `serviceForBooking(booking)` from the booking's own `event_type_id` (verified — it takes only
  `bookingId` + `newStartTime`, no `serviceId`), so a reschedule always stays on the same
  service; the count is therefore unambiguously that one service's, and there is no
  "reschedule into a different capped service" case to handle.

`createRequest` inserts `request_created` (excluded — requests are uncapped, issue 8) and
cancel only *frees* capacity, so neither gates. **Stated invariant for future work:** *any*
code that transitions a row **into** `pending`/`confirmed` for a service (a future
request-approval/convert flow, an admin manual-create) must run this capacity gate under the
`calendarKey` advisory lock — capacity is a property of the *transition into held*, not of the
insert statement.

**Concurrency (locked — the race the reviewer looks for):** the count and the insert run in
the **same transaction under the same per-`calendarKey` advisory lock** that already
serializes all creates for a bot's shared calendar. All of a solo owner's services share one
`calendarKey` (keystone K1 keys it on the connected-calendar identity, falling back to
`bot:<id>`), so concurrent creates for the same service+day serialize on that lock → the
count-then-insert is atomic w.r.t. other creates; no check-then-act race, no new
lock/constraint. The lock is keyed on `calendarKey`, **coarser** than `(service, day)`, so it
cannot under-serialize.

**Fail-closed if the calendarKey assumption ever breaks (locked):** the capacity guarantee
relies on every concurrent create for the same bot taking the *same* `calendarKey` lock. This
holds because `calendarKey` is computed once per create from
`resolveCalendarIdentity(bot.id)` and is **per-bot, not per-service** (K1 invariant). P5 does
**not** introduce any per-service calendar key. If a future slice makes `calendarKey`
per-service (it must not, per K1), capacity for a service would still be self-consistent
(same service → same key), but cross-service day counts are irrelevant since the cap is
per-service anyway. Documented so the invariant is explicit, not silently assumed.

**One timezone source (locked):** the day window for create **and** reschedule counting uses
**`AvailabilityRule.timezone`** (`rule.timezone`) — the single business-availability timezone,
already loaded in both paths (`loadRule`), the same source the slot engine uses. `loadRule`
throws `BOOKING_NOT_CONFIGURED` when no rule exists, so a booking can never reach the capacity
check without a defined timezone; there is no fallback/ambiguity. "Business timezone" in this
doc always means `rule.timezone`.

**Day-boundary — exact half-open window (locked — issue 6):** compute the
local day of the slot in `rule.timezone` via Luxon, then take `dayStartUtc =
local.startOf('day').toUTC()` and `nextDayStartUtc = local.startOf('day').plus({ days: 1
}).toUTC()`. The count predicate is the **half-open** range
`start_utc >= dayStartUtc AND start_utc < nextDayStartUtc` — never `endOf('day')` — so DST
days (23h/25h) and the midnight boundary are exact and non-overlapping. **Counting is by
`start_utc` only (locked — issue 3):** a long (P5c) booking that *starts* 23:30 local and ends
after midnight counts solely against its **start** day, not the day it spills into. This is the
deliberate, accepted model ("max **starts** per day"); P5 does not split or double-count a
cross-midnight span. (Cross-midnight conflicts are still handled correctly by the
`blocked_range`/EXCLUDE machinery — this note is only about the capacity *count*.)

**No slot-engine change:** capacity is *not* pre-filtered out of `computeSlots` (a fully-
booked day still shows slots until the cap rejects at create time). Locked: **enforce at
create, do not hide slots.** Rationale: keeps the slot engine pure/capacity-unaware and
avoids an extra per-day aggregate query on every availability check; the create-time 409 is
the authority and the agent recovers by offering another day. (Noted as a deliberate UX
trade-off, not an oversight.)

**Agent recovery on `CAPACITY_REACHED` (locked — issue 1):** because slots stay visible for a
capped-out day (we don't pre-filter), the SERVICES/booking prompt gains: *"If create_booking
returns CAPACITY_REACHED, that service is full for that day — offer the next available day,
don't retry the same day."* Same recoverable-409 pattern as `SLOT_UNAVAILABLE`.

**Admin/manual paths today (locked — issue 2, named not deferred):** the only code that
writes `pending`/`confirmed` internal rows today is `InternalProvider.createBooking`
(create) and `rescheduleBooking` (day-changing move) — both gated above. The portal admin
surface (`scheduler.routes.ts`) exposes **only** `bookings/:id/cancel` and
`bookings/:id/reschedule` (verified) — it has **no** admin manual-create endpoint, so there is
no ungated promote path in P5's scope. The "future request-approval/convert" flow does not
exist yet; when it is built it must call the gate (the invariant above). Nothing currently
bypasses capacity.

*Demoable:* set max=1 on a service, book it for a day, attempt a second booking that day →
`CAPACITY_REACHED`; a different day still books; rescheduling a booking **into** a full day is
also rejected.

---

## P5c — Duration modes (`range`, `ai`)  *(slot-engine + create-path — the only slot-engine change)*

Today `slot-engine.ts` and `createBooking`/`reschedule` use `service.durationMin` as the one
true length. P5c makes the **effective duration** a function of `durationMode`.

**Locked model — effective duration is resolved once, then the existing machinery is reused.**
The provider has a single `resolveDuration(service, requestedDurationMin?): number` helper:

- `'fixed'` → returns `service.durationMin` and **ignores** the param entirely.
- `'range'` / `'ai'` → uses the agent-supplied optional `durationMin` param on
  `check_availability` / `create_booking` / `request_appointment`. `range` = the customer
  picks; `ai` = the agent estimates from the conversation. Provider logic is identical; only
  the prompt guidance for *how the agent chooses* differs.

**Prompt ordering — resolve duration BEFORE checking availability (locked — issues 4, 5):** for
a `range`/`ai` service the prompt instructs the agent to **establish the duration first** (ask
the customer for `range`; estimate from the conversation for `ai`) and pass that `durationMin`
into **`check_availability`** so the offered chips already fit — turning the
`minDurationMin`-fallback into the exception, not the norm, and minimizing avoidable
`SLOT_UNAVAILABLE` 409s. The **same is mandatory for `request_appointment`** (see the
deterministic rule below): the agent always passes `durationMin` for a range/ai service so the
owner-visible request scope is accurate. Default-to-min stays the safe provider fallback, not
the intended agent behavior.

**Out-of-range / absent handling (locked — deterministic, surfaced, not silently shortened):**
- **Absent** `durationMin` on a `range`/`ai` service → default to `minDurationMin` (the
  conservative shortest job). This is a sane default, not a silent shortening of a stated job.
  **Deterministic for requests too (issue 6):** the prompt rule is unconditional — *for any
  `range`/`ai` service the agent MUST pass `durationMin` to `request_appointment` and
  `create_booking`* (collect for `range`, estimate for `ai`); the provider default-to-min is a
  safety net for a misbehaving agent, not an allowed shortcut. (Drops the earlier vague "when
  materially relevant".)
- **Mode flip between availability and create (issue 5):** if a service's `durationMode` flips
  to `fixed` between the availability check (where the agent passed e.g. 90) and create-time
  re-resolution, `resolveDuration` returns `service.durationMin` and **ignores** the param —
  the booked length would differ from what the customer discussed. Locked: this is acceptable
  because create-time re-resolution is the **authority** (services can change mid-conversation,
  exactly like the keystone re-validates mode/active), AND the create-time `offered` recompute
  re-runs on the *fixed* length so the slot is still valid; the agent's confirmation step
  (prompt already requires confirming the time before booking) surfaces the final service
  state. No silent overlap; at worst a shorter-than-discussed fixed booking the agent confirms.
- **Out of `[minDurationMin, maxDurationMin]`** → the provider does **not** silently clamp.
  It throws `BookingError('Requested duration is outside this service's allowed range',
  'DURATION_OUT_OF_RANGE', 400)` (recoverable; the agent re-asks within bounds). Rationale:
  silently clamping a 120-min request down to a 90-min max would book a too-short slot the
  customer didn't agree to. (Resolves review round-1 issue 7 — surfaced, not silent.)
- The resolved value must satisfy `min ≤ effective ≤ max`; granularity alignment is **not**
  required (the booked length need not be a multiple of `slotGranularityMin`).

**Invalid service config (locked):** if `durationMode` is `range`/`ai` but `minDurationMin`
or `maxDurationMin` is null/≤0, or `minDurationMin > maxDurationMin`, the config is invalid.
The **portal form and the zod schema** both enforce `5 ≤ min ≤ max ≤ 1440` for non-fixed
modes (a new `.superRefine` on `serviceInputSchema` — schema currently allows each bound
independently but not the cross-field min≤max, so P5c adds that refinement). As a runtime
backstop for any bypassed/legacy row, `resolveDuration` treats an invalid range as
**effectively fixed**: it falls back to `service.durationMin` (always present, default 30) and
logs a warning, never crashing the create path.

**Slot-engine impact (locked):** `computeSlots` already takes `eventType.durationMin`. The
provider passes the **resolved effective duration** as that field at create-time revalidation
and at availability time. Concretely:
- **Availability (`checkAvailability`):** `checkAvailability` gains the same optional
  `durationMin` param. **If the agent already knows the duration** (a `range` choice or an
  `ai` estimate), it passes it and availability is computed with that **effective** duration —
  so the offered chips actually fit and the customer doesn't repeatedly pick unusable starts
  (resolves issue 5). **If duration is not yet known**, availability falls back to
  `minDurationMin` (the shortest plausible job) so no fittable start is hidden. Locked:
  availability uses the resolved duration when known, else `minDurationMin`; the booked length
  is still re-resolved and re-checked at create.
- **Create-time revalidation (exact check, locked):** the offered-slot recompute and the
  `blocked_range` (`start − bufferBefore` .. `end + bufferAfter`, where
  `end = start + effective`) use the **resolved effective duration**, not `durationMin`. The
  recompute reuses the **exact pattern the codebase already ships** for fixed bookings — it
  calls `computeSlots` with `eventType.durationMin = effective` over the `rangeStart=start`,
  `rangeEnd=start+1000ms` window and asserts `.some(s => new Date(s.start).getTime() ===
  start.getTime())` (identical to today's `createBooking`/`reschedule` `offered` check, just
  with `effective` swapped in for `durationMin`). The 1-second window is already proven for
  fixed durations in the current code (it works because `computeSlots` enumerates slot starts
  on the granularity grid and the query-window filter `startMs ∈ [rangeStart, rangeEnd)` admits
  exactly the one candidate at `start`); P5c changes **only** the duration fed in, so the
  established window semantics are unchanged. This single check enforces **all** window
  constraints with the effective length — i.e. it confirms `start + effective` fits inside the availability window
  (min-notice, horizon, and the day's `windows` end, since `computeSlots` only emits a slot
  when `startMin + duration ≤ winEndMin`) **and** does not overlap busy (internal + Google,
  buffer-padded). If the longer resolved job no longer fits or now overlaps, `offered` is
  false → `SLOT_UNAVAILABLE` (409), and the `EXCLUDE USING gist` constraint is the final
  backstop on the INSERT. So the explicit guarantee is: *a slot is only booked if
  `start + effective + buffers` is fully inside an availability window and free of conflicts*.
  Offering availability on `minDurationMin` is the accepted trade-off; its only failure mode is
  this recoverable 409, never a silent overlap.
- **Agent recovery on the 409 (locked — issue 9):** the SERVICES/booking prompt gains a rule:
  *"If create_booking returns SLOT_UNAVAILABLE for a range/AI service, the chosen length did
  not fit that start — offer a different start time (re-check availability) or propose a
  shorter duration within the allowed range; never retry the same start with the same
  length."* This makes the trade-off recoverable in practice rather than a dead end.

**Requests validate bounds only, not availability-fit (locked — issue 10):** a request never
holds a slot (`createRequest` does no slot recompute and never blocks the calendar — verified).
So for `request_appointment`, `resolveDuration` enforces only the **range bounds**
(`min ≤ effective ≤ max`, with the same `DURATION_OUT_OF_RANGE` on violation) and persists
`booked_duration_min`; it does **not** run the offered-slot / window-fit check (that is a
confirmed-booking concern). The end time stored on the request is `start + effective` purely
for display. **Requests are informational only (locked — issue 8):** a `request_created` row
is **never** treated as busy/blocked by any conflict code — verified: `loadBusy` and the
`EXCLUDE` constraint both scope to `status IN ('pending','confirmed')`, and `createRequest`
already writes a degenerate `blocked_range` that no query consults. So a request's
`start..end` may freely overlap a real booking or another request; P5c's variable end time
does not change this — it adds no new conflict surface.

**Persisting the chosen duration — `Booking.booked_duration_min` (the one new column, locked):**
Both `create_booking` and `request_appointment` persist the resolved effective minutes to a
new `Booking.booked_duration_min int null` column. **Locked to remove null-ambiguity (issue
7): every P5-era booking persists its length here — including `fixed` services (which write
`service.durationMin`).** So a non-null value is the booking's frozen length regardless of
mode, and `null` means **only** "row predates P5c" (a true legacy row). This makes
`booked_duration_min` the single authority for an existing booking's length and prevents a
later service-`durationMin` edit from retroactively changing an old fixed booking's perceived
or rescheduled length. Set identically on confirmed bookings and requests (a request row shows
its estimated/requested length). **No backfill; one fallback everywhere (locked — issue 6):**
the migration does **not** backfill existing rows (they stay `null` = legacy). Every consumer
— reschedule, Google-sync summary, and admin/portal duration display — uses the single
expression `bookedDurationMin ?? service.durationMin`, so legacy rows render their fixed
length and no duration math ever reads a raw null.

**Reschedule (locked — grandfathered length, never shrunk, never re-validated against current
bounds):** reschedule reuses the booking's **frozen** length
`effective = booking.bookedDurationMin ?? service.durationMin`:
- For any P5-era booking `bookedDurationMin` is non-null (every create persists it, above), so
  reschedule simply carries the original length forward.
- The `?? service.durationMin` fallback only fires for a true legacy (pre-P5c) row, whose
  length *was* `service.durationMin` — so it reconstructs, never shrinks.
**Grandfathering (issue 2):** reschedule does **not** re-validate the frozen length against the
service's *current* `[minDurationMin, maxDurationMin]`. If the owner later lowers `maxDurationMin`
from 90→60, an existing 90-min booking still reschedules at 90 min (its agreed length is
honored); the new bounds apply only to *new* bookings. Reschedule never re-prompts for a
duration. (The target-day capacity check from P5b still applies.)

**Effective duration flows to every downstream end-time (locked — issue 4):** `end = start +
effective` is computed once at create (replacing today's `start + service.durationMin`) and
that single `end` feeds **all** downstream consumers: `Booking.end_utc`, the `blocked_range`
upper bound, the mirrored Google event end (`syncGoogleCreate`/`syncGoogleReschedule` already
take `end`), the ICS `DTEND` (`sendBookingEmail` already takes `end`), and the portal duration
display (`bookedDurationMin ?? service.durationMin`). Reminders key off `start` (unaffected by
duration). No downstream consumer re-derives length from `service.durationMin`.

**Portal authoring:** in `ServicesSection.tsx`, a `durationMode` select; when `range`/`ai`,
show `minDurationMin`/`maxDurationMin` number fields (the existing fixed `durationMin` stays
for `fixed`). Client-side validation refuses save unless `5 ≤ min ≤ max ≤ 1440`.
**Legacy/invalid render (locked — issue 13):** `formFromService` defensively coerces a row
whose `durationMode` is `range`/`ai` but has null/invalid bounds — it pre-fills `minDurationMin
?? durationMin` and `maxDurationMin ?? durationMin` so the form never renders `NaN`/blank and
never auto-submits an invalid default; the owner must enter valid bounds before saving. The
backstop in `resolveDuration` (invalid range → treat as fixed) covers any row that bypasses the
form entirely.

*Demoable:* a `range` service offered on availability; booking it with a chosen 90-min
duration blocks 90 min on the calendar (a later overlapping booking is rejected) and the
portal row shows the real duration.

---

## P5d — Price logic (prompt-only; display already done)  *(no storage, no enforcement)*

**Already done (do not rebuild):** the price one-liner in the SERVICES catalog
(`priceHint`) and the portal price-display editor. P5d adds **only** prompt behavior beyond
display — it persists **nothing** new and *nudges* (does not force) `on_request` toward a
request. The owner sees the
price by looking at the service definition the row references by name; no quote is copied onto
the booking/request row.

**Locked scope (precise field + format):** the *only* new behavior is two prompt rules in the
SERVICES block of `prompt-builder.ts`; no provider/storage change.
1. The SERVICES catalog line already carries the price one-liner from `priceHint`
   (`fixed`/`from`/`range` → a `€…` string; `on_request` → `price on request`). The agent may
   **state that displayed string** when asked a price for a `fixed`/`from`/`range` service; it
   must **never invent a number** for `on_request` (or `none`).
2. For `priceDisplayType='on_request'`: *"price is on request — do not quote a number; capture
   the job via `request_appointment` so the owner can quote."* This is a **prompt nudge**, not
   the safety mechanism.

**`on_request` ≠ a confirm-blocking flag (locked — issue 14):** `priceDisplayType` is purely
presentational; it does **not** force a service into request-mode and P5d does **not** add any
provider enforcement keyed on it. If an owner wants an "on request" service to *never*
auto-confirm, they set the service's **`bookingMode='request'`** (the keystone's real
confirm-gate), and the keystone short-circuit then guarantees no auto-booking regardless of the
prompt. So a prompt miss or a direct `create_booking` API call on an `on_request` **but
`bookingMode='auto'`** service can still confirm — and that is **intended** (the owner chose
auto-book; price-display is just how the price is shown). We deliberately do not couple price
display to booking mode.

**No structured price on the booking (locked):** we do **not** add a price field to `Booking`
and do **not** compute totals or charge. The owner already sees the priced service because the
request/booking row labels the **service name** (P2c), and the per-service price is editable in
the portal — so no duplicated price string is persisted on the row. (Resolves review round-1
issue 11: the agent does not stuff a price into `aiSummary`/`notes`; price stays on the
service definition, which the row already references by name.) `request_appointment` is
unchanged; only the prompt differs.

**No enforcement, no slot/create logic change, no schema change.** Pure prompt + the existing
catalog. This slice is deliberately tiny — it exists to lock "no payments" and to *nudge*
`on_request` toward a request (the guaranteed no-confirm gate remains `bookingMode='request'`,
not `priceDisplayType`).

**Portal authoring:** none new — the price-display editor already exists in
`ServicesSection.tsx` (`priceDisplayType` select + `fixedPrice`/`minPrice`/`maxPrice` fields).
`priceNote` is in `FormState` but **not yet rendered**; P5d adds a `priceNote` text input to
the existing price block (one field, since the agent/catalog can surface it).

*Demoable:* an `on_request` service **set to `bookingMode='request'`** (the real confirm-gate):
the agent does not quote a number, captures a request via `request_appointment`, and the portal
Requests row labels the priced service by name. (An `on_request` + `bookingMode='auto'` service
may still auto-confirm — intended, per the issue-14 note; the *guaranteed* no-confirm behavior
comes from request-mode, not from `priceDisplayType`.) A `fixed`/`range` service: the agent
states the displayed price string when asked.

---

## P5e — File upload (customer attaches files to a booking)  *(create-path + one new public endpoint)*

The biggest slice — the existing upload infra is **owner-only (Clerk)**; the customer needs a
session-authenticated path, and the file must link to the booking.

**Storage — one exact persisted shape (locked):** `Booking.uploadedFiles` (`jsonb`, already
present) is an array of **exactly**
`{ fileSessionId: string, fileName: string, mimeType: string, fileSize: number, fileKey: string }`.
`fileSessionId` is the `UploadSession` id (the same id `files.routes.ts` preview/download key
on); `fileKey` is the immutable S3 object key (snapshot — see immutability below). No URLs are
stored (signed URLs are short-lived). The display layer reads a **subset** of this one shape
(`fileSessionId` + `fileName`); it is not a second schema. The owner re-derives a signed URL
via the existing `GET /files/:id/download` keyed on `fileSessionId`.

**Who/when collects (locked):** the customer uploads **during the chat**, before the agent
books. Flow:
1. The widget already exposes `fileUploadEnabled` (`widget.ts:164`) and `Message` metadata
   already carries `fileName/fileUrl` — but there is **no public upload endpoint**. P5e adds
   `POST /widget/files/upload` + `POST /widget/files/:sessionId/upload-complete`, mounted under
   the widget router, **authenticated by `authenticateWidget`** (the visitor's widget session),
   **not** `requireClerkAuth`. These are thin wrappers over the **same** `getUploadService()` /
   `performScan` used by `files.routes.ts` — reuse, not reimplement.
2. **Tenant for quota/key:** taken from the widget session's `tenantId` (server-trusted),
   never the client. `UploadSession.tenantId` is set to the widget session's tenant and
   `chatSessionId = req.widget.sessionId`, both **server-side**. Because the row is tenant-
   owned identically to a portal upload (same `UploadService.generateUploadUrl` writes the same
   `tenantId`/`fileKey`/status fields), the owner-side `GET /files/:id/download` authorizes
   purely on `session.tenantId` (verified — it does **not** depend on a Clerk uploader
   identity), so the owner can download a widget-uploaded file. (Resolves round-2 issue 3.)
3. **`POST /widget/files/upload` server-bound contract (locked — issue 10):** the route
   **ignores any client-supplied tenant/key/path** and calls `generateUploadUrl({ tenantId:
   req.widget.tenantId, chatSessionId: req.widget.sessionId, fileName, fileSize, mimeType })`.
   `fileSize`/`mimeType`/`fileName` from the client are passed **only** into the existing
   `validateFile`/`validateQuota` (25 MB cap + allowlist + quota); the **`fileKey` is
   server-derived** (content-addressed `uploads/<tenant>/…`) and the presigned PUT pins
   `ContentLength`/`Content-Type` (verified in `upload.service`), so a client cannot upload a
   larger/other-type object than declared. The session is bound to the widget's
   tenant+chatSession before the URL is returned.
4. **`upload-complete` ownership + state-transition rules (locked — issues 4, 9):** the widget
   `POST /widget/files/:sessionId/upload-complete` first loads the `UploadSession` and
   **rejects (403) unless** `session.tenantId === req.widget.tenantId` **and**
   `session.chatSessionId === req.widget.sessionId` — a widget session can only complete/probe
   **its own** upload. It reuses the **existing** `/upload-complete` handling (verified in
   `files.routes.ts`), which (a) **verifies the object actually landed in S3**
   (`fileExists(fileKey)`) before scanning, (b) runs the virus scan over the **real uploaded
   object** so the actual bytes are inspected — not just the client's declared `mimeType`
   header. Issue 7/10 caveat stated honestly: a presigned PUT alone does not hard-enforce
   size/type, so the **authoritative** post-upload guard is the S3 object existing + the scan;
   if stricter true-content-type verification (sniffing detected MIME from the stored object's
   magic bytes and rejecting on mismatch before `ready`) is required, P5e adds that one check to
   the shared `performScan` path so the widget and portal paths gain it together (no new
   per-caller logic). (c) is **idempotent /
   terminal-state locked** — once `ready`/`quarantined` it returns the cached result and
   **never re-scans or re-transitions**, so a session can't be swapped into a different state
   after `ready` and a booking's stored snapshot stays valid. The content-addressed `fileKey`
   means a "re-upload" is a *different* object/session, not a mutation of this one.
   **Expired widget session (locked — issue 9):** `authenticateWidget` is the gate on both
   widget upload routes, so an expired/invalid widget session cannot upload **or** complete —
   a presigned URL outliving the chat is moot because `upload-complete` (and thus the
   `ready` transition a booking requires) is unreachable without a live session, and
   attachment at booking time additionally re-checks `chatSessionId === ctx.session.id`. A
   still-valid presigned PUT can deposit bytes after the chat ends, but with no reachable
   `upload-complete` the object never scans to `ready` and can never attach; it counts only
   against the existing tenant quota under the existing unattached-object lifecycle (issue 9 —
   no new quota/cleanup obligation in P5; the presigned URL's own short expiry bounds it).
5. **Auth/limits reused (locked):** the same 25 MB per-file cap, mime/extension allowlist,
   virus scan, and tenant quota apply — they live in `upload.service`/`validation.service` and
   run regardless of caller. **Plan-gate:** the existing `requireFeature(tenantId,
   'fileUpload', …)` is applied in the widget upload route too.
6. The customer uploads → gets a `fileSessionId` (after `upload-complete` returns `ready`).
   **Where the ids live + reach the tool (locked — issue 7):** the `ready` upload is persisted
   as a `Message` of `type:'file'` whose `metadata` carries `{ fileName, fileSize, fileType,
   fileUrl, fileSessionId }` (extending the **existing** `Message.metadata` shape, which already
   has `fileName/fileSize/fileType/fileUrl` — P5e adds `fileSessionId`). The agent runtime
   collects the `fileSessionId`s from the session's `type:'file'` messages as **structured
   context** (not from visible text or a stale signed URL) and passes them as a
   `fileSessionIds: string[]` param (the agent selects only the files relevant to *this*
   booking — the prompt scopes it to files the customer shared for the service being booked, so
   a multi-service chat does not auto-attach unrelated earlier files; the booking-time
   `chatSessionId` match is the hard floor, agent relevance-selection the soft one). **Max 5 files per booking/request (locked):** the provider
   caps `uploadedFiles.length ≤ 5` (else `BookingError('Too many files attached',
   'TOO_MANY_FILES', 400)`) to bound jsonb size, quota, and tool-payload bloat. (Per-file size
   is already capped at 25 MB.)

**Two independent gates — widget capability vs per-service permission (locked — issue 8):** the
existing widget `fileUploadEnabled` (`widget.ts:164`) is a **bot-level capability** that merely
makes the upload control *exist* in the widget; it is **not** the per-service permission. P5e
keeps them separate: `fileUploadEnabled` gates whether the widget can upload **at all**;
`ServiceType.fileUploadAllowed` gates whether a file may be **attached to a booking** for that
service. Because the widget control may be globally visible, a customer **can** upload before a
service is resolved (or for a disallowed service) — that is exactly why the **authoritative**
accept/reject is the booking-time `fileUploadAllowed` check (ordered-checks, below), not the UI.

**Service gating happens at booking time, not upload time (locked):** the upload endpoints do
**not** require a `serviceId` (the customer may upload before the agent has resolved a
service). Whether the upload is *invited* is a prompt concern: the agent invites a file **only**
once it has resolved a service with `fileUploadAllowed = true`. Locked rule to avoid the
"uploaded a file that can't be used" trap (issue 14): **the agent identifies the service
first, then invites the upload** (same "disambiguate first" ordering the keystone/P2 already
mandate) — it does **not** invite uploads while the service is unresolved. If a file
nonetheless arrives for a no-upload service at booking time, the provider returns the
recoverable `FILE_UPLOAD_NOT_ALLOWED` (ordered-checks, below) and the agent tells the customer
plainly. An upload
that is never attached simply ages out under the existing upload-session lifecycle — no
orphan-cleanup work is in scope for P5.

**Session-context invariant (locked — issue 13):** linkage relies on
`ctx.session.id` in `createBooking`/`requestAppointment` being the **same widget session** that
performed the upload. This is already true: `booking.service.ts` resolves `ctx` from the
**same `sessionId`** the booking tool runs under (`resolveContext(sessionId)`), and the upload
endpoints stamp `chatSessionId = req.widget.sessionId`. Both derive from the one live widget
session, so `chatSessionId === ctx.session.id` holds for a legitimate same-conversation
attach and fails for any cross-session id. (Stated explicitly as the load-bearing assumption.)

**Linkage / enforcement point (locked — ordered checks):** in
`createBooking`/`requestAppointment`, before INSERT and only when `uploadedFiles` is non-empty,
the provider runs these steps **in this order**:
1. **Service-disallow first (issue 10):** if the resolved service has `fileUploadAllowed =
   false` → throw `FILE_UPLOAD_NOT_ALLOWED` **before** loading any `UploadSession`. This avoids
   a differentiated-error/timing oracle that could reveal whether a foreign/unscanned
   `fileSessionId` exists.
2. **Dedupe** by `fileSessionId` (issue 11 — repeats collapse to one entry so they can't pad the
   row or game the cap), then enforce **≤ 5** distinct ids (`TOO_MANY_FILES`).
3. **Validate each** distinct id: load the `UploadSession`, require `status === 'ready'`
   (scanned clean) **and** `tenantId === ctx.tenant.id` **and** `chatSessionId ===
   ctx.session.id` **and** that the snapshot fields are **well-formed** — non-empty
   `fileName`, `fileKey`, `mimeType` and a positive numeric `fileSize` (issue 8: a malformed /
   partial session row is rejected, never snapshotted with nulls into the exact-shape jsonb). Invalid/unscanned/foreign ids → `BookingError('Attached
file is not available', 'FILE_NOT_READY', 400)` (recoverable). **What is stored (locked,
immutability):** we copy a **snapshot** of the scanned, immutable fields read from
the validated session — the exact `{ fileSessionId, fileName, mimeType, fileSize, fileKey }`
shape locked under **Storage** above — into `Booking.uploadedFiles` at attach time. The S3 object is content-addressed
(`uploads/<tenant>/<yyyy>/<mm>/<dd>/<hash>.<ext>`, verified) and the session reaches `ready`
only after a clean scan; the snapshot + immutable key mean a later session-row mutation cannot
silently swap the file behind a confirmed booking.

**No silent data loss (locked):** the service-disallow check (step 1 above) **throws**
`BookingError('This service does not accept file uploads', 'FILE_UPLOAD_NOT_ALLOWED', 400)`
rather than silently dropping the file, so the agent tells the customer plainly instead of
booking as if the attachment landed. `FILE_NOT_READY` / `TOO_MANY_FILES` /
`FILE_UPLOAD_NOT_ALLOWED` are all recoverable. Files are **optional** — a `fileUploadAllowed`
service does **not** require one (permission, not obligation).

**Portal authoring:** a "Allow file upload" checkbox in `ServicesSection.tsx`.

**Display (locked — both bookings AND requests):** `AdminBookingRow` (`booking.service.ts`)
gains `uploadedFiles?` (`{ fileSessionId, fileName }[]`); `adminListBookings` selects
`uploaded_files` for **all** scopes (`upcoming`/`past`/`requests`) — requests render through the
**same** `BookingCard` row in `Bookings.tsx` (P2c), so one row change covers both. Each file
renders as a download link hitting the existing owner `GET /files/:id/download` (Clerk-auth,
**tenant-scoped, not booking-scoped**). **Access model (locked — issue 11):** that route
authorizes by the file's **tenant** only (verified — `session.tenantId`), not by booking
linkage, so any admin of the owning tenant can download any of that tenant's file sessions by
id (including not-yet-attached widget uploads). P5 **reuses this existing tenant-wide file
access model unchanged** — it is acceptable because the only actors with portal/Clerk access
are the tenant's own owner/admins, and adding per-booking file ACLs is out of scope. Stated
explicitly rather than assumed. **Resilient to a gone file (locked):** the row renders the
**snapshot** `fileName` from `Booking.uploadedFiles` regardless of the underlying
`UploadSession`'s current state, so a row never breaks. The `ready` **status** is terminal (issue 11 — it never
re-transitions back to scanning/pending), but the **object/row can still be removed later** by
an out-of-band action (tenant deletion, retention purge, an admin removing a file) — that is
deletion, not a status re-transition, so it does not conflict with the terminal-state
guarantee. If the owner clicks download after such a removal, the existing
`GET /files/:id/download` returns 404 `NotFoundError`; the portal shows a "file no longer
available" state. We add no new behavior.

**Unattached-file lifecycle (locked — issue 12, scope boundary):** an uploaded file that is
never attached to a booking is a tenant-owned object governed by the **existing** upload
lifecycle (tenant quota + the existing reconcile/cleanup of non-terminal sessions in
`upload.service`) — P5 introduces **no** new retention or cleanup obligation and explicitly
does **not** add orphan-file GC. This is called out as a known, accepted boundary: widget
uploads use the same quota and lifecycle as portal uploads, no better, no worse.

*Demoable:* enable file upload on a service, upload a photo in the widget, book/request →
the file is virus-scanned, snapshot-linked to the booking, and the owner downloads it from the
Bookings **or** Requests row; a foreign/unscanned id → `FILE_NOT_READY`; a file aimed at a
no-upload service → `FILE_UPLOAD_NOT_ALLOWED`.

---

## Slice ordering (tracer bullets, simplest-first)

Each is independently demoable end-to-end. Slot-engine touch is called out.

| Slice | Touches slot engine? | New endpoint? | New schema? | Blocked by |
|-------|----------------------|---------------|-------------|------------|
| **P5a** address/phone | No (create-path) | No | No | — |
| **P5b** capacity | No (counts bookings in create txn) | No | No | — |
| **P5c** duration range/ai | **Yes** (effective duration) | No | **Yes** (`Booking.booked_duration_min`) | — |
| **P5d** price (prompt only) | No (prompt only) | No | No | P2 (request flow) |
| **P5e** file upload | No (create-path) | **Yes** (widget upload + complete) | No | — |

- **P5a — address/phone.** Tool params + provider threading + `ADDRESS_REQUIRED` + portal
  checkboxes + row display. *Demoable above.*
- **P5b — capacity.** Per-service per-day count inside the existing advisory-lock txn +
  `CAPACITY_REACHED` + portal `maxBookingsPerDay` field + (optional) row context. *Demoable
  above.* (Parallel with P5a.)
- **P5c — duration modes.** `resolveDuration` helper, `durationMin` tool param,
  availability-on-min, create/reschedule on effective duration, `Booking.booked_duration_min`
  migration, portal duration-mode UI. *Demoable above.* (The only slot-engine-adjacent slice;
  do it after P5a/P5b are green so the create path is well-exercised.)
- **P5d — price quote-on-request.** Prompt rules only: `on_request` → `request_appointment`;
  agent may state the displayed price string for `fixed`/`from`/`range`, never invents a
  number. No storage, no price on the row. Tiny. *Demoable above.* Blocked by P2 (the request
  flow it routes to).
- **P5e — file upload.** Public widget upload endpoints (session-auth, reusing the upload
  service + scan), `uploadedFiles` param, per-session/tenant file validation + linkage,
  portal toggle + download links. *Demoable above.* Largest; do last.

## Concurrency / safety summary (for review)

- **Capacity race:** count + insert (create) and count + day-changing update (reschedule) run
  in the same transaction under the existing per-`calendarKey` `pg_advisory_xact_lock`
  (keystone K1). No new lock; the shared-calendar lock already serializes all
  capacity-consuming transitions for the bot, so check-then-write is atomic. Half-open
  `[dayStartUtc, nextDayStartUtc)` window by start-time; requests are uncapped and don't count.
- **Duration overlap:** the `EXCLUDE USING gist (calendar_key, blocked_range)` constraint +
  create-time `offered` recompute use the **effective** duration, so a longer job correctly
  blocks its full span; offering on `minDurationMin` is the documented trade-off whose failure
  mode is a recoverable `SLOT_UNAVAILABLE`, never a silent overlap.
- **File auth/linkage:** customer uploads go through `authenticateWidget` (not Clerk), reuse
  the 25 MB cap + mime allowlist + virus scan + tenant quota + plan-gate, and are bound to a
  booking only after validating `status='ready'` + matching `tenantId` + matching
  `chatSessionId`. No cross-tenant/cross-session file attachment is possible.
- **Stale slot chips:** every create-path rule (address-required, capacity, effective
  duration, file readiness) runs after `resolveService` re-resolves the live service under the
  lock — never trusted from the chip.
