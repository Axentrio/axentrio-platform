# Cal.com Booking Integration — Design Spec

**Date:** 2026-04-01
**Status:** Draft
**Summary:** Add Cal.com booking capabilities to the chatbot platform via internal booking proxy endpoints. n8n's AI Agent gets booking tools; the platform handles credentials, Cal.com API calls, and tenant isolation.

---

## Problem Statement

The n8n-as-brain architecture lets the AI agent handle general conversation and KB questions. But when a customer wants to book an appointment, the agent can't help — it has no booking tools. Customers hit a dead end or get handed off to a human for something that should be automated.

The Deeny client already has a working Cal.com booking flow in a separate n8n workflow, but it uses hardcoded credentials and can't work in the shared multi-tenant workflow.

## Design Principle

**Platform as secure proxy.** n8n never sees Cal.com credentials. The platform decrypts credentials, calls Cal.com, returns results. Same pattern as the RAG search endpoint.

---

## Architecture

### Booking Flow

```
User: "I want to book Thursday"
    → Platform → n8n
    → AI Agent decides to check availability
    → Tool: POST /api/v1/internal/booking/availability
      (sends sessionId + date range)
    → Platform: derives tenant from session → decrypts Cal.com key → calls Cal.com API
    → Returns available slots to n8n
    → AI Agent shows slots, collects name/email
    → User confirms
    → Tool: POST /api/v1/internal/booking/create
      (sends sessionId + booking details + idempotency key)
    → Platform: calls Cal.com create booking → stores idempotency key → returns confirmation
    → AI Agent confirms to user
    → Platform: sends booking confirmation email (via Resend, when configured)
```

### Reschedule/Cancel Flow

```
User: "Can I change my appointment to Friday?"
    → AI Agent: Tool: POST /api/v1/internal/booking/reschedule
      (sends sessionId + bookingId + new time)
    → Platform: calls Cal.com reschedule API → sends update email

User: "Cancel my appointment"
    → AI Agent: Tool: POST /api/v1/internal/booking/cancel
      (sends sessionId + bookingId)
    → Platform: calls Cal.com cancel API → sends cancellation email
```

---

## Data Model

### Tenant Settings

New field in `tenant.settings.integrations` (JSONB):

```typescript
integrations: {
  calcom: {
    apiKey: string;           // Encrypted with encrypt() before storage
    eventTypeId: number;      // Which Cal.com event type to book
    collectFields: string[];  // ["name", "email"] minimum, optionally "phone", "serviceType", "notes"
    language: string;         // "en" | "nl" | "fr" | "de" — for booking prompt generation
  }
}
```

- **No separate timezone** — inherits from `tenant.settings.businessHours.timezone`
- **API key encrypted** — same `encrypt()`/`decrypt()` used for AI BYOK keys
- **API key redacted** — `GET /tenants/me` must strip `integrations.calcom.apiKey` (same as `settings.ai.apiKey`)

### Booking Log Table

New table `booking_logs` for idempotency and audit:

```
id              UUID PRIMARY KEY
tenant_id       UUID NOT NULL (FK → tenants)
session_id      UUID NOT NULL (FK → chat_sessions)
idempotency_key VARCHAR UNIQUE
cal_booking_id  VARCHAR          -- Cal.com's booking ID
event_type      VARCHAR          -- 'created' | 'rescheduled' | 'cancelled'
attendee_name   VARCHAR
attendee_email  VARCHAR
start_time      TIMESTAMPTZ
end_time        TIMESTAMPTZ
notes           TEXT
created_at      TIMESTAMPTZ DEFAULT NOW()
```

Used for:
- Idempotency (prevent duplicate bookings)
- Audit trail (which session created which booking)
- Email notifications (lookup booking details for confirmation emails)

---

## Internal Booking Endpoints

All endpoints use `Bearer RAG_INTERNAL_SECRET` auth (same as RAG search endpoint). Tenant derived from `sessionId` server-side — never from the request body.

### POST /api/v1/internal/booking/list

Lookup existing bookings for a customer. Required for reschedule/cancel flows — the AI agent won't always have the bookingId in conversation history.

```json
// Request
{
  "sessionId": "uuid",
  "attendeeEmail": "jane@example.com"
}

// Response
{
  "bookings": [
    {
      "id": "cal_booking_xyz",
      "startTime": "2026-04-05T09:00:00+02:00",
      "endTime": "2026-04-05T09:30:00+02:00",
      "attendee": { "name": "Jane Doe", "email": "jane@example.com" },
      "status": "accepted"
    }
  ]
}
```

Server validates that the attendeeEmail matches a booking in `booking_logs` for this tenant before returning results.

### POST /api/v1/internal/booking/availability

