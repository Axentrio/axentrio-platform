# Issues — Internal Scheduler, Phase 0 (tracer-bullet slices)

Source plan: [internal-scheduler-plan.md](./internal-scheduler-plan.md). Phase 0 = internal booking engine with no Google dependency; each slice is a thin end-to-end vertical slice, demoable on its own. Phase 1 (Google) and Phase 2 (more providers / reconciliation) are in the plan and not yet sliced here.

---

## 1. Provider seam — `BookingProvider` dispatcher (behavior-preserving)
**Type:** AFK · **Blocked by:** None — can start immediately

### What to build
Refactor the booking service into a `BookingProvider` interface (`listEventTypes`, `getAvailability`, `createBooking`, `rescheduleBooking`, `cancelBooking`) with the existing Cal.com logic moved verbatim into a `CalcomProvider`. The service becomes a dispatcher selecting the provider from the bot's settings (default `calcom`). No behavior change: the n8n booking tools, internal booking endpoints, and prompt are untouched; existing Cal.com bookings work exactly as before.

### Acceptance criteria
- [ ] `BookingProvider` interface defined; `CalcomProvider` implements it with the current Cal.com behavior unchanged.
- [ ] The 5 booking-service entrypoints keep their signatures and dispatch on the bot's configured provider (default `calcom`).
- [ ] Existing Cal.com booking flow (availability → create → reschedule → cancel) passes end-to-end with no behavior change (regression tests green).
- [ ] No changes to n8n tools, `/internal/booking/*` endpoints, or the booking prompt.

### Blocked by
None — can start immediately.

---

## 2. Internal availability — schema + slot engine
**Type:** AFK · **Blocked by:** #1

### What to build
Introduce the `event_types` and `availability_rules` tables and an internal slot engine, plus an `InternalProvider.getAvailability`. For a bot configured with `provider:internal`, `check_availability` returns slots computed from a single event type + weekly availability rules, in the owner's timezone. No booking creation yet — availability only.

### Acceptance criteria
- [ ] Migrations for `event_types` (single active type per bot, with duration/buffers/min-notice/max-horizon) and `availability_rules` (weekly hours + timezone + date overrides + granularity).
- [ ] Slot engine: expands weekly hours in the owner tz, applies date overrides (full-day closures + one-off opens), slices by duration/granularity, applies buffers + min-notice (no past slots), enforces max horizon, returns UTC slots.
- [ ] DST handled (spring-forward gap skipped; fall-back overlap = first occurrence); covered by frozen-clock unit tests across multiple timezones.
- [ ] `check_availability` on a `provider:internal` bot returns internal slots end-to-end.

### Blocked by
- #1 (provider seam)

---

## 3. Internal create booking — DB source of truth + concurrency safety
**Type:** AFK · **Blocked by:** #2

### What to build
Add the `bookings` table (status, `start/end_utc`, `blocked_range`, `calendar_key`, `idempotency_key`, attendee, `sequence`) with a buffer-aware exclusion constraint and partial-unique idempotency. Implement `InternalProvider.createBooking` using the reserve-first protocol (insert `pending` → confirm) behind a per-`calendar_key` lock, re-validating availability before reserving. Writes a `booking_logs` audit entry. No external calendar, no ICS yet — a confirmed booking lands in the DB.

### Acceptance criteria
- [ ] `bookings` migration with `EXCLUDE USING gist (calendar_key WITH =, blocked_range WITH &&) WHERE status IN ('pending','confirmed')`, CHECK `end_utc > start_utc`, partial-unique `(tenant_id, bot_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND status <> 'failed'`.
- [ ] `createBooking` re-validates against rules/buffers/min-notice/horizon/internal-busy, reserves via `pending`, confirms; on failure marks `failed` (slot freed).
- [ ] Concurrent create on the same slot → exactly one succeeds, the other gets `SLOT_UNAVAILABLE` (integration test with parallel requests).
- [ ] Idempotent retry (same key+payload) returns the existing booking; same key + different payload → `IDEMPOTENCY_MISMATCH`.
- [ ] `booking_logs` entry written on create; full booking conversation via n8n creates a DB booking end-to-end.

