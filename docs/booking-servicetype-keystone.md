# Keystone: ServiceType (multiple bookable services per bot)

The booking engine today assumes **one** bookable service per bot. The "AI Booking
System for Solo Entrepreneurs" spec assumes a **catalog** of services, each with its
own duration / booking-mode / price / intake / rules. Making services a list is the
keystone every other slice (request-only, intake questions, presets, mobile, capacity,
price) hangs off.

This doc is the precise spec for that change. Locked decisions:

- **Service selection:** prompt catalog + `serviceId` param (NOT a `list_services` tool).
- **Availability:** one business schedule per bot; all services share it (per-service
  day filters are a later slice).
- **Naming:** rename `EventType` → `ServiceType` (entity + table).

## Current state (verified)

- `AvailabilityRule` — 1 per bot: `timezone, weeklyHours, dateOverrides, slotGranularityMin`.
  This is *business* availability and **stays business-level**. Maps to the spec's
  BusinessAvailability/BlockedDate.
- `EventType` — exactly **1 active per bot** (partial-unique `bot_id WHERE is_active`):
  `name, slug, durationMin, buffers, minNotice, maxHorizon, locationType, isActive`.
- `computeSlots(rule, eventType, range, now, busy)` — already separates business (`rule`)
  from service (`eventType`). Multi-service = call it with the same `rule` and the
  *selected* service's fields. **No slot-engine change needed.**
- Agent tools `check_availability(startDate,endDate)` / `create_booking(startTime,name,email,notes)`
  carry **no service**; the server resolves "the one active EventType". The prompt never
  names services.
- `calendarKey` is calendar-identity based (`gcal:<email>` / `bot:<id>`) — a solo owner's
  services correctly block the **same** calendar. **No change.**

## Schema

Rename `chatbot_event_types` → `chatbot_service_types`, entity `EventType` → `ServiceType`.
Drop the single-active partial-unique index; allow **N active per bot**. Add columns NOW
even where behavior lands in a later slice (re-migrating prod is the expensive part):

```
ServiceType
  (keep) name, slug, durationMin, bufferBeforeMin, bufferAfterMin,
         minNoticeMin, maxHorizonDays, locationType, isActive
  + category                 varchar null
  + description              text null
  + booking_mode             'auto' | 'request'   default 'auto'   ← core product decision
  + online_bookable          bool default true
  + duration_mode            'fixed' | 'range' | 'ai' default 'fixed'  (only 'fixed' implemented now)
  + min_duration_min         int null
  + max_duration_min         int null
  + price_display_type       'none'|'fixed'|'from'|'range'|'on_request' default 'none'
  + fixed_price / min_price / max_price  numeric null
  + price_note               varchar null
  + customer_location_required   bool default false
  + customer_address_required    bool default false
  + file_upload_allowed          bool default false
  + max_bookings_per_day     int null   (capacity enforced in a later slice)
  + preparation_instructions text null
  + sort_order               int default 0
```

Extend `Booking` (one table, per spec — a request is just a status):
```
  status enum gains 'request_created'
  + booking_mode        'auto' | 'request'
  + source_channel      varchar null
  + intake_answers      jsonb null
  + uploaded_files      jsonb null
  + ai_summary          text null
  + customer_phone      varchar null
  + customer_address    varchar null
```

**Migration:** every existing active EventType becomes that bot's first ServiceType
(`booking_mode='auto'`, `sort_order=0`). No data loss; single-service bots behave identically.

**Constraints (replace the dropped single-active index):**
- Unique `(bot_id, slug)` so the catalog/portal can address services by stable slug even
  though the agent uses `id`.
- **Zero active services is a valid state** — booking is simply "not configured" for that
  bot (existing `BOOKING_NOT_CONFIGURED` path); the prompt catalog is empty and the agent
  won't offer booking. Don't require ≥1.

**FK / external-payload back-compat (do NOT break history):** Postgres `ALTER TABLE … RENAME`
carries existing FKs/indexes automatically, so the table rename is safe. **Keep the
`Booking.event_type_id` column name as-is** (do not rename to `service_type_id`) — it's
referenced by analytics, admin views, webhook payloads (`appointment.booked`), and calendar
metadata. Expose it in code as `serviceTypeId` if desired, but the column and any
external-facing field names (`eventType`/`event_type_id`) stay stable.

## Agent service-selection

- **Prompt:** inject a compact ACTIVE-services catalog into the system prompt —
  `id · name · duration · mode · price one-liner`. (~5-10 services = no bloat.)
- **Tools:** add `serviceId` (optional) to `check_availability` and `create_booking`.
  The LLM picks from the catalog and passes the id.
