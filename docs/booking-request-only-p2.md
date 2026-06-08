# P2: Request-only booking flow

The keystone made request-only services *possible* (a `request_created` Booking with no
calendar event); P2 makes it a *flow*: the AI captures a request when it shouldn't
auto-book, the owner is actually notified, and requests surface in the portal.

## What the keystone already provides

- `Booking.status='request_created'`, `Booking.booking_mode='request'`.
- `InternalProvider.createBooking` short-circuits a **request-mode service** to a private
  `createRequest()` → stores the request (preferred time, attendee, notes), **no** calendar
  event / email / reminders, and requests never block the calendar (the gist EXCLUDE
  constraint only covers `pending`/`confirmed`). `CreateBookingResult.requested` flags it.
- K2 prompt already tells the agent to phrase request-only services as requests.

## Locked decisions

- **A request is a `Booking` row** (`status='request_created'`), NOT a `Lead`. The `Lead`
  table is standalone contact capture (`capture_lead` tool); a request is an appointment
  intent that can later become `confirmed`.
- **Owner notification is a direct email** to `botSettings.ai.supportEmail` (reliable),
  PLUS a new `booking.request_created` webhook event (for n8n/automation routing). We do
  NOT rely solely on a customer-configured webhook.
- **AI fallback uses an explicit `request_appointment` tool** — the agent chooses it; we
  don't silently reinterpret `create_booking`. (The keystone's request-mode short-circuit
  on `create_booking` stays as a safety net so a request-mode service can never be
  auto-confirmed even if the agent picks the wrong tool.)
- **A request always has a resolved service + a preferred time.** To avoid null
  service/time edge cases, the agent disambiguates FIRST (the prompt already says "ask which
  service — never guess"), so by the time it calls `request_appointment` it knows the
  `serviceId` (or the bot's sole active service) and a `preferredTime`. `start_utc`/`end_utc`
  and the webhook/email `service` are therefore always populated. (No schema change to make
  times/service nullable.)
- **One idempotent notification path.** Both the `create_booking` request-mode short-circuit
  AND `request_appointment` create a request through the same `createRequest()`, which is
  the single place that fires side effects (webhook + owner email) — exactly ONCE per newly
  inserted request (skipped on an idempotent re-return). Same persistence + metadata +
  notification contract for both callers.
- **Requests are view-only in the portal** for P2 (a "Requests" tab). Approve / decline /
  convert-to-booking is the future approval workflow, out of scope.
- **"No calendar connected" is NOT a fallback trigger** for us: the internal scheduler's
  availability source is `AvailabilityRule`, not Google, so we can still auto-book without
  Google. (Differs from the generic spec, which assumes the calendar is the source.)

## P2a — AI fallback-to-request (the safety rule)

New tool `request_appointment` (`api/src/agent/tools/request-booking.tool.ts`),
registered in `tool-registry.ts` under the same `bookingEnabled` gate as the other booking
tools. Params: `attendeeName, attendeeEmail, preferredTime` (required), `serviceId?`
(defaults to the bot's sole active service; the agent disambiguates ≥2 first), `notes?`,
`aiSummary?` (a short agent-written summary of the request for the owner). It calls a new
`requestBooking()` dispatcher in `booking.service.ts` → `InternalProvider.createRequest`
(promote it to a public entrypoint; the keystone's `create_booking` short-circuit calls the
same method). It does NOT validate an offered slot (a request is a preference, not a
confirmed slot) and never touches the calendar. `createRequest` resolves the service via the
existing `resolveService(botId, serviceId?)` (so `SERVICE_REQUIRED`/`SERVICE_NOT_FOUND` still
apply), sets `source_channel = ctx.session.channel`, stores `aiSummary`, and on a NEW row
fires the notifications below (idempotent re-returns fire nothing).

Prompt rules (prompt-builder SERVICES/booking section), in order:
1. If the request matches **no service or is ambiguous**, **ask a disambiguating question
   first** — do not confirm AND do not capture a request until the service is identified.
   (A request always has a resolved service.)
2. Once the service is known: use `create_booking` (auto-confirm) ONLY for an **auto-book**
   service when the customer has chosen an available time.
3. Otherwise use `request_appointment` (and tell the customer it's a request the owner will
   review) — when the service is **request-only**, the **scope/duration is unclear**, the
   job sounds **complex, urgent or risky**, or the agent is otherwise **not confident** it
   can safely confirm. Never invent a confirmation.

## P2b — Owner notification on a request

**Single, idempotent post-create path.** Both notifications fire from `createRequest()` ONCE
per newly inserted request (skipped when it returns an existing row on an idempotent retry),
so the `create_booking` short-circuit and `request_appointment` behave identically and never
double-notify. `bookingId` is the natural idempotency anchor.

- **Webhook:** add `booking.request_created` to `WebhookEventType` (`webhook.types.ts`) +
  a `BookingRequestCreatedEvent` payload `{ booking: { bookingId, startTime, endTime,
  attendeeName, attendeeEmail, notes }, service: { id, name } }` (service always present —
  a request has a resolved service). Emit fire-and-forget via `emitWebhookEvent`, built from
  `ctx.session` like `appointment.booked`.
- **Owner email:** `sendRequestNotificationEmail({ ownerEmail, serviceName, attendeeName,
  attendeeEmail, preferredTime, notes, aiSummary })` in `booking-email.ts` (owner-only,
  plain HTML, NO ICS), sent only when `botSettings.ai.supportEmail` is set. **If it's unset,
  skip + log — that's an accepted degraded state because the portal "Requests" tab (P2c) is
  the GUARANTEED in-app surface**, and the webhook still fires for routing.

`Booking.source_channel` (= `ctx.session.channel`) and `Booking.ai_summary` (the agent's
`aiSummary` param) are persisted on the request row for the portal display.

## P2c — Requests in the portal

- Extend `BookingScope` to `'upcoming' | 'past' | 'requests'`.
- `adminListBookings`: when `scope==='requests'`, add `status='request_created'` to the
  **existing** `WHERE tenantId + botId(anchor) + provider='internal'` clause (same tenancy /
  authorization scoping as upcoming/past — the new scope must not widen access), order by
  `created_at DESC`; include `bookingMode`/notes in the row. (Requests have no Meet URL.)
- `Bookings.tsx`: add a **Requests** tab (read-only — no reschedule/cancel). A request row
  shows attendee + contact, requested time, service name, and notes/summary. `statusPill`
  gets a `request_created` style ("Request", blue/indigo).
- `AdminBookingRow` / `AdminBooking` gain `serviceName?` and `bookingMode?` so the row can
  label the service and distinguish a request.

## Out of scope (later epics)

Intake questions (P3), approve/decline/convert-to-booking + email action buttons (future
approval workflow), mobile/service-area request triggers (P5), in-app Inbox surfacing.

## Slices (tracer bullets)

- **P2a** — `request_appointment` tool + `requestBooking()` dispatcher + prompt fallback
  rules + `booking.request_created` webhook event. *Demoable: asking for a request-only or
  ambiguous service captures a `request_created` Booking via chat; no calendar event.*
- **P2b** — Owner notification email on request creation (+ `source_channel`/`ai_summary`
  populated). *Demoable: creating a request emails the owner.* Blocked by P2a.
- **P2c** — Portal "Requests" tab (admin `requests` scope + dashboard tab + service label).
  *Demoable: the owner sees captured requests in the portal.* Blocked by P2a (parallel P2b).