### Blocked by
- #2 (internal availability)

---

## 4. ICS confirmation invite
**Type:** AFK · **Blocked by:** #3

### What to build
On a confirmed internal booking, email the customer a single ICS calendar invite (METHOD:REQUEST, stable `ics_uid`, `sequence=0`) via the existing email service, so the booking lands on the customer's calendar with native reminders.

### Acceptance criteria
- [ ] ICS (REQUEST) generated with a stable `ics_uid` stored on the booking; emailed to the customer on create.
- [ ] Adding the `.ics` to Gmail/Outlook produces a correct event (time, title, duration, tz).
- [ ] Reuses the existing email/automation pipeline; owner notification path defined (Phase 0: owner also gets the ICS).

### Blocked by
- #3 (internal create booking)

---

## 5. Reschedule + cancel (internal) with ICS lifecycle
**Type:** AFK · **Blocked by:** #4

### What to build
Implement `InternalProvider.rescheduleBooking` and `cancelBooking` with the two-hold reschedule (hold new range while old stays held until confirmed), authorization checks (tenant + session/attendee ownership), and ICS lifecycle: reschedule → updated REQUEST (same uid, `SEQUENCE++`); cancel → METHOD:CANCEL (`SEQUENCE++`). Cancelled rows free their slot.

### Acceptance criteria
- [ ] Reschedule updates the booking (two-hold, no gap where the old slot is grabbable) and emails an updated ICS REQUEST; cancel sets status `cancelled`, frees the slot, emails ICS CANCEL.
- [ ] Authorization: cross-tenant or cross-session/attendee reschedule/cancel rejected (404, no enumeration).
- [ ] Cancel is idempotent (re-cancel = no-op success); `sequence` increments on each change.
- [ ] `booking_logs` entries for reschedule/cancel; end-to-end via the n8n conversation.

### Blocked by
- #4 (ICS confirmation)

---

## 6. Reminders
**Type:** AFK · **Blocked by:** #4

### What to build
Schedule 24h + 1h reminder emails as delayed BullMQ jobs on confirm; store `reminder_job_ids`; skip a reminder whose delay is ≤0 (booking already inside the window); the reminder worker re-reads booking status/start/sequence at execution and no-ops if cancelled/rescheduled/stale. Reschedule/cancel replace or cancel the jobs.

### Acceptance criteria
- [ ] On confirm, 24h + 1h jobs scheduled; `delay<=0` reminders skipped (not sent immediately).
- [ ] Worker re-reads the booking at run time and does not send for cancelled/rescheduled/sequence-stale bookings.
- [ ] Reschedule reschedules the jobs; cancel cancels them; `reminder_job_ids` tracked on the booking.

### Blocked by
- #4 (ICS confirmation)

---

## 7. Portal config UI — provider, event type, availability
**Type:** AFK · **Blocked by:** #2

### What to build
Extend the portal Bookings/Integrations settings so an admin can select the booking provider (`internal` vs `calcom`), define the single event type (name, duration, buffers, min-notice, horizon), and set weekly availability + timezone + date overrides. Reuse the existing CalcomSettings UI pattern. This is the config surface that makes slices 2–6 usable by a real tenant.

### Acceptance criteria
- [ ] Provider selector persists `bot.settings.integrations.provider`; switching is reflected in the n8n payload (`buildIntegrationsConfig` emits the booking block for `internal`).
- [ ] Event-type editor (single active type) and weekly availability + timezone + overrides editor, persisting to the new tables.
- [ ] A tenant can configure internal booking entirely from the portal and the bot then books against it end-to-end.

### Blocked by
- #2 (internal availability schema)