```json
// Request
{
  "sessionId": "uuid",
  "startDate": "2026-04-05T00:00:00",
  "endDate": "2026-04-05T23:59:59"
}

// Response
{
  "slots": [
    { "start": "2026-04-05T09:00:00+02:00", "end": "2026-04-05T09:30:00+02:00" },
    { "start": "2026-04-05T10:00:00+02:00", "end": "2026-04-05T10:30:00+02:00" }
  ],
  "timezone": "Europe/Brussels"
}

// Error (no Cal.com configured)
{ "error": "Booking not configured for this tenant", "code": "BOOKING_NOT_CONFIGURED" }
```

### POST /api/v1/internal/booking/create

```json
// Request
{
  "sessionId": "uuid",
  "idempotencyKey": "sess_abc123_2026-04-05T09:00",
  "startTime": "2026-04-05T09:00:00+02:00",
  "attendee": {
    "name": "Jane Doe",
    "email": "jane@example.com"
  },
  "notes": "Hair coloring appointment"
}

// Response
{
  "success": true,
  "booking": {
    "id": "cal_booking_xyz",
    "startTime": "2026-04-05T09:00:00+02:00",
    "endTime": "2026-04-05T09:30:00+02:00",
    "attendee": { "name": "Jane Doe", "email": "jane@example.com" }
  }
}

// Idempotent response (same key sent twice)
{
  "success": true,
  "booking": { ... },  // original booking returned
  "idempotent": true
}
```

### POST /api/v1/internal/booking/reschedule

```json
// Request
{
  "sessionId": "uuid",
  "bookingId": "cal_booking_xyz",
  "newStartTime": "2026-04-06T14:00:00+02:00"
}

// Response
{
  "success": true,
  "booking": {
    "id": "cal_booking_xyz",
    "startTime": "2026-04-06T14:00:00+02:00",
    "endTime": "2026-04-06T14:30:00+02:00"
  }
}
```

### POST /api/v1/internal/booking/cancel

```json
// Request
{
  "sessionId": "uuid",
  "bookingId": "cal_booking_xyz",
  "reason": "Customer requested cancellation"
}

// Response
{
  "success": true,
  "cancelled": true
}
```

---

## Outbound Payload

Add lightweight `integrations` indicator to the payload (no credentials):

```typescript
// New field alongside tenantConfig and knowledgeBase
integrations: {
  calcom?: {
    enabled: true;
    language: string;
    collectFields: string[];
    timezone: string;          // from businessHours.timezone
  }
}
```

This tells the n8n workflow to inject booking instructions and enable booking tools.

---

## n8n Workflow Changes

### Build System Prompt — Booking Section

When `integrations.calcom.enabled` is present in the payload, append to system prompt:

```
BOOKING ASSISTANT
You have access to booking tools: check_availability, create_booking, reschedule_booking, cancel_booking.

When the customer wants to book, reschedule, or cancel an appointment:

BOOKING FLOW:
1. Detect booking intent
2. Ask when they'd like to come
3. Call check_availability with the date — NEVER assume availability
4. Show available slots, ask them to pick
5. Collect: {collectFields}
6. Confirm all details with the customer
7. On confirmation, call create_booking

RESCHEDULE FLOW:
1. Ask which booking (if multiple) and new preferred date
2. Call check_availability for the new date
3. Show slots, confirm new time
4. Call reschedule_booking

CANCEL FLOW:
1. Confirm cancellation with the customer
2. Call cancel_booking

RULES:
- Check conversation history — don't restart completed steps
- Don't call check_availability twice for the same date
- Always confirm before creating/rescheduling/cancelling
- Timezone: {timezone}
```

Language-specific variants generated based on `integrations.calcom.language`.

### AI Agent Tool Nodes

Five tool nodes added to the AI Agent. In all tools, `sessionId` is injected via n8n expression (`$('Extract Message').item.json.sessionId`), NOT exposed as a placeholder the AI fills.

**list_bookings** (toolHttpRequest):
- POST `{$env.API_URL}/api/v1/internal/booking/list`
- Auth: `Bearer {$env.RAG_INTERNAL_SECRET}`
- Static body fields: `sessionId` (from Extract Message expression)
- AI-filled placeholders: `attendeeEmail`
- Use case: AI calls this to find existing bookings before reschedule/cancel

**check_availability** (toolHttpRequest):
- POST `{$env.API_URL}/api/v1/internal/booking/availability`
- Auth: `Bearer {$env.RAG_INTERNAL_SECRET}`
- Static body fields: `sessionId` (from Extract Message expression)
- AI-filled placeholders: `startDate`, `endDate`

**create_booking** (toolHttpRequest):
- POST `{$env.API_URL}/api/v1/internal/booking/create`
- Auth: `Bearer {$env.RAG_INTERNAL_SECRET}`
- Static body fields: `sessionId` (from Extract Message expression)
- AI-filled placeholders: `idempotencyKey`, `startTime`, `attendee.name`, `attendee.email`, `notes`

