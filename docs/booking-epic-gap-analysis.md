# Booking epic — gap analysis

**Question asked:** we built the booking system already; how much of the *AI Booking System for Solo
Entrepreneurs* epic did we miss, and is service area really absent?

**Answer:** service area is absent — completely and deliberately. Beyond that, the epic's *mechanics*
are largely built and the epic's *configuration surface* is where the shortfall is.

Audited 247 discrete requirements from the epic against the code: **106 built, 72 partial, 69 missing.**
Every non-built claim was re-checked by a second pass tasked with disproving it; 14 were corrected.
Findings below carry `file:line` evidence; the items marked **verified directly** were re-confirmed by
hand (running the repo's own zod, reading the code) rather than taken on report.

---

## Scorecard

| Area | Built | Partial | Missing | State |
|---|---|---|---|---|
| Service type configuration | 19 | 7 | 2 | Strongest area — all 24 spec fields are real columns |
| Booking flow, statuses, AI rules | 30 | 5 | 4 | Mechanically solid; fallbacks are prompt-only |
| Calendar integration | 18 | 7 | 9 | Plumbing excellent; event/invite *content* thin |
| Portal pages | 15 | 14 | 7 | Consistently exposes less than the API stores |
| Availability & capacity | 10 | 10 | 8 | Hours real; "capacity" barely exists |
| Intake & file upload | 9 | 6 | 11 | 4 of 11 question fields, 2 of 12 question types |
| Business-type presets | 3 | 15 | 12 | A service seeder, not a preset system |
| **Service area / mobile** | **2** | **8** | **16** | **Does not exist in any spelling** |

---

## 1. Service area — confirmed absent

A 24-variant sweep (`serviceArea`, `service_area`, `coverage`, `radius`, `travelBuffer`, `travelTime`,
`maxDistance`, `province`, `geofence`, `haversine`, `acceptedCities`, `allowedPostcodes`,
`OUT_OF_SERVICE_AREA`, `urgentAllowed`, …) returns **zero files each**. None of the 79 migrations adds a
geo, area or distance column. There is no `BookingSettings` model at all.

This was a deliberate carve-out, not an oversight — `docs/booking-extended-fields-p5.md:98`:

> Travel-time / geocoding / service-area-radius logic. Address/phone are *captured* strings; we do not
> validate an address, compute travel time, or gate slots by distance.

**Today's product answer to "I only serve 25 km" is a help doc telling the owner to write it in a
knowledge-base document** (`api/src/copilot/docs/uploading-knowledge.en.md:21`). That is why Achraf hit
it: nothing stops the bot booking a job 300 km away.

**What exists to build on** (do not duplicate):
- `ServiceType.customerAddressRequired` — fully wired entity → zod → provider gate (`ADDRESS_REQUIRED`)
  → prompt → portal toggle
- `Booking.customerAddress` — free text, `varchar(512)`
- per-service `bufferBeforeMin` / `bufferAfterMin` — enforced by the slot engine *and* the DB exclusion
  range; the only travel-buffer-shaped mechanism that exists
- a business address captured **once** by the onboarding wizard into
  `tenant.settings.onboarding.company.{street,postalCode,city}` — and read by nothing afterwards

**Where a service-area value has to be threaded:** load it in `bookingModule.buildPromptSection`
(`api/src/modules/booking.module.ts:247-259`, which already loads `ServiceType` + `AvailabilityRule` by
`botId`) and emit it in `buildServicesSection` beside the existing `hasContact` clause. Note
`ModulePromptContext` carries only `{tenantId, botId, config}` — no business location — so the loader must
fetch it itself. For the AI to *recover* from an out-of-area job, a tool error code
(`OUT_OF_SERVICE_AREA`) needs adding beside `ADDRESS_REQUIRED` at `internal.provider.ts:177`.

Both address sources are deliberately verbatim free text with no city/postcode decomposition, so any
containment check needs a parser or geocoder that does not exist today.

---

## 2. Live defects — broken in shipped product

These are not spec gaps. They are things that do not work right now.

### 2.1 The onboarding wizard's Bookings step cannot save — **verified directly**

`BookingsStep.tsx:76` builds `weeklyHours` keyed `monday…sunday`. The API enum is
`mon|tue|wed|thu|fri|sat|sun` (`api/src/schemas/scheduler.schema.ts:6`). Running the repo's own zod
against the wizard's exact payload:

```
WIZARD PAYLOAD success = false
  invalid_enum_value, path ["weeklyHours","monday"]   received "monday"
  invalid_enum_value, path ["weeklyHours","saturday"] received "saturday"
SHORT-KEY payload success = true
```

`PUT /scheduler/config` rejects it, `mutateAsync` throws, and the catch at `BookingsStep.tsx:90-93`
swallows the rejection so `submit.mutate` never fires. **The owner gets a toast and the step never
advances.** The step also hydrates with the same long keys (`:55-56`), so it always shows defaults.

**Root cause:** `portal/src/queries/useSchedulerQueries.ts:13` types `WeeklyHours` as
`Record<string, TimeWindow[]>` — a loose string key rather than the 7-value union. That is why the
compiler never caught it, and why `SchedulerSettings.tsx` (short keys, correct) and `BookingsStep.tsx`
(long keys, broken) can disagree in the same codebase. The portal unit test mocks the transport and
asserts the broken shape, so it locks the bug in.

**Fix:** narrow the portal type to the union — the compiler then points at the one broken call site —
and correct the test's expected payload.

### 2.2 Split shifts and lunch breaks are destroyed on save — **verified directly**

The entity, API and slot engine all support multiple windows per day. The portal models exactly one:
`SchedulerSettings.tsx:99` reads `weekly?.[key]?.[0]`, `:188` writes `[{start, end}]`. So a break is
unauthorable in the UI, **and any second window written via the API or seeded by a preset is silently
destroyed the next time the owner hits Save.** Date overrides truncate identically (`:90-91`, `:192`).

### 2.3 Booking status `failed` is dead — **verified directly**

`BookingStatus` declares `'failed'` but no code path writes it. The spec's four failure modes instead
throw with no row (`SLOT_UNAVAILABLE`, `INTAKE_REQUIRED`), degrade to a request
(`CALENDAR_NOT_CONNECTED`), or leave the row `confirmed` with `sync_pending`.

### 2.4 A booking is confirmed *before* the calendar event exists — **verified directly**

The epic's hard rule is "never confirm before the calendar event is created". The order is inverted:
the row commits as `confirmed` and the customer is told so, then `syncCalendarCreate` runs
(`internal.provider.ts:711`); on failure the booking stands with `sync_pending` (`:1182`).

*This one is a defensible engineering choice* — the Postgres `EXCLUDE` constraint, not the calendar, is
the real double-booking authority, and a reconciler retries. **The actual harm is 2.5.**

### 2.5 A terminal calendar-sync failure is invisible to the owner

A booking whose mirror went terminal (`sync_last_error` set) still renders as a green **Confirmed** pill.
It never reaches the owner's calendar, and for a channel booking with no customer email there is no email
either — so the appointment exists only in a portal list nobody opens. There is no sync-status column,
banner or alert anywhere.

### 2.6 Outlook shows "Connected" when its token is dead

The API returns `needsReauth` for Outlook; the portal type drops the field and renders no reconnect
branch. Google gets a banner; Outlook silently degrades to request-mode bookings.

### 2.7 The onboarding wizard hard-requires *Google*

An Outlook-only business is blocked at the gate even though the platform fully supports Outlook.

### 2.8 Widget file upload 404s — *already documented*

`widget.js:2530` posts to `/api/v1/uploads/presigned-url`; `uploadRouter` is never mounted (and the auth
schemes mismatch anyway). Pre-existing and written up in `docs/widget-file-upload-status.md` — listed
here only for completeness. Net effect: a customer photo can reach a booking **only** via Messenger or
Instagram, while `booking.module.ts:225` invites attachments on every channel.

### 2.9 Timezone is unvalidated on the owner path

The preset path validates IANA-ness (`presets.ts:71-85`); the owner-facing path accepts any 1–64 char
string. `Europe/Brusselz` saves fine, then luxon returns an invalid DateTime and `slot-engine.ts:61-65`
skips every slot — **all availability silently disappears** with no error.

---

## 3. Capability gaps, ranked

### 3.1 Capacity protection barely exists

The epic devotes a section to protecting a solo owner. What is built is one per-**service**
`maxBookingsPerDay`. Missing entirely:

- **business-level daily cap** — a plumber with five services capped at 2/day can still be booked 10 times
- **minimum time between bookings** — only fakeable as per-service buffers, which also pad against
  external calendar events and must be repeated on every service
- **daily working-hour limit** — nothing sums booked duration, so five 4-hour jobs fit an 8-hour day
- **travel buffer** — the address is collected and never used for anything

Related: *every* rate-limiting knob the epic puts on a business-level `BookingSettings` record (default
buffers, minimum notice, max days ahead) exists **per-service only**. A solo owner with five services
sets the same three numbers five times, and nothing keeps them consistent. Preset-seeded services get
min-notice `0` while hand-added ones default to `60` (`ServicesSection.tsx:88`) — same business, two
different rules.

### 3.2 Presets are a service seeder, not a preset system

The mechanism works end to end (`presets.ts` + `POST /scheduler/presets/:key/apply` + a "Start from a
preset" dialog). But a preset can only define services and one shared Mon–Fri availability. It **cannot**
define intake questions (structurally forbidden — `presets.ts:21` `.omit`), visible/hidden settings,
service-area settings, AI rules, or file-upload recommendations. The choice is **never persisted**, so no
later screen can adapt to it.

The acceptance criterion *"they should only see the settings relevant to that business type"* fails
outright: there is no business-type step in onboarding, and the booking settings render every control
unconditionally.

**Vertical coverage against the six pilot targets:**

| Epic vertical | Shipped |
|---|---|
| Hairdressers | `barber` — male grooming only; no colour, blow-dry, women's cut |
| Beauty specialists | **none** |
| Plumbers / electricians / handymen | **none** (the vertical Achraf is testing) |
| Photographers / videographers | `photographer` — no videographer variant, no file-upload flag |
| Small car garages | **none** |
| Tattoo artists | **none** |

Three shipped presets (`cleaner`, `consultant`, `tutor`) are not in the epic at all.

Worse, there are **three disconnected vertical axes** that never reference each other: the booking preset
key, `BotTemplate.category`, and `SpecialtyDef.businessType`. No `business_type` column exists on Tenant
or Bot in any of the 79 migrations. Picking "Photographer" in bookings gives a service list and leaves the
bot on `blank-base` with no vertical identity. The one seeded template has no category, so
`specialtiesForVertical` returns `[]` for every tenant out of the box.

### 3.3 Intake questions are a minimal subset

Against the epic's 11-field question model, **4 fields exist** (label, type, required, implicit order).
Missing: field key, AI instruction, example answer, lead-capture mapping, include-in-calendar toggle,
active flag, explicit sort order.

Against 12 question types, **2 exist** (`text`, `choice`). Long text, phone, email, address, date, time,
number, yes/no and multiple-choice are all faked as free text — nothing validated or normalised. A
multi-select answer is **silently discarded** by the write-side normaliser.

Consequences worth noting: the answer key is a server-minted uuid, and the Leads drawer prints that raw
uuid as the question label (`Leads.tsx:706`). Deleting a question hard-deletes it from the jsonb, after
which historical answers fall back to the uuid label. Reordering means delete-and-re-add, which re-mints
ids and orphans past answers.

### 3.4 `durationMode: 'ai'` is an alias for `'range'`

Three enum values, two behaviours. `hasValidRange()` and `resolveDuration()`
(`internal.provider.ts:240`, `:253`) treat `ai` and `range` identically; the *only* difference in the
whole codebase is the prompt label "AI-estimated" vs "choose length" (`booking.module.ts:166`).

There is no estimator, no urgency/complexity/location signal, no KB lookup for duration. And the epic's
safety rule — *"if the AI is uncertain, create a request instead"* — has nothing behind it: there is no
uncertainty signal a tool can emit and no server-side downgrade. If the model omits `durationMin`
entirely, the create path books the **shortest** length rather than refusing (`:264`).

### 3.5 AI fallbacks are prompt-only where they need teeth

Of the nine "do not auto-book" conditions, the server enforces request-only services, missing intake,
missing address/phone, capacity, and calendar-unavailable. **Four are prompt text with no code behind
them** — no service match, unclear duration, urgency/risk, outside business rules — and *outside the
service area* does not exist in any form.

Concretely: a bot with a single active service that omits `serviceId` will auto-book that service for an
off-catalog request.

Also, when `create_booking` silently downgrades to a request (`internal.provider.ts:576`), the model
receives `requested: true` and **no prompt line anywhere explains that field** — so it can still narrate a
downgraded request as a confirmed booking. The downgraded result also omits `displayTime`, `timezone` and
`serviceName` (`:859-868`), leaving no positive signal to phrase it correctly.

### 3.6 Calendar event and invite content

Mechanics are strong (OAuth, live free/busy, idempotent creation, reschedule/cancel propagation, a
hardened retry reconciler). Content is not.

**Event title** is the bare service name — no `Booking: <service> - <customer>`, so the owner's calendar
shows three identical "Haircut" blocks. **Event body omits** uploaded file links, source channel, internal
booking ID and service duration; AI summary is hardcoded `null` on the auto-confirm path — i.e. the main
flow always ships an event with no summary.

**Customer invite omits** business name (it arrives unbranded from the Axentrio sender), business contact
details, duration, and the customer's own name in the visible body. For `in_person` it sends the literal
string `"In person"` — there is no business-address field anywhere — so the customer never receives an
actual address.

`preparationInstructions` is **completely dead**: stored, API-writable, no portal input, and read by
nothing — not the prompt, not the email, not the ICS. No owner can set it and no customer can ever see it.

Apple/iCal is unimplemented. The Google calendar picker is API-only (every owner is silently pinned to
`primary`); Outlook has no equivalent and always writes to `/me/events`.

### 3.7 Portal exposes less than the API stores

Four `ServiceType` fields have **no control at all**: `onlineBookable`, `preparationInstructions`,
`locationType`, `sortOrder`. `onlineBookable` is worse than cosmetic — the SERVICES prompt block omits the
`onlineBookable` filter every other consumer applies (`booking.module.ts:250`), so an offline service is
advertised to the bot and then 404s as `SERVICE_NOT_FOUND` at book time.

Three required booking-record columns are populated server-side and never returned or rendered:
`sourceChannel`, `aiSummary`, calendar sync status. `priceNote` is stored and editable but never reaches
the AI or the customer — a service configured "fixed €80 / per hour" is quoted by the bot as a flat "€80".

The preset picker becomes **permanently unreachable** once a single service exists, including one added by
mistake.

### 3.8 Date overrides never reach the AI

Only the weekly grid is composed into the prompt. Holidays, vacations and one-off hours are **never
stated**, so "are you open on 25 December?" is answered from the weekly line ("days not listed are
closed") and will confidently contradict the closure the engine actually enforces.

---

## 4. Recommended order

Ranked by harm-per-unit-of-work, not by epic order.

**Now — broken things (small, self-contained):**
1. Wizard weekday keys + narrow the portal `WeeklyHours` type so the compiler catches the class (2.1)
2. Multi-window support in the hours editor — stops silent data destruction (2.2)
3. Sync-failure visibility: a column/banner on Bookings + Outlook `needsReauth` branch (2.5, 2.6)
4. IANA timezone validation on the owner path (2.9)

**Next — Achraf's actual ask (service area):**
5. Business-level service area + the out-of-area path. Smallest honest version: a free-text area on the
   bot rendered into the SERVICES prompt block, so the bot *states* coverage and captures an out-of-area
   job as a request. **This advises, it does not enforce** — enforcement needs the customer address
   parsed into something comparable, and a false rejection costs a real customer. Recommend shipping the
   advisory version, watching whether it leaks, then deciding on geocoding.

**Then — the configuration shortfall:**
6. Business-level booking defaults (notice, horizon, buffers, daily cap, minimum gap) — kills the
   "set the same number on five services" problem and gives capacity somewhere to live
7. Persist the chosen business type on the bot, then make presets carry intake questions and
   service-area defaults; add the four missing pilot verticals — **plumber first**
8. Calendar event/invite content: title format, booking ID, duration, source channel, business name and
   contact, and make `preparationInstructions` actually reach the customer

**Deliberately not recommending yet:** the full 12 intake question types, `durationMode: 'ai'` as a real
estimator, Apple/iCal, and geocoded distance checks. Each is a genuine spec gap, none is currently
costing a customer a booking.