- **serviceId is optional for back-compat:** a bot with exactly one active service
  defaults to it server-side (today's behavior keeps working mid-migration); a bot with
  ≥2 active services requires `serviceId` (else the server returns a "which service?"
  error the LLM can recover from).
- **Slot-chip threading:** `agent.service` already stashes offered slots in
  `pendingAvailability`; also stash the `serviceId` so the tapped quick-reply books the
  *right* service. (Optional nice-to-have: present the services themselves as quick replies.)
- **Rolling-deploy / stale-chip handling:** mid-rollout, `create_booking` may arrive with
  **no `serviceId`** (old prompt, old slot chip emitted before deploy, or external channel
  with a pre-deploy payload). Rule: missing `serviceId` → if the bot has exactly **one**
  active service, use it (old single-service behavior preserved); if **≥2**, return a
  recoverable `SERVICE_REQUIRED` error the LLM resolves by asking which service. Never guess.
- **No match / ambiguous / `booking_mode='request'`** → do NOT auto-confirm. In the
  keystone, `create_booking` on a request-mode service stores a **minimal
  `request_created` record now** (no calendar event, no notification) and the AI tells the
  customer it's a request, not a confirmation. The *full* request UX + owner notification
  is P2. (Read: minimal request record now, rich request flow later.)

## Provider / service layer

- `loadConfig(botId)` → `loadService(botId, serviceId?)` (defaults to sole active service)
  + `loadAvailability(botId)`.
- `checkAvailability(ctx, serviceId, startDate, endDate)` and
  `createBooking(ctx, serviceId, idempotencyKey, startTime, attendee, …)`.
- `createBooking` branches on `service.bookingMode`: `'auto'` → today's confirmed flow;
  `'request'` → create `status='request_created'`, **no calendar event, no owner
  notification** (notification + the richer request UX are P2; the keystone only lands the
  field + this short-circuit so a request-mode service never silently auto-books).
- `Booking.event_type_id` is always set (column name unchanged — see migration back-compat).

### Create-time revalidation (mandatory — slots/catalog can go stale)

A `serviceId` arriving from a (possibly old) slot chip or a multi-turn gap must be
re-validated inside `createBooking`, under the existing per-`calendarKey` advisory lock:
1. service exists, **belongs to this bot**, and is **active** (else reject — the catalog
   may have changed since the slot was offered);
2. recompute the offered slot against **that service's** duration/buffers/minNotice/maxHorizon
   (not a stale snapshot) — the booked time must still be a real offered slot;
3. `booking_mode` is still `'auto'` (a service flipped to `request` mid-conversation must
   not auto-book).

### Cross-service double-booking (already covered — make it explicit)

All of a solo owner's services share one `calendarKey`, so the **existing** guards already
prevent two *different* services from overlapping on the same calendar: the per-`calendarKey`
`pg_advisory_xact_lock` serializes concurrent creates, and the `EXCLUDE USING gist
(calendar_key WITH =, blocked_range WITH &&)` constraint rejects any overlap regardless of
service. No new locking is needed — but K1 must keep `calendarKey` calendar-identity based
(NOT per-service), or this protection breaks.

## Out of scope for the keystone (clean seams for later slices)

Request-only *flow* + owner notification, intake-questions table, business-type presets,
mobile/service-area + capacity enforcement + AI-estimated duration + price logic +
file→booking linkage, richer records/calendar-event content, Outlook/Apple providers.
The keystone only makes the **fields + service-id plumbing** exist so those are additive.

## Keystone slices (tracer bullets)

- **K1 — ServiceType schema + provider back-compat.** Rename + migrate, allow N, add
  columns (above) + the `(bot_id, slug)` unique constraint, `loadService(botId, serviceId?)`
  defaulting to sole active service, `checkAvailability`/`createBooking` accept `serviceId`
  with the create-time revalidation + `SERVICE_REQUIRED` rules above. *Demoable: existing
  single-service bots unaffected; a manually-seeded 2nd **auto-mode** service is bookable via
  the API with `serviceId`; a **request-mode** service yields `status='request_created'` with
  no calendar event (no owner notification yet).*
- **K2 — Agent service-selection.** Prompt catalog, `serviceId` on the two tools, slot-chip
  threading. *Demoable: with ≥2 services, a customer asking for service X gets X's
  availability and books X end-to-end in chat.* Blocked by K1.
- **K3 — Services CRUD API + portal Services list.** Replace the single event-type editor
  with a Services list (name, duration, mode, price, active) + editor. *Demoable: owner
  manages multiple services in the portal; the agent reflects them.* Blocked by K1 (parallel
  with K2).

## Then (separate epics, not keystone)

P2 request-only flow · P3 intake questions · P4 business-type presets · P5 mobile/area +
capacity + duration modes + price + file upload · P6 rich records/calendar content + Outlook.