**reschedule_booking** (toolHttpRequest):
- POST `{$env.API_URL}/api/v1/internal/booking/reschedule`
- Auth: `Bearer {$env.RAG_INTERNAL_SECRET}`
- Static body fields: `sessionId` (from Extract Message expression)
- AI-filled placeholders: `bookingId`, `newStartTime`

**cancel_booking** (toolHttpRequest):
- POST `{$env.API_URL}/api/v1/internal/booking/cancel`
- Auth: `Bearer {$env.RAG_INTERNAL_SECRET}`
- Static body fields: `sessionId` (from Extract Message expression)
- AI-filled placeholders: `bookingId`, `reason`

---

## Email Notifications

### Design

After successful booking/reschedule/cancel, the platform sends an email notification. The booking service calls a `sendBookingNotification()` function with booking details and notification type.

### Email Types

1. **Booking confirmation** — sent to attendee email after `create`
2. **Reschedule confirmation** — sent after `reschedule`
3. **Cancellation confirmation** — sent after `cancel`

### Implementation

Email sending via Resend. For Step 1, the function is stubbed — logs the notification but doesn't send. Resend integration is configured separately later.

```typescript
async function sendBookingNotification(
  type: 'created' | 'rescheduled' | 'cancelled',
  booking: BookingDetails,
  tenantName: string
): Promise<void> {
  // Step 1: log only
  logger.info(`[Booking] Email notification: ${type}`, { booking });
  // Step 2 (later): send via Resend
}
```

---

## Security

- **Credentials never leave the platform** — n8n calls platform proxy endpoints, not Cal.com directly
- **Tenant derived from sessionId** — prevents cross-tenant booking via prompt injection. Note: this is a different contract from the RAG search endpoint (which uses `tenantId`). Booking endpoints use `sessionId` because they are side-effectful.
- **API key encrypted at rest** — same `encrypt()`/`decrypt()` as AI BYOK keys
- **API key managed via dedicated controller** — NOT through generic `PATCH /tenants/me`. Follows the same pattern as `ai-settings.routes.ts` with dedicated Zod schema, encryption on write, and `hasApiKey`-style response (never returns raw key)
- **Booking ownership validation** — `reschedule` and `cancel` endpoints verify the `bookingId` exists in `booking_logs` for this tenant before calling Cal.com. Prevents cross-tenant booking mutation.
- **Bearer token auth** — same `RAG_INTERNAL_SECRET` as RAG search endpoint
- **Idempotency key scoped to tenant** — `idempotency_key` is unique per tenant (composite unique on `tenant_id` + `idempotency_key`), not globally unique
- **`sessionId` injected by n8n expression, not AI-controlled** — Tool nodes use `$('Extract Message').item.json.sessionId` in the request body, NOT as a placeholder the AI agent fills. The AI agent cannot control which session's tenant is used.

## Error Handling

- **Malformed dates** — `400 BAD_REQUEST` with validation error. Dates must be valid ISO 8601. Do not pass invalid dates to Cal.com.
- **Cal.com downtime** — `503 BOOKING_UNAVAILABLE` when Cal.com API returns 5xx or times out. AI agent should tell the customer to try again later.
- **Slot race condition** — `409 SLOT_UNAVAILABLE` when the selected slot was taken between availability check and booking. AI agent should suggest checking availability again.
- **Booking not configured** — `400 BOOKING_NOT_CONFIGURED` when tenant has no `integrations.calcom` settings.
- **Missing timezone** — defaults to `'UTC'` when `tenant.settings.businessHours.timezone` is not set.

## What Gets Built

**Platform (7 items):**
1. `api/src/n8n/booking.routes.ts` — Five internal endpoints (list, availability, create, reschedule, cancel)
2. `api/src/n8n/booking.service.ts` — Cal.com API client, credential decryption, idempotency, booking ownership validation
3. `api/src/database/entities/BookingLog.ts` — Entity for booking_logs table
4. Database migration for booking_logs table
5. `api/src/knowledge/integrations.routes.ts` — Dedicated controller for integrations config (encrypt on write, redact on read, Zod validation)
6. Outbound payload enrichment — add `IntegrationsConfig` to types, JSON schema, and payload builder
7. Mount booking routes + integrations routes in `api/src/server.ts`

**n8n (4 items):**
1. Updated "Extract Message" node — parse `integrations` from payload
2. Updated "Build System Prompt" node — inject booking instructions when calcom enabled
3. 5 tool nodes on AI Agent (list_bookings, check_availability, create_booking, reschedule_booking, cancel_booking)
4. All tools use `sessionId` from Extract Message expression (not AI-controlled)

## Out of Scope

- Dashboard UI for configuring integrations (Phase 2)
- Calendly or other booking providers (separate integration)
- Multiple event types per tenant
- Booking analytics/reporting
- Resend email sending (stubbed — tenant configures Resend separately later)
