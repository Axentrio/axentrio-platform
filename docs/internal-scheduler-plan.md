# Plan: Internal Scheduler + Multi-Provider Calendar Integration

## Goal
Replace the Cal.com dependency with an internal booking engine (our DB is the source of truth) that mirrors confirmed bookings to the business owner's external calendar (Google first, **extensible to Office365/CalDAV/etc.**), respects the owner's selected calendars' busy times, sends reminders, and keeps Cal.com as an optional per-bot provider during transition.

## Architecture decision (verified against Cal.com's repo)
We follow **Cal.com's model (Design A)**: our DB holds the authoritative `bookings`; external calendars are a side-channel used for (a) **free/busy reads** on the *selected* calendars and (b) a **mirror write** to a *destination* calendar, with the external event tracked in a `booking_references` row. This is the only model that generalizes across providers (Google-as-source-of-truth doesn't). Extensibility comes from a `CalendarProvider` interface (mirrors Cal.com's `Calendar` interface) with one implementation per provider.

- Verified: Cal.com's `Calendar` interface = `createEvent / updateEvent / deleteEvent / getAvailability→EventBusyDate[] / listCalendars`, implemented by 10 providers (google, office365, caldav, apple, exchange×3, lark, feishu, ics-feed).
- Verified: `Booking` is source of truth; `BookingReference(type, uid, meetingUrl, externalCalendarId, credentialId)`; `Credential(type, key Json)`; `SelectedCalendar` (read-for-busy) vs `DestinationCalendar` (write target).
- Verified: Cal.com tolerates external manual-edit divergence (webhooks ≈ cache invalidation) and uses no DB exclusion constraint (has had double-booking races) → we improve on both: accept divergence as a known v1 limitation, and add an exclusion constraint for concurrency safety.

## Two abstraction layers (don't conflate)
1. **`BookingProvider`** (dispatch): `calcom` vs `internal`, chosen per bot from `bot.settings.integrations.provider`. `booking.service.ts` becomes a dispatcher; `CalcomProvider` = existing logic moved; `InternalProvider` = new engine. **Bot conversation, n8n tools, `/internal/booking/*` endpoints, and prompt are unchanged**; the only additive changes above the provider are one `buildIntegrationsConfig` condition, new portal settings, and new error codes via the existing `BookingError` envelope.
2. **`CalendarProvider`** (inside `InternalProvider`): `createEvent / updateEvent / deleteEvent / getBusyTimes / listCalendars`, registry keyed by provider type (`'google'`, later `'office365'`, `'caldav'`). Google is the first impl. This is where multi-provider extensibility lives.

## Decisions
- **DB is source of truth; external calendar is mirror + busy-source.** `bookings` authoritative; `booking_references` track external event(s).
- **Buffers enforced atomically.** `bookings.blocked_range = tstzrange(start − buffer_before, end + buffer_after)`; exclusion constraint on `blocked_range` (improves on Cal.com).
- **Double-booking scoped to the destination resource.** Materialized `calendar_key` on `bookings` = `destination credentialId + externalCalendarId` if connected, else `bot_id`. Exclusion constraint uses `calendar_key` so multiple bots sharing one destination calendar can't double-book.
- **Busy = union of all SelectedCalendars (across providers), not one.** Availability subtracts internal confirmed bookings + the union of `getBusyTimes` over every selected calendar (queried **live** at create; display path may cache ≤60s). Relaxes the earlier single-calendar limitation, matching Cal.com.
- **Race-safe write protocol (reserve-first, unified for create AND reschedule):** (1) reserve the slot via a local row `status='pending'` + `blocked_range` (participates in exclusion constraint), (2) write to the destination calendar via `CalendarProvider.createEvent/updateEvent`, (3) mark `confirmed` + insert/update `booking_references` (uid, meetingUrl). On any failure → mark `failed` (frees slot). Reschedule uses the same reserve-then-write protocol (fixes the earlier "patch Google first" race). A reconciliation job sweeps stale `pending` rows and deletes orphan external events found via an idempotency tag stored in the event's `extendedProperties.private` (so orphans are recoverable even if the reference write never landed).
- **createBooking re-validates availability** (rules, duration, buffers, min-notice, horizon, internal busy, live external busy) before reserving; the exclusion constraint is the last-line race guard.
- **Idempotency.** Key from n8n (`sessionId + startTime`). `UNIQUE(tenant_id, bot_id, idempotency_key)` **excluding `failed` rows** (partial index `WHERE status <> 'failed'`) so a failed attempt doesn't permanently block retry. Same key + same payload → return existing (200); same key + different payload → `IDEMPOTENCY_MISMATCH` (409).
- **No duplicate invites.** External event created **owner-only** (no customer attendee → provider sends no invite). Customer's single invite = our ICS (stable `ics_uid`, `sequence`), Meet/conferencing URL embedded from the `booking_reference`. **Recipients by phase:** Phase 0 (no calendar) → ICS to customer + owner; Phase 1 (connected) → ICS to **customer only** (owner's invite IS the calendar event).
- **ICS lifecycle.** Reschedule → updated REQUEST (same `ics_uid`, `SEQUENCE++`); cancel → `METHOD:CANCEL` (`SEQUENCE++`).
- **Reminders.** 24h + 1h delayed BullMQ jobs (`addJob(...,{delay})`); if `delay<=0` skip that reminder; store `reminder_job_ids`; cancel/replace on reschedule/cancel.
- **Authorization (precise).** Every reschedule/cancel must match `tenant_id` (hard). Bot-initiated: additionally `sessionId == booking.session_id` OR provided `attendee_email == booking.attendee_email` (original stored email, not a changed one). Owner portal actions authorized by existing admin auth, scoped to tenant. Mismatch → 404 (no enumeration).
- **Conferencing best-effort.** Meet/Teams link requested; if the connected account can't create one (permission/provider), **book anyway without a link + warn the owner** (booking success is not gated on conferencing). Goal reads "conferencing link when the account supports it."
- **Disconnect semantics.** Disconnecting a calendar credential does **not** delete already-created external events (we never silently wipe the owner's calendar). Future bookings on that bot fall back to internal-only (no external mirror) until reconnected; reschedule/cancel of existing references with a removed credential degrade gracefully (cancel locally + notify; reschedule requires reconnect). Existing references are retained for audit.
- **Internal-provider audit.** `InternalProvider` writes `booking_logs` on create/reschedule/cancel/failure/reconciliation (parity with `CalcomProvider`, which already logs).
- **Only the owner OAuths; customers get ICS.** Single event type per bot in v1 (partial unique `(bot_id) WHERE is_active`). Singular cardinality: one availability rule per bot; one active credential per `(bot_id, provider)`.
- **Phasing.** Phase 0 = internal engine + ICS (no calendar provider). Phase 1 = `CalendarProvider` abstraction + **Google** impl (OAuth, getBusyTimes, createEvent, references) = **Cal.com-replacement gate**. Phase 2 = additional providers (O365/CalDAV) + optional webhook-driven external-edit reconciliation.

## Out of scope (v1)
- Cal.com replacement for round-robin/collective/multi-host/paid bookings — Cal.com stays selectable.
- SMS reminders; multiple event types per bot; customer-side OAuth.
- Faithful two-way reconciliation of manual external edits (Phase 2; divergence accepted as a known limitation, as Cal.com does).
- Providers beyond Google in v1 (the *interface* is built v1; the second impl proves it in Phase 2).

## Implementation outline

### Phase 0 — Provider seam + internal engine + ICS (~1.5–2 wks)
1. `BookingProvider` interface `api/src/n8n/booking-providers/types.ts`.
2. Move Cal.com logic → `booking-providers/calcom.provider.ts`; `booking.service.ts` dispatches on `bot.settings.integrations.provider` (default `'calcom'`).
3. Migrations: `event_types`, `availability_rules`, `bookings`, `booking_references`, `calendar_credentials`, `selected_calendars`, `destination_calendars` (schema below). Enable `btree_gist`; add exclusion + CHECK + unique/partial-unique.
4. Authorization middleware/helpers for reschedule/cancel (above).
5. `InternalProvider` (no calendar yet): slot engine; reserve-first create; reschedule/cancel; idempotency; ICS + reminders; `booking_logs`.
6. Slot engine `booking-providers/slot-engine.ts`: weekly_hours in owner tz → date_overrides (full-day/holiday + one-off open) → slice by duration/granularity → buffers + min_notice (no past) → max_horizon → DST (spring gap=skip, fall overlap=first) → subtract internal busy → UTC slots. Frozen-clock tests.
7. ICS (REQUEST/CANCEL, sequence) + reminders (skip if `delay<=0`).
8. `buildIntegrationsConfig` emits booking block for `provider==='internal'`.
9. Portal: provider pick; single event type; weekly availability + tz + overrides.

### Phase 1 — CalendarProvider abstraction + Google impl (~1.5–2.5 wks; Google verification in parallel) — REPLACEMENT GATE
10. `CalendarProvider` interface + registry `booking-providers/calendar/`; `GoogleCalendarProvider` impl (`createEvent/updateEvent/deleteEvent/getBusyTimes/listCalendars`).
11. Google Cloud project + consent screen + **submit OAuth verification day 1** (`calendar.events` + freebusy are sensitive/restricted; CASA possible; ~100-user cap until verified).
12. OAuth → `calendar_credentials` (encrypted tokens via `encrypt()`), refresh manager; portal Connect/Disconnect; pick `destination_calendar` + one-or-more `selected_calendars`. On connect, **grandfather** existing bookings on their current `bot_id` `calendar_key` (do NOT rewrite them); only bookings created *after* connect adopt the destination-calendar key. (No backfill → no exclusion-constraint violation; consistent with the resolution below.)
13. Wire into slot engine: external busy = union `getBusyTimes(selected_calendars)`, live at create; degraded → `BOOKING_TEMPORARILY_UNAVAILABLE` (retryable), never offer all slots blindly.
14. Wire into write protocol: reserve → `createEvent` (owner-only, conferencing requested, reminders) → store `booking_reference` + `calendar_key`. Reschedule → `updateEvent`; cancel → `deleteEvent`. **404 on reschedule/cancel** (owner manually removed it): cancel → idempotent success (mark cancelled); reschedule → recreate via `createEvent`, new reference.

### Phase 2 — More providers + external-edit reconciliation (optional)
15. Second `CalendarProvider` (Office365/CalDAV) — proves the interface.
16. Provider webhooks/watch channels → invalidate availability cache; optional reconcile of external cancels back to `bookings` (as far as Cal.com does, or better).

## Failure handling (fail-closed, all writes)
- Create: pending→external write→confirmed; failure→failed (no ICS/reminders)→`BOOKING_UNAVAILABLE`; reconciliation sweeps pending + orphan events (idempotency tag in `extendedProperties.private`).
- Reschedule/cancel: reserve-first per protocol; 404 handled as above; never leave an uncancellable booking.
- **Reschedule double-fault** (external `updateEvent` succeeded but local finalize then fails): set `sync_pending=true` (row stays `confirmed`, still holds its slot) and enqueue a reconciliation job that re-reads the external event (via `booking_reference`) and makes the DB match (idempotent). Flagged, never silently divergent.

## Concurrency & consistency core (the inherent Design-A hard part — validated in implementation via concurrency tests, not provable in the plan)
- **Per-`calendar_key` lock.** create and reschedule acquire a short lock (Postgres advisory or Redis) on `calendar_key` for the read-availability → external-write → DB-finalize window, so two concurrent operations on the same calendar serialize. The DB exclusion constraint remains the last-line guard.
- **Reschedule = two-hold, not free-then-reserve.** Insert a transient `pending` hold row for the NEW range while the original `confirmed` row keeps holding the OLD range; on external-update success, move the original to the new range and drop the hold; on failure, drop the hold (old slot never left). Eliminates the "old slot grabbed in the gap" race.
- **Canonical `calendar_key`.** Derive from `(provider_type + external_calendar_id)` once connected (immutable per booking, set at create); internal-only/pre-connect rows use `bot_id`. Never derive from `credential_id` (rotates on reconnect) or rewrite on reconnect — so one real calendar resource always maps to exactly one key, and grandfathered rows (which were never on that external calendar) are a genuinely separate conflict domain.
- **Disconnect mode is config, not ambiguous.** Per-bot `calendar_required`: if `true`, a missing/revoked credential blocks new create/reschedule with `CALENDAR_REAUTH_REQUIRED` until reconnect (cancel still succeeds locally); if `false`, the bot falls back to internal-only (mirror-less) bookings. Pick per bot; no contradiction.
- **Cross-provider lifecycle routing.** Provider provenance is recorded for **every** booking — internal in `bookings.provider`, Cal.com in `booking_logs` (already carries `cal_booking_id`). reschedule/cancel route by the booking's recorded provider, so a bot provider switch never strands existing bookings of either origin.
- Distinct error codes: `BOOKING_NOT_CONFIGURED` (no credential), `CALENDAR_REAUTH_REQUIRED` (revoked/expired token), `CALENDAR_NOT_FOUND` (deleted/inaccessible destination), `BOOKING_TEMPORARILY_UNAVAILABLE` (busy lookup down), `IDEMPOTENCY_MISMATCH`, `SLOT_UNAVAILABLE`.

## Schema detail
- `event_types(id, tenant_id, bot_id, name, slug, duration_min, buffer_before_min, buffer_after_min, min_notice_min, max_horizon_days, location_type, is_active, ...)` — partial unique `(bot_id) WHERE is_active`.
- `availability_rules(id, tenant_id, bot_id UNIQUE, timezone, weekly_hours jsonb, date_overrides jsonb, slot_granularity_min, ...)`.
- `bookings(id, tenant_id, bot_id, provider['internal'], event_type_id, session_id, status['pending'|'confirmed'|'cancelled'|'failed'], sync_pending bool default false, start_utc NOT NULL, end_utc NOT NULL, blocked_range tstzrange NOT NULL, calendar_key text NOT NULL, attendee_name, attendee_email, notes, ics_uid, sequence int default 0, reminder_job_ids jsonb, idempotency_key, ...)` (only `provider='internal'` rows live here; Cal.com bookings are not mirrored). `sync_pending` is a **sync flag, not a status** — a row needing reconciliation stays `confirmed` and keeps holding its slot.
  - partial unique `(tenant_id, bot_id, idempotency_key) WHERE status <> 'failed'`.
  - CHECK `end_utc > start_utc`.
  - EXCLUDE USING gist (`calendar_key WITH =`, `blocked_range WITH &&`) WHERE `status IN ('pending','confirmed')`.
- `booking_references(id, booking_id, provider_type, external_event_uid, external_calendar_id, credential_id, meeting_url, created_at)` — mirrors Cal.com's `BookingReference`.
- `calendar_credentials(id, tenant_id, bot_id, provider_type, status, key_enc jsonb, account_email, token_expiry, ...)` — partial unique `(bot_id, provider_type) WHERE status='active'`.
- `selected_calendars(id, credential_id, external_calendar_id, ...)` — calendars to read for busy (Cal.com `SelectedCalendar`).
- `destination_calendars(id, bot_id UNIQUE, credential_id, external_calendar_id, ...)` — the one write target (Cal.com `DestinationCalendar`).

## Testing
- Unit: slot engine (tz/DST/buffers/min-notice/horizon/overrides/merge, frozen clock).
- Integration: BookingProvider dispatch; CalendarProvider registry; concurrent create → one wins (buffer-aware exclusion); idempotent retry / failed-row-retry / mismatch; reschedule/cancel auth (cross-tenant/session rejected); ICS REQUEST/CANCEL/sequence; reminder skip-when-late/cancel; pending→failed reconciliation + orphan cleanup via extendedProperties tag.
- Contract: mocked Google (freebusy/insert/patch/delete) incl. token refresh, 429/5xx, revoked token, deleted calendar, no-conferencing, 404-on-cancel/reschedule, busy-down degraded.
- E2E: n8n booking conversation vs `provider:'internal'` in staging; event on test Google Calendar w/ Meet + reminder; reschedule + cancel propagate; second-provider stub honors the same contract.
- Regression: Cal.com provider path stays green.

## Security
- Provider credentials encrypted at rest (`encrypt()`), never logged, never sent to n8n. Internal endpoints keep `verifyInternalAuth`. Minimum scopes per provider. Disconnect revokes provider token + retains references for audit. Reschedule/cancel authorization enforced.

## Resolved implementation details (round-4 review)
- **Reschedule txn:** single-row UPDATE of the existing booking (new `start/end/blocked_range`, `sequence++`). The exclusion constraint naturally excludes the row from itself, so the old slot frees and the new reserves atomically. If the subsequent external `updateEvent` fails, revert the row to its prior range (and prior `sequence`). No second row, no both-held-forever.
- **Cancelled rows:** `status='cancelled'` is outside the exclusion predicate → slot freed automatically; additionally stop/replace reminder jobs, `sequence++`, emit ICS CANCEL. Cancel is idempotent (re-cancel = no-op success).
- **Credential vs event vs calendar errors (distinct):** credential removed/revoked → `CALENDAR_REAUTH_REQUIRED`, reschedule/new-create blocked until reconnect, **local cancel still succeeds** (mark cancelled, flag reference orphaned-for-cleanup); event 404 with valid credential → cancel = idempotent success, reschedule = recreate via `createEvent`; destination calendar deleted/inaccessible → `CALENDAR_NOT_FOUND`.
- **Zero selected calendars:** default the busy-check set to the **destination calendar** (you always check at least what you write to).
- **Token refresh failure mid-write:** pending→`failed` (slot freed), surface `CALENDAR_REAUTH_REQUIRED`, retry allowed after reconnect (failed rows don't block the idempotency key).
- **Idempotency payload comparison:** compare normalized `{start_utc, event_type_id, duration, attendee_email (lowercased/trimmed), timezone}`. Reschedule/cancel calls use a **separate key namespace** from create (e.g. `resched:<key>`), so they never collide with the create key.
- **External-write idempotency (lost-response safety):** set `iCalUID = bookings.ics_uid` on `createEvent` and tag `extendedProperties.private.bookingId`. A retry after a lost response re-inserts the **same** iCalUID (provider treats as upsert / surfaces existing) instead of creating a duplicate; reconciliation finds orphans by the private tag.
- **`booking_references` uniqueness:** unique `(booking_id, provider_type, external_calendar_id)` to prevent duplicate references from retries.
- **Busy lookup:** use the provider **free/busy API** (Google `freeBusy`), which expands recurring events and honors transparency server-side. Rule: all-day events = busy; declined/transparent events = ignored. Query window = requested availability range ± max event duration, tz-normalized. (Finer boundary handling is TDD-level.)
- **Reminder safety:** the reminder worker **re-reads** booking `status/start_utc/sequence` at execution and no-ops if cancelled, rescheduled, or sequence-stale — job cancellation is best-effort, this is the guarantee.
- **OAuth scopes (narrowest):** request `calendar.events` (write) + `calendar.freebusy` (read busy) — the least-sensitive combo that satisfies the goal; avoid full `calendar` (restricted). **Action:** confirm each scope's current sensitivity tier + verification consequence against Google's live scope list before committing the timeline (don't assume CASA without confirming).
- **Provider isolation + switch behavior:** each booking stores its **originating `provider`** (`bookings.provider`). A bot uses one active `BookingProvider` for *new* bookings, but reschedule/cancel of an **existing** booking routes by **that booking's own `provider`**, not the bot's current setting — so switching a bot from `internal`→`calcom` (or back) never strands existing bookings; they remain reschedulable/cancellable via their origin provider. Cal.com bookings are not mirrored into internal `bookings`; internal availability/exclusion only considers `provider='internal'` rows. History is not migrated on switch.
- **Idempotency null-safety:** partial unique is `(tenant_id, bot_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND status <> 'failed'` (Postgres allows multiple NULLs otherwise).
- **Migration note:** `bookings` is a **new, empty** table created **with** the exclusion + CHECK + partial-unique constraints in the same migration — no backfill, no validation pass against existing rows, no heavy lock, even while Cal.com stays active.
- **calendar_key backfill (pushback on over-engineering):** on connect, **grandfather** existing bookings on their `bot_id` `calendar_key`; only *new* bookings adopt the destination-calendar key. Avoids any exclusion-constraint violation at connect time. The shared-destination case (Q1) is rare; revisit only if it materializes.

## Open questions
- (Q1) Does any tenant point multiple bots at one destination calendar? If never, `calendar_key` ≈ `bot_id` and the grandfather rule is moot.
- (Q2) Resolved: conferencing link is best-effort (book without it + warn).
- (Q3) Realistic *second* provider (Office365 vs CalDAV/Apple)? Shapes which interface edges we validate in v1 even though impl lands in Phase 2.
